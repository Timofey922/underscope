import pytest

from underscope.detector_eval import (
    load_findings,
    match,
    render_report,
    run_detector,
    save_findings,
    score,
)
from underscope.models import DamageFinding


def f(panel="door", t="dent", sev=0.4, conf=0.9):
    return DamageFinding(panel=panel, damage_type=t, severity=sev, confidence=conf)


def test_match_prefers_same_type_and_is_one_to_one():
    truth = [f("door", "scratch"), f("door", "dent")]
    pred = [f("door", "dent", conf=0.9), f("door", "dent", conf=0.5), f("hood")]
    pairs, missed, false_alarms = match(truth, pred)
    assert [(t.damage_type.value, p.confidence) for t, p in pairs] == [
        ("dent", 0.9), ("scratch", 0.5)]
    assert missed == [] and [p.panel.value for p in false_alarms] == ["hood"]


def test_perfect_detector_scores_perfectly():
    truth = {"a.jpg": [f(), f("frame", "crush", 0.8)], "clean.jpg": []}
    s = score(truth, truth)
    assert (s.precision, s.recall, s.f1, s.type_accuracy) == (1.0, 1.0, 1.0, 1.0)
    assert s.severity_mae == 0 and s.frame_missed == 0 and s.clean_correct == 1


def test_misses_false_alarms_severity_and_calibration():
    truth = {"a.jpg": [f("door", "dent", 0.4), f("frame", "crush", 0.8)], "b.jpg": []}
    pred = {"a.jpg": [f("door", "scratch", 0.6, conf=0.95)], "b.jpg": [f("hood", conf=0.3)]}
    s = score(truth, pred)
    assert (s.true_findings, s.predicted, s.matched) == (2, 2, 1)
    assert s.precision == 0.5 and s.recall == 0.5
    assert s.type_accuracy == 0.0 and s.severity_mae == pytest.approx(0.2)
    assert s.frame_missed == 1 and s.clean_correct == 0
    assert s.brier == pytest.approx(((0.95 - 1) ** 2 + 0.3**2) / 2)
    assert s.calibration[0] == [1, 0] and s.calibration[3] == [1, 1]


def test_failed_photos_are_left_out():
    truth = {"a.jpg": [f()], "b.jpg": [f()]}
    s = score(truth, {"a.jpg": [f()]}, errors={"b.jpg": "declined"})
    assert s.photos == 1 and s.recall == 1.0 and "declined" in render_report(s)


def test_roundtrip_and_run_detector(tmp_path):
    truth = {"a.jpg": [f()], "b.jpg": []}
    path = save_findings(truth, tmp_path / "x.json")
    assert load_findings(path) == truth

    class Flaky:
        def detect_photo(self, ref):
            if ref == "b.jpg":
                raise RuntimeError("blurry")
            return truth[ref]

    pred, errors = run_detector(Flaky(), ["a.jpg", "b.jpg"])
    assert pred == {"a.jpg": truth["a.jpg"]} and errors == {"b.jpg": "blurry"}
    report = render_report(score(truth, pred, errors))
    assert "Panel recall" in report and "blurry" in report
