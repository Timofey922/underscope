"""Command line interface."""

from __future__ import annotations

import json
import sys
from enum import Enum
from pathlib import Path as FsPath
from typing import Annotated

import typer
from pydantic import ValidationError

from underscope import review
from underscope.decision import LABEL, evaluate
from underscope.models import Recommendation, VehicleRecord
from underscope.perception import MockDetector


class DetectorName(str, Enum):
    MOCK = "mock"
    CLAUDE = "claude"


def _make_detector(name: DetectorName, labels: FsPath | None, photo_root: FsPath):
    if name == DetectorName.CLAUDE:
        from underscope.vision import ClaudeVisionDetector

        return ClaudeVisionDetector(photo_root)
    return MockDetector.from_file(labels) if labels else MockDetector()

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


def _detect(detector, vehicle: VehicleRecord):
    """Run the detector; a photo it can't analyze ends the command with a clear message."""
    try:
        return detector.detect(vehicle)
    except Exception as err:
        from underscope.vision import DetectionError

        if not isinstance(err, DetectionError):
            raise
        typer.echo(f"Damage detection failed: {err}", err=True)
        raise typer.Exit(2) from err


def _views(detector, vehicle: VehicleRecord) -> dict[str, str]:
    """Which side of the car each of this vehicle's photos shows, when the detector says."""
    views = getattr(detector, "views", {})
    return {ref: views[ref] for ref in vehicle.photo_refs if ref in views}


def _unmapped_reasons(detector) -> list[str]:
    """Damage the detector saw but couldn't place on a panel goes to the checker."""
    notes = getattr(detector, "notes", {})
    return [f"Seen in {ref} but not on a modeled panel: {note}"
            for ref, items in notes.items() for note in items]  # fmt: skip


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
    detector_name: Annotated[
        DetectorName,
        typer.Option("--detector", help="mock reads labels; claude looks at the photos."),
    ] = DetectorName.MOCK,
    photo_root: Annotated[
        FsPath, typer.Option("--photo-root", help="Folder the vehicle's photo_refs are in.")
    ] = FsPath("."),
) -> None:
    """Evaluate disposition paths for one vehicle, after a human checker confirms the damage."""
    try:
        vehicle = _load_vehicle(vehicle_file)
    except ValueError as err:
        typer.echo(str(err), err=True)
        raise typer.Exit(2) from err
    detector = _make_detector(detector_name, labels, photo_root)
    status = "Findings NOT confirmed by a human checker."
    if confirmed:
        req = review.load(confirmed)
        if req.vin != vehicle.vin:
            raise typer.BadParameter(f"review is for VIN {req.vin}, not {vehicle.vin}")
        if review.is_stale(req, vehicle, _detect(detector, vehicle)):
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
        findings = _detect(detector, vehicle)
        req = review.build_request(vehicle, findings, review_mode, views=_views(detector, vehicle))
        req.reasons += _unmapped_reasons(detector)
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
    detector_name: Annotated[
        DetectorName,
        typer.Option("--detector", help="mock reads labels; claude looks at the photos."),
    ] = DetectorName.MOCK,
    photo_root: Annotated[
        FsPath, typer.Option("--photo-root", help="Folder the vehicles' photo_refs are in.")
    ] = FsPath("."),
) -> None:
    """Evaluate a folder of vehicles. Confirmed reviews are decided; the rest go to the queue.

    Exits 3 while any vehicle is still waiting for a checker.
    """
    detector = _make_detector(detector_name, None, photo_root)
    decided, waiting, invalid = [], [], []
    for path in sorted(vehicle_dir.glob("*.json")):
        try:
            vehicle = _load_vehicle(path)
        except ValueError as err:
            invalid.append(str(err))
            continue
        try:
            findings = detector.detect(vehicle)
        except Exception as err:  # noqa: BLE001 - one bad vehicle shouldn't stop the batch
            invalid.append(f"{path}: damage detection failed: {err}")
            continue
        existing = review_dir / f"{vehicle.vin}.json"
        req = review.load(existing) if existing.exists() else None
        if req and review.is_stale(req, vehicle, findings):
            req = None  # vehicle changed since review: start a fresh one
        if req and req.status == "confirmed":
            rec, status = evaluate(req.vehicle, req.findings), f"confirmed by {req.checker}"
        else:
            if req is None:
                req = review.build_request(
                    vehicle, findings, review_mode, views=_views(detector, vehicle)
                )
                req.reasons += _unmapped_reasons(detector)
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


