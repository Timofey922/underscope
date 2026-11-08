# ACV vs Copart scorecard

A weighted scorecard that says where a damaged car most likely sells best: **ACV** (dealer wholesale) or **Copart** (salvage buyers).

Five categories add up to **100 points**. Each finding leans from −1 (all Copart) to +1 (all ACV) and gets its share of its category:

> points = category weight × the finding's share of the category × lean

So no category can give more than its weight. The higher total wins; totals within **5 points** are **too close to call**.

It sits next to the other two answers on the page; it doesn't replace them:
- **Fix it or sell it as-is**: `/api/decide`, two dollar ranges.
- **Where to send it**: `/api/route`, Artem's engine, four exits ranked by simulated net proceeds.

- Logic: `api/_lib/scorecard.ts` (`scoreChannels()`). Pure, no AI, no network, so it reruns on every reviewer edit.
- The inputs that need judgment come from **OpenAI**, upstream:
  - drivability from the photos (`/api/grade-photos`)
  - the price of all fault codes fixed together and the non-engine modules they point to (`/api/decode-codes`)
- Every weight, share and lean is a placeholder in `SCORECARD_CONFIG` at the top of `scorecard.ts`.

## Weights

| Category | Points | What goes in |
|---|---|---|
| Title | 25 | the title brand |
| Drivability | 20 | damage location, fluids, rust, tires, brakes, glass, aftermarket modifications |
| Repair cost and uncertainty | 35 | repair estimate vs value, fault codes priced together, non-engine modules (airbag/SRS, ABS, …) |
| Unknown flags | 10 | what nobody could check |
| Market fit | 10 | public listings in the state, age and mileage (unchanged) |

## 1. Title (25)

| Title | Lean | Points |
|---|---|---|
| clean | +1 | ACV 25 |
| rebuilt | −0.2 | Copart 5 |
| salvage, flood | −1 | Copart 25 |
| lemon | 0 | 0 |
| not sure | 0 | 0 (listed as not scored) |
| non-repairable | | forces Copart |

## 2. Drivability (20)

The photo grader (OpenAI, `drivability` in its JSON) reports one status per item:

| Item | Share | Statuses, best first (lean) |
|---|---|---|
| Damage location | 0.30 | none (+1), cosmetic (+0.5), **affects driving** (−1) |
| Fluids | 0.15 | dry (+1), seepage (0), **leaking** (−1) |
| Tires | 0.15 | good (+1), worn (+0.5), **flat or damaged** (−1) |
| Brakes | 0.15 | ok (+1), warning (−0.5), **damaged** (−1) |
| Glass | 0.10 | intact (+1), chipped (+0.5), cracked or broken (−1) |
| Rust | 0.10 | none (+1), surface (0), heavy (−1) |
| Aftermarket modifications | 0.05 | none (+1), minor (0), major (−1) |

"Unknown" leans 0.

**Weakest link.** The statuses in bold stop the car from being driven. If any of them shows, the whole 20 points go to Copart, split between the blocking items. Intact glass and good tires don't make a car with a crushed radiator support drivable. Otherwise each item adds its share.

**The grades, flags and fault codes can only make an item worse**, so reviewer edits count:

| Evidence | Item becomes at least |
|---|---|
| frame or suspension damage suspected; wheels and tires graded replace; engine bay or underbody damaged | damage location: affects driving |
| any other damaged part | damage location: cosmetic |
| fluid leak flagged | fluids: leaking |
| wheels and tires: replace / repairable | tires: flat or damaged / worn |
| windshield: replace / repairable | glass: cracked or broken / chipped |
| brake/ABS fault code: major or critical / any | brakes: damaged / warning |

**Without photos** the seller's **Does it drive?** answer counts for the whole category (yes +20 ACV, no +20 Copart). If the seller isn't sure either, only problems shown by the grades, flags or codes are scored, and drivability is listed as not scored.

## 3. Repair cost and uncertainty (35)

