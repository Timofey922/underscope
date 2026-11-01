"""Claude vision damage detector: photos -> DamageFinding list.

Install with `pip install -e '.[vision]'`. One request per photo; the model is constrained by a
JSON schema to our panel and damage-type values. Damage that maps to no panel we model
(wheels, mirrors, lights, interior) is kept as notes for the human checker instead of being
forced onto a wrong panel.

Credentials come from the environment the Anthropic SDK reads (ANTHROPIC_API_KEY or an
`ant auth login` profile); this module never reads key files.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path as FsPath
from typing import Any

from underscope.models import DamageFinding, DamageType, Panel, VehicleRecord

MODEL = "claude-opus-5-5"
# Server-side refusal fallback ("default" routes by refusal category). Car photos shouldn't
# trigger refusals, but a declined photo then still gets an answer instead of failing.
FALLBACK_BETA = "server-side-fallback-2026-07-01"

# Claude Opus 5.5 list price, USD per million tokens (input, output), from Anthropic's model
# table. Used only to estimate and report what an evaluation run costs.
PRICE_PER_MTOK = (4.00, 20.00)
# Rough tokens per photo for the pre-run estimate: a downscaled image plus the prompt in, and
# the findings JSON plus thinking out. Actual usage is reported after the run.
EST_TOKENS_PER_PHOTO = (2500, 3000)


def cost_usd(input_tokens: int, output_tokens: int) -> float:
    return (input_tokens * PRICE_PER_MTOK[0] + output_tokens * PRICE_PER_MTOK[1]) / 1e6


def estimated_cost_usd(photos: int) -> float:
    return photos * cost_usd(*EST_TOKENS_PER_PHOTO)


MEDIA_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
               ".webp": "image/webp", ".gif": "image/gif"}  # fmt: skip
MAX_IMAGE_BYTES = 5 * 1024 * 1024  # API limit per image

SYSTEM = f"""You inspect photos of damaged vehicles for a remarketing company and report \
exterior damage as structured findings.

Report each distinct damaged area you can see. For each one give:
- panel: one of {", ".join(p.value for p in Panel)}. Both sides of the car share a panel name \
(left and right doors are both "door"). Headlights and the grille count as front_bumper; \
taillights as rear_bumper. Use "frame" only for visible structural damage: bent rails or \
pillars, buckled floor, misaligned panel gaps from structural deformation.
- damage_type: one of {", ".join(t.value for t in DamageType)}. scratch = paint or clear-coat \
only; dent = deformed metal or plastic without tearing; crack = split or fractured part or \
glass; crush = heavy deformation that collapses the panel's shape; broken = missing, \
detached or shattered part.
- severity from 0 to 1 for how much of that panel's full repair the damage needs: about 0.1 \
for a small ding or scuff, 0.3 for a dent a hand could cover, 0.6 for damage over most of \
the panel, 0.9 or more when the panel needs replacing.
- confidence from 0 to 1 that this damage really exists as described. Lower it for glare, \
reflections, dirt, shadows, distance, blur or a partial view.

Put damage that fits no panel above (wheels, tires, mirrors, interior, underbody you can \
glimpse) in unmapped_damage as short descriptions. If the photo shows no vehicle or no \
damage, return empty lists. Describe only what is visible; don't guess about hidden damage."""

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "panel": {"type": "string", "enum": [p.value for p in Panel]},
                    "damage_type": {"type": "string", "enum": [t.value for t in DamageType]},
                    "severity": {"type": "number"},
                    "confidence": {"type": "number"},
                },
                "required": ["panel", "damage_type", "severity", "confidence"],
                "additionalProperties": False,
            },
        },
        "unmapped_damage": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["findings", "unmapped_damage"],
    "additionalProperties": False,
}


class DetectionError(RuntimeError):
    """A photo couldn't be analyzed (missing file, refusal, unusable response)."""


def _clamp(x: float) -> float:
    return min(1.0, max(0.0, float(x)))


