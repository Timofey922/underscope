// Checks the ACV vs Copart scorecard (api/_lib/scorecard.ts) on hand-made cases, one per kind of answer.
// npm run test:scorecard   (no network, no keys)
import { scoreChannels, SCORECARD_CONFIG, DRIVE_ITEMS, type ScoreInput, type Drivability, type CodeAssessment } from '../api/_lib/scorecard.ts';
import { PARTS } from '../api/grade-photos.ts';

const grades = (damaged: Record<string, string> = {}, rest = 'fine') => PARTS.map((part) => ({ part, grade: damaged[part] ?? rest }));
const clearFlags = { airbags_deployed: false, frame_suspected: false, fluid_leak: false } as const;
// market(n): the model is listed on n different public sites in the state (2+ = a real dealer market).
const market = (n: number, extra: object = {}) => ({ ran: true, listings: n * 2, sites: Array.from({ length: n }, (_, i) => `site${i}.com`), state: 'NY', age_years: 5, mileage: 60000, ...extra });
// What the photo model reports; everything good unless overridden.
const drive = (over: Partial<Record<keyof Drivability, string>> = {}): Drivability => Object.fromEntries(DRIVE_ITEMS.map((k) =>
  [k, { status: over[k] ?? { damage_location: 'none', fluids: 'dry', rust: 'none', tires: 'good', brakes: 'unknown', glass: 'intact', modifications: 'none' }[k], note: 'test' }])) as Drivability;
const assess = (cost_low: number, cost_high: number, extra: Partial<CodeAssessment> = {}): CodeAssessment =>
  ({ root_causes: [], cost_low, cost_high, modules: [], confidence: 'medium', note: 'test', ...extra });

