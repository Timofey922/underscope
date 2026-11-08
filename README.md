# Underscope

**Where should this damaged car go?** Underscope reads a damaged vehicle's VIN, photos and OBD-II trouble codes, prices the damage, and compares four exits: repair it and resell on ACV, sell it as-is on ACV, sell it as salvage on Copart, or part it out. It says which one likely nets the most, and whether repairing or selling as-is pays more. Every answer is a range, never a single price. When two options are too close to call, it says so and names the one check that would settle it.

Built for UB Hacking as a demo for ACV, which is now part of Copart. Independent project, not affiliated with ACV or Copart.

## Live demo

**https://underscope-eight.vercel.app**

- Enter a VIN: it decodes to year, make, model and trim right away (NHTSA vPIC). Verified vehicles in the registry fill in their title and market values.
- Add photos and trouble codes, and the clean wholesale value. For a VIN that isn't in the registry, add 3+ sold prices from similar salvage lots; when the registry has the same make and model within 3 model years, those are filled in and labeled "estimated from similar vehicles".
- The result: where to send the car, all exits with their net ranges, repair vs sell as-is, an ACV vs Copart points check, and the part grades and fault codes behind it. Click any part grade or damage flag to change it; everything recomputes live.
- Without enough market data it shows the decoded vehicle, photo grades and codes, and says what's missing. It never makes up prices.
- Every push to `main` deploys automatically.

## How it works

```
VIN + photos + fault codes + market values
        │
        ├─ VIN        NHTSA vPIC decode (cached in Supabase)
        ├─ vision     OpenAI grades 25 parts: fine / repairable / replace / unknown,
        │             flags hidden risks (airbags, frame, fluid leaks)
        ├─ parts      replaced parts priced from eBay listings for this vehicle, else a table
        ├─ codes      DTC meaning (Supabase table or OpenAI), priced by OpenAI for this
        │             vehicle, shared repairs counted once, real shop quotes win
        ├─ decision   repair band (parts + labor, widened for unknowns) vs as-is band
        │             (sold salvage comps), 1,000 draws → fix / sell as-is / too close
        └─ engine     four exits (repair + ACV, ACV as-is, Copart salvage, part out),
                      P10/P50/P90 net each → where to send it
```

Photos can't show frame, mechanical or flood damage, so the model marks those `unknown` instead of guessing, and unknowns widen the repair band.

**Scope:** all passenger vehicles (cars, SUVs, pickups, vans).

## APIs

All CORS-open, so the Lovable app (or anything else) can call them.

| Endpoint | What it does |
|---|---|
| `POST /api/decode-vin` `{ vin }` | Year, make, model, trim, body, engine, drive from NHTSA vPIC |
| `GET /api/vehicle?vin=` | Verified title and market values from the registry; comps from similar vehicles otherwise |
| `POST /api/classify-photos` | Photo views and close-up boxes (cheap model) |
| `POST /api/grade-photos` `{ vin, photos }` | 25 part grades, problems, flags, photo gaps |
| `POST /api/decode-codes` `{ vin, codes, title_status? }` | Code meanings and prices for this vehicle, triage |
| `POST /api/decide` | Repair band, both net ranges, P(fix wins), verdict, ACV vs Copart points |
| `POST /api/route` | The engine: all exits with net ranges and the destination |
| `POST /api/market-fit` | Public dealer listings of the model in a state (off without a Firecrawl key) |

## Repo layout

| Folder | What's in it |
|---|---|
| `api/` | Vercel functions (TypeScript, plus `route.py` for the engine). Shared logic in `api/_lib/` |
| `public/` | The demo page (`index.html`, `app.js`, `app.css`) and `demo_vehicles.json` (made-up test fixtures) |
| `scripts/` | Seed and test scripts |
| `supabase/migrations/` | Postgres schema with row level security: `dtc_codes`, `scans`, `vehicles` (registry), `vin_cache` |
| `data/` | `dtc_codes.csv` (60 generic OBD-II codes), `repair_costs.csv`, `test_scans.json` (10 demo scans) |
| `test_vehicles/` | Test vehicles (photos only, gitignored) |
| `engine/` | Artem's Python engine: routing decision, damage detector, evaluation harness, calibration. See `engine/README.md`. Tests: `cd engine && make test` (242 passing) |

**Stack:** plain HTML/JS page on Vercel (a Lovable app can call the same APIs), Vercel functions in `api/`, OpenAI at request time for photos and fault codes (no model training), Supabase (Postgres), NHTSA vPIC, eBay Browse API for parts prices.

## Setup

Requires Node 20+ (and Python 3.11+ for the engine).

```powershell
npm install
copy .env.example .env             # then fill in the values
npm run seed:codes                 # load data/dtc_codes.csv into Supabase
npm run seed:vehicles              # load verified VINs from data/vehicles.local.json (gitignored)
npm run dev                        # local server: page + api/*.ts
npm run typecheck
npm run test:vin                   # VIN decoder: pickup, cargo van, bad format, typo
npm run test:codes                 # the 10 demo scans
npm run test:decision              # sample vehicles get their expected verdict
npm run test:scorecard             # ACV vs Copart points cases
```

Keys are read only from environment variables: `.env` locally, Vercel project settings in production. Server-only: `OPENAI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `FIRECRAWL_API_KEY`. The front end only gets `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

## Testing accuracy

Photos: label each test vehicle by hand without looking at the model's answer (`npm run score:photos -- --template`), grade them (`npm run test:photos`), then `npm run score:photos` reports parts right, recall, precision, wrong side and **expensive misses** (model says `fine`, truth is `replace`). Last hand-checked run on 24 Copart lots with gpt-5.5: about 92% parts right, 82% recall, 89% precision, 0 wrong side.

Known limitation: the vision model is good at broken glass, missing bumpers and flat tires, but weak on dents and scratches.

## Beyond the hackathon

This demo is the first slice of a larger **channel-routing engine**: for each vehicle, rank every channel it could go to (ACV dealer wholesale, the Copart salvage lanes, recyclers, a direct buyer), each with a P10/P50/P90 net band, days to cash, dispute risk and the likely buyer. The plan builds it on proxy data first, adds a published data contract so Copart/ACV data can plug in later, and evaluates it with a backtest harness, in three 30-day phases: mechanism, evidence, then a shadow-mode pilot.

Not in this demo: fine-tuning, dataset downloads, scraping (market fit runs one search of public listings, never auction sites), logins, payments, VIN data beyond the free NHTSA decode, or any Copart/ACV integration.