@app.command("detect-eval")
def detect_eval_cmd(
    labels: Annotated[
        FsPath, typer.Argument(exists=True, help="True labels JSON: photo ref -> findings.")
    ],
    photo_root: Annotated[
        FsPath, typer.Option("--photo-root", help="Folder the labeled photos are in.")
    ] = FsPath("."),
    detector_name: Annotated[
        DetectorName, typer.Option("--detector", help="Detector to score.")
    ] = DetectorName.CLAUDE,
    predictions: Annotated[
        FsPath | None,
        typer.Option("--predictions", exists=True,
                     help="Score saved predictions instead of running a detector (free)."),
    ] = None,  # fmt: skip
    save: Annotated[
        FsPath | None, typer.Option("--save", help="Save the detector's predictions here.")
    ] = None,
    limit: Annotated[
        int | None, typer.Option("--limit", min=1, help="Only the first N labeled photos.")
    ] = None,
    yes: Annotated[
        bool, typer.Option("--yes", help="Confirm a paid run (the claude detector).")
    ] = False,
    report: Annotated[
        FsPath | None, typer.Option("--report", help="Also write the report as Markdown.")
    ] = None,
    match_by: Annotated[
        str,
        typer.Option("--match-by", help="panel (default), or type for labels without panels."),
    ] = "panel",
    batch: Annotated[
        bool,
        typer.Option("--batch", help="Submit as a Message Batch: half price, results within "
                                     "24 hours. Collect them later with --collect."),
    ] = False,  # fmt: skip
    collect: Annotated[
        FsPath | None,
        typer.Option("--collect", exists=True, help="Batch state file from --batch."),
    ] = None,
    batch_state: Annotated[
        FsPath, typer.Option("--batch-state", help="Where --batch saves its state.")
    ] = FsPath("detect_batch.json"),
) -> None:
    """Score a damage detector against labeled photos."""
    from underscope import detector_eval as de

    truth = de.load_findings(labels)
    refs = sorted(truth)[:limit] if limit else sorted(truth)
    truth = {r: truth[r] for r in refs}
    errors: dict[str, str] = {}
    spent = None
    if predictions:
        pred = de.load_findings(predictions)
    elif collect:
        from underscope.vision import ClaudeVisionDetector

        state = json.loads(collect.read_text())
        detector = ClaudeVisionDetector(photo_root, model=state.get("model", "claude-opus-5-5"))
        status, pred, errors = detector.collect_batch(state)
        if status != "ended":
            typer.echo(f"Batch {state['batch_id']} is still {status}; try again later.")
            raise typer.Exit(AWAITING_CONFIRMATION)
        truth = {r: truth[r] for r in truth if r in state["photos"].values()}
        spent = detector.spent_usd(batch=True)
    elif detector_name == DetectorName.CLAUDE:
        from underscope.vision import ClaudeVisionDetector, estimated_cost_usd

        estimate = estimated_cost_usd(len(refs)) / (2 if batch else 1)
        if not yes:
            how = "as a batch (half price)" if batch else ""
            typer.echo(
                f"This sends {len(refs)} photos to Claude {how}, roughly ${estimate:,.2f}. "
                "Re-run with --yes to go ahead (use --limit to try a few first)."
            )
            raise typer.Exit(1)
        detector = ClaudeVisionDetector(photo_root)
        if batch:
            try:
                state = detector.submit_batch(refs)
            except Exception as err:
                from underscope.vision import DetectionError

                if not isinstance(err, DetectionError):
                    raise
                raise typer.BadParameter(str(err)) from err
            batch_state.write_text(json.dumps(state, indent=2))
            typer.echo(
                f"Submitted batch {state['batch_id']} with {len(refs)} photos. State saved to "
                f"{batch_state}.\nCollect: underscope detect-eval {labels} --photo-root "
                f"{photo_root} --collect {batch_state} [--save predictions.json]"
            )
            return
        pred, errors = de.run_detector(detector, refs)
        spent = detector.spent_usd()
    else:
        pred, errors = de.run_detector(_MockPhotoDetector(labels), refs)
    if save and not predictions:
        de.save_findings(pred, save)
        if errors:
            typer.echo(f"Saved predictions for {len(pred)} photos; {len(errors)} failed "
                       "and aren't in the file.")  # fmt: skip
    if match_by not in ("panel", "type"):
        raise typer.BadParameter("--match-by must be panel or type")
    text = de.render_report(de.score(truth, pred, errors, by=match_by))
    if spent is not None:
        text += f"\nAPI cost of this run: ${spent:,.2f} (from reported token usage).\n"
    typer.echo(text)
    if report:
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(text)


