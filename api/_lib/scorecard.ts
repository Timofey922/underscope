// ACV vs Copart points scorecard. Each category gives points to ACV (dealer wholesale) or Copart
// (salvage buyers); the higher total says where the car most likely sells best.
// Pure logic, no AI, no network: /api/decide runs it on every reviewer edit.
// Every number is a placeholder in SCORECARD_CONFIG; tune them there.

export const SCORECARD_CONFIG = {
  closeMargin: 5,                      // totals closer than this -> "too_close"
  title: {                             // [acv, copart]
    clean: [10, 0], rebuilt: [3, 5], salvage: [0, 10], flood: [0, 20], lemon: [3, 3], unknown: [0, 0],
  } as Record<string, [number, number]>,
  drivable: { yes: [8, 0], no: [0, 8], unknown: [0, 0] } as Record<string, [number, number]>,
  condition: {
    light: [6, 0] as [number, number],    // 0 replace, <= lightMaxRepairable repairable
    moderate: [2, 0] as [number, number], // <= moderateMaxReplace replace and <= moderateMaxDamaged damaged
    heavy: [0, 6] as [number, number],
    lightMaxRepairable: 2, moderateMaxReplace: 2, moderateMaxDamaged: 6,
    airbagsDeployed: 5,                // Copart
  },
  repairVsValue: {                     // repair band midpoint / clean wholesale
    bands: [
      { below: 0.25, pts: [10, 0] }, { below: 0.5, pts: [4, 0] },
      { below: 0.75, pts: [0, 5] }, { below: Infinity, pts: [0, 10] },
    ] as { below: number; pts: [number, number] }[],
    repairOverValue: 15,               // Copart: top of the repair band is more than the car is worth after repair
  },
  hiddenRisks: {                       // all Copart
    frameSuspected: 6, frameUnknown: 2, airbagsUnknown: 2, fluidLeak: 3,
    floodOrFire: 8, perCriticalCode: 3, manyUnknownParts: 2, manyUnknownPartsAt: 5,
  },
  marketFit: {                         // counts different listing sites (cargurus, cars.com...), not search results
    manySites: 2, manyPts: [6, 0] as [number, number],      // several sites list this model in the state
    oneSitePts: [2, 0] as [number, number],
    noSitesPts: [0, 6] as [number, number],                 // no local dealer market -> salvage buyers
    oldYears: 15, highMileage: 200_000, oldOrHighPts: [0, 4] as [number, number],
  },
};

type Tri = boolean | 'unknown';
export type MarketFit = {
  ran: boolean; listings?: number; sites?: string[]; age_years?: number | null; mileage?: number | null; state?: string | null; error?: string;
};
export type ScoreInput = {
  title_status?: string;
  drivable?: 'yes' | 'no' | 'unknown';
  grades: { part: string; grade: string }[];
  flags?: { airbags_deployed?: Tri; frame_suspected?: Tri; fluid_leak?: Tri; flood_suspected?: Tri; fire_damage?: Tri };
  codes?: { code: string; severity?: string }[];
  repair: { low: number; high: number };
  clean_wholesale?: number;
  arv_high?: number | null;            // top of the after-repair value
  market?: MarketFit | null;
};
type Row = { finding: string; acv: number; copart: number; reason: string };
export type Category = { key: string; label: string; acv: number; copart: number; rows: Row[] };
export type Scorecard = {
  winner: 'acv' | 'copart' | 'too_close'; acv: number; copart: number; margin: number;
  forced: string | null; categories: Category[]; missing: string[];
};

const C = SCORECARD_CONFIG;
const row = (finding: string, [acv, copart]: [number, number], reason: string): Row => ({ finding, acv, copart, reason });
const pct = (x: number) => `${Math.round(x * 100)}%`;
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

