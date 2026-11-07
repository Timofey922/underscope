# Underscope

**Fix it and sell, or sell it as-is?** Underscope looks at photos of a damaged vehicle, plus its VIN and OBD-II trouble codes. It compares the likely net from repairing and selling against the likely net from selling as-is, and tells you which one probably pays more. When the two are too close to call, it says so and names the one check that would settle it.

Built for UB Hacking as a demo for ACV, which is now part of Copart.

## How it works

```
photos + VIN + fault codes
        │
        ├─ vision/    Claude grades 25 parts: fine / repairable / replace / unknown
        │             and flags hidden risks (airbags, frame, fluid leaks)
        ├─ codes/     decode DTCs (generic table, or Claude + NHTSA vPIC for
        │             manufacturer codes) → system, severity, cost band, triage
        └─ decision/  repair band (parts + labor, widened for unknowns)
                      as-is band (comparable salvage sales)
                      1,000 Monte Carlo draws → P(fix wins)
                          > 70%  → fix
                          < 30%  → sell as-is
                          else   → too close to call + what to check
```

Every result is a range, never a single price. Photos can't show frame, mechanical or flood damage, so the model marks those `unknown` instead of guessing, and unknowns widen the repair band.

**Scope:** full-size pickups and cargo vans only.

The front end is a Lovable app. The seller uploads photos and a VIN, then sees a grid of parts with their grades, the two net bands, and the recommendation. A reviewer can change any grade and the numbers recompute live.

## Repo layout

| Folder | What's in it |
|---|---|
| `vision/` | Claude vision call, part grading, JSON validation |
| `codes/` | OBD-II fault code decoding and triage |
| `decision/` | Repair band, as-is band, Monte Carlo recommendation |
| `data/` | CSV lookup tables: DTC descriptions, DTC costs, repair costs, comps |
| `test_vehicles/` | 20 test vehicles (photos only, gitignored) |

## Setup

Requires Python 3.10+.

```powershell
python -m venv venv
venv\Scripts\Activate.ps1          # macOS/Linux: source venv/bin/activate
pip install -r requirements.txt
copy .env.example .env             # then put your key in ANTHROPIC_API_KEY
```

The API key is read from the `ANTHROPIC_API_KEY` environment variable. Keep it out of the code and the front end.

## Testing

We run all 20 test vehicles and compare the model's grade with our own grade for each part. We report the agreement rate and the **expensive misses**: parts the model called `fine` that actually need `replace`.

Known limitation: the vision model is good at broken glass, missing bumpers and flat tires, but weak on dents and scratches. Demo vehicles are chosen so the decision rests on obvious damage.

## Beyond the hackathon

This demo is the first slice of a larger **channel-routing engine**. For each scanned vehicle, the engine would rank every channel it could go to: ACV dealer wholesale, the Copart salvage lanes, recyclers, or a direct buyer. Each channel gets a P10/P50/P90 net band, days to cash, dispute risk and the buyer segment most likely to pay. The plan builds it on proxy data first, adds a published data contract so Copart/ACV data can plug in later, and evaluates it with a backtest harness. It runs in three 30-day phases: mechanism, then evidence, then a shadow-mode pilot. The research plan and build plan documents have the details.

Not in this demo: fine-tuning, scraping, a database, logins, payments, or any Copart/ACV integration.
