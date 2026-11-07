// POST /api/grade-photos  { vin, photos: [JPEG data URLs] } -> part grades, flags, photo gaps.
// All photos of one vehicle go to OpenAI in ONE request (CLAUDE.md "Vision call").
// A strict JSON schema with every part as a required key guarantees all 25 parts come back.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { openaiClient } from './_lib/openai.js';

export const config = { maxDuration: 60 };

export const PARTS = [
  'front_bumper', 'hood', 'grille', 'left_headlight', 'right_headlight', 'windshield',
  'left_front_fender', 'right_front_fender', 'left_front_door', 'right_front_door',
  'left_rear_door', 'right_rear_door', 'left_mirror', 'right_mirror', 'left_rear_quarter',
  'right_rear_quarter', 'tailgate_or_rear_doors', 'rear_bumper', 'left_taillight', 'right_taillight',
  'wheels_and_tires', 'roof', 'interior', 'engine_bay', 'underbody',
] as const;
const GRADES = ['fine', 'repairable', 'replace', 'unknown'] as const;

export const GRADE_CONFIG = {
  maxPhotos: 30,
  imageDetail: 'high' as const,      // damage is small; low detail misses it
  reasoningEffort: 'low' as const,   // GPT-5 models don't accept temperature 0; schema keeps output stable
};

export type GradeResult = {
  parts: { part: string; grade: string; confidence: number; evidence_photo: number | null }[];
  flags: { airbags_deployed: boolean | 'unknown'; frame_suspected: boolean | 'unknown'; fluid_leak: boolean | 'unknown' };
  photo_gaps: string[];
};

const triState = { anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['unknown'] }] };
const partSchema = {
  type: 'object', additionalProperties: false,
  required: ['grade', 'confidence', 'evidence_photo'],
  properties: {
    grade: { type: 'string', enum: GRADES },
    confidence: { type: 'number' },
    evidence_photo: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
  },
};
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['parts', 'flags', 'photo_gaps'],
  properties: {
    parts: { type: 'object', additionalProperties: false, required: [...PARTS], properties: Object.fromEntries(PARTS.map((p) => [p, partSchema])) },
    flags: {
      type: 'object', additionalProperties: false,
      required: ['airbags_deployed', 'frame_suspected', 'fluid_leak'],
      properties: { airbags_deployed: triState, frame_suspected: triState, fluid_leak: triState },
    },
    photo_gaps: { type: 'array', items: { type: 'string' } },
  },
};

const SYSTEM = `You grade vehicle damage from photos for a used-car remarketing tool. Reply with JSON only, matching the schema.
Grade every part:
- fine: no visible damage
- repairable: damaged but fixable (dent, scratch, repairable crack)
- replace: broken, missing, or too damaged to repair
- unknown: not visible or unclear in the photos. Use unknown rather than guess.
Left and right always mean the vehicle's own sides as seen from the driver's seat (US: left = driver side), never the viewer's left or right. A photo of the car's left side shows the left doors, and its front corner shows the left headlight.
Parts: ${PARTS.join(', ')}. "interior" covers seats, dash and airbags; "engine_bay" covers the radiator area and leaks; "underbody" covers frame rails, exhaust and catalytic converter.
evidence_photo is the 1-based number of the photo that best shows the part, or null when the grade is unknown.
confidence is 0 to 1.
flags: true/false only when a photo clearly shows it, otherwise "unknown". frame_suspected is true when damage suggests the frame may be bent (crushed corners, misaligned panel gaps, deployed airbags with heavy front damage).
photo_gaps: short notes on angles that are missing or unusable (e.g. "no clear underbody photo").`;

export async function gradePhotos(vin: string, photos: string[]): Promise<GradeResult> {
  const client = openaiClient();
  if (!client) throw new Error('Set OPENAI_API_KEY and OPENAI_MODEL');
  const { ai, model } = client;

  const content = [
    { type: 'text' as const, text: `VIN ${vin}. ${photos.length} photo(s), numbered in order below. Grade all ${PARTS.length} parts as json.` },
    ...photos.flatMap((url, i) => [
      { type: 'text' as const, text: `Photo ${i + 1}:` },
      { type: 'image_url' as const, image_url: { url, detail: GRADE_CONFIG.imageDetail } },
    ]),
  ];

  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await ai.chat.completions.create({
        model,
        reasoning_effort: GRADE_CONFIG.reasoningEffort,
        response_format: { type: 'json_schema', json_schema: { name: 'vehicle_grades', strict: true, schema: SCHEMA } },
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }],
      });
      const raw = JSON.parse(res.choices[0].message.content ?? '');
      // Schema guarantees every part; clamp values the schema can't express.
      const parts = PARTS.map((part) => {
        const p = raw.parts[part];
        const photo = Number.isInteger(p.evidence_photo) && p.evidence_photo >= 1 && p.evidence_photo <= photos.length ? p.evidence_photo : null;
        return { part, grade: p.grade, confidence: Math.max(0, Math.min(1, Number(p.confidence) || 0)), evidence_photo: p.grade === 'unknown' ? null : photo };
      });
      return { parts, flags: raw.flags, photo_gaps: raw.photo_gaps };
    } catch (e) {
      lastError = (e as Error).message;
      console.warn(`OpenAI grading attempt ${attempt + 1} failed: ${lastError.slice(0, 200)}`);
    }
  }
  throw new Error(`Photo grading failed: ${lastError.slice(0, 200)}`);
}

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') {
    return res.status(200).json({
      endpoint: 'POST /api/grade-photos',
      body: { vin: '17-character VIN', photos: ['data:image/jpeg;base64,... (resized to ~1000px, up to 30)'] },
      returns: 'parts[25] {part, grade, confidence, evidence_photo}, flags, photo_gaps',
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const { vin, photos } = req.body ?? {};
  const cleanVin = typeof vin === 'string' ? vin.trim().toUpperCase() : '';
  if (!VIN_RE.test(cleanVin)) return res.status(400).json({ error: 'vin must be 17 characters (no I, O or Q)' });
  if (!Array.isArray(photos) || photos.length === 0 || photos.length > GRADE_CONFIG.maxPhotos) {
    return res.status(400).json({ error: `photos must be an array of 1 to ${GRADE_CONFIG.maxPhotos} images` });
  }
  if (!photos.every((p) => typeof p === 'string' && PHOTO_RE.test(p))) {
    return res.status(400).json({ error: 'each photo must be a base64 data URL (JPEG, PNG or WebP)' });
  }
  try {
    return res.status(200).json(await gradePhotos(cleanVin, photos));
  } catch (e) {
    return res.status(502).json({ error: (e as Error).message });
  }
}
