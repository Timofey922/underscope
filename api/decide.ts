// POST /api/decide  { title_status, grades, flags, codes, values, assumptions?, vehicle? }
//   -> repair band, after-repair value, as-is band, both net ranges, P(fix wins), verdict, check.
// No AI here: the page calls it again on every reviewer edit. With `vehicle`, replaced parts are priced from eBay
// listings that fit it (api/_lib/parts-prices.ts, cached), otherwise from data/repair_costs.csv.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { decide, DECISION_CONFIG } from './_lib/decision.js';
import { ebayPartPrices } from './_lib/parts-prices.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') {
    return res.status(200).json({
      endpoint: 'POST /api/decide',
      body: {
        title_status: 'clean | salvage | rebuilt | flood | non_repairable | lemon | unknown',
        grades: [{ part: 'hood', grade: 'replace' }],
        flags: { airbags_deployed: 'unknown', frame_suspected: false, fluid_leak: false },
        codes: '[decoded codes from /api/decode-codes]',
        values: { clean_wholesale: 18000, salvage_comps: [6200, 6900, 7400] },
        assumptions: DECISION_CONFIG.defaults,
        vehicle: { year: 2019, make: 'Toyota', model: 'Tacoma', body_type: 'pickup', note: 'optional: prices replaced parts from eBay' },
      },
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  const b = req.body ?? {};
  if (!Array.isArray(b.grades)) return res.status(400).json({ error: 'grades must be an array of { part, grade }' });
  try {
    const replaced = b.grades.filter((g: any) => g && g.grade === 'replace').map((g: any) => String(g.part));
    const part_prices = await ebayPartPrices(b.vehicle, replaced);
    return res.status(200).json(decide({ ...b, part_prices }));
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