@app.command("label")
def label_cmd(
    photo_dir: Annotated[
        FsPath, typer.Argument(exists=True, file_okay=False, help="Folder of photos to label.")
    ],
    labels: Annotated[
        FsPath, typer.Option("--labels", help="Labels file to create or extend.")
    ] = FsPath("labels.json"),
    prefill: Annotated[
        FsPath | None,
        typer.Option("--prefill", exists=True,
                     help="Start each photo from saved predictions (faster, but can anchor "
                          "the labeler on the model's answer)."),
    ] = None,  # fmt: skip
) -> None:
    """Record the true damage in each photo, for scoring detectors. Resumable."""
    from underscope import labeling
    from underscope.detector_eval import load_findings, save_findings

    done = load_findings(labels) if labels.exists() else {}
    start = load_findings(prefill) if prefill else {}
    todo = labeling.photos_to_label(photo_dir, done)
    typer.echo(f"{len(done)} labeled, {len(todo)} to go. Labels file: {labels}")
    typer.echo(labeling.HELP)
    for i, ref in enumerate(todo, 1):
        findings = [f.model_copy(update={"confidence": 1.0}) for f in start.get(ref, [])]
        typer.echo(f"\n[{i}/{len(todo)}] {(photo_dir / ref).resolve()}")
        typer.echo(labeling.describe(findings))
        while True:
            try:
                action, msg = labeling.apply(findings, typer.prompt("label"), ref)
            except ValueError as err:
                typer.echo(f"Not applied: {err}")
                continue
            if action == "edit":
                typer.echo(labeling.describe(findings))
            elif action == "help":
                typer.echo(msg or labeling.HELP)
            else:
                break
        if action == "next":
            done[ref] = findings
            save_findings(done, labels)
        elif action == "quit":
            break
    typer.echo(f"\n{len(done)} photos labeled in {labels}.")


@app.command("import-coco")
def import_coco_cmd(
    annotations: Annotated[FsPath, typer.Argument(exists=True, help="COCO annotations JSON.")],
    mapping: Annotated[
        FsPath, typer.Option("--mapping", exists=True, help="Category mapping YAML.")
    ],
    out: Annotated[FsPath, typer.Option("--out", help="Labels file to write.")] = FsPath(
        "labels.json"
    ),
) -> None:
    """Convert COCO damage annotations into labels for detect-eval."""
    from underscope.coco_import import convert_file
    from underscope.detector_eval import save_findings

    try:
        labels, counts = convert_file(annotations, mapping)
    except (ValueError, KeyError) as err:
        raise typer.BadParameter(f"mapping or annotations don't fit: {err}") from err
    save_findings(labels, out)
    typer.echo(
        f"{counts['images']} images, {counts['damage']} damage labels written to {out}\n"
        f"  placed on a labeled part: {counts['on_part']}\n"
        f"  on the default panel (score with --match-by type): {counts['default_panel']}\n"
        f"  dropped, no panel: {counts['no_panel']}; ignored by mapping: {counts['ignored']}\n"
        f"  categories not in the mapping: {counts['unknown_category']}"
    )


class _MockPhotoDetector:
    """Per-photo view of the label file; scores 100% by construction (pipeline check)."""

    def __init__(self, labels: FsPath):
        from underscope.detector_eval import load_findings

        self.labels = load_findings(labels)

    def detect_photo(self, ref: str):
        return self.labels.get(ref, [])


if __name__ == "__main__":
    app()
