# Underscope — UB Hacking demo

## What we're building
A demo for ACV (now owned by Copart) that looks at photos of a damaged vehicle and recommends: **fix it and sell, or sell as-is**. It does NOT predict an exact price; it compares two price *ranges* and says which option likely nets more, or "too close to call".

This is a 24-hour hackathon build. Keep everything simple. Do not add features outside this file.

## Scope
- Vehicles: full-size pickups and cargo vans only.
- 20 test vehicles in `test_vehicles/<id>/` (photos only, used for testing, never training).
- Front end: existing Lovable app (seller upload screen + results + reviewer toggle).
- Back end: small Python API that calls the Claude API.

## Part list (25) — every part must appear in model output
front_bumper, hood, grille, left_headlight, right_headlight, windshield, left_front_fender, right_front_fender, left_front_door, right_front_door, left_rear_door, right_rear_door, left_mirror, right_mirror, left_rear_quarter, right_rear_quarter, tailgate_or_rear_doors, rear_bumper, left_taillight, right_taillight, wheels_and_tires, roof, interior (seats, dash, airbags), engine_bay (radiator area, leaks), underbody (frame rail, exhaust, catalytic converter)

## Grades
- fine: no visible damage
- repairable: damaged but can be fixed (dent, scratch, crack that can be repaired)
- replace: broken, missing, or too damaged to repair
- unknown: part not visible or unclear in the photos (mandatory option, use it rather than guess)

## Vision call (Claude API)
- Send all photos of one vehicle in ONE request; resize to ~1000 px long side.
- System prompt demands JSON only; temperature 0.
- Parse the JSON; reject and retry if invalid or any part is missing.
- Output shape:
```json
{
  "parts": [{"part": "hood", "grade": "replace", "confidence": 0.8, "evidence_photo": 2}],
  "flags": {"airbags_deployed": "unknown", "frame_suspected": true, "fluid_leak": false},
  "photo_gaps": ["no clear underbody photo"]
}
```
- API key from environment variable `ANTHROPIC_API_KEY`. Never put it in code or the front end.

## Fault codes module (owner: Tim)
Input: VIN + list of OBD-II trouble codes from a scan tool (e.g. ["P0300", "C1232"]).
Steps:
1. Validate format: letter + 4 characters. Letter = system: P powertrain, C chassis, B body, U network. Second character 0 = generic (same meaning for all makes), 1 = manufacturer-specific (meaning depends on make from VIN).
2. Generic codes: look up the description in `data/dtc_generic.csv` (code, description).
3. Manufacturer-specific or not found: ask Claude to explain it given the make/model from the NHTSA vPIC VIN decode; it must answer "unknown" if unsure, never guess.
4. Map each code to: system (engine, transmission, brakes/ABS, airbag/SRS, electrical, emissions, body), severity (minor, moderate, major, critical) and a repair cost band low/high from `data/dtc_costs.csv`.
5. Output per vehicle:
```json
{
  "codes": [{"code": "P0300", "description": "Random/multiple cylinder misfire", "system": "engine",
             "severity": "major", "cost_low": 150, "cost_high": 2500, "source": "generic_table"}],
  "summary": {"count": 1, "worst_severity": "major", "cost_low": 150, "cost_high": 2500},
  "triage": "full_inspection"
}
```
6. Triage rule: if many codes or any critical ones (airbag deployed, transmission, major engine), set "triage": "skip_inspection_sell_as_is", because a full inspection isn't worth the time and money. Thresholds live in one config dict.
7. Code costs are added to the repair band; critical codes also widen the band like an unknown flag.

## Repair band
Lookup table (CSV) of part x grade -> parts cost low/high, labor hours low/high, paint yes/no. Seller labor rate is an input.
Repair band = sum of rows for flagged parts. If any flag is "unknown" or frame_suspected is true, widen the top of the band by a fixed amount and record the reason.

## As-is band
Hand-entered per vehicle: 5-10 comparable sold salvage lots + one clean wholesale value with a condition haircut. Band = low/high of comps.

## Decision
- fix_net = after_repair_value - repair_band - holding_days * daily_cost - selling_fee
- as_is_net = as_is_band - fee - transport
- Sample each band 1000 times (uniform low..high), count how often fix wins.
- >70%: "fix". <30%: "sell as-is". Otherwise "too close to call" + the check that would change it most (usually the unknown flag).

## UI (Lovable)
Upload photos + VIN -> part grid with grade and source photo -> both nets with bands and days -> recommendation -> reviewer toggle to change any grade and recompute live.

## Test
Run all 20 vehicles; compare model grade vs our grade per part in a sheet. Report agreement % and expensive misses (model "fine" where truth is "replace").

## Do NOT build
Fine-tuning, dataset downloads, scraping, database, logins, payments, VIN enrichment beyond the free NHTSA vPIC call, any Copart/ACV integration.

## Known limitation
The vision model is weak on dents/scratches, strong on broken glass, missing bumpers, flat tires. Pick demo vehicles where the decision depends on obvious damage.

## Working style
- Keep code short and readable; one file per step where possible.
- Ask before adding dependencies.
- Don't open or read images in test_vehicles/ unless asked.
