# Backtest vs oracle (SYNTHETIC data)

**Read this first:** the 500 vehicles and their 'true' outcomes are synthetic and are
drawn from the same PLACEHOLDER model the engine uses. The engine sees noisy findings
(severity noise, 5% missed findings, imperfect confidence); the oracle sees the true
findings and one realized outcome per path. These numbers show decision quality under
perception noise and outcome variance, not accuracy on real auction data.

Vehicles: 500. Oracle = best realized net per vehicle (average $8,728).

| Metric | Value |
|---|---|
| Accuracy (picked the oracle's path) | 85.6% |
| Average regret (oracle net - chosen net) | $114 per vehicle |
| Human-review rate | 7.2% |

## By review flag

| Group | Vehicles | Accuracy | Avg regret |
|---|---|---|---|
| Flagged for review | 36 | 55.6% | $324 |
| Not flagged | 464 | 87.9% | $98 |

## Baselines: always pick one path (average regret)

| Policy | Avg regret |
|---|---|
| always repair_then_acv | $539 |
| always acv_as_is | $1,608 |
| always copart_salvage | $6,587 |
| always part_out | $4,889 |
| UnderScope | $114 |

Regret is in dollars (integer cents internally). Regenerate with `.venv/bin/python -m underscope.backtest`.
