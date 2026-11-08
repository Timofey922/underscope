// POST /api/market-fit  { vin, state, mileage? } -> how many public listings of the same year/make/model exist in that
// state, for the "market fit" category of the ACV vs Copart scorecard (api/_lib/scorecard.ts).
// If dealers list this car in the state, it fits ACV's dealer market; if nobody does, it is more likely a Copart car.
// Uses Firecrawl search (FIRECRAWL_API_KEY) over PUBLIC listings only: ACV and Copart sites are excluded from the
// query and dropped from the results. Without a key or a state it answers { ran: false } and the category scores 0.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { decodeVin } from './decode-codes.js';

export const config = { maxDuration: 30 };

export const MARKET_CONFIG = {
  endpoint: 'https://api.firecrawl.dev/v2/search',
  limit: 10,
  timeoutMs: 15000,
  excludedSites: ['acvauctions.com', 'acvmax.com', 'copart.com', 'iaai.com'],  // never use auction platforms' data
  priceRange: [500, 300000] as [number, number],                              // ignore $ amounts outside this
};

export const STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

export type MarketFitResult = {
  ran: boolean;
  vehicle: { year: string | null; make: string | null; model: string | null };
  state: string | null;
  query: string | null;
  listings: number;                       // results that name this make and model
  price_low: number | null; price_high: number | null;   // $ amounts seen in those results
  sample: { title: string; url: string }[];
  age_years: number | null;
  mileage: number | null;
  source: 'firecrawl';
  error?: string;
};

type Hit = { url?: string; title?: string; description?: string; markdown?: string };
const cache = new Map<string, { at: number; hits: Hit[] }>();   // per warm instance; one search per model+state per hour

async function search(query: string, key: string): Promise<Hit[]> {
  const hit = cache.get(query);
  if (hit && Date.now() - hit.at < 3600_000) return hit.hits;
  const res = await fetch(MARKET_CONFIG.endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit: MARKET_CONFIG.limit }),
    signal: AbortSignal.timeout(MARKET_CONFIG.timeoutMs),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) throw new Error(`Firecrawl ${res.status}: ${String(body.error ?? '').slice(0, 120)}`);
  // v2 returns { data: { web: [...] } }; v1 returned { data: [...] }.
  const hits: Hit[] = Array.isArray(body.data) ? body.data : body.data?.web ?? [];
  cache.set(query, { at: Date.now(), hits });
  return hits;
}

export async function marketFit(vin: string, state: string | null, mileage: number | null): Promise<MarketFitResult> {
  const v = await decodeVin(vin);
  const vehicle = { year: v.year, make: v.make, model: v.model };
  const age = v.year ? new Date().getFullYear() - Number(v.year) : null;
  const out: MarketFitResult = {
    ran: false, vehicle, state, query: null, listings: 0, price_low: null, price_high: null, sample: [],
    age_years: age != null && age >= 0 ? age : null, mileage, source: 'firecrawl',
  };
  const key = process.env.FIRECRAWL_API_KEY;
  if (!state) return { ...out, error: 'no state given' };
  if (!key) return { ...out, error: 'FIRECRAWL_API_KEY not set' };
  if (!v.make || !v.model) return { ...out, error: 'could not decode the VIN' };

  const query = `${v.year ?? ''} ${v.make} ${v.model} used for sale ${STATES[state]} ${MARKET_CONFIG.excludedSites.map((s) => `-site:${s}`).join(' ')}`.replace(/\s+/g, ' ').trim();
  try {
    const hits = await search(query, key);
    const words = (s: string) => s.toLowerCase().split(/[\s-]+/).filter(Boolean);
    const need = [...words(v.make), ...words(v.model)];
    const relevant = hits.filter((h) => {
      const host = (() => { try { return new URL(h.url ?? '').hostname; } catch { return ''; } })();
      if (MARKET_CONFIG.excludedSites.some((s) => host.endsWith(s))) return false;
      const text = `${h.title ?? ''} ${h.description ?? ''}`.toLowerCase();
      return need.every((w) => text.includes(w));
    });
    const [lo, hi] = MARKET_CONFIG.priceRange;
    const prices = relevant.flatMap((h) => [...`${h.title ?? ''} ${h.description ?? ''}`.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d{3,6})(?!\d)/g)]
      .map((m) => Number(m[1].replace(/,/g, ''))).filter((n) => n >= lo && n <= hi));
    return {
      ...out, ran: true, query, listings: relevant.length,
      price_low: prices.length ? Math.min(...prices) : null, price_high: prices.length ? Math.max(...prices) : null,
      sample: relevant.slice(0, 5).map((h) => ({ title: h.title ?? '', url: h.url ?? '' })),
    };
  } catch (e) {
    return { ...out, query, error: (e as Error).message.slice(0, 160) };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') {
    return res.status(200).json({
      endpoint: 'POST /api/market-fit',
      body: { vin: '17-character VIN', state: 'two-letter US state, e.g. NY', mileage: 'optional odometer reading' },
      returns: 'ran, vehicle, state, query, listings, price_low, price_high, sample[], age_years, mileage, error?',
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  const { vin, state, mileage } = req.body ?? {};
  const cleanVin = typeof vin === 'string' ? vin.trim().toUpperCase() : '';
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(cleanVin)) return res.status(400).json({ error: 'vin must be 17 characters (no I, O or Q)' });
  const st = typeof state === 'string' && state ? state.trim().toUpperCase() : null;
  if (st && !STATES[st]) return res.status(400).json({ error: 'state must be a two-letter US state code' });
  const miles = Number.isFinite(Number(mileage)) && Number(mileage) > 0 ? Math.round(Number(mileage)) : null;
  return res.status(200).json(await marketFit(cleanVin, st, miles));
}
