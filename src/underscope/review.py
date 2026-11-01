"""Human-in-the-loop damage review: a checker confirms findings before the decision runs.

A detector can't flag damage it never saw, so by default every vehicle's findings go to a
human checker first. The request lists every area of the car (all panels, undercarriage,
engine) as damaged, to verify, or clear, and is written as JSON (the handoff) plus an HTML
sheet that highlights every damaged area. "risky" mode only asks when risk signals exist.
"""

from __future__ import annotations

import html
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path as FsPath
from typing import Literal

from pydantic import BaseModel, Field

from underscope.config import Assumptions, default_assumptions
from underscope.decision import evaluate
from underscope.models import DamageFinding, DamageType, Panel, VehicleRecord


class ReviewMode(StrEnum):
    ALL = "all"
    RISKY = "risky"


class AreaStatus(StrEnum):
    DAMAGED = "damaged"
    VERIFY = "verify"  # high-risk area with nothing confirmed either way
    CLEAR = "clear"


# Areas where a miss is expensive and a detector sees poorly; always called out for checking.
HIGH_RISK_PANELS = (Panel.FRAME,)
EXTRA_AREAS = ("undercarriage", "engine")


class Area(BaseModel):
    name: str
    status: AreaStatus
    detail: str = ""


class ReviewRequest(BaseModel):
    vin: str
    status: Literal["pending", "confirmed"] = "pending"
    mode: ReviewMode = ReviewMode.ALL
    reasons: list[str] = Field(default_factory=list)
    vehicle: VehicleRecord
    findings: list[DamageFinding]
    checker: str | None = None
    confirmed_at: str | None = None

    def areas(self) -> list[Area]:
        out = []
        for panel in Panel:
            hits = [f for f in self.findings if f.panel == panel]
            if hits:
                detail = "; ".join(_finding_text(f) for f in hits)
                out.append(Area(name=panel.value, status=AreaStatus.DAMAGED, detail=detail))
            elif panel in HIGH_RISK_PANELS and self.status == "pending":
                out.append(
                    Area(name=panel.value, status=AreaStatus.VERIFY,
                         detail="nothing detected; structural misses are costly, check it")
                )  # fmt: skip
            else:
                out.append(Area(name=panel.value, status=AreaStatus.CLEAR))
        for name, flag, what in (
            ("undercarriage", self.vehicle.undercarriage_damage, "undercarriage damage"),
            ("engine", self.vehicle.engine_audio_abnormal, "abnormal engine audio"),
        ):
            if flag:
                out.append(Area(name=name, status=AreaStatus.DAMAGED, detail=f"{what} flagged"))
            elif flag is None:
                out.append(Area(name=name, status=AreaStatus.VERIFY, detail="not inspected"))
            else:
                out.append(Area(name=name, status=AreaStatus.CLEAR))
        return out


def _finding_text(f: DamageFinding) -> str:
    src = "checker" if f.verified else f"conf {f.confidence:.2f}"
    photo = f", photo {f.photo_ref}" if f.photo_ref else ""
    return f"{f.damage_type.value} severity {f.severity:.2f} ({src}{photo})"


def risk_reasons(
    vehicle: VehicleRecord, findings: list[DamageFinding], a: Assumptions | None = None
) -> list[str]:
    """Signals that the findings may be wrong or that a mistake would be costly.

    Reuses existing thresholds (simulation.low_confidence_threshold and the engine's own
    review flags) rather than adding new numbers.
    """
    a = a or default_assumptions()
    low = a["simulation"]["low_confidence_threshold"]
    out = []
    weak = [f for f in findings if not f.verified and f.confidence < low]
    if weak:
        out.append(f"{len(weak)} finding(s) below confidence {low:.2f}.")
    if vehicle.undercarriage_damage is None or vehicle.engine_audio_abnormal is None:
        out.append("Undercarriage or engine-audio inspection is missing.")
    if vehicle.undercarriage_damage:
        out.append("Undercarriage damage is flagged.")
    if any(f.panel in HIGH_RISK_PANELS for f in findings):
        out.append("Structural (frame) damage detected.")
    if not findings:
        out.append("No damage detected at all; confirm the car is really clean.")
    rec = evaluate(vehicle, findings, a)
    out += [f"Decision: {r}" for r in rec.review_reasons]
    return out


