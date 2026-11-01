import pytest

from underscope import review
from underscope.models import DamageFinding, Panel, VehicleRecord


def veh(**kw):
    base = dict(vin="V1", year=2021, make="X", model="Y", mileage=1000, region="NY",
                clean_value_cents=2_000_000, undercarriage_damage=False,
                engine_audio_abnormal=False)  # fmt: skip
    return VehicleRecord(**{**base, **kw})


def f(panel="door", sev=0.4, conf=0.9):
    return DamageFinding(panel=panel, damage_type="dent", severity=sev, confidence=conf)


def test_lists_every_area_and_marks_frame_to_verify():
    req = review.build_request(veh(), [f()])
    areas = {a.name: a.status for a in req.areas()}
    assert set(areas) == {p.value for p in Panel} | {"undercarriage", "engine"}
    assert areas["door"] == review.AreaStatus.DAMAGED
    assert areas["frame"] == review.AreaStatus.VERIFY
    assert areas["hood"] == review.AreaStatus.CLEAR


def test_missing_inspection_flags_need_verifying_and_are_risky():
    req = review.build_request(veh(undercarriage_damage=None), [f()])
    areas = {a.name: a.status for a in req.areas()}
    assert areas["undercarriage"] == review.AreaStatus.VERIFY
    assert any("inspection" in r for r in req.reasons)
    assert review.needs_confirmation(review.ReviewMode.RISKY, req.reasons)


def test_quiet_vehicle_only_skipped_in_risky_mode():
    req = review.build_request(veh(), [f(conf=0.95)])
    assert req.reasons == []
    assert review.needs_confirmation(review.ReviewMode.ALL, req.reasons)
    assert not review.needs_confirmation(review.ReviewMode.RISKY, req.reasons)


def test_no_findings_is_a_risk_signal():
    assert any("No damage" in r for r in review.risk_reasons(veh(), []))


def test_confirm_verifies_everything_and_needs_a_name():
    req = review.build_request(veh(), [f(conf=0.5)])
    with pytest.raises(ValueError):
        review.confirm(req, "  ")
    review.add_finding(req, "frame", "crush", 0.7)
    review.set_severity(req, 1, 0.6)
    review.confirm(req, "admin")
    assert req.status == "confirmed" and req.confirmed_at
    assert all(x.verified and x.confidence == 1.0 for x in req.findings)
    assert [x.severity for x in req.findings] == [0.6, 0.7]
    # Once confirmed, an undamaged frame is clear rather than "verify".
    assert {a.name: a.status for a in req.areas()}["frame"] == review.AreaStatus.DAMAGED


def test_bad_edits_rejected():
    req = review.build_request(veh(), [f()])
    with pytest.raises(ValueError):
        review.remove_finding(req, 2)
    with pytest.raises(ValueError):
        review.add_finding(req, "wing", "dent", 0.3)


def test_save_load_roundtrip_and_html_escapes(tmp_path):
    req = review.build_request(veh(make="<script>x</script>"), [f()])
    json_path, html_path = review.save(req, tmp_path)
    assert review.load(json_path) == req
    page = html_path.read_text()
    assert "<script>x" not in page and "&lt;script&gt;" in page
    assert page.count('class="area') == 9  # frame + 8 body panels drawn
