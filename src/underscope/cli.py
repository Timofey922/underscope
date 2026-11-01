"""Command line interface."""

from __future__ import annotations

import json
from pathlib import Path as FsPath
from typing import Annotated

import typer

from underscope.decision import LABEL, evaluate
from underscope.models import Recommendation, VehicleRecord
from underscope.perception import MockDetector

app = typer.Typer(
    help="UnderScope: disposition decisions for damaged vehicles.", no_args_is_help=True
)


def _money(cents: int) -> str:
    return f"{'-' if cents < 0 else ''}${abs(cents) / 100:,.0f}"


def render(vehicle: VehicleRecord, rec: Recommendation) -> str:
    lines = [
        f"{vehicle.year} {vehicle.make} {vehicle.model} {vehicle.trim}".strip()
        + f"  VIN {vehicle.vin}  ({vehicle.region}, {vehicle.mileage:,} mi, "
        f"{vehicle.title_status})",
        "",
        f"RECOMMENDATION: {LABEL[rec.winner]}",
    ]
    if rec.needs_human_review:
        lines.append("** NEEDS HUMAN REVIEW **")
    lines += ["", f"{'Path':<28}{'Expected':>10}{'P10':>10}{'P50':>10}{'P90':>10}"]
    for o in rec.options:
        lines.append(
            f"{LABEL[o.path]:<28}{_money(o.expected_cents):>10}{_money(o.p10_cents):>10}"
            f"{_money(o.p50_cents):>10}{_money(o.p90_cents):>10}"
        )
    lines += ["", rec.explanation]
    if rec.review_reasons:
        lines += ["", "Review reasons:", *(f"  - {r}" for r in rec.review_reasons)]
    if rec.flip_conditions:
        lines += ["", "What would flip it:", *(f"  - {c}" for c in rec.flip_conditions)]
    lines += ["", "(Values use PLACEHOLDER assumptions in config/assumptions.yaml.)"]
    return "\n".join(lines)


@app.callback()
def main() -> None:
    """UnderScope command line."""


@app.command("evaluate")
def evaluate_cmd(
    vehicle_file: Annotated[
        FsPath, typer.Argument(exists=True, readable=True, help="Vehicle JSON.")
    ],
    labels: Annotated[
        FsPath | None,
        typer.Option("--labels", exists=True, help="Detector labels JSON: photo ref -> findings."),
    ] = None,
    as_json: Annotated[
        bool, typer.Option("--json", help="Print the recommendation as JSON.")
    ] = False,
) -> None:
    """Evaluate disposition paths for one vehicle."""
    vehicle = VehicleRecord(**json.loads(vehicle_file.read_text()))
    detector = MockDetector.from_file(labels) if labels else MockDetector()
    rec = evaluate(vehicle, detector.detect(vehicle))
    if as_json:
        typer.echo(rec.model_dump_json(indent=2))
    else:
        typer.echo(render(vehicle, rec))


if __name__ == "__main__":
    app()
