// POST /api/grade-photos  { vin, photos: [JPEG data URLs] } -> part grades, every visible problem, flags, photo gaps.
// All photos of one vehicle go to OpenAI in ONE request (CLAUDE.md "Vision call").
// A strict JSON schema with every part as a required key guarantees all 25 parts come back.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { openaiClient } from './_lib/openai.js';
import { repairBand, DECISION_CONFIG, type Decision } from './_lib/decision.js';
import { ebayPartPrices } from './_lib/parts-prices.js';

export const config = { maxDuration: 60 };

export const PARTS = [
  'front_bumper', 'hood', 'grille', 'left_headlight', 'right_headlight', 'windshield',
  'left_front_fender', 'right_front_fender', 'left_front_door', 'right_front_door',
  'left_rear_door', 'right_rear_door', 'left_mirror', 'right_mirror', 'left_rear_quarter',
  'right_rear_quarter', 'tailgate_or_rear_doors', 'rear_bumper', 'left_taillight', 'right_taillight',
  'wheels_and_tires', 'roof', 'interior', 'engine_bay', 'underbody',
] as const;
const GRADES = ['fine', 'repairable', 'replace', 'unknown'] as const;
const PRICE_CLASSES = ['economy', 'mainstream', 'premium', 'luxury', 'unknown'] as const;
const DAMAGE_TYPES = [
  'dent', 'scratch', 'scrape', 'crack', 'broken', 'shattered_glass', 'missing', 'bent_or_deformed', 'crushed',
  'misaligned_panel', 'rust', 'burn', 'water_line', 'deployed_airbag', 'flat_or_damaged_tire', 'fluid_leak', 'other',
] as const;
const FLAGS = ['airbags_deployed', 'frame_suspected', 'fluid_leak', 'flood_suspected', 'fire_damage', 'suspension_damage_suspected'] as const;

export const GRADE_CONFIG = {
  maxPhotos: 30,
  maxCrops: 16,                      // full-resolution close-ups cut by the page from /api/classify-photos boxes
  imageDetail: 'high' as const,      // damage is small; low detail misses it
  reasoningEffort: 'low' as const,   // only for reasoning models (gpt-5.x, o-series); gpt-4o takes temperature 0 instead
  passes: 2,                         // grade twice at once (pass 2 sees the photos in reverse order), keep the worse grade per part
  recheck: true,                     // second look at fine parts next to damage
  recheckAfterS: 35,                 // skip the second look when the passes took longer (Vercel stops a function at 60 s)
  recheckMaxParts: 10, recheckMaxPhotos: 6, recheckMaxCrops: 6,
};

// Close-up cut from photo `photo` around a region stage 1 flagged.
export type Crop = { photo: number; kind: 'damage' | 'vin_label' | 'odometer'; part: string; note: string; image: string };
export type GradeOptions = { views?: (string | null)[]; crops?: Crop[] };

type Tri = boolean | 'unknown';
export type Damage = { part: string; type: string; severity: 'minor' | 'moderate' | 'severe'; description: string; photos: number[]; confidence: number };
export type GradeResult = {
  photo_views: { photo: number; view: string; cue: string }[];
  vehicle: {
    year: number | null; make: string | null; model: string | null; trim: string | null; body_type: string; color: string | null;
    price_class: (typeof PRICE_CLASSES)[number];  // scales parts prices in the repair estimate
    identified_from: string;
    vin_visible: string | null;            // read from a photo (door label, dash), if legible
    vin_check_digit_ok: boolean | null;    // false = misread; never trust a VIN that fails this
    vin_matches_input: boolean | null;     // photo VIN vs the VIN the seller typed
    odometer_visible: number | null; odometer_unit: 'mi' | 'km' | 'unknown';
  };
  parts: { part: string; grade: string; severity: 'minor' | 'moderate' | 'severe' | null; confidence: number; evidence_photo: number | null; note: string }[];
  damages: Damage[];
  missing_parts: { item: string; part: string; photos: number[] }[];
  flags: Record<(typeof FLAGS)[number], Tri>;
  primary_damage_area: string;
  overall_severity: 'none' | 'light' | 'moderate' | 'heavy' | 'total_loss_likely';
  photo_gaps: string[];
  summary: string;
  // Priced from data/repair_costs.csv at the default labor rate; /api/decide reprices with the seller's rate and reviewer edits.
  repair_estimate: Decision['repair'];
  meta: {
    model: string; seconds: number; attempts: number; photos: number; crops: number;
    passes: Record<string, string>[];      // each grading pass's grade per part, before merging
    side_fixes: SideFix[];                 // damage moved to the mirror-image part
    recheck: { parts: string[]; upgraded: string[]; seconds: number; skipped?: string };
  };
};