export function scoreChannels(inp: ScoreInput): Scorecard {
  const missing: string[] = [];
  const f = inp.flags ?? {};
  const cats: Category[] = [];
  const add = (key: string, label: string, rows: Row[]) =>
    cats.push({ key, label, rows, acv: rows.reduce((s, r) => s + r.acv, 0), copart: rows.reduce((s, r) => s + r.copart, 0) });

  // 1. Title
  const title = inp.title_status ?? 'unknown';
  const forced = title === 'non_repairable' ? 'A non-repairable title can only be sold for parts or salvage.' : null;
  if (forced) add('title', 'Title', [row('non_repairable', [0, 0], forced)]);
  else {
    if (title === 'unknown') missing.push('title status');
    add('title', 'Title', [row(title, C.title[title] ?? C.title.unknown,
      title === 'clean' ? 'Dealers buy clean titles at full wholesale.'
        : title === 'unknown' ? 'Title not confirmed; no points until it is.'
        : 'Branded titles sell at a discount to dealers; salvage buyers expect them.')]);
  }

  // 2. Drivable and condition
  const drivable = inp.drivable ?? 'unknown';
  if (drivable === 'unknown') missing.push('whether it drives');
  const replace = inp.grades.filter((g) => g.grade === 'replace').length;
  const repairable = inp.grades.filter((g) => g.grade === 'repairable').length;
  const cc = C.condition;
  const level = replace === 0 && repairable <= cc.lightMaxRepairable ? 'light'
    : replace <= cc.moderateMaxReplace && replace + repairable <= cc.moderateMaxDamaged ? 'moderate' : 'heavy';
  const condRows = [
    row(drivable === 'unknown' ? 'not sure if it drives' : drivable === 'yes' ? 'drives' : "doesn't drive", C.drivable[drivable],
      drivable === 'yes' ? 'A car that drives can go through a dealer lane.' : drivable === 'no' ? 'Non-runners need a tow and suit salvage buyers.' : 'Seller not sure; no points.'),
    row(`${level} damage (${replace} replace, ${repairable} repairable)`, cc[level],
      level === 'heavy' ? 'Heavy damage is what salvage buyers bid on.' : 'Little damage keeps it a dealer car.'),
  ];
  if (f.airbags_deployed === true) condRows.push(row('airbags deployed', [0, cc.airbagsDeployed], 'Deployed airbags usually mean a salvage sale.'));
  add('condition', 'Drivable and condition', condRows);

  // 3. Repair cost vs car value
  const rv = C.repairVsValue;
  const valueRows: Row[] = [];
  if (inp.clean_wholesale && inp.clean_wholesale > 0) {
    const ratio = (inp.repair.low + inp.repair.high) / 2 / inp.clean_wholesale;
    const band = rv.bands.find((b) => ratio < b.below)!;
    valueRows.push(row(`repair about ${pct(ratio)} of clean value`, band.pts,
      ratio < 0.5 ? 'Repair is small next to the value; worth fixing and selling to dealers.' : 'Repair eats most of the value.'));
    if (inp.arv_high != null && inp.repair.high > inp.arv_high) {
      valueRows.push(row(`repair up to ${usd(inp.repair.high)} > value after repair ${usd(inp.arv_high)}`, [0, rv.repairOverValue],
        'Repair could cost more than the car is worth: Copart marketplace.'));
    }
  } else {
    missing.push('clean wholesale value');
    valueRows.push(row('no clean wholesale value', [0, 0], 'Enter the clean wholesale value to score this.'));
  }
  add('repair_vs_value', 'Repair cost vs value', valueRows);

  // 4. Hidden risks
  const h = C.hiddenRisks;
  const riskRows: Row[] = [];
  if (f.frame_suspected === true) riskRows.push(row('frame damage suspected', [0, h.frameSuspected], 'Frame damage is hard to sell to dealers.'));
  else if (f.frame_suspected === 'unknown') riskRows.push(row("can't tell about the frame", [0, h.frameUnknown], 'Unchecked frame is a risk dealers price in.'));
  if (f.airbags_deployed === 'unknown') riskRows.push(row("can't tell if airbags deployed", [0, h.airbagsUnknown], 'Unknown airbag state is a hidden cost.'));
  if (f.fluid_leak === true) riskRows.push(row('fluid leak', [0, h.fluidLeak], 'Leaks point to mechanical damage.'));
  if (f.flood_suspected === true || f.fire_damage === true) riskRows.push(row('flood or fire suspected', [0, h.floodOrFire], 'Flood and fire cars belong with salvage buyers.'));
  for (const c of inp.codes ?? []) if (c.severity === 'critical') riskRows.push(row(`${c.code} is critical`, [0, h.perCriticalCode], 'Critical fault code: likely costly mechanical repair.'));
  const unknown = inp.grades.filter((g) => g.grade === 'unknown').length;
  if (unknown >= h.manyUnknownPartsAt) riskRows.push(row(`${unknown} parts not visible`, [0, h.manyUnknownParts], 'Much of the car is unseen.'));
  if (!riskRows.length) riskRows.push(row('none found', [0, 0], 'No hidden risks flagged.'));
  add('hidden_risks', 'Hidden risks', riskRows);

  // 5. Market fit (public listings found by /api/market-fit)
  const m = inp.market, mf = C.marketFit;
  const fitRows: Row[] = [];
  if (m && m.ran && (Array.isArray(m.sites) || typeof m.listings === 'number')) {
    const n = m.sites ? m.sites.length : (m.listings ?? 0) > 0 ? 1 : 0;
    const where = m.state ? ` in ${m.state}` : '';
    fitRows.push(row(n ? `listed on ${n} public site${n === 1 ? '' : 's'}${where}${m.sites?.length ? ` (${m.sites.slice(0, 3).join(', ')}${m.sites.length > 3 ? '…' : ''})` : ''}` : `no public listings${where}`,
      n >= mf.manySites ? mf.manyPts : n === 1 ? mf.oneSitePts : mf.noSitesPts,
      n >= mf.manySites ? 'Dealers sell this model locally, so it fits ACV\'s market.'
        : n === 1 ? 'Only one site lists it locally: a thin dealer market.' : 'No local dealer market: more likely a Copart car.'));
  } else {
    missing.push('market fit (state, or listing search unavailable)');
    fitRows.push(row(m?.error ? `not run: ${m.error}` : 'not run', [0, 0],
      !m || m.error === 'no state given' ? 'Pick a state to search public listings.' : 'The listing search was unavailable; no points.'));
  }
  const age = m?.age_years ?? null, miles = m?.mileage ?? null;
  if ((age != null && age > mf.oldYears) || (miles != null && miles > mf.highMileage)) {
    fitRows.push(row([age != null && age > mf.oldYears ? `${age} years old` : '', miles != null && miles > mf.highMileage ? `${miles.toLocaleString('en-US')} miles` : ''].filter(Boolean).join(', '),
      mf.oldOrHighPts, 'Old or high-mileage cars fall outside most dealer wholesale.'));
  }
  add('market_fit', 'Market fit', fitRows);

  const acv = cats.reduce((s, c) => s + c.acv, 0), copart = cats.reduce((s, c) => s + c.copart, 0);
  const margin = Math.abs(acv - copart);
  const winner = forced ? 'copart' : margin < C.closeMargin ? 'too_close' : acv > copart ? 'acv' : 'copart';
  return { winner, acv, copart, margin, forced, categories: cats, missing };
}
