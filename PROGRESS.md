# PROGRESS

## Checklist
- [x] M1 Scaffold
- [x] M2 Domain model
- [x] M3 config/assumptions.yaml
- [x] M4 Valuation
- [x] M5 Decision engine (subagent review before commit)
- [x] M6 Data (fixtures, stubs, synthetic generator)
- [ ] M7 CLI
- [ ] M8 Proof (backtest, case studies)
- [ ] M9 Docs

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
M7: typer CLI src/underscope/cli.py: `underscope evaluate vehicle.json` (+ --json).