const triState = { anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['unknown'] }] };
const nullable = (type: string) => ({ anyOf: [{ type }, { type: 'null' }] });
const photoList = { type: 'array', items: { type: 'integer' } };
const partSchema = {
  type: 'object', additionalProperties: false,
  required: ['grade', 'confidence', 'evidence_photo', 'note'],
  properties: {
    grade: { type: 'string', enum: GRADES },
    confidence: { type: 'number' },
    evidence_photo: nullable('integer'),
    note: { type: 'string' },
  },
};
const VIEWS = ['front', 'front_left', 'left_side', 'rear_left', 'rear', 'rear_right', 'right_side', 'front_right',
  'interior', 'dashboard', 'engine_bay', 'underbody', 'label_or_document', 'detail', 'other'] as const;
// Property order matters: the model writes photo_views first, so left/right is settled before any part is graded.
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['photo_views', 'vehicle', 'parts', 'damages', 'missing_parts', 'flags', 'primary_damage_area', 'overall_severity', 'photo_gaps', 'summary'],
  properties: {
    photo_views: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['photo', 'cue', 'view'],
        properties: { photo: { type: 'integer' }, cue: { type: 'string' }, view: { type: 'string', enum: VIEWS } },
      },
    },
    vehicle: {
      type: 'object', additionalProperties: false,
      required: ['year', 'make', 'model', 'trim', 'body_type', 'color', 'price_class', 'identified_from', 'vin_visible', 'odometer_visible', 'odometer_unit'],
      properties: {
        year: nullable('integer'), make: nullable('string'), model: nullable('string'), trim: nullable('string'),
        body_type: { type: 'string', enum: ['sedan', 'coupe', 'hatchback', 'wagon', 'suv', 'pickup', 'minivan', 'passenger_van', 'cargo_van', 'other', 'unknown'] },
        color: nullable('string'),
        price_class: { type: 'string', enum: PRICE_CLASSES },
        identified_from: { type: 'string' },
        vin_visible: nullable('string'),
        odometer_visible: nullable('integer'),
        odometer_unit: { type: 'string', enum: ['mi', 'km', 'unknown'] },
      },
    },
    parts: { type: 'object', additionalProperties: false, required: [...PARTS], properties: Object.fromEntries(PARTS.map((p) => [p, partSchema])) },
    damages: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['part', 'type', 'severity', 'description', 'photos', 'confidence'],
        properties: {
          part: { type: 'string', enum: PARTS },
          type: { type: 'string', enum: DAMAGE_TYPES },
          severity: { type: 'string', enum: ['minor', 'moderate', 'severe'] },
          description: { type: 'string' },
          photos: photoList,
          confidence: { type: 'number' },
        },
      },
    },
    missing_parts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['item', 'part', 'photos'],
        properties: { item: { type: 'string' }, part: { type: 'string', enum: PARTS }, photos: photoList },
      },
    },
    flags: { type: 'object', additionalProperties: false, required: [...FLAGS], properties: Object.fromEntries(FLAGS.map((f) => [f, triState])) },
    primary_damage_area: { type: 'string', enum: ['front', 'rear', 'left_side', 'right_side', 'roof', 'undercarriage', 'interior', 'all_over', 'none', 'unknown'] },
    overall_severity: { type: 'string', enum: ['none', 'light', 'moderate', 'heavy', 'total_loss_likely'] },
    photo_gaps: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
};

