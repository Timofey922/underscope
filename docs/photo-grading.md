# Photo grading and per-part pricing

How Underscope turns photos of a damaged vehicle into part grades, a list of problems and a priced repair estimate, all in one JSON file.

```
photos (page)
  │
  ├─ 1. /api/classify-photos   gpt-4o (OPENAI_CLASSIFY_MODEL)
  │      768 px photos with a labelled 4x4 grid
  │      → which view each photo is (front-left, rear, interior...), boxes around anything that might be damage,
  │        the VIN label and the odometer (up to 4 per photo)
  │
  ├─ page cuts close-up crops out of the full-resolution photos around those boxes
  │      (up to 16, one photo at a time, within the 4.3 MB request budget)
  │
  ├─ 2. /api/grade-photos      gpt-5.5 (OPENAI_MODEL)
  │      1000 px photos + views + crops
  │      a. two grading passes at once (the second sees the photos in reverse order); keep the worse grade per part
  │      b. damage seen only in photos of the other side moves to the mirror-image part
  │      c. second look at fine parts next to damage, with the photos that show the damage
  │      → 25 part grades, every problem with its severity, flags, vehicle, VIN, odometer
  │      → repair_estimate: replaced parts priced from eBay for the vehicle seen, the rest from data/repair_costs.csv
  │
  ├─ 3. /api/decide            no AI
  │      grades + severities + vehicle (eBay parts prices) + vehicle class + fault codes + market values
  │      → repair band (priced per part), both net ranges, P(fix wins), verdict
  │
  └─ Download JSON             everything above in one file
```

## Why two stages

Stage 1 uses a fast model for the easy, mechanical jobs:
- **Sort the photos.** It answers simple picture questions: what is at the left and right edge of the picture, and is the front end on the image's left, center or right. Code (`viewFrom()` in `api/classify-photos.ts`) turns those answers into the vehicle's side. Small models mix up the picture's left with the vehicle's left when asked directly; they get the picture questions right.
- **Point at things worth a closer look.** It names grid cells (A1 to D4) around anything that might be damage, the VIN label and the odometer. The page cuts those areas out of the original photo at full resolution, so stage 2 sees small dents and label text in detail even though the full photos are downscaled. It is told to mark doubtful spots too, because stage 2 throws out false alarms but rarely finds damage nobody pointed at. On the 26 test cars the boxes covered 12% of the hand-labeled damage with the old prompt on gpt-4o-mini, 24% with the new prompt, and 35% on gpt-4o (which was also faster, about 12 s a car).

Stage 2 does the grading with the photos, the views from stage 1 and the crops. Crops are hints: a crop with no real damage is treated as a false alarm. Around the grading call, `gradePhotos()` adds three checks (all in `GRADE_CONFIG`):

- **Grade twice, keep the worse** (`passes: 2`). Two calls run at the same time, the second with photos and crops in reverse order (each keeps its number). Per part the worse grade wins (replace > repairable > fine > unknown), with that pass's evidence and damages; flags take true over unknown over false. A missed dent costs more than an extra "repairable". Same wait as one call, twice the cost.
- **Right side** (`fixSides()`). Fenders, doors, quarter panels and mirrors only show from their own side. If every side view that shows a part's damage is a view of the other side (stage 1's view per photo; three-quarter views count only for doors), the damage moves to the mirror-image part, and the part itself becomes fine (or unknown when no photo shows its side). Each move is listed in `meta.side_fixes`.
- **Second look next to damage** (`recheck`). Fine parts next to a damaged part (bumper next to fender, headlight, hood...) get one more call with the photos and crops that show the damage, asking about those parts only. A part is raised to repairable or replace only when the answer names a photo that shows it; nothing is lowered. Skipped when the passes took over 35 s (`recheckAfterS`), so stage 2 stays under Vercel's 60 s. Listed in `meta.recheck`.

The grade rules (`GRADE_RULES`) are shared by the passes and the second look. They include fixed rules for glass, lights, mirrors, wheels and tires (any crack in a windshield or lens, a hanging or broken mirror, a flat tire or bent wheel means replace), the parts most often missed in testing.

Copart photos come in a fixed order (1 front-left, 2 rear-left, 3 rear-right, 4 front-right, 5 front, 6 rear, then interior, dashboard, engine, labels), but nothing relies on that order, so seller photos in any order work.

