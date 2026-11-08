// POST /api/decode-codes  { vin, codes, title_status? } -> decoded fault codes, summary and triage.
// title_status is entered by the seller (no free API returns title brands by VIN).
// Generic codes come from the Supabase dtc_codes table; manufacturer-specific or
// unlisted codes are explained by OpenAI at request time (it must say "unknown" rather than guess).
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { lookupRegistry, type RegistryTitle } from './_lib/registry.js';
import { MODULES, type CodeAssessment } from './_lib/scorecard.js';

// ---- Config: every threshold and fallback lives here ----
export const CONFIG = {
  triage: {
    manyCodes: 6,                                  // this many valid codes or more -> skip inspection
    skipSeverities: ['critical'],                  // any code at these severities -> skip
    skipSystemsAtMajor: ['transmission', 'airbag/SRS'], // major-or-worse in these systems -> skip
    skipTitles: ['non_repairable', 'flood'],       // seller-entered title brands that skip inspection
  },
  // Model for explaining codes the table doesn't have. OPENAI_CODES_MODEL overrides; defaults to OPENAI_MODEL.
  codesModel: () => process.env.OPENAI_CODES_MODEL || process.env.OPENAI_MODEL || 'gpt-5.5',
  // Cost band for codes explained by OpenAI (the table has its own costs).
  costBySeverity: {
    minor: [50, 400], moderate: [150, 1500], major: [400, 4000], critical: [1000, 6000], unknown: [100, 3000],
  } as Record<string, [number, number]>,
  maxCodes: 50,
  vpicTimeoutMs: 8000,
  // Price of all codes fixed together, from OpenAI (codes often share one root cause, so summing them overstates).
  combination: { maxCost: 60000 },
};

const SYSTEMS = ['engine', 'transmission', 'brakes/ABS', 'airbag/SRS', 'electrical', 'emissions', 'body'];
const SEVERITIES = ['minor', 'moderate', 'major', 'critical']; // ordered, worst last
export const TITLE_STATUSES = ['clean', 'salvage', 'rebuilt', 'flood', 'non_repairable', 'lemon', 'unknown'] as const;
export type TitleStatus = (typeof TITLE_STATUSES)[number];
const CODE_RE = /^[PCBU][0-3][0-9A-F]{3}$/;
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

type Source = 'generic_table' | 'openai' | 'unknown' | 'invalid';
export type DecodedCode = {
  code: string; description: string; system: string; severity: string;
  cost_low: number; cost_high: number; source: Source;
};
export type Vehicle = { year: string | null; make: string | null; model: string | null; engine: string | null };
export type DecodeResult = {
  vehicle: Vehicle;
  title_status: TitleStatus;
  // 'registry' = verified record in the demo registry (wins over the seller's choice); 'seller' = picked on the page.
  title_source: { from: 'registry'; source: RegistryTitle['source']; title_state: string | null } | { from: 'seller' };
  codes: DecodedCode[];
  summary: { count: number; worst_severity: string; cost_low: number; cost_high: number };
  triage: 'full_inspection' | 'skip_inspection_sell_as_is';
  reason: string;
  // OpenAI's price for fixing all valid codes together and the non-engine modules they point to (null without codes
  // or when OpenAI is unavailable). Feeds the ACV vs Copart scorecard; `summary` still adds each code's own cost.
  combination: CodeAssessment | null;
};

// ---- Steps ----

export async function decodeVin(vin: string): Promise<Vehicle> {
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
    return empty; // vPIC down: keep going, the model just gets less context
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

// Strict schema: one entry per code, enums for system/severity, "unknown" always allowed.
const CODES_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['codes'],
  properties: {
    codes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['code', 'description', 'system', 'severity'],
        properties: {
          code: { type: 'string' },
          description: { type: 'string' },
          system: { type: 'string', enum: [...SYSTEMS, 'unknown'] },
          severity: { type: 'string', enum: [...SEVERITIES, 'unknown'] },
        },
      },
    },
  },
};

