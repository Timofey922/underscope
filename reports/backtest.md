# Backtest vs oracle (SYNTHETIC data)

**Read this first:** the vehicles and their 'true' outcomes are synthetic. The engine
sees noisy findings (severity noise, 5% missed findings, imperfect confidence); the
oracle sees the true findings and one realized outcome per path. Two truths:

- **Same model:** outcomes drawn from the engine's own placeholder model. This only
  measures perception noise and outcome variance; it is circular by construction.
- **Misspecified:** outcomes drawn from a perturbed world where every placeholder is
  off by up to 25% and market noise is 1.5x wider (`data.perturbed`). The gap between
  the two columns shows how much results lean on the engine's own assumptions.

Neither is accuracy on real auction data.

Vehicles: 500. Oracle = best realized net per vehicle.

| Metric | Same model | Misspecified |
|---|---|---|
| Accuracy (picked the oracle's path) | 90.0% | 91.4% |
| Average regret per vehicle | $61 | $80 |
| Human-review rate | 3.2% | 3.2% |
| Best fixed-policy regret | $101 | $76 |

- Same model: UnderScope ($61) beats the best fixed policy, always acv_as_is ($101).
- Misspecified: UnderScope ($80) does not beat the best fixed policy, always acv_as_is ($76).

## Same model

Average oracle net $7,946.

| Group | Vehicles | Accuracy | Avg regret |
|---|---|---|---|
| Flagged for review | 16 | 37.5% | $491 |
| Not flagged | 484 | 91.7% | $47 |

| Policy | Avg regret |
|---|---|
| always repair_then_acv | $2,075 |
| always acv_as_is | $101 |
| always copart_salvage | $6,989 |
| always part_out | $4,671 |
| UnderScope | $61 |

## Misspecified

Average oracle net $7,918.

| Group | Vehicles | Accuracy | Avg regret |
|---|---|---|---|
| Flagged for review | 16 | 50.0% | $715 |
| Not flagged | 484 | 92.8% | $59 |

| Policy | Avg regret |
|---|---|
| always repair_then_acv | $2,407 |
| always acv_as_is | $76 |
| always copart_salvage | $6,504 |
| always part_out | $4,977 |
| UnderScope | $80 |

Regret is in dollars (integer cents internally). Regenerate with `.venv/bin/python -m underscope.data && .venv/bin/python -m underscope.backtest`.
