STATUS: DONE

# PROGRESS

## Checklist
- [x] M1 Scaffold
- [x] M2 Domain model
- [x] M3 config/assumptions.yaml
- [x] M4 Valuation
- [x] M5 Decision engine (subagent review before commit)
- [x] M6 Data (fixtures, stubs, synthetic generator)
- [x] M7 CLI
- [x] M8 Proof (backtest, case studies)
- [x] M9 Docs

## Decisions for humans
- Project-local .venv created; installs are inside it only.

- Placeholder calibration: raised as_is_discount_multiple_of_repair to 3.0, lowered repaired-value haircut to 1% and holding to $20/day so a ~$690 dent repair pays back. Replace all with real data.
- Repair path holding cost covers repair days + days to sell (more conservative than TASK.md literal).
- Part-out path also deducts a tow cost (transport.parts_cents), beyond the TASK.md formula.
- review_overlap_threshold = P(runner-up beats winner in a paired draw) >= 0.35.
- total_loss_decides is only evaluated when some draws cross the threshold (clean title).
- Unknown inspection flags each add an allowance, so both missing adds it twice (reviewer noted; intended).
- M5 subagent review (math/units/signs): no findings.

## Blockers
none

## Next step
All milestones done. See Morning summary.

## Morning summary
**Built:** scaffold, pydantic domain model + MockDetector, placeholder assumptions config,
valuation, seeded Monte Carlo decision engine (ranking, review flags, total-loss flag,
explanations, flip conditions), fixtures + ACV/Copart stubs + 500-vehicle synthetic set, typer CLI,
backtest and case-study reports, README and data requirements.

**Run:** `python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'`, then `make test`,
`.venv/bin/underscope evaluate data/fixtures/dent_600.json [--json]`. See README.

**Results (synthetic, circular by construction):** 85.6% accuracy vs oracle, $114 average regret
per vehicle (best fixed policy: $539), 7.2% human-review rate. Details in reports/backtest.md.

**Decisions to review:** see "Decisions for humans" above, especially the placeholder
recalibration (as-is discount multiple, holding cost, haircut), the repair-path holding cost, the
part-out tow cost, and the review overlap threshold of 0.35.

**Next three steps:**
1. Replace placeholders with real data once a partnership exists (docs/DATA_REQUIREMENTS.md).
2. Build a real DamageDetector behind the protocol and score it on labeled photos.
3. Calibrate simulation uncertainty and review thresholds on real outcomes; add sensitivity to
   repair cost near the total-loss threshold in the flip conditions.
