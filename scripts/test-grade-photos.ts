// Sends test vehicles' photos to /api/grade-photos the way the page does, times each call, saves grade.json.
// npm run test:photos -- [vehicle ids...]   (default: every folder in test_vehicles/). Needs `npm run dev` running.
// Photos are resized like the browser (1000 px long side, JPEG 0.82) with ImageMagick `convert`.
import { readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const DIR = join(ROOT, 'test_vehicles');
const API = process.env.API_URL ?? 'http://localhost:3000/api/grade-photos';
const VIN = process.env.TEST_VIN ?? '1FTYR2CM1KKA12345'; // placeholder; the endpoint only needs a well-formed VIN
const VERCEL_LIMIT_S = 60;

const num = (f: string) => Number(f.match(/(\d+)\.\w+$/)?.[1] ?? 0);
const ids = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(DIR).filter((d) => !d.startsWith('.')).sort();

const rows: string[][] = [];
for (const id of ids) {
  const folder = join(DIR, id);
  if (!existsSync(folder)) { console.error(`${id}: no folder ${folder}`); continue; }
  const files = readdirSync(folder).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort((a, b) => num(a) - num(b) || a.localeCompare(b));
  const photos = files.map((f) => 'data:image/jpeg;base64,' +
    execFileSync('convert', [join(folder, f), '-auto-orient', '-resize', '1000x1000>', '-quality', '82', 'jpg:-']).toString('base64'));
  const mb = photos.reduce((n, p) => n + p.length, 0) / 1e6;

  const t0 = Date.now();
  const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vin: VIN, photos }) });
  const secs = (Date.now() - t0) / 1000;
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) { rows.push([id, String(files.length), mb.toFixed(1), secs.toFixed(0), `ERROR ${res.status}: ${body.error ?? ''}`]); continue; }

  writeFileSync(join(folder, 'grade.json'), JSON.stringify(body, null, 2));
  const v = body.vehicle;
  const g = body.parts.reduce((m: Record<string, number>, p: any) => (m[p.grade] = (m[p.grade] ?? 0) + 1, m), {});
  rows.push([
    id, String(files.length), mb.toFixed(1), secs.toFixed(0) + (secs > VERCEL_LIMIT_S ? ' (OVER 60s)' : ''),
    `${[v.year, v.make, v.model].filter(Boolean).join(' ') || 'unidentified'} | ${body.overall_severity} | ` +
    `${g.replace ?? 0} replace, ${g.repairable ?? 0} repairable, ${g.unknown ?? 0} unknown | ${body.damages.length} problems, ${body.missing_parts.length} missing`,
  ]);
  console.log(rows.at(-1)!.join('  '));
}

console.log('\nvehicle    photos  MB   secs  result');
for (const r of rows) console.log(`${r[0].padEnd(10)} ${r[1].padStart(6)} ${r[2].padStart(4)} ${r[3].padStart(5)}  ${r[4]}`);
