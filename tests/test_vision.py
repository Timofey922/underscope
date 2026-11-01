import json
from types import SimpleNamespace

import pytest

from underscope.models import VehicleRecord
from underscope.vision import (
    FALLBACK_BETA,
    MODEL,
    SCHEMA,
    ClaudeVisionDetector,
    DetectionError,
    parse_response,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def reply(payload, stop="end_turn"):
    text = payload if isinstance(payload, str) else json.dumps(payload)
    return SimpleNamespace(
        stop_reason=stop,
        content=[
            SimpleNamespace(type="thinking", thinking=""),
            SimpleNamespace(type="text", text=text),
        ],
        usage=SimpleNamespace(input_tokens=1500, output_tokens=200),
    )


class FakeClient:
    """Stands in for anthropic.Anthropic: records requests, returns canned replies."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        return self.replies.pop(0)


def vehicle(*refs):
    return VehicleRecord(vin="V", year=2021, make="X", model="Y", mileage=1, region="NY",
                         photo_refs=list(refs))  # fmt: skip


def finding(panel="door", t="dent", sev=0.4, conf=0.8):
    return {"panel": panel, "damage_type": t, "severity": sev, "confidence": conf}


def test_detects_findings_per_photo_with_photo_ref(tmp_path):
    (tmp_path / "a.png").write_bytes(PNG)
    (tmp_path / "b.jpg").write_bytes(PNG)
    client = FakeClient(
        reply({"findings": [finding()], "unmapped_damage": ["front left tire flat"]}),
        reply({"findings": [finding("hood", "scratch", 0.1, 0.6)], "unmapped_damage": []}),
    )
    det = ClaudeVisionDetector(tmp_path, client=client)
    out = det.detect(vehicle("a.png", "b.jpg"))
    assert [(f.panel.value, f.photo_ref) for f in out] == [("door", "a.png"), ("hood", "b.jpg")]
    assert det.notes["a.png"] == ["front left tire flat"]
    assert len(det.usage) == 2


def test_request_shape(tmp_path):
    (tmp_path / "a.png").write_bytes(PNG)
    client = FakeClient(reply({"findings": [], "unmapped_damage": []}))
    ClaudeVisionDetector(tmp_path, client=client, effort="high").detect_photo("a.png")
    call = client.calls[0]
    assert call["model"] == MODEL and call["betas"] == [FALLBACK_BETA]
    assert call["fallbacks"] == "default"
    assert call["output_config"] == {"effort": "high",
                                     "format": {"type": "json_schema", "schema": SCHEMA}}
    image, text = call["messages"][0]["content"]
    assert image["source"]["media_type"] == "image/png" and text["type"] == "text"
    assert "temperature" not in call and "thinking" not in call


def test_values_clamped_into_range():
    out, _ = parse_response(reply({"findings": [finding(sev=1.4, conf=-0.2)],
                                   "unmapped_damage": []}), "p")  # fmt: skip
    assert out[0].severity == 1.0 and out[0].confidence == 0.0


@pytest.mark.parametrize("resp", [
    reply({"findings": []}, stop="refusal"),
    reply({"findings": []}, stop="max_tokens"),
    reply("not json"),
    reply({"findings": [finding(panel="wheel")], "unmapped_damage": []}),
])  # fmt: skip
def test_unusable_responses_raise(resp):
    with pytest.raises(DetectionError):
        parse_response(resp, "p")


def test_missing_unsupported_and_oversized_photos(tmp_path):
    det = ClaudeVisionDetector(tmp_path, client=FakeClient())
    with pytest.raises(DetectionError, match="not found"):
        det.detect_photo("nope.jpg")
    (tmp_path / "a.bmp").write_bytes(PNG)
    with pytest.raises(DetectionError, match="unsupported"):
        det.detect_photo("a.bmp")
    (tmp_path / "big.jpg").write_bytes(b"\x00" * (5 * 1024 * 1024 + 1))
    with pytest.raises(DetectionError, match="5 MB"):
        det.detect_photo("big.jpg")


def test_schema_enums_match_domain_model():
    from underscope.models import DamageType, Panel

    items = SCHEMA["properties"]["findings"]["items"]["properties"]
    assert items["panel"]["enum"] == [p.value for p in Panel]
    assert items["damage_type"]["enum"] == [t.value for t in DamageType]
