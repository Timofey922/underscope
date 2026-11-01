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
| Accuracy (picked the oracle's path) | 90.4% | 90.2% |
| Average regret per vehicle | $57 | $80 |
| Human-review rate | 6.0% | 6.0% |
| Best fixed-policy regret | $110 | $76 |

- Same model: UnderScope ($57) beats the best fixed policy, always acv_as_is ($110).
- Misspecified: UnderScope ($80) does not beat the best fixed policy, always acv_as_is ($76).
- Same model, the 94% of vehicles not flagged for review: UnderScope ($39) beats always acv_as_is ($84) on the same vehicles.
- Misspecified, the 94% of vehicles not flagged for review: UnderScope ($55) beats always acv_as_is ($57) on the same vehicles.

## Same model: by damage band (true repair cost / clean value)

| Band | Vehicles | Accuracy | UnderScope regret | Best fixed policy | Its regret |
|---|---|---|---|---|---|
| light (0%-15%) | 266 | 98.5% | $2 | always acv_as_is | $47 |
| mid (15%-50%) | 187 | 88.8% | $85 | always acv_as_is | $122 |
| heavy (>=50%) | 47 | 51.1% | $258 | always part_out | $344 |

## Misspecified: by damage band (true repair cost / clean value)

| Band | Vehicles | Accuracy | UnderScope regret | Best fixed policy | Its regret |
|---|---|---|---|---|---|
| light (0%-15%) | 266 | 97.4% | $12 | always acv_as_is | $15 |
| mid (15%-50%) | 187 | 88.8% | $140 | always acv_as_is | $123 |
| heavy (>=50%) | 47 | 55.3% | $225 | always acv_as_is | $236 |

## Same model

Average oracle net $7,957.

| Group | Vehicles | Accuracy | Avg regret |
|---|---|---|---|
| Flagged for review | 30 | 46.7% | $348 |
| Not flagged | 470 | 93.2% | $39 |

| Policy | Avg regret |
|---|---|
| always repair_then_acv | $1,755 |
| always acv_as_is | $110 |
| always copart_salvage | $7,000 |
| always part_out | $4,682 |
| UnderScope | $57 |

## Misspecified

Average oracle net $7,920.

| Group | Vehicles | Accuracy | Avg regret |
|---|---|---|---|
| Flagged for review | 30 | 43.3% | $472 |
| Not flagged | 470 | 93.2% | $55 |

| Policy | Avg regret |
|---|---|
| always repair_then_acv | $2,075 |
| always acv_as_is | $76 |
| always copart_salvage | $6,506 |
| always part_out | $4,979 |
| UnderScope | $80 |

Regret is in dollars (integer cents internally). Regenerate with `.venv/bin/python -m underscope.data && .venv/bin/python -m underscope.backtest`.
