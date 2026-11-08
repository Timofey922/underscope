// POST /api/decode-vin  { vin } -> year, make, model and specs from NHTSA vPIC (free, no key), cached in Supabase.
// 400 for a malformed VIN, 422 "VIN not recognized" when vPIC can't name the year, make and model, 502 if vPIC is down.
// A recognized VIN with a vPIC problem (e.g. a wrong check digit) still decodes, with `warning`.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { decodeVinFull } from './_lib/vin.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') {
    return res.status(200).json({
      endpoint: 'POST /api/decode-vin',
      body: { vin: '17-character VIN' },
      returns: 'year, make, model, trim, bodyClass, vehicleType, engineCylinders, displacementL, fuelType, driveType, gvwr, warning?, cached',
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST /api/decode-vin with { vin }' });
  const r = await decodeVinFull(req.body?.vin);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  return res.status(200).json({ ...r.data, cached: r.cached });
}
