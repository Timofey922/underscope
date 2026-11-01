# UnderScope

A decision engine for damaged vehicles. Given damage findings (eventually from ACV inspection
images) plus vehicle data, it estimates net proceeds for each disposition path and recommends
the one with the highest expected margin:

1. Repair, then sell on ACV Auctions
2. Sell as-is on ACV Auctions
3. Sell as salvage on Copart
4. Part out the vehicle

**Status:** development prototype. Every number comes from `config/assumptions.yaml`, all
labeled PLACEHOLDER. ACV and Copart adapters are stubs; there is no network access. Synthetic
data is clearly labeled. Nothing here is real market data.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
make test   # pytest -q
make lint   # ruff
```

## Usage

```bash
.venv/bin/underscope evaluate data/fixtures/dent_600.json          # readable output
.venv/bin/underscope evaluate data/fixtures/total_loss.json --json # machine-readable
.venv/bin/underscope evaluate vehicle.json --labels labels.json    # MockDetector labels per photo ref

.venv/bin/python -m underscope.data          # regenerate data/synthetic/ (500 vehicles, seed 7)
.venv/bin/python -m underscope.backtest      # -> reports/backtest.md
.venv/bin/python -m underscope.case_studies  # -> reports/case_studies.md
```

Vehicle JSON fields: `vin, year, make, model, trim, mileage, region, title_status, photo_refs,
undercarriage_damage, engine_audio_abnormal`, optional `clean_value_cents`, and optional inline
`findings` (`panel, damage_type, severity 0-1, confidence 0-1`).

## How it works

```mermaid
flowchart LR
    IMG[Photos / inspection data] --> DET[DamageDetector<br/>MockDetector today]
    DET --> F[DamageFinding list]
    V[VehicleRecord] --> VAL
    F --> VAL[Valuation<br/>as-is, repaired, salvage,<br/>parts, repair cost range]
    CFG[(config/assumptions.yaml<br/>PLACEHOLDER)] --> VAL
    CFG --> SIM
    VAL --> SIM[Monte Carlo, 1,000 seeded draws<br/>net proceeds per path]
    SIM --> RANK[Rank by expected margin<br/>P10 / P50 / P90]
    RANK --> REC[Recommendation<br/>review flag, total-loss flag,<br/>explanation, what would flip it]
    REC --> CLI[CLI]
```

Notes:
- Money is integer cents in the decision layer.
- `needs_human_review` is set when the top two paths overlap heavily, when finding confidence
  is low, or when the total-loss threshold decides the outcome.
- Results are deterministic for a given seed (`simulation.seed`).

## Results (synthetic only)

See `reports/backtest.md` (accuracy, regret vs oracle, review rate) and
`reports/case_studies.md`. The synthetic truth shares the engine's placeholder model, so these
show behavior under noise, not real-world accuracy. Data we would need from ACV and Copart:
`docs/DATA_REQUIREMENTS.md`.