// Grade definitions, shared by the grading passes and the second look at parts next to damage.
const GRADE_RULES = `- fine: visible in at least one photo (even at an angle or partly) and undamaged.
- repairable: damaged but fixable: any dent or crease (even small), scrape or scratch through the paint, repairable crack, scuffed or torn bumper cover.
- replace: broken, cracked through, shattered, missing, crushed or torn, or too damaged to repair. A deployed airbag makes interior "replace".
- unknown: ONLY when no photo shows the part at all (typically the underbody, the top of the roof, or a side that was not photographed). Every part you can see in any photo gets fine, repairable or replace.
- Glass, lights, mirrors, wheels and tires have fixed rules. Check each of them in every photo before grading:
  - windshield: replace if it has any crack, a hole, or a chip with cracks running from it; a single small chip with no cracks is repairable.
  - headlights and taillights: replace if the lens is cracked, broken, holed or missing, the light is hanging, pushed in or out of its opening, or has water inside; a scuffed lens with no crack is repairable.
  - mirrors: replace if the mirror is missing, hanging, folded flat by a hit, its housing is cracked or broken, or its glass is cracked or missing; a scraped mirror cap is repairable.
  - wheels_and_tires: replace if any tire is flat, torn or off the rim, or any wheel is bent, cracked, broken or missing; curb rash on a wheel is repairable.
- Missing real damage costs more than one extra "repairable", so when a panel looks dented or scraped, grade it repairable.
- Dirt, water spots, wash marks, light swirl marks, tiny stone chips and faded headlight lenses are not damage: grade them fine.
- Grade the panel the damage is actually on. Damage on a bumper corner does not make the fender, headlight or grille repairable unless that part itself is dented, scratched, cracked or pushed out of line.`;

const SYSTEM = `You are an experienced auto-damage appraiser grading one vehicle from its photos for a used-car remarketing tool. Reply with JSON only, matching the schema. Work through the steps in order; the JSON fields come in the same order.

Left and right ALWAYS mean the vehicle's own sides as seen from the driver's seat (US: left = driver side), never the left or right of the picture.

STEP 1 - photo_views: one entry per photo with its view and the cue you used.
- If a photo's label gives its view ("view from the photo classifier"), copy it. It was worked out from where the headlights and taillights sit in the picture. Override it only if the photo plainly contradicts it, and say why in cue.
- Otherwise: in a side or three-quarter photo, if the vehicle's front end points toward the LEFT edge of the picture you are looking at its LEFT side; toward the RIGHT edge, its RIGHT side. A van's sliding side door and its track rail are on the right side.
- In a straight-on FRONT photo you face the vehicle, so its LEFT headlight, fender and mirror are on the RIGHT half of the picture. In a straight-on REAR photo its LEFT taillight is on the LEFT half.

STEP 2 - look at every photo and every close-up crop before grading. Crops are full-resolution cut-outs of areas a first pass flagged, each from the numbered photo shown in its label; a crop with no real damage is a false alarm, and its part label is only a hint. Scan the whole vehicle in each photo: bumpers, grille, lights, hood, every door, quarter panels, wheels and tires, glass, mirrors. Small dents and creases show as bent reflections or uneven panel gaps.

STEP 3 - grade all 25 parts:
${GRADE_RULES}
Parts: ${PARTS.join(', ')}. "interior" covers seats, dash and airbags; "engine_bay" covers the radiator area and leaks; "underbody" covers frame rails, exhaust and catalytic converter.
evidence_photo is the number of the photo that best shows the part (never a crop number), or null when the grade is unknown. note is a few words on what you saw. confidence is 0 to 1.

STEP 4 - the rest:
- damages: every distinct problem that needs repair (not dirt or wear), with a specific description (where, how big) and the photo numbers that show it. Every part graded repairable or replace needs at least one entry. severity sets that part's price: minor = one small spot (a small dent, a short scratch, a chipped lens); moderate = a larger area or several spots; severe = most of the part, deep or torn damage, or crushed or missing with its mounts.
- missing_parts: specific items that are absent (e.g. "front bumper cover", "left headlight assembly", "driver mirror glass").
- flags: true/false only when a photo clearly shows it, otherwise "unknown". frame_suspected is true when damage suggests the frame may be bent (crushed corners, pushed-in wheels, misaligned panel gaps, deployed airbags with heavy front damage).
- vehicle.price_class sets parts prices: economy (Kia, Hyundai, Nissan Versa-type small cars), mainstream (Toyota, Honda, Ford, Chevrolet, most pickups and SUVs), premium (Acura, Lexus, Buick, Volvo, loaded full-size trucks), luxury (BMW, Mercedes-Benz, Audi, Porsche, Land Rover, Tesla), unknown if you cannot tell the make.
- vehicle: year/make/model/trim/color only from badges, labels, body shape or text visible in the photos; say what you used in identified_from. If a door-jamb label shows a build date (MM/YY), the model year is that year or the next one. Read the VIN from the VIN-label crop if there is one, character by character; copy a VIN or odometer reading only if you can read every character, otherwise null. The odometer is the total-distance reading (not TRIP A/B, range or outside temperature); count its digits one by one and keep every leading digit (115,000 has six digits, not five).
- photo_gaps: angles that are missing or unusable (e.g. "no clear underbody photo").
- summary: 2-3 plain sentences for a used-car manager: what is damaged, how badly, and what the photos cannot show. Physical damage only; no prices (they are worked out from your grades and severities).`;

