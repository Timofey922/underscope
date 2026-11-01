# Case studies

All vehicles are fixtures (fake VINs, makes); all values use PLACEHOLDER assumptions from config/assumptions.yaml. These illustrate engine behavior, not market outcomes.

## Case 1: the $600 dent

Dealer persona. A door dent on a clean-title car, repair estimate in the $600-700 range. (`data/fixtures/dent_600.json`)

```
2022 SynthA Alpha Base  VIN FIXDENT0000000001  (NY, 28,000 mi, clean)

RECOMMENDATION: repair then sell on ACV

Path                          Expected       P10       P50       P90
repair then sell on ACV        $22,325   $20,000   $22,265   $24,738
sell as-is on ACV              $22,011   $19,820   $21,936   $24,307
part out                        $9,794    $6,970    $9,598   $12,919
sell as salvage on Copart       $4,563    $2,981    $4,539    $6,160

Best path: repair then sell on ACV, expected net $22,325 (P10 $20,000, P90 $24,738). Next best is sell as-is on ACV at $22,011, $314 behind; it wins in 9% of simulated outcomes. Expected repair cost is $656 (3% of a $25,000 clean value; total-loss threshold 75% in NY).

What would flip it:
  - For repair then sell on ACV: expected repair cost would have to rise by about $273 to flip the ranking.
  - For sell as-is on ACV: the sale price would have to rise by about $320 to flip the ranking.

(Values use PLACEHOLDER assumptions in config/assumptions.yaml.)
```

**Takeaway:** Repairing wins narrowly because buyers discount the visible damage by more than the repair costs. The margin is thin, so the result is sensitive to the placeholder as-is discount multiple and holding cost.

## Case 2: a borderline write-off

Adjuster persona. Frame crush plus a door dent; repair cost sits near the NY total-loss threshold. (`data/fixtures/borderline_writeoff.json`)

```
2019 SynthC Eps Base  VIN FIXBORDER00000001  (NY, 70,000 mi, clean)

RECOMMENDATION: repair then sell on ACV
** NEEDS HUMAN REVIEW **

Path                          Expected       P10       P50       P90
repair then sell on ACV         $7,603    $4,574    $7,730   $10,568
part out                        $6,345    $4,299    $6,228    $8,595
sell as salvage on Copart       $2,889    $1,830    $2,868    $3,965
sell as-is on ACV               $1,087      $879    $1,084    $1,303

Best path: repair then sell on ACV, expected net $7,603 (P10 $4,574, P90 $10,568). Next best is part out at $6,345, $1,258 behind; it wins in 32% of simulated outcomes. Expected repair cost is $6,887 (38% of a $18,000 clean value; total-loss threshold 75% in NY). In 0% of draws the repair crosses the threshold and the title is branded. The total-loss threshold decides this outcome.

Review reasons:
  - The total-loss threshold decides the outcome: the best path differs depending on whether a repair would brand the title.

What would flip it:
  - For repair then sell on ACV: expected repair cost would have to rise by about $1,094 to flip the ranking.
  - For part out: net parts revenue would have to rise by about $1,258 to flip the ranking.

(Values use PLACEHOLDER assumptions in config/assumptions.yaml.)
```

**Takeaway:** Whether the repair crosses the total-loss threshold (and brands the title) changes the best path, so the engine flags the threshold as decisive and asks for human review.

## Case 3: an obvious total loss

Adjuster persona. Severe frame, hood and bumper damage with undercarriage damage flagged. (`data/fixtures/total_loss.json`)

```
2020 SynthB Gamma Base  VIN FIXTOTAL000000001  (NY, 61,000 mi, clean)

RECOMMENDATION: part out

Path                          Expected       P10       P50       P90
part out                        $6,345    $4,299    $6,228    $8,595
sell as salvage on Copart       $2,504    $1,564    $2,484    $3,458
sell as-is on ACV               $1,087      $879    $1,084    $1,303
repair then sell on ACV        -$9,181  -$16,189   -$9,173      $107

Best path: part out, expected net $6,345 (P10 $4,299, P90 $8,595). Next best is sell as salvage on Copart at $2,504, $3,841 behind; it wins in 1% of simulated outcomes. Expected repair cost is $16,368 (91% of a $18,000 clean value; total-loss threshold 75% in NY). Repair is past the total-loss threshold, so a repaired car would carry a brand.

What would flip it:
  - For part out: net parts revenue would have to fall by about $3,841 to flip the ranking.
  - For sell as salvage on Copart: the sale price would have to rise by about $4,175 to flip the ranking.

(Values use PLACEHOLDER assumptions in config/assumptions.yaml.)
```

**Takeaway:** Repair costs exceed the clean value, so repair loses money in nearly every draw. Parts and salvage dominate; no review flag is needed.
