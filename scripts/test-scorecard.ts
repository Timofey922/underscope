// Checks the ACV vs Copart scorecard (api/_lib/scorecard.ts) on hand-made cases, one per kind of answer.
// npm run test:scorecard   (no network, no keys)
import { scoreChannels, type ScoreInput } from '../api/_lib/scorecard.ts';
import { PARTS } from '../api/grade-photos.ts';

const grades = (damaged: Record<string, string> = {}, rest = 'fine') => PARTS.map((part) => ({ part, grade: damaged[part] ?? rest }));
const clearFlags = { airbags_deployed: false, frame_suspected: false, fluid_leak: false } as const;
// market(n): the model is listed on n different public sites in the state.
const market = (n: number, extra: object = {}) => ({ ran: true, listings: n * 2, sites: Array.from({ length: n }, (_, i) => `site${i}.com`), state: 'NY', age_years: 5, mileage: 60000, ...extra });

const cases: { name: string; want: string; inp: ScoreInput }[] = [
  { name: 'clean, drives, light damage, cheap repair', want: 'acv', inp: {
    title_status: 'clean', drivable: 'yes', grades: grades({ rear_bumper: 'repairable' }), flags: clearFlags,
    repair: { low: 400, high: 900 }, clean_wholesale: 18000, arv_high: 17100, market: market(3) } },
  { name: "salvage, doesn't drive, heavy damage", want: 'copart', inp: {
    title_status: 'salvage', drivable: 'no', flags: { ...clearFlags, frame_suspected: 'unknown' },
    grades: grades({ front_bumper: 'replace', hood: 'replace', grille: 'replace', left_headlight: 'replace', right_headlight: 'replace', windshield: 'replace' }),
    repair: { low: 4000, high: 11000 }, clean_wholesale: 14000, arv_high: 10600, market: market(1) } },
  { name: 'repair costs more than the car', want: 'copart', inp: {
    title_status: 'clean', drivable: 'unknown', flags: clearFlags,
    grades: grades({ front_bumper: 'replace', hood: 'replace', left_front_fender: 'replace' }),
    repair: { low: 6000, high: 9500 }, clean_wholesale: 9000, arv_high: 8550, market: market(1) } },
  { name: 'flood title', want: 'copart', inp: {
    title_status: 'flood', drivable: 'unknown', flags: { ...clearFlags, flood_suspected: true }, grades: grades(),
    repair: { low: 0, high: 500 }, clean_wholesale: 15000, arv_high: 10000, market: market(3) } },
  { name: 'non-repairable title (forced)', want: 'copart', inp: {
    title_status: 'non_repairable', drivable: 'yes', flags: clearFlags, grades: grades(),
    repair: { low: 0, high: 0 }, clean_wholesale: 20000, arv_high: null, market: market(3) } },
  { name: 'mixed signals', want: 'too_close', inp: {
    title_status: 'rebuilt', drivable: 'yes', flags: { ...clearFlags, frame_suspected: 'unknown' },
    grades: grades({ front_bumper: 'replace', hood: 'repairable', left_front_fender: 'repairable' }),
    repair: { low: 2500, high: 6000 }, clean_wholesale: 12000, arv_high: 10000, market: market(0) } },
  { name: 'no market search (state missing)', want: 'acv', inp: {
    title_status: 'clean', drivable: 'yes', grades: grades(), flags: clearFlags,
    repair: { low: 0, high: 0 }, clean_wholesale: 20000, arv_high: 19000, market: { ran: false, error: 'no state given' } } },
];

let failed = 0;
const rows = cases.map(({ name, want, inp }) => {
  const s = scoreChannels(inp);
  if (s.winner !== want) failed++;
  return { case: name, ACV: s.acv, Copart: s.copart, winner: s.winner, pass: s.winner === want ? 'yes' : `NO (want ${want})`,
    categories: s.categories.map((c) => `${c.key} ${c.acv}/${c.copart}`).join(', ') };
});
console.table(rows);
console.log(failed ? `${failed} of ${cases.length} FAILED` : `All ${cases.length} scorecard cases give the expected channel.`);
process.exit(failed ? 1 : 0);
