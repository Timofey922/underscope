// POST /api/decode-codes  { vin, codes, title_status? } -> decoded fault codes, summary and triage.
// title_status is entered by the seller (no free API returns title brands by VIN).
// Meaning: generic codes from the Supabase dtc_codes table; manufacturer-specific or unlisted codes
// are explained by OpenAI (it must say "unknown" rather than guess).
// Price: OpenAI (gpt-5.5) prices every code for this exact vehicle at request time. A real quote
// stored with a registry vehicle beats it; fixed bands are only a fallback when the model can't price.
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
  // Model that explains and prices codes. OPENAI_CODES_MODEL overrides; defaults to OPENAI_MODEL.
  codesModel: () => process.env.OPENAI_CODES_MODEL || process.env.OPENAI_MODEL || 'gpt-5.5',
  codesReasoning: 'medium' as const, // more thought per price; ~10-20 s with gpt-5.5
  // Fallback only, when the model can't price a code (no key, API error, or it says unknown).
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

type Source = 'generic_table' | 'openai' | 'unknown' | 'invalid'; // where the meaning came from
// Where the price came from: real quote for this car, OpenAI estimate for this car, or a fixed fallback band.
type CostSource = 'quote' | 'openai_estimate' | 'table_fallback' | 'severity_fallback' | 'none';
export type DecodedCode = {
  code: string; description: string; system: string; severity: string;
  cost_low: number; cost_high: number; source: Source;
  cost_source: CostSource;
  cost_alone?: { low: number; high: number }; // this code's price on its own, before shared repairs were counted once
  repair?: string | null;     // the likely fix the price covers
  quote_note?: string | null; // where a 'quote' cost came from
};
export type Vehicle = { year: string | null; make: string | null; model: string | null; engine: string | null };
export type DecodeResult = {
  vehicle: Vehicle;
  title_status: TitleStatus;
  // 'registry' = verified record in the demo registry (wins over the seller's choice); 'seller' = picked on the page.
  title_source: { from: 'registry'; source: RegistryTitle['source']; title_state: string | null } | { from: 'seller' };
  codes: DecodedCode[];
  summary: { count: number; worst_severity: string; cost_low: number; cost_high: number; shared_repair?: string | null };
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
  return new Map((data ?? []).map((r) => [r.code, { ...r, source: 'generic_table' as const, cost_source: 'table_fallback' as const }]));
}

function unknownCode(code: string): DecodedCode {
  const [lo, hi] = CONFIG.costBySeverity.unknown;
  return { code, description: 'unknown', system: 'unknown', severity: 'unknown', cost_low: lo, cost_high: hi, source: 'unknown', cost_source: 'severity_fallback' };
}

// Strict schema: one entry per code, enums for system/severity, "unknown" / null always allowed.
const CODES_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['codes', 'together'],
  properties: {
    together: {
      type: 'object', additionalProperties: false, required: ['cost_low', 'cost_high', 'shared_repair'],
      properties: { cost_low: { type: ['integer', 'null'] }, cost_high: { type: ['integer', 'null'] }, shared_repair: { type: 'string' } },
    },
    codes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['code', 'description', 'system', 'severity', 'repair', 'cost_low', 'cost_high'],
        properties: {
          code: { type: 'string' },
          description: { type: 'string' },
          system: { type: 'string', enum: [...SYSTEMS, 'unknown'] },
          severity: { type: 'string', enum: [...SEVERITIES, 'unknown'] },
          repair: { type: 'string' },
          cost_low: { type: ['integer', 'null'] },
          cost_high: { type: ['integer', 'null'] },
        },
      },
    },
  },
};

type AIItem = { description: string; system: string; severity: string; repair: string; cost_low: number | null; cost_high: number | null };
type AITogether = { cost_low: number | null; cost_high: number | null; shared_repair: string };
type AIReply = { items: Map<string, AIItem>; together: AITogether | null };

