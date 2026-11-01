from underscope.backtest import run_backtest
from underscope.data import generate_synthetic


def test_backtest_metrics_sane():
    res = run_backtest(generate_synthetic(40, seed=11))
    assert 0 <= res["accuracy"] <= 1 and 0 <= res["review_rate"] <= 1
    assert res["avg_regret_cents"] >= 0
    assert res["flagged"]["n"] + res["unflagged"]["n"] == 40
    # Engine should not be worse than the worst fixed policy.
    assert res["avg_regret_cents"] <= max(res["baseline_avg_regret_cents"].values())


def test_report_has_both_truths(tmp_path):
    from underscope.backtest import write_report

    res = run_backtest(generate_synthetic(10, seed=2))
    text = write_report(res, res, tmp_path / "b.md").read_text()
    assert "Same model" in text and "Misspecified" in text


def test_damage_bands_partition_and_have_baselines():
    res = run_backtest(generate_synthetic(60, seed=4))
    bands = res["bands"]
    assert list(bands) == ["light", "mid", "heavy"]
    assert sum(b["n"] for b in bands.values()) == 60
    assert sum(b["regret"] for b in bands.values()) == round(res["avg_regret_cents"] * 60)
    for b in bands.values():
        assert set(b["baselines"]) == set(res["baseline_avg_regret_cents"])
