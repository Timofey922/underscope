STATUS: DONE

# PROGRESS

`STATUS: DONE` refers to the TASK.md milestones (M1-M9) and keeps `run.sh` from restarting
them. Current work is interactive; see the review log below.

## Checklist
- [x] M1-M9 prototype (unattended run, branch agent/2026-11-01-103713, fast-forwarded to main)
- [x] Review and hardening pass (2026-11-01, interactive)

## Review log (2026-11-01)

| # | Finding | Fix |
|---|---|---|
| F1 | Backtest truth came from the engine's own model (circular) | `data.perturbed` world; report shows same-model and misspecified results |
| F2 | Holding cost charged only on the repair path; as-is/Copart sell days drawn but unused | Holding on every sale path |
| F3 | Part-out value ignored damage | PLACEHOLDER `parts.panel_share_of_parts_value`, `damage_type_loss_factor` |
| F4 | As-is value could price below salvage | Floor as-is at expected salvage |
| F5 | Placeholders tuned so the dent case would favor repair | Reverted to untuned values (1.3x, 6%, $40/day); added `underscope.sensitivity` |
| F6 | Any repair past the total-loss threshold branded the title, even a dealer's own | `VehicleRecord.insurance_claim`; branding only on claims |
| F7 | Flip conditions used a closed form that ignored coupling (wrong amount and direction) | Bisection over a repair-cost scale |
| F8 | "Threshold decides" fired at 0.1% branded draws; explanation said "0%" and "decides" together | PLACEHOLDER `simulation.total_loss_min_branded_share` (5%), counterfactual wording |
| F9 | Config had no schema checks | Ordered ranges, percents, cents, enum coverage, draws |
| F10 | "Borderline write-off" fixture sat at 38% repair ratio vs a 75% threshold | Clean value lowered so it sits at 72% |
| F11 | Repaired-value haircut was a flat 6% regardless of damage (decided by user: scale with severity) | `repaired_value_haircut_pct_at_total_damage` (PLACEHOLDER 20%) x damage score |

Checked and fine: integer-cents arithmetic, common random numbers, seeding, fee signs.
Confidence-weighted expected repair cost assumes confidence = P(damage exists); a real
detector's confidence must be calibrated for that to hold.

## What the honest numbers say
- With the untuned placeholders, repair rarely wins. It bears ~1.15x repair (hidden-damage
  reserve), a damage-scaled haircut and extra holding, while buyers only discount as-is cars
  by 1.3x repair. The dent case needs a ~2.4x discount for repair to win.
- Under a misspecified world the engine does not beat "always sell as-is" on the synthetic mix
  ($84 vs $78 regret per vehicle). The synthetic mix is mostly light damage.
- Part-out vs as-is on heavy damage depends on the parts placeholders.
- By damage band (reports/backtest.md), the misspecified world shows the engine losing to
  "always as-is" in the mid band (15-50% repair ratio, $142 vs $123), which is where dealer
  repair decisions live. Heavy band has only 47 vehicles; its numbers are noisy.

## Decisions for humans
- Haircut now scales with damage score (repair cost / clean value). 20% at full damage is
  anchored just under the rebuilt-title discount, not tuned. A structural (frame) premium on
  top is a possible refinement.
- `insurance_claim` defaults to false (dealer). On a claim, branding = `rebuilt` after repair;
  the as-is/Copart paths don't yet model the insurer's salvage title on a total loss.
- Review overlap threshold stays 0.35: P(runner-up beats winner) is about 0.5 at most, so the
  original 0.60 could never fire.
- Part-out still deducts a tow cost (transport.parts_cents), beyond the TASK.md formula.
- Unknown inspection flags each add an allowance (both missing adds it twice).

## Blockers
none

## Next step
Find why the engine underperforms "always as-is" in the mid band under misspecification
(likely the repair path's sensitivity to the as-is discount multiple); consider a stratified
synthetic set with more mid/heavy vehicles. Real data (docs/DATA_REQUIREMENTS.md) remains the main unlock.
