// Demo registry lookup (Supabase `vehicles`, server-only under RLS).
// Returns only what the page may show; odometer and notes stay private.
import { createClient } from '@supabase/supabase-js';
import { decodeVinFull } from './vin.js';

export type RegistryTitle = {
  title_status: 'clean' | 'salvage' | 'rebuilt' | 'flood' | 'non_repairable' | 'lemon';
  title_state: string | null;
  source: 'title_document' | 'dealer_listing' | 'online_listing' | 'nmvtis_report';
  clean_wholesale: number | null;
  salvage_comps: number[] | null;
  values_note: string | null;
  // Real repair quotes per fault code for this car; they replace the generic dtc_codes estimate.
  code_quotes: Record<string, { low: number; high: number; note?: string }> | null;
};

export async function lookupRegistry(vin: string): Promise<RegistryTitle | null> {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null; // no server key: behave as if not registered
  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await db.from('vehicles').select('title_status, title_state, source, clean_wholesale, salvage_comps, values_note, code_quotes').eq('vin', vin).maybeSingle();
  if (error) { console.warn(`vehicles lookup failed: ${error.message}`); return null; }
  return data as RegistryTitle | null;
}

// ---- Comps from similar registry vehicles ----
// For a VIN that isn't in the registry: sold salvage prices hand-entered for registry cars of the same make and
// model within ±SIMILAR.years model years. Only real registry data; sample/demo values are never used. The other
// cars' VINs stay on the server: callers get their year/make/model only.

export const SIMILAR = { years: 3, minComps: 3 };
export type SimilarComps = { comps: number[]; from: string[]; label: string } | null;
const norm = (s: string | null | undefined) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export async function similarComps(vin: string): Promise<SimilarComps> {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const me = await decodeVinFull(vin);
  if (!me.ok) return null;
  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await db.from('vehicles').select('vin, salvage_comps').not('salvage_comps', 'is', null).neq('vin', vin);
  if (error || !data?.length) return null;
  const others = await Promise.all(data.map(async (r) => ({ r, d: await decodeVinFull(r.vin) }))); // vin_cache makes these fast
  const hits = others.filter(({ d }) => d.ok && norm(d.data.make) === norm(me.data.make) && norm(d.data.model) === norm(me.data.model)
    && Math.abs((d.data.year ?? 0) - (me.data.year ?? 0)) <= SIMILAR.years);
  const comps = hits.flatMap(({ r }) => (r.salvage_comps as number[]) ?? []).filter((n) => n > 0).sort((a, b) => a - b);
  if (comps.length < SIMILAR.minComps) return null;
  const make = (m: string | null) => (m && m.length > 3 ? m.replace(/\B\w+/g, (w) => w.toLowerCase()) : m); // MAZDA -> Mazda, BMW stays
  const from = hits.map(({ d }) => (d.ok ? `${d.data.year} ${make(d.data.make)} ${d.data.model}` : ''));
  return { comps, from, label: 'estimated from similar vehicles' };
}
