// Photo-grading accuracy: compare the model's grades with hand-labeled ground truth.
//
//   npm run score:photos -- --template   write a blank truth.json in each test_vehicles/<id>/ that has none
//   npm run score:photos                 score every vehicle that has both truth.json and grade.json
//
// Run `npm run test:photos` first (needs `npm run dev`); it writes grade.json per vehicle.
// truth.json is filled in by a person WITHOUT looking at grade.json (blind), one grade per part:
//   { "hood": "replace", "front_bumper": "repairable", ... }   grades: fine | repairable | replace | unknown
// Writes test_vehicles/ACCURACY.md and prints the summary. No API calls.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DIR = process.env.TEST_DIR ?? join(ROOT, 'test_vehicles');
const PRED = process.env.OUT ?? 'grade.json';
const PARTS = ['front_bumper', 'hood', 'grille', 'left_headlight', 'right_headlight', 'windshield',
  'left_front_fender', 'right_front_fender', 'left_front_door', 'right_front_door', 'left_rear_door',
  'right_rear_door', 'left_mirror', 'right_mirror', 'left_rear_quarter', 'right_rear_quarter',
  'tailgate_or_rear_doors', 'rear_bumper', 'left_taillight', 'right_taillight', 'wheels_and_tires', 'roof',
  'interior', 'engine_bay', 'underbody'];
const GRADES = ['fine', 'repairable', 'replace', 'unknown'];
const DAMAGED = new Set(['repairable', 'replace']);
const mirror = (p: string) => p.startsWith('left_') ? p.replace('left_', 'right_') : p.startsWith('right_') ? p.replace('right_', 'left_') : null;

type Grades = Record<string, string>;

/** Accepts { part: grade }, { parts: { part: grade } } or { parts: [{ part, grade }] }. */
function readGrades(file: string): Grades {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const src = raw.result?.parts ?? raw.parts ?? raw;
  const out: Grades = {};
  if (Array.isArray(src)) for (const x of src) out[x.part] = x.grade;
  else for (const [k, v] of Object.entries(src)) if (typeof v === 'string') out[k] = v;
  return out;
}

const vehicles = existsSync(DIR) ? readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
if (!vehicles.length) { console.error(`No vehicle folders in ${DIR}. Put the test cars there (test_vehicles/<id>/*.jpg).`); process.exit(1); }

if (process.argv.includes('--template')) {
  let made = 0;
  for (const id of vehicles) {
    const f = join(DIR, id, 'truth.json');
    if (existsSync(f)) continue;
    writeFileSync(f, JSON.stringify(Object.fromEntries(PARTS.map((p) => [p, ''])), null, 2) + '\n');
    made++;
  }
  console.log(`Wrote ${made} blank truth.json file(s). Fill each part with ${GRADES.join(' | ')} by looking at the photos only, not at ${PRED}.`);
  process.exit(0);
}

type Row = { id: string; parts: number; right: number; tp: number; fn: number; fp: number; expensive: string[]; wrongSide: string[]; unlabeled: number };
const rows: Row[] = [];
const confusion: Record<string, Record<string, number>> = Object.fromEntries(GRADES.map((t) => [t, Object.fromEntries(GRADES.map((p) => [p, 0]))]));
let skipped = 0;

