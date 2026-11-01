"""Command line interface."""

from __future__ import annotations

import json
import sys
from pathlib import Path as FsPath
from typing import Annotated

import typer
from pydantic import ValidationError

from underscope import review
from underscope.decision import LABEL, evaluate
from underscope.models import Recommendation, VehicleRecord
from underscope.perception import MockDetector

AWAITING_CONFIRMATION = 3  # exit code: findings written for a checker, decision not made yet

app = typer.Typer(
    help="UnderScope: disposition decisions for damaged vehicles.", no_args_is_help=True
)


def _money(cents: int) -> str:
    return f"{'-' if cents < 0 else ''}${abs(cents) / 100:,.0f}"


def render(vehicle: VehicleRecord, rec: Recommendation) -> str:
    lines = [
        f"{vehicle.year} {vehicle.make} {vehicle.model} {vehicle.trim}".strip()
        + f"  VIN {vehicle.vin}  ({vehicle.region}, {vehicle.mileage:,} mi, "
        f"{vehicle.title_status}{', insurance claim' if vehicle.insurance_claim else ''})",
        "",
        f"RECOMMENDATION: {LABEL[rec.winner]}",
        rec.answer,
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


def _load_vehicle(path: FsPath) -> VehicleRecord:
    """Parse a vehicle file; raises ValueError with a readable message when it's invalid."""
    try:
        return VehicleRecord(**json.loads(path.read_text()))
    except json.JSONDecodeError as err:
        raise ValueError(f"invalid vehicle file {path}: not JSON ({err.msg})") from err
    except (ValidationError, TypeError) as err:
        first = err.errors()[0] if isinstance(err, ValidationError) else {"msg": str(err)}
        where = ".".join(str(x) for x in first.get("loc", ())) or "file"
        raise ValueError(f"invalid vehicle file {path}: {where}: {first['msg']}") from err


def _yes_no(text: str) -> bool:
    if text.lower() in ("y", "yes", "true"):
        return True
    if text.lower() in ("n", "no", "false"):
        return False
    raise ValueError(f"expected yes or no, got {text!r}")


PROMPT_HELP = """Commands:
  a                      accept the findings and continue to the decision
  + panel type severity  add a finding (e.g. + frame dent 0.6)
  - N                    remove finding #N
  s N severity           set the severity of finding #N
  u yes|no               undercarriage damage present?
  e yes|no               abnormal engine audio?
  q                      stop; leave the review pending"""


def _interactive_review(req: review.ReviewRequest, review_dir: FsPath) -> bool:
    """Walk the checker through the findings. True once confirmed, False if they quit."""
    typer.echo(PROMPT_HELP)
    while True:
        cmd = typer.prompt("review").strip().split()
        try:
            if not cmd:
                continue
            if cmd[0] == "a":
                review.confirm(req, typer.prompt("Checker name"))
                review.save(req, review_dir)
                return True
            if cmd[0] == "q":
                review.save(req, review_dir)
                return False
            if cmd[0] == "+" and len(cmd) == 4:
                review.add_finding(req, cmd[1], cmd[2], float(cmd[3]))
            elif cmd[0] == "-" and len(cmd) == 2:
                review.remove_finding(req, int(cmd[1]))
            elif cmd[0] == "s" and len(cmd) == 3:
                review.set_severity(req, int(cmd[1]), float(cmd[2]))
            elif cmd[0] in ("u", "e") and len(cmd) == 2:
                review.set_flag(req, "undercarriage" if cmd[0] == "u" else "engine",
                                _yes_no(cmd[1]))  # fmt: skip
            else:
                typer.echo(PROMPT_HELP)
                continue
        except ValueError as err:
            typer.echo(f"Not applied: {err}")
            continue
        review.save(req, review_dir)
        typer.echo(review.render_text(req))


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
    review_mode: Annotated[
        review.ReviewMode,
        typer.Option("--review-mode", help="Ask a checker for every vehicle, or only risky ones."),
    ] = review.ReviewMode.ALL,
    confirmed: Annotated[
        FsPath | None,
        typer.Option("--confirmed", exists=True, help="Resume from a confirmed review JSON."),
    ] = None,
    skip_confirm: Annotated[
        bool,
        typer.Option("--skip-confirm", help="Decide on unconfirmed findings (batch/testing)."),
    ] = False,
    interactive: Annotated[
        bool | None,
        typer.Option("--interactive/--no-interactive",
                     help="Prompt the checker here. Default: when a terminal is attached."),
    ] = None,  # fmt: skip
    review_dir: Annotated[
        FsPath, typer.Option("--review-dir", help="Where review JSON and HTML sheets go.")
    ] = FsPath("reviews"),
) -> None:
    """Evaluate disposition paths for one vehicle, after a human checker confirms the damage."""
    try:
        vehicle = _load_vehicle(vehicle_file)
    except ValueError as err:
        typer.echo(str(err), err=True)
        raise typer.Exit(2) from err
    detector = MockDetector.from_file(labels) if labels else MockDetector()
    status = "Findings NOT confirmed by a human checker."
    if confirmed:
        req = review.load(confirmed)
        if req.vin != vehicle.vin:
            raise typer.BadParameter(f"review is for VIN {req.vin}, not {vehicle.vin}")
        if review.is_stale(req, vehicle, detector.detect(vehicle)):
            typer.echo(
                f"The vehicle data or its detected damage changed since {confirmed} was "
                f"reviewed. Send it back to a checker:\n  underscope evaluate {vehicle_file}",
                err=True,
            )
            raise typer.Exit(AWAITING_CONFIRMATION)
        if req.status != "confirmed":
            typer.echo(f"{confirmed} is still pending; confirm it first:", err=True)
            typer.echo(f"  underscope confirm {confirmed} --checker NAME", err=True)
            raise typer.Exit(AWAITING_CONFIRMATION)
        vehicle, findings = req.vehicle, req.findings
        status = f"Findings confirmed by {req.checker} at {req.confirmed_at}."
    else:
        findings = detector.detect(vehicle)
        req = review.build_request(vehicle, findings, review_mode)
        if not skip_confirm and review.needs_confirmation(review_mode, req.reasons):
            json_path, html_path = review.save(req, review_dir)
            typer.echo(review.render_text(req), err=as_json)
            typer.echo(f"\nReview sheet (highlights every damaged area): {html_path}", err=as_json)
            if interactive is None:
                interactive = sys.stdin.isatty()
            if not interactive or not _interactive_review(req, review_dir):
                typer.echo(
                    f"\nAwaiting checker confirmation. Review request: {json_path}\n"
                    f"  1. underscope confirm {json_path} --checker NAME [edits]\n"
                    f"  2. underscope evaluate {vehicle_file} --confirmed {json_path}",
                    err=True,
                )
                raise typer.Exit(AWAITING_CONFIRMATION)
            vehicle, findings = req.vehicle, req.findings
            status = f"Findings confirmed by {req.checker} at {req.confirmed_at}."
            typer.echo("", err=as_json)
        elif not skip_confirm:
            status = "Not sent for review: no risk signals (review mode: risky)."
    rec = evaluate(vehicle, findings)
    if as_json:
        out = json.loads(rec.model_dump_json())
        out["findings_status"] = status
        typer.echo(json.dumps(out, indent=2))
    else:
        typer.echo(render(vehicle, rec) + f"\n{status}")