def needs_confirmation(mode: ReviewMode, reasons: list[str]) -> bool:
    return mode == ReviewMode.ALL or bool(reasons)


def build_request(
    vehicle: VehicleRecord,
    findings: list[DamageFinding],
    mode: ReviewMode = ReviewMode.ALL,
    a: Assumptions | None = None,
) -> ReviewRequest:
    return ReviewRequest(
        vin=vehicle.vin,
        mode=mode,
        reasons=risk_reasons(vehicle, findings, a),
        vehicle=vehicle.model_copy(update={"findings": []}),
        findings=list(findings),
    )


# ------------------------------------------------------------------ checker edits


def add_finding(req: ReviewRequest, panel: str, damage_type: str, severity: float) -> None:
    req.findings.append(
        DamageFinding(panel=Panel(panel), damage_type=DamageType(damage_type),
                      severity=severity, confidence=1.0, verified=True)
    )  # fmt: skip


def remove_finding(req: ReviewRequest, number: int) -> None:
    """number is 1-based, as shown to the checker."""
    if not 1 <= number <= len(req.findings):
        raise ValueError(f"no finding #{number}")
    del req.findings[number - 1]


def set_severity(req: ReviewRequest, number: int, severity: float) -> None:
    if not 1 <= number <= len(req.findings):
        raise ValueError(f"no finding #{number}")
    f = req.findings[number - 1]
    req.findings[number - 1] = f.model_copy(update={"severity": severity, "verified": True})


def set_flag(req: ReviewRequest, area: str, value: bool) -> None:
    field = {"undercarriage": "undercarriage_damage", "engine": "engine_audio_abnormal"}[area]
    req.vehicle = req.vehicle.model_copy(update={field: value})


def confirm(req: ReviewRequest, checker: str) -> None:
    """Checker vouches for every finding: each becomes verified with confidence 1.0."""
    if not checker.strip():
        raise ValueError("checker name is required")
    req.findings = [f.model_copy(update={"verified": True, "confidence": 1.0})
                    for f in req.findings]  # fmt: skip
    req.status = "confirmed"
    req.checker = checker.strip()
    req.confirmed_at = datetime.now(UTC).isoformat(timespec="seconds")


# ------------------------------------------------------------------ files


def paths(req: ReviewRequest, directory: str | FsPath) -> tuple[FsPath, FsPath]:
    d = FsPath(directory)
    return d / f"{req.vin}.json", d / f"{req.vin}.html"


def save(
    req: ReviewRequest, directory: str | FsPath, json_path: FsPath | None = None
) -> tuple[FsPath, FsPath]:
    """Write the request JSON and its HTML sheet (same name, .html) and return both paths."""
    if json_path is None:
        json_path, html_path = paths(req, directory)
    else:
        html_path = json_path.with_suffix(".html")
    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(req.model_dump_json(indent=2))
    html_path.write_text(render_html(req))
    return json_path, html_path


def load(path: str | FsPath) -> ReviewRequest:
    return ReviewRequest.model_validate_json(FsPath(path).read_text())


# ------------------------------------------------------------------ rendering

_MARK = {AreaStatus.DAMAGED: "!!", AreaStatus.VERIFY: "??", AreaStatus.CLEAR: "  "}


def render_text(req: ReviewRequest) -> str:
    v = req.vehicle
    lines = [
        f"DAMAGE REVIEW  VIN {req.vin}  {v.year} {v.make} {v.model}  [{req.status}]",
        "",
        "Every area of the car (!! damaged, ?? verify, blank = nothing detected):",
    ]
    for area in req.areas():
        detail = f"  {area.detail}" if area.detail else ""
        lines.append(f"  {_MARK[area.status]} {area.name:<14}{area.status.value:<8}{detail}")
    lines += ["", "Findings:"]
    lines += [f"  #{i} {f.panel.value}: {_finding_text(f)}" for i, f in enumerate(req.findings, 1)]
    if not req.findings:
        lines.append("  (none)")
    if req.reasons:
        lines += ["", "Why this needs a careful look:", *(f"  - {r}" for r in req.reasons)]
    if req.checker:
        lines += ["", f"Confirmed by {req.checker} at {req.confirmed_at}."]
    return "\n".join(lines)


