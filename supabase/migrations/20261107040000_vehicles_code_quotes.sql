-- Real repair quotes per fault code for a registry vehicle, e.g. {"P0087": {"low": 4000, "high": 7500, "note": "shop quote, Nov 2026"}}.
-- decode-codes uses them instead of the generic dtc_codes estimate for that car.
alter table public.vehicles
  add column code_quotes jsonb check (code_quotes is null or jsonb_typeof(code_quotes) = 'object');