| Finding | Share | Lean |
|---|---|---|
| Repair estimate (middle) ÷ clean wholesale | 0.40 | under 25%: +1; 25–50%: +0.4; 50–75%: −0.5; 75% or more: −1 |
| Fault codes together (middle of OpenAI's price) ÷ clean wholesale | 0.30 | under 5%: +0.5; 5–15%: −0.25; 15–30%: −0.6; 30% or more: −1. Low confidence leans −0.25 further. No codes: 0 |
| Non-engine modules | 0.30 | replacement likely: −1; fault codes only: −0.5; airbags intact and no module faults: +0.5; not known: 0 |

- **Module replacement is likely** when airbags deployed, flood or fire is suspected (electrical modules), or OpenAI says a module usually needs replacing for those codes.
- **Repair could cost more than the car is worth.** If the top of the repair range is above the value after repair, the whole 35 points go to Copart.

## 4. Unknown flags (10)

All lean Copart:

| Flag | Share |
|---|---|
| can't tell about the frame | 0.30 |
| can't tell if airbags deployed | 0.20 |
| can't tell about fluid leaks | 0.15 |
| can't tell about flood damage | 0.15 |
| 5+ parts not visible | 0.20 |

## 5. Market fit (10, unchanged)

| Finding | Points |
|---|---|
| this year/make/model listed on 2+ different public sites in the state (e.g. CarGurus, Cars.com) | ACV 6 |
| listed on 1 site: thin dealer market | ACV 2 |
| no listings: no local dealer market | Copart 6 |

It counts different listing sites, not search results: each result is usually a search page covering many cars.
| over 15 years old or over 200,000 miles | Copart 4 |

Anything that can't be scored scores 0 and is listed in `missing`: title, drivability, clean value, market fit.

## Inputs

| Input | From |
|---|---|
| Title | the Title buttons, or the registry |
| Drivability | `/api/grade-photos` → `drivability` (OpenAI, from the photos). The seller's **Does it drive?** is used only without photos. |
| Part grades, flags | photo grading, plus reviewer edits |
| Fault codes, their combined price and modules | `/api/decode-codes` → `codes`, `combination` (OpenAI) |
| Repair band, value after repair | `/api/decide` (parts table and eBay, plus the fault codes priced together) |
| Clean wholesale | the page, or the registry |
| Listings, age, mileage | `/api/market-fit`; mileage is the odometer read from the photos |

The page sends `drivability` and `code_assessment` (the `combination` object) to `/api/decide` along with everything else.

## Fault codes priced together: `combination` in `/api/decode-codes`

One OpenAI call per scan (`assessCombination()`, model `OPENAI_CODES_MODEL`, else `OPENAI_MODEL`) looks at all valid codes with the vehicle from the VIN decode:
- It groups codes that share a root cause (misfires on several cylinders, one wiring fault setting codes in several modules) and prices each cause once, as US independent-shop parts plus labor.
- It lists the non-engine modules involved: `airbag_srs`, `abs_brakes`, `transmission_control`, `body_control`, `instrument_cluster`, `network_communication`, `steering_suspension`, `other_electronic`. Each is `fault_reported`, or `replacement_likely` when the codes usually mean the module itself must be replaced.

```json
{
  "root_causes": [{ "codes": ["P0300", "P0301"], "cause": "string", "repair": "string", "cost_low": 250, "cost_high": 950 }],
  "cost_low": 250, "cost_high": 950,
  "modules": [{ "module": "airbag_srs", "status": "fault_reported | replacement_likely", "codes": ["B0001"], "note": "string" }],
  "confidence": "low | medium | high",
  "note": "string"
}
```

It runs at the same time as the per-code pricing call. Its `cost_low`/`cost_high` are then set to the scan's one fault-code total (`summary`): each code priced by gpt-5.5 for this car, shared repairs counted once, real quotes from the registry kept as they are. So the repair estimate, the scorecard and the page all use the same number; the root causes and modules explain it. Earlier testing of this call on its own, with gpt-5.5: Examples from testing with gpt-5.5:

| Codes | One by one | Together |
|---|---|---|
| 2016 Civic: P0300, P0301, P0302, P0304 | $600–10,000 | $250–950 (plugs and coils) |
| 2015 F-150: C0035, C0040, U0121 | $700–7,000 | $250–1,500 (ABS wiring or module) |
| 2012 Altima: P0700, P0730, P0741 | $1,200–12,000 | $2,500–5,500 (CVT) |

## Output: `channel` in `/api/decide` (also `channel_scorecard` in Download JSON)

```json
{
  "winner": "acv | copart | too_close",
  "acv": "number (one decimal)",
  "copart": "number",
  "margin": "number",
  "close_margin": 5,
  "forced": "string | null (set for non-repairable titles)",
  "categories": [{
    "key": "title | drivability | cost_uncertainty | unknown_flags | market_fit",
    "label": "string",
    "weight": "int (max points)",
    "acv": "number",
    "copart": "number",
    "rows": [{ "finding": "string", "acv": "number", "copart": "number", "reason": "string" }]
  }],
  "missing": ["string"]
}
```

## Market fit: `POST /api/market-fit`

```json
{ "vin": "17 chars", "state": "NY", "mileage": 84000 }
```

1. Decodes the VIN with NHTSA vPIC (`decodeVin()` in `api/decode-codes.ts`).
2. Runs one Firecrawl search: `"<year> <make> <model> used for sale <State>"`.
3. Keeps results whose title or snippet names the make and model, and counts the **different sites** among them.
   - Results are mostly search pages ("Used Mazda3 for sale in New York"), each covering many cars, so the count of results means little; the number of sites carrying the model is what's scored.
   - Prices: `$` amounts from the snippets, keeping only $1,500–300,000, then dropping any more than 3× from the median. With fewer than 2 left there is no price range; this drops text like "$500 below market".

ACV, Copart and IAAI sites are excluded from the query and dropped from the results. The search covers **public listings only**, never auction platforms' data. Results are cached per model and state for an hour on a warm function.

```json
{
  "ran": "boolean",
  "vehicle": { "year": "string | null", "make": "string | null", "model": "string | null" },
  "state": "string | null",
  "query": "string | null",
  "listings": "int (matching search results, mostly search pages)",
  "sites": ["string (different listing sites, e.g. cargurus.com; this is what's scored)"],
  "price_low": "int | null",
  "price_high": "int | null",
  "sample": [{ "title": "string", "url": "string (one per site, up to 5)" }],
  "age_years": "int | null",
  "mileage": "int | null",
  "source": "firecrawl",
  "error": "string (only when ran is false)"
}
```

Without `FIRECRAWL_API_KEY`, without a state, or if the VIN won't decode, it answers `ran: false` with an `error`, and market fit scores 0. The key lives only in `.env` and Vercel settings.

## Test

```bash
npm run test:scorecard
```

Ten hand-made cases, one per kind of answer:
1. a clean car that drives
2. salvage that doesn't drive
3. repair costing more than the car
4. flood
5. non-repairable
6. a seller who says it drives while the photos say no
7. airbags out with costly codes
8. codes that look costly one by one but are cheap together
9. a close call
10. no market search

It also checks that no category gives more than its weight and that the weights add up to 100.