# Top-down car, front at the top. Panels aren't sided in the model, so both sides share a
# status. (x, y, w, h) in a 240x460 viewBox.
_SHAPES: dict[str, list[tuple[int, int, int, int]]] = {
    "front_bumper": [(50, 20, 140, 26)],
    "hood": [(62, 50, 116, 86)],
    "fender": [(34, 50, 26, 86), (180, 50, 26, 86)],
    "windshield": [(66, 140, 108, 34)],
    "roof": [(66, 178, 108, 120)],
    "door": [(34, 140, 28, 160), (178, 140, 28, 160)],
    "quarter_panel": [(34, 304, 28, 100), (178, 304, 28, 100)],
    "rear_bumper": [(50, 412, 140, 26)],
}


def _severity_class(findings: list[DamageFinding]) -> str:
    worst = max(f.severity for f in findings)
    return "sev-high" if worst >= 0.66 else "sev-mid" if worst >= 0.33 else "sev-low"


def render_html(req: ReviewRequest) -> str:
    e = html.escape
    v = req.vehicle
    areas = {a.name: a for a in req.areas()}
    shapes = []
    frame = areas["frame"]
    frame_cls = (
        _severity_class([f for f in req.findings if f.panel == Panel.FRAME])
        if frame.status == AreaStatus.DAMAGED
        else frame.status.value
    )
    # Frame drawn as rails under the body so it reads as structure, not skin.
    shapes.append(
        f'<g class="area frame {frame_cls}"><title>frame: {e(frame.status.value)}'
        f' {e(frame.detail)}</title><rect x="20" y="12" width="200" height="434" rx="28"/></g>'
    )
    for name, rects in _SHAPES.items():
        area = areas[name]
        hits = [f for f in req.findings if f.panel.value == name]
        cls = _severity_class(hits) if hits else area.status.value
        body = "".join(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6"/>' for x, y, w, h in rects
        )
        shapes.append(
            f'<g class="area {cls}"><title>{e(name)}: {e(area.status.value)} '
            f"{e(area.detail)}</title>{body}</g>"
        )
    svg = (
        '<svg viewBox="0 0 240 460" role="img" aria-label="Top-down car diagram, front at top">'
        + "".join(shapes)
        + "</svg>"
    )
    badge = {AreaStatus.DAMAGED: "Damaged", AreaStatus.VERIFY: "Verify", AreaStatus.CLEAR: "Clear"}
    rows = "".join(
        f'<tr class="row-{a.status.value}"><td>{e(a.name)}</td>'
        f'<td><span class="badge {a.status.value}">{badge[a.status]}</span></td>'
        f"<td>{e(a.detail)}</td></tr>"
        for a in req.areas()
    )
    findings = "".join(
        f"<tr><td>#{i}</td><td>{e(f.panel.value)}</td><td>{e(f.damage_type.value)}</td>"
        f"<td>{f.severity:.2f}</td><td>{'checker' if f.verified else f'{f.confidence:.2f}'}</td>"
        f"<td>{e(f.photo_ref or '')}</td></tr>"
        for i, f in enumerate(req.findings, 1)
    ) or '<tr><td colspan="6">No findings.</td></tr>'
    reasons = "".join(f"<li>{e(r)}</li>" for r in req.reasons) or "<li>None.</li>"
    if req.status == "confirmed":
        status = f"Confirmed by {e(req.checker or '')} at {e(req.confirmed_at or '')}"
    else:
        status = "Awaiting checker confirmation"
    photos = "".join(f"<li>{e(p)}</li>" for p in v.photo_refs) or "<li>None.</li>"
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Damage review {e(req.vin)}</title>
<style>
:root {{ --bg:#fff; --fg:#1d1d1f; --muted:#6b6b70; --line:#d9d9de; --panel:#f1f1f4;
  --low:#f2c94c; --mid:#f2994a; --high:#d93a3a; --verify:#2f6fdf; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg:#16161a; --fg:#ececf0; --muted:#a0a0a8;
  --line:#3a3a42; --panel:#24242a; --low:#c9a43a; --mid:#d4813f; --high:#e05555;
  --verify:#5b8ff0; }} }}
body {{ margin:0; background:var(--bg); color:var(--fg);
  font:15px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; }}
main {{ max-width:960px; margin:0 auto; padding:24px 16px; }}
h1 {{ font-size:20px; margin:0 0 4px; }} h2 {{ font-size:16px; margin:24px 0 8px; }}
.muted {{ color:var(--muted); }}
.status {{ display:inline-block; margin-top:8px; padding:4px 10px; border-radius:999px;
  border:1px solid var(--line); }}
.grid {{ display:grid; grid-template-columns:minmax(200px,280px) 1fr; gap:24px;
  align-items:start; }}
@media (max-width:640px) {{ .grid {{ grid-template-columns:1fr; }} }}
svg {{ width:100%; height:auto; }}
.area rect {{ fill:var(--panel); stroke:var(--line); stroke-width:2; }}
.frame rect {{ fill:none; stroke-width:6; }}
.sev-low rect {{ fill:var(--low); }} .sev-mid rect {{ fill:var(--mid); }}
.sev-high rect {{ fill:var(--high); }}
.frame.sev-low rect {{ fill:none; stroke:var(--low); }}
.frame.sev-mid rect {{ fill:none; stroke:var(--mid); }}
.frame.sev-high rect {{ fill:none; stroke:var(--high); }}
.verify rect {{ stroke:var(--verify); stroke-dasharray:8 6; stroke-width:4; }}
table {{ width:100%; border-collapse:collapse; }}
td, th {{ text-align:left; padding:6px 8px; border-bottom:1px solid var(--line);
  vertical-align:top; }}
.badge {{ padding:2px 8px; border-radius:6px; font-size:13px; white-space:nowrap; }}
.badge.damaged {{ background:var(--high); color:#fff; }}
.badge.verify {{ border:2px dashed var(--verify); }}
.badge.clear {{ color:var(--muted); }}
.legend span {{ display:inline-block; width:12px; height:12px; border-radius:3px;
  margin:0 4px 0 12px; vertical-align:-1px; }}
.table-wrap {{ overflow-x:auto; }}
code {{ background:var(--panel); padding:1px 5px; border-radius:4px; }}
</style></head><body><main>
<h1>Damage review: {e(f"{v.year} {v.make} {v.model} {v.trim}".strip())}</h1>
<div class="muted">VIN {e(req.vin)} · {e(v.region)} · {v.mileage:,} mi · {e(v.title_status.value)}
{" · insurance claim" if v.insurance_claim else ""}</div>
<div class="status">{status}</div>
<div class="grid">
<div><h2>Every area of the car</h2>{svg}
<div class="legend muted"><span style="background:var(--low)"></span>minor
<span style="background:var(--mid)"></span>moderate
<span style="background:var(--high)"></span>severe
<span style="border:2px dashed var(--verify)"></span>verify</div>
<p class="muted">Front at top. Outer outline is the frame.</p></div>
<div><h2>Area checklist</h2><div class="table-wrap"><table>
<tr><th>Area</th><th>Status</th><th>Detail</th></tr>{rows}</table></div>
<h2>Findings</h2><div class="table-wrap"><table>
<tr><th></th><th>Panel</th><th>Type</th><th>Severity</th><th>Confidence</th><th>Photo</th></tr>
{findings}</table></div>
<h2>Why this needs a careful look</h2><ul>{reasons}</ul>
<h2>Photos</h2><ul>{photos}</ul>
<h2>How to confirm</h2>
<p>Check every damaged and verify area against the photos or the car. Then either answer the
prompt in the terminal, or run <code>underscope confirm {e(req.vin)}.json --checker NAME</code>
with <code>--add panel:type:severity</code>, <code>--remove N</code>,
<code>--undercarriage yes|no</code> or <code>--engine-audio yes|no</code> as needed.</p>
</div></div></main></body></html>
"""