## Endpoints

All accept and return JSON, with open CORS. Vercel limits a request body to about 4.5 MB and a function to 60 s.

### `POST /api/classify-photos`

```json
{ "photos": ["data:image/jpeg;base64,... (768 px, grid drawn on it)"] }
```

Returns, per photo: `photo` (1-based), `view` (`front`, `front_left`, `left_side`, `rear_left`, `rear`, `rear_right`, `right_side`, `front_right`, `interior`, `dashboard`, `engine_bay`, `underbody`, `label_or_document`, `detail`, `other`, `exterior_unknown_side`), `side`, what the model saw (`observed`) and `regions` (`kind`: damage / vin_label / odometer, `part` with left_/right_ added from the view, `note`, `cells`, `box` as fractions of the image).

The grid is drawn by `drawGrid()` in `public/app.js` (and `gridded()` in `scripts/test-grade-photos.ts`).

### `POST /api/grade-photos`

```json
{
  "vin": "17 characters",
  "photos": ["data:image/jpeg;base64,... (~1000 px, upload order)"],
  "views": ["front_left", "rear_left", null],
  "crops": [{ "photo": 1, "kind": "damage", "part": "front_bumper", "note": "torn cover", "image": "data:image/jpeg;base64,..." }]
}
```

`views` and `crops` are optional; without them it grades the photos alone. Returns:

| Field | What it holds |
|---|---|
| `photo_views` | the view of each photo and the cue used |
| `vehicle` | year, make, model, trim, body type, color, `price_class` (economy / mainstream / premium / luxury / unknown), VIN read from a label (`vin_visible`, `vin_check_digit_ok`, `vin_matches_input`), odometer |
| `parts` | all 25 parts: `grade` (fine / repairable / replace / unknown), `severity` (minor / moderate / severe, or null), `confidence`, `evidence_photo` (1-based), `note` |
| `damages` | every problem: part, type (dent, crack, missing...), severity, description, photos |
| `missing_parts` | specific items that are gone |
| `flags` | airbags deployed, frame suspected, fluid leak, flood, fire, suspension: true / false / "unknown" |
| `primary_damage_area`, `overall_severity`, `photo_gaps`, `summary` | overview for a person |
| `repair_estimate` | the priced repair, see below (default $95/hr labor) |
| `meta` | model, seconds, attempts, photo and crop counts |

A part's `severity` is the worst problem listed for it in `damages`. The model fills in `damages` anyway, so this adds no extra work for it.

### `POST /api/decide`

Same as before, with three optional additions: `vehicle_class` and a `severity` on each grade (both from the photo grading), and `vehicle` `{ year, make, model, body_type }` for eBay parts prices. The page sends the VIN decode's year/make/model when it has them, otherwise what the photos show, plus the body type from the photos; sample vehicles send no `vehicle` and keep table prices. See CLAUDE.md "Decision".

## How each part is priced

Prices never come from the model. The model says **what** is damaged and **how badly**; eBay listings and the table turn that into dollars.

1. Look up the part and grade in `data/repair_costs.csv`: parts cost low/high, labor hours low/high, paint yes/no.
2. **A replaced part is priced from eBay when it can be** (`api/_lib/parts-prices.ts`): one Browse API search for that part, limited to listings eBay says fit the exact year/make/model (new and used, fixed price). Kept: listings whose title names the part and the right side, without pairs, kits, accessories or small pieces, and within 3× of the median price. Parts cost = the middle half of those prices (price plus shipping when eBay gives it); if at least 2 are OEM/genuine, their median can raise the top. Fewer than 5 fitting listings, no keys, an unknown vehicle, a part with no eBay category (roof, interior, engine bay, underbody, wheels and tires), or eBay taking over 7 s: the table is used. Results are cached in memory for 6 hours, so reviewer edits stay instant.
3. **Severity narrows labor, not the price of a new part.** minor takes the bottom 0–40% of the labor-hours range, moderate 30–70%, severe 60–100%. For a repair it narrows the materials cost too. A replaced part is bought whole, so it gets its full price range. No severity (a reviewer changed the grade, or a sample vehicle) keeps the full ranges.
4. **Vehicle class scales table parts costs**: economy ×0.85, mainstream ×1, premium ×1.3, luxury ×1.7. eBay prices (already for the exact vehicle), labor and paint are not scaled.
5. Labor cost = hours × labor rate (default $95/hr, changeable on the page).
6. Paint adds $150–400 per panel that needs it.
7. Part price = parts + labor + paint, low and high. Each line says where its parts cost came from: `parts_source` (`ebay` or `table`) and `parts_listings`.

