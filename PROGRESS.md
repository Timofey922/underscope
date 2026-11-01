# PROGRESS

## Checklist
- [x] M1 Scaffold
- [x] M2 Domain model
- [x] M3 config/assumptions.yaml
- [ ] M4 Valuation
- [ ] M5 Decision engine (subagent review before commit)
- [ ] M6 Data (fixtures, stubs, synthetic generator)
- [ ] M7 CLI
- [ ] M8 Proof (backtest, case studies)
- [ ] M9 Docs

## Decisions for humans
- Project-local .venv created; installs are inside it only.

## Blockers
none

## Next step
M4: valuation in src/underscope/valuation.py (uses default_assumptions()).
