// Label review sheet: every part where the hand label (truth.json) and the model disagree, with what the model saw and
// which photos to look at, so a person can re-check the label against the photos. Never changes truth.json.
//   npm run review:labels -- [result files...]     (default grade.json; e.g. base55.json v2.json)
// Optional second opinion per vehicle in test_vehicles/<id>/review.json: { "<part>": { "grade": "...", "note": "..." } },
// from someone (or a model) grading the listed photos WITHOUT seeing the label or the model's answer.
// Writes test_vehicles/LABEL_REVIEW.md.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIR = process.env.TEST_DIR ?? join(resolve(import.meta.dirname, '..'), 'test_vehicles');
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['grade.json'];
const DAMAGED = new Set(['repairable', 'replace']);
const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const gradesOf = (raw: any): Record<string, string> => {
  const src = raw.result?.parts ?? raw.parts ?? raw;
  return Array.isArray(src) ? Object.fromEntries(src.map((p: any) => [p.part, p.grade])) : src;
};

type Row = { id: string; part: string; truth: string; models: string[]; saw: string; photos: number[]; second?: { grade: string; note: string } };
const rows: Row[] = [];
for (const id of readdirSync(DIR).filter((d) => /^\d+$/.test(d)).sort()) {
  const t = join(DIR, id, 'truth.json');
  const outs = files.map((f) => join(DIR, id, f));
  if (!existsSync(t) || !outs.every(existsSync)) continue;
  const truth = gradesOf(read(t));
  const results = outs.map((f) => read(f).result ?? read(f));
  const second = existsSync(join(DIR, id, 'review.json')) ? read(join(DIR, id, 'review.json')) : {};
  for (const [part, tg] of Object.entries(truth)) {
    if (!tg || tg === 'unknown') continue;
    const models = results.map((r) => gradesOf(r)[part]);
    if (models.every((m) => m === tg)) continue;
    // What the model saw on this part, and the photos it pointed to (plus its evidence photo when it called the part fine).
    const saw = new Set<string>(), photos = new Set<number>();
    for (const r of results) {
      const p = (r.parts ?? []).find((x: any) => x.part === part);
      if (p?.note) saw.add(p.note);
      if (p?.evidence_photo) photos.add(p.evidence_photo);
      for (const d of r.damages ?? []) if (d.part === part) { saw.add(`${d.severity} ${String(d.type).replace(/_/g, ' ')}: ${d.description}`); d.photos.forEach((n: number) => photos.add(n)); }
    }
    rows.push({ id, part, truth: tg, models, saw: [...saw].join('; '), photos: [...photos].sort((a, b) => a - b), second: second[part] });
  }
}

const kind = (r: Row) => {
  const m = r.models.filter(Boolean);
  if (DAMAGED.has(r.truth) && m.every((x) => x === 'fine')) return r.truth === 'replace' ? 'missed, expensive' : 'missed';
  if (r.truth === 'fine' && m.every((x) => DAMAGED.has(x))) return 'extra damage';
  return 'grade differs';
};
const agree = (r: Row) => !r.second ? '' : r.second.grade === r.truth ? 'label' : r.models.includes(r.second.grade) ? 'model' : 'neither';
const esc = (s: string) => s.replace(/\|/g, '/').replace(/\n/g, ' ');
const lines = [
  '# Label review',
  '',
  `Parts where the hand label and the model (${files.join(', ')}) disagree: ${rows.length}. Look at the listed photos and decide which is right;`,
  'fix `truth.json` only when the photos clearly show the label is wrong (label blind, as before). "Second look" is a grade from the',
  'same photos by a reviewer who saw neither the label nor the model\'s answer; it is a hint, not ground truth.',
  '',
  `| Vehicle | Part | Kind | Label | ${files.map((f) => f.replace('.json', '')).join(' | ')} | Second look | Sides with | What the model saw | Photos |`,
  `|---|---|---|---|${files.map(() => '---').join('|')}|---|---|---|---|`,
  ...rows.map((r) => `| ${r.id} | ${r.part} | ${kind(r)} | ${r.truth} | ${r.models.map((m) => m ?? '-').join(' | ')} | ${r.second ? `${r.second.grade}: ${esc(r.second.note)}` : ''} | ${agree(r)} | ${esc(r.saw)} | ${r.photos.join(', ')} |`),
];
const withSecond = rows.filter((r) => r.second);
if (withSecond.length) {
  const c = (k: string) => withSecond.filter((r) => agree(r) === k).length;
  lines.push('', `Second look on ${withSecond.length} parts: sides with the label ${c('label')}, with the model ${c('model')}, with neither ${c('neither')}.`);
}
writeFileSync(join(DIR, 'LABEL_REVIEW.md'), lines.join('\n') + '\n');
console.log(`${rows.length} disagreements -> ${join(DIR, 'LABEL_REVIEW.md')}`);
