// VIN decoding with NHTSA vPIC (free, no key), cached in Supabase `vin_cache`.
// Used by /api/decode-vin and by every endpoint that needs the vehicle (fault codes, photo grading, market fit).
import { createClient } from '@supabase/supabase-js';

export const VIN_CONFIG = {
  url: (vin: string) => `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${vin}?format=json`,
  timeoutMs: 8000,
  retries: 1,
};

export type DecodedVin = {
  vin: string;
  year: number | null; make: string | null; model: string | null; trim: string | null;
  bodyClass: string | null; vehicleType: string | null;
  engineCylinders: number | null; displacementL: number | null; fuelType: string | null;
  driveType: string | null; gvwr: string | null;
  warning?: string; // vPIC's ErrorText when its ErrorCode isn't "0" (e.g. a wrong check digit); fields still decoded
};
export type VinResult = { ok: true; data: DecodedVin; cached: boolean } | { ok: false; status: number; error: string };

/** Trim + uppercase, then exactly 17 of A-Z / 0-9 without I, O or Q. Returns the clean VIN or an error message. */
export function validateVin(raw: unknown): { vin: string } | { error: string } {
  const vin = String(raw ?? '').trim().toUpperCase();
  if (!vin) return { error: 'Enter a VIN.' };
  if (vin.length !== 17) return { error: `A VIN has 17 characters; this one has ${vin.length}.` };
  if (/[IOQ]/.test(vin)) return { error: 'VINs never use the letters I, O or Q. Check for a 1 or a 0.' };
  if (!/^[A-Z0-9]{17}$/.test(vin)) return { error: 'A VIN has only letters A-Z and digits 0-9.' };
  return { vin };
}

const text = (v: unknown) => { const s = String(v ?? '').trim(); return s ? s : null; };
const num = (v: unknown) => { const s = text(v); const n = s === null ? NaN : Number(s); return Number.isFinite(n) ? n : null; };

function db() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? createClient(url, key, { auth: { persistSession: false } }) : null; // no server key: no cache
}

async function fetchVpic(vin: string): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt <= VIN_CONFIG.retries; attempt++) {
    try {
      const res = await fetch(VIN_CONFIG.url(vin), { signal: AbortSignal.timeout(VIN_CONFIG.timeoutMs) });
      if (!res.ok) throw new Error(`vPIC answered ${res.status}`);
      return (await res.json()).Results?.[0] ?? {};
    } catch (e) { last = e; }
  }
  throw last;
}

/** Validate, read the cache, else call vPIC and cache a recognized VIN. Never throws. */
export async function decodeVinFull(raw: unknown): Promise<VinResult> {
  const v = validateVin(raw);
  if ('error' in v) return { ok: false, status: 400, error: v.error };
  const { vin } = v;
  const cache = db();
  if (cache) {
    const { data } = await cache.from('vin_cache').select('data').eq('vin', vin).maybeSingle();
    if (data?.data) return { ok: true, data: data.data as DecodedVin, cached: true };
  }
  let r: any;
  try { r = await fetchVpic(vin); } catch (e) {
    return { ok: false, status: 502, error: `NHTSA VIN decoder unavailable: ${(e as Error).message}` };
  }
  const out: DecodedVin = {
    vin, year: num(r.ModelYear), make: text(r.Make), model: text(r.Model), trim: text(r.Trim),
    bodyClass: text(r.BodyClass), vehicleType: text(r.VehicleType),
    engineCylinders: num(r.EngineCylinders), displacementL: num(r.DisplacementL), fuelType: text(r.FuelTypePrimary),
    driveType: text(r.DriveType), gvwr: text(r.GVWR),
  };
  const code = String(r.ErrorCode ?? '0').trim();
  if (code !== '0') out.warning = text(r.ErrorText) ?? `vPIC error code ${code}`;
  if (!out.year || !out.make || !out.model) return { ok: false, status: 422, error: 'VIN not recognized' };
  if (cache) {
    const { error } = await cache.from('vin_cache').upsert({ vin, data: out });
    if (error) console.warn(`vin_cache write failed: ${error.message}`);
  }
  return { ok: true, data: out, cached: false };
}

/** Body type the photo grader and eBay use (sedan, suv, pickup, ...) from vPIC's BodyClass. */
export function bodyType(bodyClass: string | null): string | null {
  const b = (bodyClass ?? '').toLowerCase();
  if (!b) return null;
  if (/pickup/.test(b)) return 'pickup';
  if (/minivan/.test(b)) return 'minivan';
  if (/van/.test(b)) return 'van';
  if (/sport utility|crossover|suv/.test(b)) return 'suv';
  if (/hatchback|liftback/.test(b)) return 'hatchback';
  if (/wagon/.test(b)) return 'wagon';
  if (/coupe|convertible|cabriolet|roadster/.test(b)) return 'coupe';
  if (/sedan|saloon/.test(b)) return 'sedan';
  return null;
}

/** "2014 MAZDA Mazda3 2.0L Gasoline" style one-liner for prompts. */
export function vehicleLine(v: DecodedVin): string {
  return [v.year, v.make, v.model, v.trim, v.displacementL ? `${v.displacementL.toFixed(1)}L` : null,
    v.engineCylinders ? `${v.engineCylinders}-cyl` : null, v.fuelType, v.driveType, v.bodyClass].filter(Boolean).join(' ');
}
