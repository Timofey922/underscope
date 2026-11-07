// POST /api/decode-codes  { vin, codes } -> decoded fault codes, summary and triage.
// Generic codes come from the Supabase dtc_codes table; manufacturer-specific or
// unlisted codes are explained by Gemini (which must say "unknown" rather than guess).
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

// ---- Config: every threshold and fallback lives here ----
export const CONFIG = {
  triage: {
    manyCodes: 6,                                  // this many valid codes or more -> skip inspection
    skipSeverities: ['critical'],                  // any code at these severities -> skip
    skipSystemsAtMajor: ['transmission', 'airbag/SRS'], // major-or-worse in these systems -> skip
  },
  // Cost band for codes explained by Gemini (the table has its own costs).
  costBySeverity: {
    minor: [50, 400], moderate: [150, 1500], major: [400, 4000], critical: [1000, 6000], unknown: [100, 3000],
  } as Record<string, [number, number]>,
  maxCodes: 50,
  vpicTimeoutMs: 8000,
};

const SYSTEMS = ['engine', 'transmission', 'brakes/ABS', 'airbag/SRS', 'electrical', 'emissions', 'body'];
const SEVERITIES = ['minor', 'moderate', 'major', 'critical']; // ordered, worst last
const CODE_RE = /^[PCBU][0-3][0-9A-F]{3}$/;
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

type Source = 'generic_table' | 'gemini' | 'unknown' | 'invalid';
export type DecodedCode = {
  code: string; description: string; system: string; severity: string;
  cost_low: number; cost_high: number; source: Source;
};
export type Vehicle = { year: string | null; make: string | null; model: string | null; engine: string | null };
export type DecodeResult = {
  vehicle: Vehicle;
  codes: DecodedCode[];
  summary: { count: number; worst_severity: string; cost_low: number; cost_high: number };
  triage: 'full_inspection' | 'skip_inspection_sell_as_is';
  reason: string;
};

// ---- Steps ----

async function decodeVin(vin: string): Promise<Vehicle> {
  const empty: Vehicle = { year: null, make: null, model: null, engine: null };
  try {
    const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${vin}?format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(CONFIG.vpicTimeoutMs) });
    const r = (await res.json()).Results?.[0] ?? {};
    const v = (s: string) => (r[s] && String(r[s]).trim()) || null;
    const engine = [v('DisplacementL') && `${Number(v('DisplacementL')).toFixed(1)}L`, v('FuelTypePrimary')]
      .filter(Boolean).join(' ') || null;
    return { year: v('ModelYear'), make: v('Make'), model: v('Model'), engine };
  } catch {
    return empty; // vPIC down: keep going, Gemini just gets less context
  }
}

async function lookupTable(codes: string[]): Promise<Map<string, DecodedCode>> {
  // Read-only lookup: dtc_codes is public under RLS, so the anon key is enough if the service key is absent.
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or VITE_SUPABASE_ANON_KEY)');
  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await db.from('dtc_codes').select('*').in('code', codes);
  if (error) throw new Error(`dtc_codes lookup failed: ${error.message}`);
  return new Map((data ?? []).map((r) => [r.code, { ...r, source: 'generic_table' as const }]));
}

function unknownCode(code: string): DecodedCode {
  const [lo, hi] = CONFIG.costBySeverity.unknown;
  return { code, description: 'unknown', system: 'unknown', severity: 'unknown', cost_low: lo, cost_high: hi, source: 'unknown' };
}

