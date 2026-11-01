import pytest

from underscope.data import ACVSource, CopartSource, FixtureSource, generate_synthetic


def test_fixtures_load():
    src = FixtureSource()
    vins = src.list_vins()
    assert "FIXDENT0000000001" in vins
    assert src.get_vehicle(vins[0]).vin == vins[0]


def test_stubs_raise_and_list_fields():
    for cls in (ACVSource, CopartSource):
        assert "vin" in cls.REQUIRED_FIELDS
        with pytest.raises(NotImplementedError):
            cls().get_vehicle("x")


def test_synthetic_seeded_and_labeled():
    a = generate_synthetic(25, seed=3)
    assert a == generate_synthetic(25, seed=3)
    assert all(r["synthetic"] for r in a)
    r = a[0]
    assert r["truth"]["best_path"] in r["truth"]["realized_net_cents"]
    assert all(isinstance(v, int) for v in r["truth"]["realized_net_cents"].values())
