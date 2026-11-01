from underscope.backtest import run_backtest
from underscope.data import generate_synthetic


def test_backtest_metrics_sane():
    res = run_backtest(generate_synthetic(40, seed=11))
    assert 0 <= res["accuracy"] <= 1 and 0 <= res["review_rate"] <= 1
    assert res["avg_regret_cents"] >= 0
    assert res["flagged"]["n"] + res["unflagged"]["n"] == 40
    # Engine should not be worse than the worst fixed policy.
    assert res["avg_regret_cents"] <= max(res["baseline_avg_regret_cents"].values())
