# ACV vs Copart scorecard

A points scorecard that says where a damaged car most likely sells best: **ACV** (dealer wholesale) or **Copart** (salvage buyers).

Each finding adds points to the channel it favors. The higher total wins. If the totals are within 5 points, the answer is **too close to call**.

It sits next to the other two answers on the page; it doesn't replace them:
- **Fix it or sell it as-is**: `/api/decide`, two dollar ranges.
- **Where to send it**: `/api/route`, Artem's engine, four exits ranked by simulated net proceeds.

The scorecard is the quick, readable version: every point comes with a reason.

- Logic: `api/_lib/scorecard.ts` (`scoreChannels()`). Pure, no AI, no network.
- Returned by `POST /api/decide` as `channel`, so it reruns on every reviewer edit.
- Market fit data: `POST /api/market-fit` (Firecrawl search of public listings).
- Every point value is a placeholder in `SCORECARD_CONFIG` at the top of `scorecard.ts`.

## The five categories

| Category | Finding | ACV | Copart |
|---|---|---|---|
| **Title** | clean | +10 | |
| | rebuilt | +3 | +5 |
| | salvage | | +10 |
| | flood | | +20 |
| | lemon | +3 | +3 |
| | non-repairable | | forces Copart |
| | not sure | 0 (listed as not scored) | |
| **Drivable and condition** | drives (seller says yes) | +8 | |
| | doesn't drive | | +8 |
| | light damage: 0 replace, ≤2 repairable | +6 | |
| | moderate: ≤2 replace, ≤6 damaged parts | +2 | |
| | heavy: anything more | | +6 |
| | airbags deployed | | +5 |
| **Repair cost vs value** (repair band midpoint ÷ clean wholesale) | under 25% | +10 | |
| | 25–50% | +4 | |
| | 50–75% | | +5 |
| | 75% or more | | +10 |
| | top of repair band > value after repair | | +15 |
| **Hidden risks** | frame suspected | | +6 |
| | can't tell about the frame | | +2 |
| | can't tell if airbags deployed | | +2 |
| | fluid leak | | +3 |
| | flood or fire suspected | | +8 |
| | each critical fault code | | +3 |
| | 5+ parts not visible | | +2 |
| **Market fit** | 5+ public listings of this year/make/model in the state | +6 | |
| | 1–4 listings | +2 | |
| | no listings: no local dealer market | | +6 |
| | over 15 years old or over 200,000 miles | | +4 |

Condition is counted from the part grades, so a reviewer changing a grade changes the points.

Anything that can't be scored scores 0 and is listed in `missing`: no title, "not sure" on drivable, no clean value, no state, or a failed listing search.

## Inputs

| Input | From |
|---|---|
| Title | the Title buttons, or the registry |
| Drivable | **Does it drive?** on the page (Yes / No / Not sure); seller only, photos can't tell |
| State | **State** dropdown on the page (optional) |
| Part grades, flags | photo grading, plus reviewer edits |
| Fault codes | `/api/decode-codes` |
| Repair band, value after repair | `/api/decide` (`data/repair_costs.csv`) |
| Clean wholesale | the page, or the registry |
| Listings, age, mileage | `/api/market-fit`; mileage is the odometer read from the photos |

## Market fit: `POST /api/market-fit`

```json
{ "vin": "17 chars", "state": "NY", "mileage": 84000 }
```

1. Decodes the VIN with NHTSA vPIC (`decodeVin()` in `api/decode-codes.ts`).
2. Runs one Firecrawl search: `"<year> <make> <model> used for sale <State>"`.
3. Counts results whose title or snippet names the make and model, and collects `$` prices from the snippets.

ACV, Copart and IAAI sites are excluded from the query and dropped from the results. The search covers **public listings only**, never auction platforms' data. Results are cached per model and state for an hour on a warm function.

```json
{
  "ran": "boolean",
  "vehicle": { "year": "string | null", "make": "string | null", "model": "string | null" },
  "state": "string | null",
  "query": "string | null",
  "listings": "int",
  "price_low": "int | null",
  "price_high": "int | null",
  "sample": [{ "title": "string", "url": "string" }],
  "age_years": "int | null",
  "mileage": "int | null",
  "source": "firecrawl",
  "error": "string (only when ran is false)"
}
```

Without `FIRECRAWL_API_KEY`, without a state, or if the VIN won't decode, it answers `ran: false` with an `error`, and market fit scores 0. The key lives only in `.env` and Vercel settings.

## Output: `channel` in `/api/decide` (also `channel_scorecard` in Download JSON)

```json
{
  "winner": "acv | copart | too_close",
  "acv": "int",
  "copart": "int",
  "margin": "int",
  "forced": "string | null (set for non-repairable titles)",
  "categories": [{
    "key": "title | condition | repair_vs_value | hidden_risks | market_fit",
    "label": "string",
    "acv": "int",
    "copart": "int",
    "rows": [{ "finding": "string", "acv": "int", "copart": "int", "reason": "string" }]
  }],
  "missing": ["string"]
}
```

Download JSON also has `drivable` (`"yes" | "no" | "unknown"`) and `market_fit` (the `/api/market-fit` response).

## Test

```bash
npm run test:scorecard
```

Seven hand-made cases, one for each kind of answer: a clean car that drives, salvage with heavy damage, repair costing more than the car, flood, non-repairable, a close call, and no market search.
