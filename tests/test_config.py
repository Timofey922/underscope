import pytest

from underscope.config import Assumptions, default_assumptions


def test_loads_and_labeled():
    a = default_assumptions()
    assert a.total_loss_threshold_pct("NY") == 75
    assert a.total_loss_threshold_pct("ZZ") == a["total_loss"]["default_threshold_pct"]


def test_ranges_ordered():
    a = default_assumptions()
    for rng in a["repair_cost"]["panel_base_cents"].values():
        assert rng[0] <= rng[1] <= rng[2]
    for key in ("acv_cents", "copart_cents", "parts_cents"):
        r = a["transport"][key]
        assert r == sorted(r)


def test_rejects_unlabeled():
    data = dict(default_assumptions().data)
    data["fees"] = {"acv": {}, "replace_with": "x"}
    with pytest.raises(ValueError):
        Assumptions(data)