/** Explains codes the table doesn't know and prices every code for this vehicle. null on failure. */
async function askOpenAI(codes: string[], vehicle: Vehicle, known: Map<string, DecodedCode>): Promise<AIReply | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || codes.length === 0) return null;
  const ai = new OpenAI({ apiKey });
  const model = CONFIG.codesModel();
  const car = [vehicle.year, vehicle.make, vehicle.model, vehicle.engine].filter(Boolean).join(' ') || 'unknown vehicle';
  const system = [
    'You explain and price OBD-II diagnostic trouble codes for one specific vehicle. Reply as json matching the schema, one entry per input code.',
    'Meaning: when a code comes with a known meaning, keep it (description, system, severity). Otherwise explain it for this make; if you are not sure what it means, set description, system and severity to "unknown". Never guess.',
    'Severity: "critical" for deployed airbags, loss of oil pressure, overheating or anything unsafe to drive.',
    'Price: cost_low and cost_high are the total US independent-shop bill in dollars (parts + labor + diagnosis) to clear this code on THIS vehicle.',
    'cost_low = the most common cheap fix (e.g. a sensor or filter); cost_high = the expensive fix the code often turns out to be (e.g. high-pressure fuel pump, injectors, turbo, transmission valve body).',
    'Price for this exact engine and brand: direct injection, turbo, diesel, hybrid and luxury or exotic makes (BMW, Mercedes, Audi, Porsche, Land Rover, Maserati...) cost far more in parts and labor than an economy car. Do not reuse generic price ranges.',
    'repair: one short line naming the likely fixes the range covers. If you cannot price it for this vehicle, set cost_low and cost_high to null.',
    'together: the one bill to clear ALL the codes on this car at the same visit. Codes that point to the same failure share one repair, counted once (e.g. P0700 + P0730 + P0868 = one transmission repair; P0300 + P0301 = one misfire cause; P0171 + P0174 = one lean condition). Codes with unrelated causes add up. shared_repair: one short line on what is shared, or "none". With a single code, repeat its price.',
  ].join('\n');
  const lines = codes.map((c) => {
    const k = known.get(c);
    return k ? `${c}: known meaning "${k.description}" (${k.system}, ${k.severity})` : `${c}: meaning not known, explain it for this make`;
  });
  // Reasoning models (gpt-5.x, o-series) take reasoning_effort and reject temperature; others take temperature 0.
  const sampling = /^(gpt-5|o\d)/.test(model) ? { reasoning_effort: CONFIG.codesReasoning } : { temperature: 0 };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await ai.chat.completions.create({
        model, ...sampling,
        response_format: { type: 'json_schema', json_schema: { name: 'dtc_codes', strict: true, schema: CODES_SCHEMA } },
        messages: [{ role: 'system', content: system }, { role: 'user', content: `Vehicle: ${car}\nCodes:\n${lines.join('\n')}` }],
      });
      const reply = JSON.parse(res.choices[0].message.content ?? '');
      const items: any[] = reply.codes;
      const byCode = new Map(items.map((i) => [String(i.code).toUpperCase(), i]));
      if (!codes.every((c) => byCode.has(c))) throw new Error('missing codes in OpenAI reply');
      return { items: new Map(codes.map((c) => [c, byCode.get(c) as AIItem])), together: reply.together ?? null };
    } catch (e) {
      // API error, invalid JSON or missing codes: retry once, then fall back
      console.warn(`OpenAI attempt ${attempt + 1} failed: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  return null;
}

/** Table/AI meaning + AI price for one code; fixed bands only when the model gave no usable price. */
function merge(code: string, table: DecodedCode | undefined, a: AIItem | undefined): DecodedCode {
  let d: DecodedCode;
  if (table) d = { ...table };
  else if (a) {
    const severity = SEVERITIES.includes(a.severity) ? a.severity : 'unknown';
    const desc = typeof a.description === 'string' && a.description.trim() ? a.description.trim() : 'unknown';
    const [lo, hi] = CONFIG.costBySeverity[severity];
    d = { code, description: desc, system: SYSTEMS.includes(a.system) ? a.system : 'unknown', severity,
      cost_low: lo, cost_high: hi, source: desc.toLowerCase() === 'unknown' ? 'unknown' : 'openai', cost_source: 'severity_fallback' };
  } else d = unknownCode(code);
  const lo = Number(a?.cost_low), hi = Number(a?.cost_high);
  if (a && a.cost_low != null && a.cost_high != null && lo > 0 && hi >= lo && d.source !== 'unknown') {
    Object.assign(d, { cost_low: Math.round(lo), cost_high: Math.round(hi), cost_source: 'openai_estimate', repair: a.repair?.trim() || null });
  }
  return d;
}

/**
 * Codes that share one failure (three transmission codes = one rebuild) would be counted three times if each
 * code's price were added up. The model also prices the whole scan as one bill; when that bill is lower than the
 * sum of its own per-code prices, scale the AI-estimated codes down by the same ratio (quotes stay as they are).
 * Returns the shared-repair note, or null when nothing was shared.
 */
function countSharedOnce(decoded: DecodedCode[], ai: AIReply | null): string | null {
  const t = ai?.together;
  if (!ai || !t || t.cost_low == null || t.cost_high == null || decoded.length < 2) return null;
  const priced = [...ai.items.values()].filter((i) => i.cost_low != null && i.cost_high != null && i.cost_high >= i.cost_low && i.cost_low > 0);
  const sumLo = priced.reduce((s, i) => s + Number(i.cost_low), 0), sumHi = priced.reduce((s, i) => s + Number(i.cost_high), 0);
  if (priced.length < 2 || !(sumLo > 0) || !(sumHi > 0) || t.cost_high < t.cost_low || t.cost_low <= 0) return null;
  const fLo = Math.min(1, t.cost_low / sumLo), fHi = Math.min(1, t.cost_high / sumHi);
  if (fLo > 0.98 && fHi > 0.98) return null; // nothing shared
  for (const d of decoded) {
    if (d.cost_source !== 'openai_estimate') continue;
    d.cost_alone = { low: d.cost_low, high: d.cost_high };
    d.cost_low = Math.round(d.cost_low * fLo); d.cost_high = Math.max(d.cost_low, Math.round(d.cost_high * fHi));
  }
  return t.shared_repair && t.shared_repair.toLowerCase() !== 'none' ? t.shared_repair.trim() : 'Some codes share one repair; it is counted once.';
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
  // OpenAI explains codes the table lacks (every manufacturer-specific code, 2nd char "1") and prices them all.
  // Karthik's root-cause call runs at the same time (meanings from the table where known), so it adds no wait.
  const provisional = valid.map((c) => table.get(c) ?? unknownCode(c));
  const [fromAI, combination] = await Promise.all([askOpenAI(valid, vehicle, table), assessCombination(provisional, vehicle)]);

  // A real quote for this car (registry) replaces the estimate; meaning and severity stay.
  const quotes = registered?.code_quotes ?? {};
  const decoded = valid.map((c) => {
    const d = merge(c, table.get(c), fromAI?.items.get(c)), q = quotes[c];
    return q ? { ...d, cost_low: q.low, cost_high: q.high, cost_source: 'quote' as const, quote_note: q.note ?? null } : d;
  });
  const shared = countSharedOnce(decoded, fromAI);
  const total = { low: decoded.reduce((s, c) => s + c.cost_low, 0), high: decoded.reduce((s, c) => s + c.cost_high, 0) };
  // One fault-code total everywhere (repair estimate, scorecard, page): per-code prices with shared repairs counted
  // once and real quotes kept. The root-cause call keeps its causes and modules; its own price is replaced.
  if (combination) Object.assign(combination, { cost_low: total.low, cost_high: total.high });
  const rank = (s: string) => SEVERITIES.indexOf(s);
  const worst = decoded.reduce((w, c) => (rank(c.severity) > rank(w) ? c.severity : w), decoded.length ? 'unknown' : 'none');

  return {
    vehicle,
    title_status: title,
    title_source: registered ? { from: 'registry', source: registered.source, title_state: registered.title_state } : { from: 'seller' },
    codes: [
      ...decoded,
      ...invalid.map((code) => ({ code, description: 'invalid code format', system: 'unknown', severity: 'unknown', cost_low: 0, cost_high: 0, source: 'invalid' as const, cost_source: 'none' as const })),
    ],
    summary: {
      count: decoded.length,
      worst_severity: worst,
      cost_low: total.low,
      cost_high: total.high,
      shared_repair: shared,
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