async function askOpenAI(codes: string[], vehicle: Vehicle): Promise<DecodedCode[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || codes.length === 0) return codes.map(unknownCode);
  const ai = new OpenAI({ apiKey });
  const model = CONFIG.codesModel();
  const car = [vehicle.year, vehicle.make, vehicle.model, vehicle.engine].filter(Boolean).join(' ') || 'unknown vehicle';
  const system = [
    'You explain OBD-II diagnostic trouble codes for a specific vehicle. Reply as json matching the schema, one entry per input code.',
    'Use "critical" for deployed airbags, loss of oil pressure, overheating or anything unsafe to drive.',
    'If you are not sure what a code means for this make, set description, system and severity to "unknown". Never guess.',
  ].join('\n');
  // Reasoning models (gpt-5.x, o-series) take reasoning_effort and reject temperature; others take temperature 0.
  const sampling = /^(gpt-5|o\d)/.test(model) ? { reasoning_effort: 'low' as const } : { temperature: 0 };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await ai.chat.completions.create({
        model, ...sampling,
        response_format: { type: 'json_schema', json_schema: { name: 'dtc_codes', strict: true, schema: CODES_SCHEMA } },
        messages: [{ role: 'system', content: system }, { role: 'user', content: `Vehicle: ${car}\nCodes: ${codes.join(', ')}` }],
      });
      const items: any[] = JSON.parse(res.choices[0].message.content ?? '').codes;
      const byCode = new Map(items.map((i) => [String(i.code).toUpperCase(), i]));
      if (!codes.every((c) => byCode.has(c))) throw new Error('missing codes in OpenAI reply');
      return codes.map((code) => {
        const i = byCode.get(code);
        const severity = SEVERITIES.includes(i.severity) ? i.severity : 'unknown';
        const sys = SYSTEMS.includes(i.system) ? i.system : 'unknown';
        const desc = typeof i.description === 'string' && i.description.trim() ? i.description.trim() : 'unknown';
        const [lo, hi] = CONFIG.costBySeverity[severity];
        const isUnknown = desc.toLowerCase() === 'unknown';
        return { code, description: desc, system: sys, severity, cost_low: lo, cost_high: hi, source: isUnknown ? 'unknown' : 'openai' };
      });
    } catch (e) {
      // API error, invalid JSON or missing codes: retry once, then fall back to unknown
      console.warn(`OpenAI attempt ${attempt + 1} failed: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  return codes.map(unknownCode);
}

// All codes of one scan, priced together for this vehicle, plus the non-engine control modules they implicate.
const COMBINATION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['root_causes', 'cost_low', 'cost_high', 'modules', 'confidence', 'note'],
  properties: {
    root_causes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['codes', 'cause', 'repair', 'cost_low', 'cost_high'],
        properties: { codes: { type: 'array', items: { type: 'string' } }, cause: { type: 'string' }, repair: { type: 'string' }, cost_low: { type: 'integer' }, cost_high: { type: 'integer' } },
      },
    },
    cost_low: { type: 'integer' },
    cost_high: { type: 'integer' },
    modules: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['module', 'status', 'codes', 'note'],
        properties: {
          module: { type: 'string', enum: [...MODULES] }, status: { type: 'string', enum: ['fault_reported', 'replacement_likely'] },
          codes: { type: 'array', items: { type: 'string' } }, note: { type: 'string' },
        },
      },
    },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    note: { type: 'string' },
  },
};

export async function assessCombination(codes: DecodedCode[], vehicle: Vehicle): Promise<CodeAssessment | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || codes.length === 0) return null;
  const ai = new OpenAI({ apiKey });
  const model = CONFIG.codesModel();
  const car = [vehicle.year, vehicle.make, vehicle.model, vehicle.engine].filter(Boolean).join(' ') || 'unknown vehicle';
  const system = [
    'You price the repair of a set of OBD-II trouble codes read from one vehicle, as a used-car reconditioning manager would. Reply as json matching the schema.',
    'Codes often share one root cause (misfires on several cylinders, a lean condition on both banks, one failed sensor or a wiring fault that sets codes in several modules, a dead battery that sets many U-codes). Group them into root_causes and price each root cause once, not each code.',
    'Prices are whole US dollars for parts plus labor at a typical independent shop for this vehicle. cost_low and cost_high cover fixing every code together: the sum of the root causes, low and high.',
    'modules: the non-engine control modules the codes point to (airbag_srs, abs_brakes, transmission_control, body_control, instrument_cluster, network_communication, steering_suspension, other_electronic). Use replacement_likely only when the codes usually mean the module itself must be replaced (for example stored crash data after an airbag deployment); otherwise fault_reported. Leave the list empty when no such module is involved; the engine computer itself is not listed.',
    'If you are not sure what a code means for this vehicle, say so in the cause, use a wide price range and confidence "low". Never invent a specific repair.',
  ].join('\n');
  const list = codes.map((c) => `${c.code}: ${c.description} (${c.system}, ${c.severity})`).join('\n');
  const sampling = /^(gpt-5|o\d)/.test(model) ? { reasoning_effort: 'low' as const } : { temperature: 0 };
  const known = new Set(codes.map((c) => c.code));
  const dollars = (n: unknown) => Math.max(0, Math.min(CONFIG.combination.maxCost, Math.round(Number(n) || 0)));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await ai.chat.completions.create({
        model, ...sampling,
        response_format: { type: 'json_schema', json_schema: { name: 'code_combination', strict: true, schema: COMBINATION_SCHEMA } },
        messages: [{ role: 'system', content: system }, { role: 'user', content: `Vehicle: ${car}\nCodes:\n${list}` }],
      });
      const r: any = JSON.parse(res.choices[0].message.content ?? '');
      const pair = (lo: unknown, hi: unknown) => { const a = dollars(lo), b = dollars(hi); return a <= b ? [a, b] : [b, a]; };
      const [lo, hi] = pair(r.cost_low, r.cost_high);
      if (hi === 0 && codes.some((c) => c.severity !== 'minor')) throw new Error('no price for the codes');
      const only = (xs: unknown) => (Array.isArray(xs) ? xs.map((x) => String(x).toUpperCase()).filter((x) => known.has(x)) : []);
      return {
        root_causes: (r.root_causes ?? []).map((x: any) => { const [a, b] = pair(x.cost_low, x.cost_high); return { codes: only(x.codes), cause: String(x.cause), repair: String(x.repair), cost_low: a, cost_high: b }; }),
        cost_low: lo, cost_high: hi,
        modules: (r.modules ?? []).filter((m: any) => (MODULES as readonly string[]).includes(m.module))
          .map((m: any) => ({ module: m.module, status: m.status === 'replacement_likely' ? 'replacement_likely' : 'fault_reported', codes: only(m.codes), note: String(m.note) })),
        confidence: ['low', 'medium', 'high'].includes(r.confidence) ? r.confidence : 'low',
        note: String(r.note ?? ''),
      };
    } catch (e) {
      console.warn(`OpenAI code combination attempt ${attempt + 1} failed: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  return null;
}

function triage(valid: DecodedCode[], title: TitleStatus): { triage: DecodeResult['triage']; reason: string } {
  const t = CONFIG.triage;
  const reasons: string[] = [];
  if (t.skipTitles.includes(title)) reasons.push(`${title.replace('_', '-')} title`);
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

export async function decodeScan(vin: string, rawCodes: string[], title: TitleStatus = 'unknown'): Promise<DecodeResult> {
  const codes = [...new Set(rawCodes.map((c) => c.trim().toUpperCase()))];
  const valid = codes.filter((c) => CODE_RE.test(c));
  const invalid = codes.filter((c) => !CODE_RE.test(c));

  const [vehicle, table, registered] = await Promise.all([
    decodeVin(vin), valid.length ? lookupTable(valid) : new Map(), lookupRegistry(vin),
  ]);
  if (registered) title = registered.title_status;
  // Not in the table (includes every manufacturer-specific code, 2nd char "1") -> OpenAI.
  const missing = valid.filter((c) => !table.has(c));
  const fromAI = new Map((await askOpenAI(missing, vehicle)).map((d) => [d.code, d]));

  const decoded = valid.map((c) => table.get(c) ?? fromAI.get(c)!);
  const combination = await assessCombination(decoded, vehicle);
  const rank = (s: string) => SEVERITIES.indexOf(s);
  const worst = decoded.reduce((w, c) => (rank(c.severity) > rank(w) ? c.severity : w), decoded.length ? 'unknown' : 'none');

  return {
    vehicle,
    title_status: title,
    title_source: registered ? { from: 'registry', source: registered.source, title_state: registered.title_state } : { from: 'seller' },
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
    ...triage(decoded, title),
    combination,
  };
}

// ---- Vercel handler ----

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS: the Lovable front end calls this from another origin.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') {
    // Opening the URL in a browser shows how to use it instead of an error.
    return res.status(200).json({
      endpoint: 'POST /api/decode-codes',
      body: { vin: '17-character VIN', codes: ['P0300', 'C0035'], title_status: `optional: ${TITLE_STATUSES.join(' | ')}` },
      returns: 'vehicle, title_status, codes[], summary, triage, reason, combination (all codes priced together + non-engine modules, from OpenAI)',
      try_it: '/',
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  const { vin, codes, title_status = 'unknown' } = req.body ?? {};
  if (!TITLE_STATUSES.includes(title_status)) {
    return res.status(400).json({ error: `title_status must be one of: ${TITLE_STATUSES.join(', ')}` });
  }
  const cleanVin = typeof vin === 'string' ? vin.trim().toUpperCase() : '';
  if (!VIN_RE.test(cleanVin)) return res.status(400).json({ error: 'vin must be 17 characters (no I, O or Q)' });
  if (!Array.isArray(codes) || codes.length > CONFIG.maxCodes || !codes.every((c) => typeof c === 'string')) {
    return res.status(400).json({ error: `codes must be an array of up to ${CONFIG.maxCodes} strings` });
  }
  try {
    return res.status(200).json(await decodeScan(cleanVin, codes, title_status));
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