for (const id of vehicles) {
  const tf = join(DIR, id, 'truth.json'), pf = join(DIR, id, PRED);
  if (!existsSync(tf) || !existsSync(pf)) { skipped++; continue; }
  const truth = readGrades(tf), pred = readGrades(pf);
  const r: Row = { id, parts: 0, right: 0, tp: 0, fn: 0, fp: 0, expensive: [], wrongSide: [], unlabeled: 0 };
  for (const part of PARTS) {
    const t = truth[part], p = pred[part] ?? 'unknown';
    if (!GRADES.includes(t)) { r.unlabeled++; continue; }
    if (t === 'unknown') continue; // the labeler couldn't see it either: not scored
    r.parts++;
    confusion[t][GRADES.includes(p) ? p : 'unknown']++;
    if (p === t) r.right++;
    if (DAMAGED.has(t) && DAMAGED.has(p)) r.tp++;
    if (DAMAGED.has(t) && !DAMAGED.has(p)) r.fn++;
    if (!DAMAGED.has(t) && DAMAGED.has(p)) r.fp++;
    if (t === 'replace' && p === 'fine') r.expensive.push(part);
    // Wrong side: model put the damage on the mirror-image part and missed the real one.
    const m = mirror(part);
    if (m && DAMAGED.has(t) && !DAMAGED.has(p) && DAMAGED.has(pred[m] ?? '') && !DAMAGED.has(truth[m] ?? '')) r.wrongSide.push(part);
  }
  rows.push(r);
}

if (!rows.length) {
  console.error(`No vehicle has both truth.json and ${PRED} (${skipped} skipped). Run \`npm run score:photos -- --template\`, fill the truth files, and run \`npm run test:photos\`.`);
  process.exit(1);
}

const sum = (k: keyof Row) => rows.reduce((s, r) => s + (r[k] as number), 0);
const parts = sum('parts'), right = sum('right'), tp = sum('tp'), fn = sum('fn'), fp = sum('fp');
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
const expensive = rows.flatMap((r) => r.expensive.map((p) => `${r.id}: ${p}`));
const wrongSide = rows.flatMap((r) => r.wrongSide.map((p) => `${r.id}: ${p}`));
const unlabeled = sum('unlabeled');

const summary = [
  `Vehicles scored: ${rows.length}${skipped ? ` (${skipped} skipped: missing truth.json or ${PRED})` : ''}`,
  `Parts scored: ${parts}${unlabeled ? ` (${unlabeled} left blank in truth.json, not scored)` : ''}`,
  `Parts graded exactly right: ${pct(right, parts)} (${right}/${parts})`,
  `Damage found (recall): ${pct(tp, tp + fn)} (${tp} of ${tp + fn} damaged parts)`,
  `Flagged damage that is real (precision): ${pct(tp, tp + fp)} (${tp} of ${tp + fp} flagged)`,
  `Expensive misses (truth replace, model fine): ${expensive.length}${expensive.length ? ` -> ${expensive.join(', ')}` : ''}`,
  `Wrong side (damage put on the mirror-image part): ${wrongSide.length}${wrongSide.length ? ` -> ${wrongSide.join(', ')}` : ''}`,
];
console.log(summary.join('\n'));

const md = [
  `# Photo-grading accuracy`, '',
  `Model grades (\`${PRED}\`) vs hand-labeled ground truth (\`truth.json\`), scored ${new Date().toISOString().slice(0, 10)}.`,
  `Parts the labeler marked \`unknown\` are not scored.`, '',
  ...summary.map((s) => `- ${s}`), '',
  `## Confusion (rows = truth, columns = model)`, '',
  `| truth \\ model | ${GRADES.join(' | ')} |`, `|---|${GRADES.map(() => '---').join('|')}|`,
  ...GRADES.filter((t) => t !== 'unknown').map((t) => `| ${t} | ${GRADES.map((p) => confusion[t][p]).join(' | ')} |`), '',
  `## Per vehicle`, '',
  `| Vehicle | Right | Recall | Precision | Expensive misses | Wrong side |`, `|---|---|---|---|---|---|`,
  ...rows.map((r) => `| ${r.id} | ${pct(r.right, r.parts)} | ${pct(r.tp, r.tp + r.fn)} | ${pct(r.tp, r.tp + r.fp)} | ${r.expensive.join(', ') || '-'} | ${r.wrongSide.join(', ') || '-'} |`),
  '',
].join('\n');
writeFileSync(join(DIR, 'ACCURACY.md'), md);
console.log(`\nReport: ${join(DIR, 'ACCURACY.md')}`);