Then, as before: fault-code repairs are added, and fixed amounts are added to the top of the band for risks the photos can't settle (frame suspected +$3,000, airbags unknown +$1,500, fluid leak unknown +$500, each critical code +$2,000, 5+ parts not visible +$1,000).

Every number above is in `DECISION_CONFIG` at the top of `api/_lib/decision.ts` (`severityShare`, `partsPriceFactor`, `paintPerPanel`, `widen`, `defaults.labor_rate`) and `PARTS_PRICE_CONFIG` in `api/_lib/parts-prices.ts` (eBay category, search words and title checks per part, minimum listings, band, timeouts). The CSV holds rough industry ranges for a generic passenger vehicle and runs high: on a 2019 Toyota Tacoma its replace prices were 2–3× a Toyota dealer's factory price and 3–7× eBay's.

eBay prices are asking prices of active listings, mostly aftermarket and used (eBay's sold prices need partner approval). They are the low end of what a part costs; a shop that uses factory parts pays more. On the Tacoma, eBay's passenger headlight came out $66–130 and three Toyota dealer sites asked $351–857. To compare for any vehicle:

```bash
npm run check:parts -- 2019 Toyota Tacoma pickup right_headlight front_bumper
```

It prints the table, eBay and factory prices from dealer parts sites side by side. The dealer prices come from one Firecrawl search per part that opens up to 3 pages (about 17 credits a part), so it is a hand check for tuning the table, not part of a vehicle check.

Example line (2019 Toyota Tacoma, $95/hr):

```json
{
  "label": "Front bumper, replace (severe)",
  "low": 545, "high": 1040,
  "part": "front_bumper", "grade": "replace", "severity": "severe",
  "parts_cost": [91, 260], "labor_hours": [3.2, 4], "labor_cost": [304, 380], "paint_cost": [150, 400],
  "parts_source": "ebay", "parts_listings": 28
}
```

## The downloaded JSON

**Download JSON** (next to Copy link on the result) saves `underscope-<VIN>-<date>.json`. The same document is shown under "API response" on the page. Built by `buildReport()` in `public/app.js`:

```json
{
  "generated_at": "2026-11-08T15:00:00.000Z",
  "input": { "vin": "...", "codes": ["P0300"], "title_status": "salvage", "photos": ["1.jpg"], "sample": null },
  "decision": { "...": "full /api/decide response: repair, arv, as_is, fix_net, as_is_net, p_fix, verdict, check" },
  "fault_codes": { "...": "full /api/decode-codes response" },
  "part_grades": [
    { "part": "front_bumper", "grade": "replace", "severity": "severe", "evidence_photo": 5, "edited_by_reviewer": false,
      "price": { "low": 545, "high": 1040, "parts_cost": [91, 260], "parts_source": "ebay", "parts_listings": 28, "labor_hours": [3.2, 4], "labor_cost": [304, 380], "paint_cost": [150, 400] } },
    { "part": "hood", "grade": "fine", "severity": null, "evidence_photo": 1, "edited_by_reviewer": false, "price": null }
  ],
  "repair_estimate": { "low": 545, "high": 3540, "labor_rate": 95, "vehicle_class": "mainstream", "lines": ["..."], "could_cost_more": ["..."] },
  "flags": { "airbags_deployed": "unknown", "frame_suspected": false, "fluid_leak": "unknown" },
  "photos": { "classification": "stage 1 response", "crops": ["crops sent to stage 2, without the images"], "grading": "stage 2 response" }
}
```

Prices in `part_grades` and `repair_estimate` come from `/api/decide`, so they follow reviewer edits and the labor rate on the page. `photos.grading.repair_estimate` is the price straight from the grader at the default rate.

## Settings

| Env var | Used for | Now |
|---|---|---|
| `OPENAI_API_KEY` | both stages | server only, never in code |
| `OPENAI_CLASSIFY_MODEL` | stage 1 | `gpt-4o` (default); set it to `gpt-4o` or remove it where it still says `gpt-4o-mini` |
| `OPENAI_MODEL` | stage 2 | `gpt-5.5` |
| `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` | eBay parts prices (`/api/decide`, `/api/grade-photos`) | production keyset, server only; without them parts use the table |
| `FIRECRAWL_API_KEY` | `npm run check:parts` dealer prices (and market fit) | server only |

Both stages switch automatically between models: gpt-5.x and o-series models get `reasoning_effort: low`, gpt-4o gets `temperature: 0`.

Tuning knobs: `CLASSIFY_CONFIG` in `api/classify-photos.ts` (model, boxes per photo), `GRADE_CONFIG` in `api/grade-photos.ts` (max photos, max crops, image detail, passes, second look and its time budget), and in `public/app.js` `MAX_CROPS` and `REQUEST_BUDGET` (4.3 MB, the page skips crops that would go over Vercel's limit).

## Testing

```bash
npm run dev
```

```bash
npm run test:photos -- 46404106 67524236
```

`test:photos` runs vehicles in `test_vehicles/<id>/` through both stages exactly as the page does, using ImageMagick for the grid and crops. It prints the time of each stage and the grade counts, and saves the full result to `test_vehicles/<id>/grade.json` (`OUT=name.json` changes the file name). Leave out the ids to run every vehicle. It needs `npm run dev` running.

`test_vehicles/` (Copart photos, results and hand-made ground truth) is kept out of git: the photos are only for testing and contain real VINs.

### Results on 26 Copart lots (Nov 8, against the hand labels in `truth.json`)

| Setup | Parts graded right | Damage found (recall) | Flagged damage that is real (precision) | Expensive misses (label replace, model fine) | Wrong side | Stage 1 + stage 2 time |
|---|---|---|---|---|---|---|
| gpt-4o-mini → gpt-4o, old flow | 86.0% | 67.4% | 82.1% | 10 | 7 | ~27 s in all |
| gpt-4o-mini → gpt-5.5, old flow | 88.2% | 76.0% | 79.7% | 9 | 5 | 15 + 24 s (max 37 / 33) |
| gpt-4o → gpt-5.5, new close-ups and rules, one pass | 91.6% | 82.2% | 86.2% | 4 | 1 | |
| + grade twice, keep the worse | 91.6% | 88.4% | 83.2% | 3 | 1 | |
| + second look next to damage (**now**) | 91.6% | 89.9% | 82.3% | 2 | 1 | 9 + 34 s (max 12 / 45) |

The one-pass, two-pass and second-look rows come from the same run (`meta.passes` keeps each pass's grades). Most parts are fine, so "parts graded right" runs high; quote recall and expensive misses. Grading twice trades about 3 points of precision for 6 of recall; the second look raised 4 parts, 2 of them matching the labels. The side fix moved nothing on these cars: with gpt-4o's views and the new close-ups only one wrong-side case was left, and there the view itself points to the side the model chose (see the label review).

Earlier, on 24 lots (Karthik's hand-checked run, different labels): gpt-5.5 alone with the best prompt ~92% right, ~82% recall, ~89% precision, 0 wrong side; gpt-4o alone ~83.5% / ~67% / ~74%.

### Checking the labels

```bash
npm run review:labels -- base55.json v2.json
```

Writes `test_vehicles/LABEL_REVIEW.md`: every part where a hand label and a model run disagree, what the model saw and which photos to look at. A `review.json` per vehicle adds a blind second look (someone grading the same photos without seeing the label or the model). The script never changes `truth.json`; fix a label only when the photos clearly show it is wrong.

## Known limits

- Dents and scratches are the weak spot, especially for gpt-4o. Broken glass, missing bumpers, crushed corners and flat tires are reliable.
- Stage 2 now takes 25–45 s for 12–14 photos (two passes plus the second look). With many more photos the second look is skipped to stay under 60 s; set `passes: 1` in `GRADE_CONFIG` if time matters more than recall.
- Frame, mechanical, flood and underbody damage can't be seen in normal photos; those come back `unknown` and widen the repair band instead of being guessed.
- Replaced parts are eBay asking prices for the exact vehicle when there are enough listings; labor, paint, repairs, hidden front-end damage and anything eBay can't price come from a generic table. None of it is a shop quote.
