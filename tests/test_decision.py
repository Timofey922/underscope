import copy

import numpy as np

from underscope.config import Assumptions, default_assumptions
from underscope.decision import PATHS, evaluate, simulate
from underscope.models import DamageFinding, Path, VehicleRecord
from underscope.valuation import value_vehicle


def veh(**kw):
    base = dict(
        vin="V",
        year=2022,
        make="X",
        model="Y",
        mileage=30000,
        region="NY",
        clean_value_cents=2_500_000,
        undercarriage_damage=False,
        engine_audio_abnormal=False,
    )
    return VehicleRecord(**{**base, **kw})  # fmt: skip


def f(panel="door", t="dent", sev=0.3, conf=0.95):
    return DamageFinding(panel=panel, damage_type=t, severity=sev, confidence=conf)


def test_small_dent_repairs():
    r = evaluate(veh(), [f(sev=0.5)])  # ~$690 door dent
    assert r.winner == Path.REPAIR_THEN_ACV
    assert not r.total_loss_decides


def test_severe_damage_goes_to_salvage_or_parts():
    v = veh(clean_value_cents=1_200_000)
    r = evaluate(v, [f("frame", "crush", 1.0), f("roof", "crush", 0.9)])
    assert r.winner in (Path.COPART_SALVAGE, Path.PART_OUT, Path.ACV_AS_IS)
    assert r.winner != Path.REPAIR_THEN_ACV


def test_deterministic_and_ranked():
    a = evaluate(veh(), [f()])
    b = evaluate(veh(), [f()])
    assert a == b
    exp = [o.expected_cents for o in a.options]
    assert exp == sorted(exp, reverse=True)
    assert all(o.p10_cents <= o.p50_cents <= o.p90_cents for o in a.options)


def test_money_is_int_and_components_sum_to_net():
    a = default_assumptions()
    v = veh()
    fi = [f()]
    val = value_vehicle(v, fi, a)
    sim = simulate(v, val, a)
    for p in PATHS:
        assert sim.nets[p].dtype == np.int64
        total = sum(sim.components[p].values())
        assert (total == sim.nets[p]).all()


def test_repair_cost_sign_and_asis_formula():
    a = default_assumptions()
    v = veh()
    val = value_vehicle(v, [f()], a)
    sim = simulate(v, val, a, draws=2000)
    assert (sim.components[Path.REPAIR_THEN_ACV]["repair_cost"] <= 0).all()
    assert (sim.components[Path.ACV_AS_IS]["acv_fees"] < 0).all()
    # as-is net ~ as_is_value * (1 - fee pct) - flat fee - transport mean
    c = sim.components[Path.ACV_AS_IS]
    approx = c["sale_price"].mean() * 0.98 - 25000 - 40000
    assert abs(sim.nets[Path.ACV_AS_IS].mean() - approx) < 0.05 * abs(approx) + 2000


def test_low_confidence_triggers_review():
    r = evaluate(veh(), [f(conf=0.3)])
    assert r.needs_human_review
    assert any("confidence" in x for x in r.review_reasons)


def _with(section, **kw):
    a = default_assumptions()
    data = copy.deepcopy(a.data)
    data[section].update(kw)
    return Assumptions(data)


def test_close_call_needs_review():
    # Overlap review fires exactly when P(runner-up beats winner) reaches the threshold.
    always = _with("simulation", review_overlap_threshold=0.0)
    never = _with("simulation", review_overlap_threshold=1.01)
    assert any("overlap" in x for x in evaluate(veh(), [f()], always).review_reasons)
    assert not any("overlap" in x for x in evaluate(veh(), [f()], never).review_reasons)


def test_total_loss_flag_only_near_threshold():
    r = evaluate(veh(), [f(sev=0.5)])
    assert not r.total_loss_decides


def test_explanation_and_flip_present():
    r = evaluate(veh(), [f()])
    assert "Best path" in r.explanation and r.flip_conditions


def test_holding_cost_charged_on_every_sale_path():
    a = default_assumptions()
    v = veh()
    sim = simulate(v, value_vehicle(v, [f()], a), a)
    for p in (Path.REPAIR_THEN_ACV, Path.ACV_AS_IS, Path.COPART_SALVAGE):
        assert (sim.components[p]["holding"] < 0).all()


def test_total_loss_only_decides_on_insurance_claims():
    v = veh(clean_value_cents=1_800_000)
    fi = [f("frame", "crush", 0.4, 0.9), f("door", "dent", 0.6, 0.9)]
    a = default_assumptions()
    assert simulate(v, value_vehicle(v, fi, a), a).branded_share == 0
    assert not evaluate(v, fi).total_loss_decides
