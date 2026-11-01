from underscope.config import default_assumptions
from underscope.models import DamageFinding, TitleStatus, VehicleRecord
from underscope.valuation import clean_value, value_vehicle


def veh(**kw):
    base = dict(
        vin="V",
        year=2022,
        make="X",
        model="Y",
        mileage=30000,
        region="NY",
        clean_value_cents=2_000_000,
    )
    return VehicleRecord(**{**base, **kw})


def f(panel="door", t="dent", sev=0.5, conf=1.0):
    return DamageFinding(panel=panel, damage_type=t, severity=sev, confidence=conf)


def test_no_damage():
    v = value_vehicle(veh(), [])
    assert v.repair_cost == (0, 0, 0)
    assert v.as_is_value == v.clean_value
    assert v.title_after_repair == TitleStatus.CLEAN


def test_repair_cost_monotone_in_severity_and_ordered():
    lo = value_vehicle(veh(), [f(sev=0.1)]).repair_cost
    hi = value_vehicle(veh(), [f(sev=0.9)]).repair_cost
    assert lo.expected < hi.expected
    assert hi.low <= hi.expected <= hi.high


def test_as_is_below_clean_and_salvage_below_as_is():
    v = value_vehicle(veh(), [f(sev=0.6)])
    assert v.salvage_value.expected < v.as_is_value < v.clean_value


def test_total_loss_brands_repaired_title():
    v = value_vehicle(veh(clean_value_cents=1_000_000), [f("frame", "crush", 1.0)])
    assert v.repair_ratio >= v.total_loss_threshold
    assert v.title_after_repair == TitleStatus.REBUILT


def test_salvage_title_repairs_to_rebuilt_and_ints():
    v = value_vehicle(veh(title_status="salvage"), [f()])
    assert v.title_after_repair == TitleStatus.REBUILT
    assert isinstance(v.as_is_value, int) and isinstance(v.repair_cost.expected, int)


def test_clean_value_depreciates():
    a = default_assumptions()
    new = clean_value(veh(clean_value_cents=None, year=2026, mileage=0), a)
    old = clean_value(veh(clean_value_cents=None, year=2016, mileage=0), a)
    assert old < new


def test_more_damage_never_raises_parts_value():
    light = value_vehicle(veh(), [f("door", "dent", 0.2)]).parts_gross_value
    heavy = value_vehicle(
        veh(), [f("frame", "crush", 1.0), f("hood", "crush", 0.9)]
    ).parts_gross_value
    none = value_vehicle(veh(), []).parts_gross_value
    assert heavy.expected < light.expected <= none.expected
    assert heavy.low <= heavy.expected <= heavy.high


def test_as_is_never_below_salvage():
    # A buyer can always send the car to salvage, so as-is can't price below it.
    for findings in ([f(sev=0.6)], [f("frame", "crush", 0.4), f()], [f("frame", "crush", 1.0)]):
        for title in ("clean", "salvage", "rebuilt"):
            v = value_vehicle(veh(clean_value_cents=1_800_000, title_status=title), findings)
            assert v.as_is_value >= v.salvage_value.expected