def image_block(path: FsPath) -> dict[str, Any]:
    media_type = MEDIA_TYPES.get(path.suffix.lower())
    if media_type is None:
        raise DetectionError(f"{path}: unsupported image type (use jpg, png, webp or gif)")
    data = path.read_bytes()
    if len(data) > MAX_IMAGE_BYTES:
        raise DetectionError(f"{path}: image is over 5 MB; downscale it first")
    encoded = base64.standard_b64encode(data).decode("ascii")
    return {"type": "image", "source": {"type": "base64", "media_type": media_type,
                                        "data": encoded}}  # fmt: skip


def parse_response(response: Any, photo_ref: str) -> tuple[list[DamageFinding], list[str]]:
    """Turn a Messages API response into findings plus unmapped-damage notes."""
    if response.stop_reason == "refusal":
        raise DetectionError(f"{photo_ref}: the model declined to analyze this photo")
    if response.stop_reason == "max_tokens":
        raise DetectionError(f"{photo_ref}: response was cut off (max_tokens)")
    text = next((b.text for b in response.content if b.type == "text"), None)
    if text is None:
        raise DetectionError(f"{photo_ref}: response had no text block")
    try:
        data = json.loads(text)
        findings = [
            DamageFinding(
                panel=Panel(f["panel"]), damage_type=DamageType(f["damage_type"]),
                severity=_clamp(f["severity"]), confidence=_clamp(f["confidence"]),
                photo_ref=photo_ref,
            )
            for f in data["findings"]
        ]  # fmt: skip
    except (json.JSONDecodeError, KeyError, ValueError, TypeError) as err:
        raise DetectionError(f"{photo_ref}: unusable response ({err})") from err
    return findings, [str(x) for x in data.get("unmapped_damage", [])]


class ClaudeVisionDetector:
    """DamageDetector backed by Claude vision.

    photo_root: directory that vehicle.photo_refs are relative to.
    client: an anthropic.Anthropic (or a stand-in with the same beta.messages.create);
    created on first use when omitted, so importing this module needs no credentials.
    """

    def __init__(
        self,
        photo_root: str | FsPath = ".",
        client: Any = None,
        model: str = MODEL,
        effort: str = "medium",
    ):
        self.photo_root = FsPath(photo_root)
        self._client = client
        self.model = model
        self.effort = effort
        self.notes: dict[str, list[str]] = {}  # photo_ref -> unmapped damage descriptions
        self.usage: list[Any] = []  # response.usage per call, for cost reporting

    @property
    def client(self) -> Any:
        if self._client is None:
            try:
                import anthropic
            except ImportError as err:
                raise DetectionError(
                    "the Claude detector needs the vision extra: pip install -e '.[vision]'"
                ) from err
            self._client = anthropic.Anthropic()
        return self._client

    def detect_photo(self, photo_ref: str) -> list[DamageFinding]:
        path = self.photo_root / photo_ref
        if not path.is_file():
            raise DetectionError(f"{photo_ref}: photo not found under {self.photo_root}")
        response = self.client.beta.messages.create(
            model=self.model,
            max_tokens=16000,
            betas=[FALLBACK_BETA],
            fallbacks="default",
            system=SYSTEM,
            output_config={"effort": self.effort,
                           "format": {"type": "json_schema", "schema": SCHEMA}},
            messages=[{"role": "user", "content": [
                image_block(path),
                {"type": "text", "text": "Report the damage in this photo."},
            ]}],
        )  # fmt: skip
        self.usage.append(getattr(response, "usage", None))
        findings, notes = parse_response(response, photo_ref)
        self.notes[photo_ref] = notes
        return findings

    def spent_usd(self) -> float:
        """Cost of the calls made so far, from the API's reported token usage."""
        used = [u for u in self.usage if u is not None]
        return cost_usd(sum(u.input_tokens for u in used), sum(u.output_tokens for u in used))

    def detect(self, vehicle: VehicleRecord) -> list[DamageFinding]:
        found: list[DamageFinding] = []
        for ref in vehicle.photo_refs:
            found.extend(self.detect_photo(ref))
        return found