@app.command("confirm")
def confirm_cmd(
    review_file: Annotated[
        FsPath, typer.Argument(exists=True, readable=True, help="Review request JSON.")
    ],
    checker: Annotated[str, typer.Option("--checker", help="Name of the human checker.")],
    add: Annotated[
        list[str] | None,
        typer.Option("--add", help="Add a finding: panel:type:severity (repeatable)."),
    ] = None,
    remove: Annotated[
        list[int] | None,
        typer.Option("--remove", help="Remove finding #N as listed (repeatable)."),
    ] = None,
    undercarriage: Annotated[
        str | None, typer.Option("--undercarriage", help="yes|no: undercarriage damage.")
    ] = None,
    engine_audio: Annotated[
        str | None, typer.Option("--engine-audio", help="yes|no: abnormal engine audio.")
    ] = None,
) -> None:
    """Checker confirms (and optionally corrects) a pending damage review."""
    req = review.load(review_file)
    try:
        # Remove first, highest number first, so the numbers match what the checker saw.
        for n in sorted(remove or [], reverse=True):
            review.remove_finding(req, n)
        for spec in add or []:
            panel, damage_type, severity = spec.split(":")
            review.add_finding(req, panel, damage_type, float(severity))
        if undercarriage is not None:
            review.set_flag(req, "undercarriage", _yes_no(undercarriage))
        if engine_audio is not None:
            review.set_flag(req, "engine", _yes_no(engine_audio))
        review.confirm(req, checker)
    except ValueError as err:
        raise typer.BadParameter(str(err)) from err
    _, html_path = review.save(req, review_file.parent, review_file)
    typer.echo(review.render_text(req))
    typer.echo(f"\nSaved {review_file} and {html_path}.")


