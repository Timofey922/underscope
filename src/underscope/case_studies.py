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
        "Dealer persona (no insurance claim). A door dent on a clean-title car, repair estimate "
        "around $650.",
        "Selling as-is wins under the untuned placeholders: a flat 6% accident-history haircut "
        "on the repaired car ($1,500 here) outweighs a $650 repair. Repair only wins if buyers "
        "discount the visible damage by about 4.5x the repair cost (reports/sensitivity.md). "
        "The answer to the dealer's question depends on two unknowns, the as-is discount and "
        "the haircut for a minor cosmetic repair, and real ACV sale data should settle both.",
    ),
    (
        "borderline_writeoff.json",
        "Case 2: a borderline write-off",
        "Adjuster persona (insurance claim). Frame crush plus a door dent; repair cost is 72% "
        "of clean value against the 75% NY total-loss threshold.",
        "The threshold doesn't decide this case. With these placeholders, repair stops paying "
        "well below the threshold (repair bears the hidden-damage reserve, haircut and "
        "holding), so near 75% it already loses. Parts vs as-is depends on the parts "
        "placeholders (gross value fraction, sell-through).",
    ),
    (
        "total_loss.json",
        "Case 3: an obvious total loss",
        "Adjuster persona (insurance claim). Severe frame, hood and bumper damage with "
        "undercarriage damage flagged.",
        "Repair costs about 90% of the clean value and loses money in nearly every draw. Part-out "
        "leads salvage and as-is, but by an amount that the parts placeholders could erase "
        "(halving gross parts value or sell-through hands it to as-is).",
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