// North American VIN check digit (position 9). A misread VIN almost always fails it.
export function vinCheckDigitOk(vin: string | null): boolean | null {
  if (!vin) return null;
  const v = vin.toUpperCase().replace(/\s/g, '');
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return false;
  const map: Record<string, number> = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
  const weights = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
  const sum = [...v].reduce((s, ch, i) => s + (/\d/.test(ch) ? Number(ch) : map[ch]) * weights[i], 0);
  return v[8] === (sum % 11 === 10 ? 'X' : String(sum % 11));
}

// ---- Extra checks around the grading passes (GRADE_CONFIG) ----
type Raw = any; // the model's JSON, shaped by SCHEMA
type PartGrade = { grade: string; confidence: number; evidence_photo: number | null; note: string };
export type SideFix = { from: string; to: string; photos: number[] };
const RANK: Record<string, number> = { unknown: 0, fine: 1, repairable: 2, replace: 3 };
const OVERALL = ['none', 'light', 'moderate', 'heavy', 'total_loss_likely'];
const isDamaged = (g: string) => g === 'repairable' || g === 'replace';
const mirrorOf = (p: string) => (p.startsWith('left_') ? `right_${p.slice(5)}` : p.startsWith('right_') ? `left_${p.slice(6)}` : null);

// Two passes over the same photos: keep the worse grade per part (a missed dent costs more than an extra "repairable").
export function mergePasses(a: Raw, b: Raw): Raw {
  const parts: Record<string, PartGrade> = {}, damages: Damage[] = [];
  for (const part of PARTS) {
    const win = RANK[b.parts[part].grade] > RANK[a.parts[part].grade] ? b : a, other = win === a ? b : a;
    parts[part] = win.parts[part];
    if (!isDamaged(parts[part].grade)) continue;
    const own: Damage[] = win.damages.filter((d: Damage) => d.part === part);
    const extra: Damage[] = other.parts[part].grade === parts[part].grade ? other.damages.filter((d: Damage) => d.part === part && !own.some((o) => o.type === d.type)) : [];
    damages.push(...own, ...extra);
  }
  const flags: Record<string, Tri> = {};
  for (const f of FLAGS) { const x = [a.flags[f], b.flags[f]]; flags[f] = x.includes(true) ? true : x.includes('unknown') ? 'unknown' : false; }
  const seen = new Set<string>();
  const missing = [...a.missing_parts, ...b.missing_parts].filter((m: { item: string; part: string }) =>
    isDamaged(parts[m.part]?.grade ?? '') && !seen.has(m.item.toLowerCase()) && !!seen.add(m.item.toLowerCase()));
  const count = (r: Raw) => PARTS.filter((p) => isDamaged(r.parts[p].grade)).length;
  const lead = count(b) > count(a) ? b : a;
  const vehicle = { ...a.vehicle };
  for (const k of Object.keys(b.vehicle)) if (vehicle[k] == null) vehicle[k] = b.vehicle[k];
  return {
    ...a, vehicle, parts, damages, missing_parts: missing, flags,
    primary_damage_area: lead.primary_damage_area, summary: lead.summary,
    overall_severity: OVERALL[Math.max(OVERALL.indexOf(a.overall_severity), OVERALL.indexOf(b.overall_severity))],
    photo_gaps: [...new Set([...a.photo_gaps, ...b.photo_gaps])],
  };
}