@app.command("queue")
def queue_cmd(
    review_dir: Annotated[
        FsPath, typer.Option("--review-dir", help="Where review JSON and HTML sheets are.")
    ] = FsPath("reviews"),
) -> None:
    """List damage reviews, pending first, and write an index page linking every sheet."""
    typer.echo(review.render_queue_text(review.list_reviews(review_dir)))
    if review_dir.is_dir():
        typer.echo(f"\nIndex: {review.write_queue_index(review_dir)}")


@app.command("batch")
def batch_cmd(
    vehicle_dir: Annotated[
        FsPath, typer.Argument(exists=True, file_okay=False, help="Folder of vehicle JSON files.")
    ],
    review_mode: Annotated[
        review.ReviewMode,
        typer.Option("--review-mode", help="Ask a checker for every vehicle, or only risky ones."),
    ] = review.ReviewMode.ALL,
    review_dir: Annotated[
        FsPath, typer.Option("--review-dir", help="Where review JSON and HTML sheets go.")
    ] = FsPath("reviews"),
    out: Annotated[
        FsPath | None, typer.Option("--out", help="Write decided recommendations as JSONL.")
    ] = None,
) -> None:
    """Evaluate a folder of vehicles. Confirmed reviews are decided; the rest go to the queue.

    Exits 3 while any vehicle is still waiting for a checker.
    """
    decided, waiting, invalid = [], [], []
    for path in sorted(vehicle_dir.glob("*.json")):
        try:
            vehicle = _load_vehicle(path)
        except ValueError as err:
            invalid.append(str(err))
            continue
        findings = MockDetector().detect(vehicle)
        existing = review_dir / f"{vehicle.vin}.json"
        req = review.load(existing) if existing.exists() else None
        if req and review.is_stale(req, vehicle, findings):
            req = None  # vehicle changed since review: start a fresh one
        if req and req.status == "confirmed":
            rec, status = evaluate(req.vehicle, req.findings), f"confirmed by {req.checker}"
        else:
            req = req or review.build_request(vehicle, findings, review_mode)
            if review.needs_confirmation(review_mode, req.reasons):
                review.save(req, review_dir)
                waiting.append(vehicle.vin)
                continue
            rec, status = evaluate(vehicle, findings), "not sent for review (no risk signals)"
        decided.append((rec, status))
    for rec, status in decided:
        typer.echo(f"{rec.vin:<20}{LABEL[rec.winner]:<28}{status}")
    for vin in waiting:
        typer.echo(f"{vin:<20}{'(awaiting checker)':<28}")
    for msg in invalid:
        typer.echo(f"skipped: {msg}")
    if out:
        out.write_text("".join(
            json.dumps({**json.loads(rec.model_dump_json()), "findings_status": status}) + "\n"
            for rec, status in decided
        ))  # fmt: skip
    if review_dir.is_dir():
        typer.echo(f"\nQueue: {review.write_queue_index(review_dir)}")
    typer.echo(f"{len(decided)} decided, {len(waiting)} awaiting a checker.")
    if waiting:
        raise typer.Exit(AWAITING_CONFIRMATION)


if __name__ == "__main__":
    app()
