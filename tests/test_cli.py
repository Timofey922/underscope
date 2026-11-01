import json

from typer.testing import CliRunner

from underscope.cli import AWAITING_CONFIRMATION, app
from underscope.data import FIXTURE_DIR

runner = CliRunner()
DENT = str(FIXTURE_DIR / "dent_600.json")
TOTAL = str(FIXTURE_DIR / "total_loss.json")


def test_text_output_with_skip_confirm():
    r = runner.invoke(app, ["evaluate", DENT, "--skip-confirm"])
    assert r.exit_code == 0, r.output
    assert "RECOMMENDATION" in r.output and "PLACEHOLDER" in r.output
    assert "NOT confirmed" in r.output


def test_json_output_with_skip_confirm():
    r = runner.invoke(app, ["evaluate", TOTAL, "--json", "--skip-confirm"])
    assert r.exit_code == 0
    out = json.loads(r.stdout)
    assert out["winner"] in {"repair_then_acv", "acv_as_is", "copart_salvage", "part_out"}
    assert "NOT confirmed" in out["findings_status"]


def test_every_vehicle_waits_for_checker_by_default(tmp_path):
    r = runner.invoke(app, ["evaluate", DENT, "--no-interactive", "--review-dir", str(tmp_path)])
    assert r.exit_code == AWAITING_CONFIRMATION
    assert "RECOMMENDATION" not in r.output
    assert (tmp_path / "FIXDENT0000000001.json").exists()
    html = (tmp_path / "FIXDENT0000000001.html").read_text()
    assert "door" in html and "Awaiting checker confirmation" in html


def test_file_handoff_confirm_then_proceed(tmp_path):
    runner.invoke(app, ["evaluate", TOTAL, "--no-interactive", "--review-dir", str(tmp_path)])
    req = tmp_path / "FIXTOTAL000000001.json"
    # Not confirmed yet: resuming is refused.
    r = runner.invoke(app, ["evaluate", TOTAL, "--confirmed", str(req)])
    assert r.exit_code == AWAITING_CONFIRMATION
    r = runner.invoke(app, ["confirm", str(req), "--checker", "admin",
                            "--remove", "3", "--add", "roof:dent:0.4"])  # fmt: skip
    assert r.exit_code == 0, r.output
    saved = json.loads(req.read_text())
    assert saved["status"] == "confirmed" and saved["checker"] == "admin"
    assert [f["panel"] for f in saved["findings"]] == ["frame", "hood", "roof"]
    assert all(f["verified"] for f in saved["findings"])
    r = runner.invoke(app, ["evaluate", TOTAL, "--confirmed", str(req)])
    assert r.exit_code == 0, r.output
    assert "RECOMMENDATION" in r.output and "confirmed by admin" in r.output


def test_confirmed_review_must_match_vehicle(tmp_path):
    runner.invoke(app, ["evaluate", TOTAL, "--no-interactive", "--review-dir", str(tmp_path)])
    req = tmp_path / "FIXTOTAL000000001.json"
    runner.invoke(app, ["confirm", str(req), "--checker", "admin"])
    r = runner.invoke(app, ["evaluate", DENT, "--confirmed", str(req)])
    assert r.exit_code != 0


def test_interactive_checker_adds_missed_damage(tmp_path):
    keys = "+ frame dent 0.8\nu no\ne no\na\nPat\n"
    r = runner.invoke(
        app, ["evaluate", DENT, "--interactive", "--review-dir", str(tmp_path)], input=keys
    )
    assert r.exit_code == 0, r.output
    assert "confirmed by Pat" in r.output
    saved = json.loads((tmp_path / "FIXDENT0000000001.json").read_text())
    assert {f["panel"] for f in saved["findings"]} == {"door", "frame"}


def test_interactive_quit_leaves_pending(tmp_path):
    r = runner.invoke(
        app, ["evaluate", DENT, "--interactive", "--review-dir", str(tmp_path)], input="q\n"
    )
    assert r.exit_code == AWAITING_CONFIRMATION
    assert json.loads((tmp_path / "FIXDENT0000000001.json").read_text())["status"] == "pending"


def test_risky_mode_skips_quiet_vehicles(tmp_path):
    # The dent fixture has confident findings, complete inspection flags and no frame damage.
    r = runner.invoke(app, ["evaluate", DENT, "--review-mode", "risky", "--no-interactive",
                            "--review-dir", str(tmp_path)])  # fmt: skip
    assert r.exit_code == 0, r.output
    assert "no risk signals" in r.output
    # The total loss has frame damage and an undercarriage flag: still goes to a checker.
    r = runner.invoke(app, ["evaluate", TOTAL, "--review-mode", "risky", "--no-interactive",
                            "--review-dir", str(tmp_path)])  # fmt: skip
    assert r.exit_code == AWAITING_CONFIRMATION