async function askGemini(codes: string[], vehicle: Vehicle): Promise<DecodedCode[]> {
  const apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL;
  if (!apiKey || !model || codes.length === 0) return codes.map(unknownCode);

  const ai = new GoogleGenAI({ apiKey });
  const car = [vehicle.year, vehicle.make, vehicle.model, vehicle.engine].filter(Boolean).join(' ') || 'unknown vehicle';
  const system = [
    'You explain OBD-II diagnostic trouble codes for a specific vehicle. Reply with JSON only, no prose.',
    'Shape: {"codes":[{"code":"P1234","description":"...","system":"...","severity":"..."}]}, one entry per input code.',
    `system must be one of: ${SYSTEMS.join(', ')}, or "unknown".`,
    `severity must be one of: ${SEVERITIES.join(', ')}, or "unknown".`,
    'Use "critical" for deployed airbags, loss of oil pressure, overheating or anything unsafe to drive.',
    'If you are not sure what a code means for this make, set description, system and severity to "unknown". Never guess.',
  ].join('\n');
  const prompt = `Vehicle: ${car}\nCodes: ${codes.join(', ')}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await ai.models.generateContent({
        model, contents: prompt,
        config: { systemInstruction: system, temperature: 0, responseMimeType: 'application/json' },
      });
      const items: any[] = JSON.parse(res.text ?? '').codes;
      const byCode = new Map(items.map((i) => [String(i.code).toUpperCase(), i]));
      if (!codes.every((c) => byCode.has(c))) throw new Error('missing codes in Gemini reply');
      return codes.map((code) => {
        const i = byCode.get(code);
        const severity = SEVERITIES.includes(i.severity) ? i.severity : 'unknown';
        const sys = SYSTEMS.includes(i.system) ? i.system : 'unknown';
        const desc = typeof i.description === 'string' && i.description.trim() ? i.description.trim() : 'unknown';
        const [lo, hi] = CONFIG.costBySeverity[severity];
        const isUnknown = desc.toLowerCase() === 'unknown';
        return { code, description: desc, system: sys, severity, cost_low: lo, cost_high: hi, source: isUnknown ? 'unknown' : 'gemini' };
      });
    } catch {
      // invalid JSON or missing codes: retry once, then fall back to unknown
    }
  }
  return codes.map(unknownCode);
}

function triage(valid: DecodedCode[]): { triage: DecodeResult['triage']; reason: string } {
  const t = CONFIG.triage;
  const reasons: string[] = [];
  if (valid.length >= t.manyCodes) reasons.push(`${valid.length} codes (threshold ${t.manyCodes})`);
  for (const c of valid) {
    if (t.skipSeverities.includes(c.severity)) reasons.push(`${c.code} is ${c.severity} (${c.system})`);
    else if (t.skipSystemsAtMajor.includes(c.system) && c.severity === 'major') reasons.push(`${c.code} is a major ${c.system} fault`);
  }
  if (reasons.length) return { triage: 'skip_inspection_sell_as_is', reason: `Skip inspection: ${reasons.join('; ')}.` };
  if (valid.length === 0) return { triage: 'full_inspection', reason: 'No fault codes reported.' };
  return { triage: 'full_inspection', reason: `${valid.length} code(s), none critical; inspection worth doing.` };
}

// ---- Core, usable from scripts ----

export async function decodeScan(vin: string, rawCodes: string[]): Promise<DecodeResult> {
  const codes = [...new Set(rawCodes.map((c) => c.trim().toUpperCase()))];
  const valid = codes.filter((c) => CODE_RE.test(c));
  const invalid = codes.filter((c) => !CODE_RE.test(c));

  const [vehicle, table] = await Promise.all([decodeVin(vin), valid.length ? lookupTable(valid) : new Map()]);
  // Not in the table (includes every manufacturer-specific code, 2nd char "1") -> Gemini.
  const missing = valid.filter((c) => !table.has(c));
  const fromGemini = new Map((await askGemini(missing, vehicle)).map((d) => [d.code, d]));

  const decoded = valid.map((c) => table.get(c) ?? fromGemini.get(c)!);
  const rank = (s: string) => SEVERITIES.indexOf(s);
  const worst = decoded.reduce((w, c) => (rank(c.severity) > rank(w) ? c.severity : w), decoded.length ? 'unknown' : 'none');

  return {
    vehicle,
    codes: [
      ...decoded,
      ...invalid.map((code) => ({ code, description: 'invalid code format', system: 'unknown', severity: 'unknown', cost_low: 0, cost_high: 0, source: 'invalid' as const })),
    ],
    summary: {
      count: decoded.length,
      worst_severity: worst,
      cost_low: decoded.reduce((s, c) => s + c.cost_low, 0),
      cost_high: decoded.reduce((s, c) => s + c.cost_high, 0),
    },
    ...triage(decoded),
  };
}

// ---- Vercel handler ----

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  const { vin, codes } = req.body ?? {};
  const cleanVin = typeof vin === 'string' ? vin.trim().toUpperCase() : '';
  if (!VIN_RE.test(cleanVin)) return res.status(400).json({ error: 'vin must be 17 characters (no I, O or Q)' });
  if (!Array.isArray(codes) || codes.length > CONFIG.maxCodes || !codes.every((c) => typeof c === 'string')) {
    return res.status(400).json({ error: `codes must be an array of up to ${CONFIG.maxCodes} strings` });
  }
  try {
    return res.status(200).json(await decodeScan(cleanVin, codes));
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
