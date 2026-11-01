"""Generates reports/case_studies.md from the three fixture vehicles."""

from __future__ import annotations

import json
from pathlib import Path as FsPath

from underscope.cli import render
from underscope.data import FIXTURE_DIR, ROOT
from underscope.decision import evaluate
from underscope.models import VehicleRecord
from underscope.perception import MockDetector

CASES = [
    (
        "dent_600.json",
        "Case 1: the $600 dent",
        "Dealer persona. A door dent on a clean-title car, repair estimate in the $600-700 range.",
        "Repairing wins narrowly because buyers discount the visible damage by more than the "
        "repair costs. The margin is thin, so the result is sensitive to the placeholder "
        "as-is discount multiple and holding cost.",
    ),
    (
        "borderline_writeoff.json",
        "Case 2: a borderline write-off",
        "Adjuster persona. Frame crush plus a door dent; repair cost sits near the NY "
        "total-loss threshold.",
        "Whether the repair crosses the total-loss threshold (and brands the title) changes the "
        "best path, so the engine flags the threshold as decisive and asks for human review.",
    ),
    (
        "total_loss.json",
        "Case 3: an obvious total loss",
        "Adjuster persona. Severe frame, hood and bumper damage with undercarriage damage flagged.",
        "Repair costs exceed the clean value, so repair loses money in nearly every draw. Parts "
        "and salvage dominate; no review flag is needed.",
    ),
]


def build() -> str:
    out = [
        "# Case studies",
        "",
        "All vehicles are fixtures (fake VINs, makes); all values use PLACEHOLDER assumptions "
        "from config/assumptions.yaml. These illustrate engine behavior, not market outcomes.",
        "",
    ]
    for fname, title, setup, takeaway in CASES:
        v = VehicleRecord(**json.loads((FIXTURE_DIR / fname).read_text()))
        rec = evaluate(v, MockDetector().detect(v))
        out += [
            f"## {title}",
            "",
            f"{setup} (`data/fixtures/{fname}`)",
            "",
            "```",
            render(v, rec),
            "```",
            "",
            f"**Takeaway:** {takeaway}",
            "",
        ]
    return "\n".join(out)


def write(path: str | FsPath = ROOT / "reports" / "case_studies.md") -> FsPath:
    p = FsPath(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(build())
    return p


if __name__ == "__main__":
    print(write())
