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
| Accuracy (picked the oracle's path) | 90.0% | 90.2% |
| Average regret per vehicle | $59 | $84 |
| Human-review rate | 4.0% | 4.0% |
| Best fixed-policy regret | $110 | $78 |

- Same model: UnderScope ($59) beats the best fixed policy, always acv_as_is ($110).
- Misspecified: UnderScope ($84) does not beat the best fixed policy, always acv_as_is ($78).

## Same model: by damage band (true repair cost / clean value)

| Band | Vehicles | Accuracy | UnderScope regret | Best fixed policy | Its regret |
|---|---|---|---|---|---|
| light (0%-15%) | 266 | 98.5% | $2 | always acv_as_is | $46 |
| mid (15%-50%) | 187 | 87.7% | $89 | always acv_as_is | $123 |
| heavy (>=50%) | 47 | 51.1% | $263 | always part_out | $346 |

## Misspecified: by damage band (true repair cost / clean value)

| Band | Vehicles | Accuracy | UnderScope regret | Best fixed policy | Its regret |
|---|---|---|---|---|---|
| light (0%-15%) | 266 | 97.4% | $16 | always acv_as_is | $18 |
| mid (15%-50%) | 187 | 88.8% | $142 | always acv_as_is | $123 |
| heavy (>=50%) | 47 | 55.3% | $231 | always acv_as_is | $242 |

## Same model

Average oracle net $7,956.

| Group | Vehicles | Accuracy | Avg regret |
|---|---|---|---|
| Flagged for review | 20 | 50.0% | $204 |
| Not flagged | 480 | 91.7% | $53 |

| Policy | Avg regret |
|---|---|
| always repair_then_acv | $1,756 |
| always acv_as_is | $110 |
| always copart_salvage | $6,999 |
| always part_out | $4,681 |
| UnderScope | $59 |

## Misspecified

Average oracle net $7,921.

| Group | Vehicles | Accuracy | Avg regret |
|---|---|---|---|
| Flagged for review | 20 | 50.0% | $352 |
| Not flagged | 480 | 91.9% | $72 |

| Policy | Avg regret |
|---|---|
| always repair_then_acv | $2,078 |
| always acv_as_is | $78 |
| always copart_salvage | $6,506 |
| always part_out | $4,979 |
| UnderScope | $84 |

Regret is in dollars (integer cents internally). Regenerate with `.venv/bin/python -m underscope.data && .venv/bin/python -m underscope.backtest`.