// Side panels and mirrors only show from their own side. When every photo that shows a part's damage is a view of
// the OTHER side, the model put it on the mirror-image part: move it there. Three-quarter views count only for doors
// (the far side's fender, mirror or quarter can peek into them).
const SIDE_ONLY = /^(left|right)_(front_fender|front_door|rear_door|rear_quarter|mirror)$/;
function viewSide(view: string | null | undefined, part: string): 'left' | 'right' | null {
  if (view === 'left_side' || view === 'right_side') return view === 'left_side' ? 'left' : 'right';
  const m = /_door$/.test(part) ? view?.match(/^(?:front|rear)_(left|right)$/) : null;
  return m ? (m[1] as 'left' | 'right') : null;
}
export function fixSides(raw: Raw, viewOf: (photo: number) => string | null, photoCount: number): SideFix[] {
  const fixes: SideFix[] = [];
  for (const part of PARTS) {
    if (!SIDE_ONLY.test(part) || !isDamaged(raw.parts[part].grade)) continue;
    const own = part.startsWith('left_') ? 'left' : 'right', to = mirrorOf(part)!;
    const shots = [...new Set([raw.parts[part].evidence_photo, ...raw.damages.filter((d: Damage) => d.part === part).flatMap((d: Damage) => d.photos)])]
      .filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= photoCount);
    const sides = shots.map((n) => viewSide(viewOf(n), part)).filter(Boolean);
    if (!sides.length || sides.includes(own)) continue;
    const from: PartGrade = raw.parts[part];
    if (RANK[from.grade] > RANK[raw.parts[to].grade]) raw.parts[to] = { ...from, note: `${from.note} (moved from ${part})` };
    raw.damages = raw.damages.map((d: Damage) => (d.part === part ? { ...d, part: to } : d));
    raw.missing_parts = raw.missing_parts.map((m: { part: string }) => (m.part === part ? { ...m, part: to } : m));
    const ownPhoto = Array.from({ length: photoCount }, (_, i) => i + 1).find((n) => viewSide(viewOf(n), part) === own) ?? null;
    raw.parts[part] = { grade: ownPhoto ? 'fine' : 'unknown', confidence: 0.5, evidence_photo: ownPhoto, note: `damage moved to ${to}: it only shows in photos of the other side` };
    fixes.push({ from: part, to, photos: shots });
  }
  return fixes;
}

// Parts next to each other ("S_" = the same side). A hit often damages the neighbors of the part it hit.
const ADJACENT: [string, string][] = [
  ['front_bumper', 'hood'], ['front_bumper', 'grille'], ['front_bumper', 'S_headlight'], ['front_bumper', 'S_front_fender'], ['front_bumper', 'engine_bay'],
  ['hood', 'grille'], ['hood', 'windshield'], ['hood', 'S_front_fender'], ['hood', 'S_headlight'], ['hood', 'engine_bay'],
  ['grille', 'S_headlight'], ['grille', 'engine_bay'], ['S_headlight', 'S_front_fender'],
  ['S_front_fender', 'S_front_door'], ['S_front_fender', 'S_mirror'], ['S_front_fender', 'wheels_and_tires'],
  ['S_front_door', 'S_rear_door'], ['S_front_door', 'S_mirror'], ['S_front_door', 'S_rear_quarter'],
  ['S_rear_door', 'S_rear_quarter'], ['S_rear_door', 'wheels_and_tires'],
  ['S_rear_quarter', 'rear_bumper'], ['S_rear_quarter', 'S_taillight'], ['S_rear_quarter', 'tailgate_or_rear_doors'], ['S_rear_quarter', 'wheels_and_tires'],
  ['rear_bumper', 'tailgate_or_rear_doors'], ['rear_bumper', 'S_taillight'], ['tailgate_or_rear_doors', 'S_taillight'], ['windshield', 'roof'],
];
const NEIGHBORS = new Map<string, Set<string>>();
for (const [x, y] of ADJACENT) for (const side of ['left_', 'right_']) {
  const a = x.replace('S_', side), b = y.replace('S_', side);
  if (!NEIGHBORS.has(a)) NEIGHBORS.set(a, new Set()); if (!NEIGHBORS.has(b)) NEIGHBORS.set(b, new Set());
  NEIGHBORS.get(a)!.add(b); NEIGHBORS.get(b)!.add(a);
}

const RECHECK_SYSTEM = `You are an experienced auto-damage appraiser taking a second, closer look at some parts of one damaged vehicle. Reply with JSON only, matching the schema.

Left and right ALWAYS mean the vehicle's own sides as seen from the driver's seat (US: left = driver side), never the left or right of the picture. The photo labels give each photo's view.

You get the photos that show the damage already found, and a list of parts NEXT TO that damage. A hit often also dents, scrapes, cracks or pushes out of line the parts beside the one it hit: a fender edge bent back by the bumper, a headlight pushed out of its opening, a hood gap that is wider on one side, a door scraped where the fender was pushed into it. Look closely at each listed part in every photo and close-up that shows it, and grade it on its own:
${GRADE_RULES}
For each part give the grade, the damage type and severity (none when fine or unknown), a short description of what you see on that part, and the numbers of the photos that show it (photo numbers, never crop numbers; empty when unknown). Grade a part repairable or replace only if you can see damage on that part itself in a photo.`;

