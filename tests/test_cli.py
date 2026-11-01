import json

from typer.testing import CliRunner

from underscope.cli import app
from underscope.data import FIXTURE_DIR

runner = CliRunner()


def test_text_output():
    r = runner.invoke(app, ["evaluate", str(FIXTURE_DIR / "dent_600.json")])
    assert r.exit_code == 0, r.output
    assert "RECOMMENDATION" in r.output and "PLACEHOLDER" in r.output


def test_json_output():
    r = runner.invoke(app, ["evaluate", str(FIXTURE_DIR / "total_loss.json"), "--json"])
    assert r.exit_code == 0
    assert json.loads(r.output)["winner"] in {
        "repair_then_acv", "acv_as_is", "copart_salvage", "part_out"
    }  # fmt: skip
