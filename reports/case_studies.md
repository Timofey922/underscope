# Case studies

All vehicles are fixtures (fake VINs, makes); all values use PLACEHOLDER assumptions from config/assumptions.yaml. These illustrate engine behavior, not market outcomes.

## Case 1: the $600 dent

Dealer persona (no insurance claim). A door dent on a clean-title car, repair estimate around $650. (`data/fixtures/dent_600.json`)

```
2022 SynthA Alpha Base  VIN FIXDENT0000000001  (NY, 28,000 mi, clean)

RECOMMENDATION: sell as-is on ACV

Path                          Expected       P10       P50       P90
sell as-is on ACV              $22,632   $20,290   $22,540   $25,035
repair then sell on ACV        $20,547   $18,288   $20,493   $22,885
part out                        $9,724    $6,917    $9,529   $12,833
sell as salvage on Copart       $3,624    $2,060    $3,579    $5,273

Best path: sell as-is on ACV, expected net $22,632 (P10 $20,290, P90 $25,035). Next best is repair then sell on ACV at $20,547, $2,084 behind; it wins in 0% of simulated outcomes. Expected repair cost is $656 (3% of a $25,000 clean value; total-loss threshold 75% in NY).

What would flip it:
  - No repair cost between $0 and 3x the estimate changes the winner.
  - For sell as-is on ACV: the sale price would have to fall by about $2,127 to flip the ranking.

(Values use PLACEHOLDER assumptions in config/assumptions.yaml.)
```

**Takeaway:** Selling as-is wins under the untuned placeholders: a flat 6% accident-history haircut on the repaired car ($1,500 here) outweighs a $650 repair. Repair only wins if buyers discount the visible damage by about 4.5x the repair cost (reports/sensitivity.md). The answer to the dealer's question depends on two unknowns, the as-is discount and the haircut for a minor cosmetic repair, and real ACV sale data should settle both.

## Case 2: a borderline write-off

Adjuster persona (insurance claim). Frame crush plus a door dent; repair cost is 72% of clean value against the 75% NY total-loss threshold. (`data/fixtures/borderline_writeoff.json`)

```
2019 SynthC Eps Base  VIN FIXBORDER00000001  (NY, 70,000 mi, clean, insurance claim)

RECOMMENDATION: part out

Path                          Expected       P10       P50       P90
part out                        $1,873      $794    $1,831    $3,098
sell as-is on ACV                 $597      $311      $607      $858
sell as salvage on Copart         $226     -$362      $207      $844
repair then sell on ACV        -$2,759   -$6,506   -$3,393      $889

Best path: part out, expected net $1,873 (P10 $794, P90 $3,098). Next best is sell as-is on ACV at $597, $1,276 behind; it wins in 6% of simulated outcomes. Expected repair cost is $6,887 (72% of a $9,500 clean value; total-loss threshold 75% in NY).

What would flip it:
  - If expected repair cost fell from $6,887 to about $4,937 (-28%), sell as-is on ACV would win.
  - For part out: net parts revenue would have to fall by about $1,276 to flip the ranking.
  - For sell as-is on ACV: the sale price would have to rise by about $1,302 to flip the ranking.

(Values use PLACEHOLDER assumptions in config/assumptions.yaml.)
```

**Takeaway:** The threshold doesn't decide this case. With these placeholders, repair stops paying well below the threshold (repair bears the hidden-damage reserve, haircut and holding), so near 75% it already loses. Parts vs as-is depends on the parts placeholders (gross value fraction, sell-through).

## Case 3: an obvious total loss

Adjuster persona (insurance claim). Severe frame, hood and bumper damage with undercarriage damage flagged. (`data/fixtures/total_loss.json`)

```
2020 SynthB Gamma Base  VIN FIXTOTAL000000001  (NY, 61,000 mi, clean, insurance claim)

RECOMMENDATION: part out

Path                          Expected       P10       P50       P90
part out                        $4,628    $2,948    $4,536    $6,459
sell as-is on ACV               $2,029    $1,646    $2,031    $2,402
sell as salvage on Copart       $1,566      $604    $1,529    $2,580
repair then sell on ACV       -$10,445  -$17,499  -$10,483   -$1,366

Best path: part out, expected net $4,628 (P10 $2,948, P90 $6,459). Next best is sell as-is on ACV at $2,029, $2,599 behind; it wins in 1% of simulated outcomes. Expected repair cost is $16,368 (91% of a $18,000 clean value; total-loss threshold 75% in NY). Repair is past the total-loss threshold, so a repaired car would carry a brand.

What would flip it:
  - If expected repair cost fell from $16,368 to about $9,325 (-43%), sell as-is on ACV would win.
  - For part out: net parts revenue would have to fall by about $2,599 to flip the ranking.
  - For sell as-is on ACV: the sale price would have to rise by about $2,653 to flip the ranking.

(Values use PLACEHOLDER assumptions in config/assumptions.yaml.)
```

**Takeaway:** Repair costs about 90% of the clean value and loses money in nearly every draw. Part-out leads salvage and as-is, but by an amount that the parts placeholders could erase (halving gross parts value or sell-through hands it to as-is).