function recheckSchema(parts: string[]) {
  return {
    type: 'object', additionalProperties: false, required: parts,
    properties: Object.fromEntries(parts.map((p) => [p, {
      type: 'object', additionalProperties: false, required: ['grade', 'type', 'severity', 'description', 'photos'],
      properties: {
        grade: { type: 'string', enum: GRADES }, type: { type: 'string', enum: DAMAGE_TYPES },
        severity: { type: 'string', enum: ['none', 'minor', 'moderate', 'severe'] }, description: { type: 'string' }, photos: photoList,
      },
    }])),
  };
}

export async function gradePhotos(vin: string, photos: string[], opts: GradeOptions = {}): Promise<GradeResult> {
  const client = openaiClient();
  if (!client) throw new Error('Set OPENAI_API_KEY and OPENAI_MODEL');
  const { ai, model } = client;
  const views = opts.views ?? [];
  const crops = (opts.crops ?? []).slice(0, GRADE_CONFIG.maxCrops);
  const C = GRADE_CONFIG;
  // Reasoning models (gpt-5.x, o-series) take reasoning_effort and reject temperature; gpt-4o is the other way round.
  const sampling = /^(gpt-5|o\d)/.test(model) ? { reasoning_effort: C.reasoningEffort } : { temperature: 0 };
  const started = Date.now();
  const elapsed = () => (Date.now() - started) / 1000;
  const okPhoto = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= photos.length;
  const clamp01 = (n: unknown) => Math.max(0, Math.min(1, Number(n) || 0));

  // Photos and crops keep their numbers whatever order they are shown in, so passes can see them in different orders.
  const photoBlock = (i: number) => [
    { type: 'text' as const, text: views[i] ? `Photo ${i + 1} (${views[i]!.replace(/_/g, '-')} view from the photo classifier):` : `Photo ${i + 1}:` },
    { type: 'image_url' as const, image_url: { url: photos[i], detail: C.imageDetail } },
  ];
  const cropBlock = (i: number) => [
    { type: 'text' as const, text: `Crop ${i + 1}, from photo ${crops[i].photo} (${crops[i].kind === 'damage' ? `possible damage on ${crops[i].part}` : crops[i].kind.replace('_', ' ')}: ${crops[i].note}):` },
    { type: 'image_url' as const, image_url: { url: crops[i].image, detail: C.imageDetail } },
  ];
  const content = (photoOrder: number[], cropOrder: number[], intro: string) => [
    { type: 'text' as const, text: intro },
    ...photoOrder.flatMap(photoBlock),
    ...(cropOrder.length ? [{ type: 'text' as const, text: `${cropOrder.length} close-up crop(s) at full resolution:` }] : []),
    ...cropOrder.flatMap(cropBlock),
  ];
  const ask = async (name: string, system: string, schema: object, user: ReturnType<typeof content>) => {
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await ai.chat.completions.create({
          model, ...sampling,
          response_format: { type: 'json_schema', json_schema: { name, strict: true, schema: schema as Record<string, unknown> } },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        });
        return JSON.parse(res.choices[0].message.content ?? '');
      } catch (e) {
        lastError = (e as Error).message;
        console.warn(`OpenAI ${name} attempt ${attempt + 1} failed: ${lastError.slice(0, 200)}`);
      }
    }
    throw new Error(lastError);
  };

  // 1. Grade in C.passes passes at once; pass 2 sees the photos and crops in reverse order.
  const n = photos.length, idx = (k: number) => Array.from({ length: k }, (_, i) => i);
  const intro = `VIN ${vin}. ${n} photo(s), each labeled with its number; refer to photos by these numbers. Grade all ${PARTS.length} parts and list every problem as json.`;
  const orders = [[idx(n), idx(crops.length)], [idx(n).reverse(), idx(crops.length).reverse()]].slice(0, Math.max(1, C.passes));
  const settled = await Promise.allSettled(orders.map(([po, co]) => ask('vehicle_grades', SYSTEM, SCHEMA, content(po, co, intro))));
  const passes = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  if (!passes.length) throw new Error(`Photo grading failed: ${String((settled[0] as PromiseRejectedResult).reason?.message ?? '').slice(0, 200)}`);
  const gradesOf = (r: Raw) => Object.fromEntries(PARTS.map((p) => [p, r.parts[p].grade]));
  const passGrades = passes.map(gradesOf);
  const raw: Raw = passes.length > 1 ? mergePasses(passes[0], passes[1]) : passes[0];

  // 2. Damage seen only from the other side goes to the mirror-image part.
  const modelView = new Map<number, string>(raw.photo_views.map((p: { photo: number; view: string }) => [p.photo, p.view]));
  const viewOf = (photo: number) => views[photo - 1] ?? modelView.get(photo) ?? null;
  const sideFixes = fixSides(raw, viewOf, n);

  // 3. Second look at fine parts next to damage, with the photos that show the damage (skipped when time is short).
  const recheck: { parts: string[]; upgraded: string[]; seconds: number; skipped?: string } = { parts: [], upgraded: [], seconds: 0 };
  const damagedParts: string[] = PARTS.filter((p) => isDamaged(raw.parts[p].grade));
  const candidates = PARTS.filter((p) => raw.parts[p].grade === 'fine' && damagedParts.some((d) => NEIGHBORS.get(d)?.has(p)))
    .sort((x, y) => damagedParts.filter((d) => NEIGHBORS.get(d)?.has(y)).length - damagedParts.filter((d) => NEIGHBORS.get(d)?.has(x)).length)
    .slice(0, C.recheckMaxParts);
  if (!C.recheck || !candidates.length) recheck.skipped = !C.recheck ? 'off' : 'nothing next to damage';
  else if (elapsed() > C.recheckAfterS) recheck.skipped = `time (${Math.round(elapsed())} s)`;
  else {
    const t0 = Date.now();
    const votes = new Map<number, number>();
    const vote = (k: unknown, w: number) => { if (okPhoto(k)) votes.set(k as number, (votes.get(k as number) ?? 0) + w); };
    for (const d of raw.damages as Damage[]) if (damagedParts.includes(d.part)) d.photos.forEach((k) => vote(k, 2));
    for (const p of [...damagedParts, ...candidates]) vote(raw.parts[p].evidence_photo, 1);
    const shown = [...votes.entries()].sort((x, y) => y[1] - x[1]).slice(0, C.recheckMaxPhotos).map(([k]) => k).sort((x, y) => x - y);
    const shownCrops = idx(crops.length).filter((i) => shown.includes(crops[i].photo)).slice(0, C.recheckMaxCrops);
    const found = (raw.damages as Damage[]).filter((d) => damagedParts.includes(d.part)).map((d) => `${d.part} (${d.severity} ${d.type.replace(/_/g, ' ')}): ${d.description}`).join('; ');
    const ask2 = `Damage already found: ${found || damagedParts.join(', ')}. Grade these parts next to it: ${candidates.join(', ')}.`;
    try {
      const rr = await ask('neighbor_check', RECHECK_SYSTEM, recheckSchema(candidates), content(shown.map((k) => k - 1), shownCrops, ask2));
      recheck.parts = candidates;
      for (const p of candidates) {
        const x = rr[p], seenIn = (x?.photos ?? []).filter(okPhoto);
        if (!x || !isDamaged(x.grade) || !seenIn.length) continue;
        const severity = x.severity === 'none' ? 'minor' : x.severity;
        raw.parts[p] = { grade: x.grade, confidence: 0.6, evidence_photo: seenIn[0], note: `second look: ${x.description}` };
        raw.damages.push({ part: p, type: x.type, severity, description: x.description, photos: seenIn, confidence: 0.6 });
        recheck.upgraded.push(p);
      }
      if (recheck.upgraded.length) sideFixes.push(...fixSides(raw, viewOf, n));
    } catch (e) {
      recheck.skipped = `failed: ${(e as Error).message.slice(0, 80)}`;
    }
    recheck.seconds = Math.round((Date.now() - t0) / 100) / 10;
  }

  // A part's severity (it prices the part) = the worst problem listed on it in damages.
  const SEV = ['minor', 'moderate', 'severe'];
  const worst = new Map<string, number>();
  for (const d of raw.damages as Damage[]) worst.set(d.part, Math.max(worst.get(d.part) ?? -1, SEV.indexOf(d.severity)));
  // Schema guarantees every part; clamp values the schema can't express.
  const parts = PARTS.map((part) => {
    const p = raw.parts[part];
    const photo = okPhoto(p.evidence_photo) ? p.evidence_photo : null;
    const w = worst.get(part) ?? -1;
    const severity = isDamaged(p.grade) && w >= 0 ? (SEV[w] as Damage['severity']) : null;
    return { part, grade: p.grade, severity, confidence: clamp01(p.confidence), evidence_photo: p.grade === 'unknown' ? null : photo, note: p.note };
  });
  const v = raw.vehicle;
  const photoVin = v.vin_visible ? String(v.vin_visible).toUpperCase().replace(/\s/g, '') : null;
  const checkOk = vinCheckDigitOk(photoVin);
  // Replaced parts priced from eBay for the vehicle seen in the photos (the page reprices with the VIN's vehicle via /api/decide).
  const part_prices = await ebayPartPrices({ year: v.year, make: v.make, model: v.model, body_type: v.body_type }, parts.filter((p) => p.grade === 'replace').map((p) => p.part));
  const repair_estimate = repairBand({ grades: parts, flags: raw.flags, vehicle_class: v.price_class, part_prices }, DECISION_CONFIG.defaults.labor_rate);
  return {
    photo_views: raw.photo_views.filter((p: { photo: number }) => okPhoto(p.photo)),
    vehicle: {
      year: v.year, make: v.make, model: v.model, trim: v.trim, body_type: v.body_type, color: v.color,
      price_class: v.price_class, identified_from: v.identified_from,
      vin_visible: photoVin,
      vin_check_digit_ok: checkOk,
      vin_matches_input: photoVin && checkOk ? photoVin === vin : null,
      odometer_visible: v.odometer_visible, odometer_unit: v.odometer_unit,
    },
    parts,
    damages: raw.damages.map((d: Damage) => ({ ...d, photos: d.photos.filter(okPhoto), confidence: clamp01(d.confidence) })),
    missing_parts: raw.missing_parts.map((m: { item: string; part: string; photos: number[] }) => ({ ...m, photos: m.photos.filter(okPhoto) })),
    flags: raw.flags,
    primary_damage_area: raw.primary_damage_area,
    overall_severity: raw.overall_severity,
    photo_gaps: raw.photo_gaps,
    summary: raw.summary,
    repair_estimate,
    meta: {
      model, seconds: Math.round(elapsed() * 10) / 10, attempts: passes.length, photos: n, crops: crops.length,
      passes: passGrades, side_fixes: sideFixes, recheck,
    },
  };
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
      body: {
        vin: '17-character VIN', photos: ['data:image/jpeg;base64,... (resized to ~1000px, up to 30)'],
        views: ['optional, per photo: view from /api/classify-photos, or null'],
        crops: [{ photo: 1, kind: 'damage | vin_label | odometer', part: 'part name or none', note: '...', image: 'data:image/jpeg;base64,...' }],
      },
      returns: 'vehicle, parts[25] {part, grade, severity, confidence, evidence_photo, note}, damages[], missing_parts[], flags, primary_damage_area, overall_severity, photo_gaps, summary, repair_estimate {low, high, lines[] per part: parts_cost, parts_source (ebay | table), labor_hours, labor_cost, paint_cost}, meta',
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const { vin, photos, views, crops } = req.body ?? {};
  const cleanVin = typeof vin === 'string' ? vin.trim().toUpperCase() : '';
  if (!VIN_RE.test(cleanVin)) return res.status(400).json({ error: 'vin must be 17 characters (no I, O or Q)' });
  if (!Array.isArray(photos) || photos.length === 0 || photos.length > GRADE_CONFIG.maxPhotos) {
    return res.status(400).json({ error: `photos must be an array of 1 to ${GRADE_CONFIG.maxPhotos} images` });
  }
  if (!photos.every((p) => typeof p === 'string' && PHOTO_RE.test(p))) {
    return res.status(400).json({ error: 'each photo must be a base64 data URL (JPEG, PNG or WebP)' });
  }
  if (views !== undefined && (!Array.isArray(views) || !views.every((v) => v === null || typeof v === 'string'))) {
    return res.status(400).json({ error: 'views must be an array of view names or null' });
  }
  const cropsOk = crops === undefined || (Array.isArray(crops) && crops.length <= GRADE_CONFIG.maxCrops && crops.every((c) =>
    c && Number.isInteger(c.photo) && c.photo >= 1 && c.photo <= photos.length && typeof c.image === 'string' && PHOTO_RE.test(c.image)));
  if (!cropsOk) return res.status(400).json({ error: `crops must be up to ${GRADE_CONFIG.maxCrops} {photo, kind, part, note, image} with a valid photo number and data URL` });
  try {
    return res.status(200).json(await gradePhotos(cleanVin, photos, { views, crops }));
  } catch (e) {
    return res.status(502).json({ error: (e as Error).message });
  }
}
