-- Cache of NHTSA vPIC VIN decodes (api/_lib/vin.ts). Public decode data only; RLS on with no policies,
-- so only the server (service role) reads and writes it.
create table public.vin_cache (
  vin        text primary key check (vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  data       jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.vin_cache enable row level security;