const cases: { name: string; want: string; inp: ScoreInput }[] = [
  { name: 'clean, drives (photos), cheap repair', want: 'acv', inp: {
    title_status: 'clean', drivability: drive({ damage_location: 'cosmetic' }), grades: grades({ rear_bumper: 'repairable' }), flags: clearFlags,
    repair: { low: 400, high: 900 }, clean_wholesale: 18000, arv_high: 17100, market: market(3) } },
  { name: "salvage, doesn't drive (seller, no photos), heavy damage", want: 'copart', inp: {
    title_status: 'salvage', drivable: 'no', flags: { ...clearFlags, frame_suspected: 'unknown' },
    grades: grades({ front_bumper: 'replace', hood: 'replace', grille: 'replace', left_headlight: 'replace', right_headlight: 'replace', windshield: 'replace' }),
    repair: { low: 4000, high: 11000 }, clean_wholesale: 14000, arv_high: 10600, market: market(1) } },
  { name: 'repair costs more than the car', want: 'copart', inp: {
    title_status: 'clean', drivable: 'unknown', flags: clearFlags,
    grades: grades({ front_bumper: 'replace', hood: 'replace', left_front_fender: 'replace' }),
    repair: { low: 6000, high: 9500 }, clean_wholesale: 9000, arv_high: 8550, market: market(1) } },
  { name: 'flood title', want: 'copart', inp: {
    title_status: 'flood', drivable: 'unknown', flags: { ...clearFlags, flood_suspected: true }, grades: grades(),
    repair: { low: 0, high: 500 }, clean_wholesale: 15000, arv_high: 10000, market: market(1) } },
  { name: 'non-repairable title (forced)', want: 'copart', inp: {
    title_status: 'non_repairable', drivable: 'yes', flags: clearFlags, grades: grades(),
    repair: { low: 0, high: 0 }, clean_wholesale: 20000, arv_high: null, market: market(3) } },
  { name: 'seller says it drives, photos say no', want: 'copart', inp: {
    title_status: 'rebuilt', drivable: 'yes', flags: { ...clearFlags, fluid_leak: true },
    drivability: drive({ damage_location: 'affects_driving', fluids: 'leaking', tires: 'flat_or_damaged', glass: 'cracked_or_broken', rust: 'surface' }),
    grades: grades({ front_bumper: 'replace', right_front_fender: 'replace', wheels_and_tires: 'replace' }),
    repair: { low: 3500, high: 7000 }, clean_wholesale: 11000, arv_high: 8000, market: market(1) } },
  { name: 'clean title, airbags out, costly codes, repair over half the value', want: 'copart', inp: {
    title_status: 'clean', drivability: drive({ damage_location: 'affects_driving', brakes: 'warning' }), flags: { ...clearFlags, airbags_deployed: true },
    grades: grades({ front_bumper: 'replace', hood: 'repairable', interior: 'replace' }),
    codes: [{ code: 'B0001', system: 'airbag/SRS', severity: 'critical' }, { code: 'P0217', system: 'engine', severity: 'critical' }, { code: 'C0035', system: 'brakes/ABS', severity: 'moderate' }],
    code_assessment: assess(3500, 7500, { confidence: 'low', modules: [{ module: 'airbag_srs', status: 'replacement_likely', codes: ['B0001'], note: '' }] }),
    repair: { low: 7000, high: 11000 }, clean_wholesale: 16000, arv_high: 14500, market: market(3) } },
  { name: 'codes look costly one by one, cheap together', want: 'acv', inp: {
    title_status: 'clean', drivability: drive(), flags: clearFlags, grades: grades({ rear_bumper: 'repairable' }),
    codes: ['P0300', 'P0301', 'P0302', 'P0304'].map((code) => ({ code, system: 'engine', severity: 'major', cost_low: 150, cost_high: 2500 })),
    code_assessment: assess(250, 900, { confidence: 'high', root_causes: [{ codes: ['P0300', 'P0301', 'P0302', 'P0304'], cause: 'worn plugs/coils', repair: 'plugs and coils', cost_low: 250, cost_high: 900 }] }),
    repair: { low: 600, high: 1800 }, clean_wholesale: 14000, arv_high: 13300, market: market(3) } },
  { name: 'close call', want: 'too_close', inp: {
    title_status: 'clean', flags: { ...clearFlags, frame_suspected: 'unknown' },
    drivability: drive({ damage_location: 'affects_driving', tires: 'flat_or_damaged', fluids: 'seepage', rust: 'surface' }),
    grades: grades({ front_bumper: 'replace', left_front_fender: 'replace', left_headlight: 'replace', wheels_and_tires: 'replace' }),
    repair: { low: 4000, high: 8500 }, clean_wholesale: 12000, arv_high: 10500, market: market(1) } },
  { name: 'no market search (state missing)', want: 'acv', inp: {
    title_status: 'clean', drivable: 'yes', grades: grades(), flags: clearFlags,
    repair: { low: 0, high: 0 }, clean_wholesale: 20000, arv_high: 19000, market: { ran: false, error: 'no state given' } } },
];

let failed = 0;
const rows = cases.map(({ name, want, inp }) => {
  const s = scoreChannels(inp);
  for (const c of s.categories) if (c.acv > c.weight + 1e-9 || c.copart > c.weight + 1e-9) { failed++; console.error(`${name}: ${c.key} gives more than its weight`); }
  if (s.winner !== want) failed++;
  return { case: name, ACV: s.acv, Copart: s.copart, winner: s.winner, pass: s.winner === want ? 'yes' : `NO (want ${want})`,
    categories: s.categories.map((c) => `${c.key} ${c.acv}/${c.copart}`).join(', ') };
});
console.table(rows);
const total = Object.values(SCORECARD_CONFIG.weights).reduce((a, b) => a + b, 0);
if (total !== 100) { failed++; console.error(`weights add up to ${total}, not 100`); }
console.log(failed ? `${failed} check(s) FAILED` : `All ${cases.length} scorecard cases give the expected channel; weights add up to 100.`);
process.exit(failed ? 1 : 0);
