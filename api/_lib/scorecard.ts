// ACV vs Copart scorecard: five weighted categories that add up to 100 points.
// Each finding leans from -1 (all Copart) to +1 (all ACV). Its points = category weight x its share of the
// category x lean, so no category can give more than its weight. The higher total says where the car most likely
// sells best; totals within closeMargin are too close to call.
// Pure logic, no AI, no network: /api/decide runs it on every reviewer edit. The inputs that need judgment come from
// OpenAI upstream: drivability from the photos (/api/grade-photos), and the price of all fault codes together plus
// the non-engine modules they point to (/api/decode-codes). Every weight, share and lean below is a placeholder.

export const SCORECARD_CONFIG = {
  // Points out of 100 per category.
  weights: { title: 20, drivability: 35, cost_uncertainty: 25, unknown_flags: 10, market_fit: 10 },
  closeMargin: 5,                      // totals closer than this -> "too_close"
  title: { clean: 1, rebuilt: -0.2, salvage: -1, flood: -1, lemon: 0, unknown: 0 } as Record<string, number>,
  drivability: {
    // Share of the drivability weight per item (sums to 1), and the lean of each status the photo model can report,
    // best first. "unknown" always leans 0.
    shares: { damage_location: 0.3, fluids: 0.15, tires: 0.15, brakes: 0.15, glass: 0.1, rust: 0.1, modifications: 0.05 },
    lean: {
      damage_location: { none: 1, cosmetic: 0.5, affects_driving: -1 },
      fluids: { dry: 1, seepage: 0, leaking: -1 },
      tires: { good: 1, worn: 0.5, flat_or_damaged: -1 },
      brakes: { ok: 1, warning: -0.5, damaged: -1 },
      glass: { intact: 1, chipped: 0.5, cracked_or_broken: -1 },
      rust: { none: 1, surface: 0, heavy: -1 },
      modifications: { none: 1, minor: 0, major: -1 },
    } as Record<string, Record<string, number>>,
    // Statuses that stop the car from being driven. Any one of them sends the whole drivability weight to Copart:
    // intact glass or good tires don't make a car with a crushed radiator support drivable.
    blocking: { damage_location: 'affects_driving', fluids: 'leaking', tires: 'flat_or_damaged', brakes: 'damaged' } as Record<string, string>,
    seller: { yes: 1, no: -1, unknown: 0 } as Record<string, number>,   // only when there are no photos
  },
  costUncertainty: {
    shares: { repair: 0.4, codes: 0.3, modules: 0.3 },
    // Repair estimate (middle of the range) / clean wholesale. If the top of the repair range is above the value
    // after repair, the whole category goes to Copart.
    repairBands: [{ below: 0.25, lean: 1 }, { below: 0.5, lean: 0.4 }, { below: 0.75, lean: -0.5 }, { below: Infinity, lean: -1 }],
    // Price of all fault codes fixed together (middle of OpenAI's range) / clean wholesale.
    codeBands: [{ below: 0.05, lean: 0.5 }, { below: 0.15, lean: -0.25 }, { below: 0.3, lean: -0.6 }, { below: Infinity, lean: -1 }],
    lowConfidenceShift: -0.25,         // OpenAI not confident about that price: lean further toward Copart
    // Non-engine modules (airbag/SRS, ABS, body, network...): replacement likely / fault codes only / checked and clear.
    modules: { replace: -1, fault: -0.5, clear: 0.5 },
  },
  unknownFlags: {                      // all Copart: what nobody could check
    shares: { frame: 0.3, airbags: 0.2, fluid_leak: 0.15, flood: 0.15, unseen_parts: 0.2 },
    unseenPartsAt: 5,
  },
  marketFit: {                         // 60% of the category for local listings, 40% for age or mileage
    shares: { listings: 0.6, age: 0.4 },
    // Counts different listing sites (cargurus, cars.com...), not search results: each result page covers many cars.
    manySites: 2, sitesLean: { many: 1, one: 1 / 3, none: -1 },
    oldYears: 15, highMileage: 200_000,
  },
};

export const DRIVE_ITEMS = ['damage_location', 'fluids', 'rust', 'tires', 'brakes', 'glass', 'modifications'] as const;
export type DriveItem = (typeof DRIVE_ITEMS)[number];
/** Statuses per drivability item, best first, then "unknown" (the photo model's enum). */
export const DRIVE_STATUS = Object.fromEntries(DRIVE_ITEMS.map((k) => [k, [...Object.keys(SCORECARD_CONFIG.drivability.lean[k]), 'unknown']])) as Record<DriveItem, string[]>;
export type Drivability = Record<DriveItem, { status: string; note?: string; photos?: number[] }>;

export const MODULES = ['airbag_srs', 'abs_brakes', 'transmission_control', 'body_control', 'instrument_cluster', 'network_communication', 'steering_suspension', 'other_electronic'] as const;
export type CodeAssessment = {
  root_causes: { codes: string[]; cause: string; repair: string; cost_low: number; cost_high: number }[];
  cost_low: number; cost_high: number;                // all codes fixed together, US dollars
  modules: { module: (typeof MODULES)[number]; status: 'fault_reported' | 'replacement_likely'; codes: string[]; note: string }[];
  confidence: 'low' | 'medium' | 'high';
  note: string;
};

type Tri = boolean | 'unknown';
export type MarketFit = {
  ran: boolean; listings?: number; sites?: string[]; age_years?: number | null; mileage?: number | null; state?: string | null; error?: string;
};
export type ScoreInput = {
  title_status?: string;
  drivable?: 'yes' | 'no' | 'unknown';       // seller's answer: used only when the photos gave no drivability
  drivability?: Drivability | null;          // from /api/grade-photos (OpenAI reading the photos)
  grades: { part: string; grade: string }[];
  flags?: { airbags_deployed?: Tri; frame_suspected?: Tri; fluid_leak?: Tri; flood_suspected?: Tri; fire_damage?: Tri; suspension_damage_suspected?: Tri };
  codes?: { code: string; severity?: string; system?: string; cost_low?: number; cost_high?: number; source?: string }[];
  code_assessment?: CodeAssessment | null;   // from /api/decode-codes (OpenAI pricing the codes together)
  repair: { low: number; high: number };
  clean_wholesale?: number;
  arv_high?: number | null;                  // top of the after-repair value
  market?: MarketFit | null;
};
type Row = { finding: string; acv: number; copart: number; reason: string };
export type Category = { key: string; label: string; weight: number; acv: number; copart: number; rows: Row[] };
export type Scorecard = {
  winner: 'acv' | 'copart' | 'too_close'; acv: number; copart: number; margin: number; close_margin: number;
  forced: string | null; categories: Category[]; missing: string[];
};

const C = SCORECARD_CONFIG, W = C.weights;
const r1 = (x: number) => Math.round(x * 10) / 10;
const clamp = (x: number) => Math.max(-1, Math.min(1, x));
/** points > 0 go to ACV, < 0 to Copart */
const row = (finding: string, points: number, reason: string): Row => ({ finding, acv: points > 0 ? r1(points) : 0, copart: points < 0 ? r1(-points) : 0, reason });
const pct = (x: number) => `${Math.round(x * 100)}%`;
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const words = (s: string) => s.replace(/_/g, ' ');
const DRIVE_LABEL: Record<DriveItem, string> = {
  damage_location: 'Damage location', fluids: 'Fluids', rust: 'Rust', tires: 'Tires', brakes: 'Brakes', glass: 'Glass', modifications: 'Aftermarket modifications',
};

/** The worse of two statuses for one drivability item ("unknown" or missing counts as least informative). */
export function worse(item: DriveItem, a: string | undefined, b: string | undefined) {
  const order = DRIVE_STATUS[item], rank = (s?: string) => (s && s !== 'unknown' ? order.indexOf(s) : -1);
  return rank(b) > rank(a) ? b! : a ?? 'unknown';
}

// What the part grades, flags and fault codes say about each drivability item. Reviewer edits flow in through these.
function evidence(inp: ScoreInput): Partial<Record<DriveItem, { status: string; why: string }>> {
  const f = inp.flags ?? {}, g = new Map(inp.grades.map((x) => [x.part, x.grade]));
  const dmg = (p: string) => g.get(p) === 'repairable' || g.get(p) === 'replace';
  const out: Partial<Record<DriveItem, { status: string; why: string }>> = {};
  const critical = [f.frame_suspected === true && 'frame damage suspected', f.suspension_damage_suspected === true && 'suspension damage suspected',
    g.get('wheels_and_tires') === 'replace' && 'wheels/tires need replacing', dmg('engine_bay') && 'engine bay damaged', dmg('underbody') && 'underbody damaged'].filter(Boolean);
  if (critical.length) out.damage_location = { status: 'affects_driving', why: critical.join(', ') };
  else if (inp.grades.some((x) => x.grade === 'repairable' || x.grade === 'replace')) out.damage_location = { status: 'cosmetic', why: 'damaged parts, none of them needed to drive' };
  if (f.fluid_leak === true) out.fluids = { status: 'leaking', why: 'fluid leak flagged' };
  if (g.get('wheels_and_tires') === 'replace') out.tires = { status: 'flat_or_damaged', why: 'wheels/tires graded replace' };
  else if (g.get('wheels_and_tires') === 'repairable') out.tires = { status: 'worn', why: 'wheels/tires graded repairable' };
  if (g.get('windshield') === 'replace') out.glass = { status: 'cracked_or_broken', why: 'windshield graded replace' };
  else if (g.get('windshield') === 'repairable') out.glass = { status: 'chipped', why: 'windshield graded repairable' };
  const brake = (inp.codes ?? []).filter((c) => c.system === 'brakes/ABS' && c.source !== 'invalid');
  const absModule = (inp.code_assessment?.modules ?? []).find((m) => m.module === 'abs_brakes');
  if (brake.some((c) => c.severity === 'major' || c.severity === 'critical')) out.brakes = { status: 'damaged', why: `brake/ABS fault ${brake.map((c) => c.code).join(', ')}` };
  else if (brake.length || absModule) out.brakes = { status: 'warning', why: `brake/ABS fault ${[...brake.map((c) => c.code), ...(absModule?.codes ?? [])].filter((x, i, a) => a.indexOf(x) === i).join(', ')}` };
  return out;
}

export function scoreChannels(inp: ScoreInput): Scorecard {
  const missing: string[] = [];
  const f = inp.flags ?? {};
  const cats: Category[] = [];
  // Rows are rounded to one decimal for display; the category total is capped at its weight so rounding can't push it over.
  const add = (key: string, label: string, weight: number, rows: Row[]) =>
    cats.push({ key, label, weight, rows, acv: Math.min(weight, r1(rows.reduce((s, r) => s + r.acv, 0))), copart: Math.min(weight, r1(rows.reduce((s, r) => s + r.copart, 0))) });

  // 1. Title (25)
  const title = inp.title_status ?? 'unknown';
  const forced = title === 'non_repairable' ? 'A non-repairable title can only be sold for parts or salvage.' : null;
  if (forced) add('title', 'Title', W.title, [row('non-repairable', -W.title, forced)]);
  else {
    if (title === 'unknown') missing.push('title status');
    add('title', 'Title', W.title, [row(words(title), W.title * (C.title[title] ?? 0),
      title === 'clean' ? 'Dealers buy clean titles at full wholesale.'
        : title === 'unknown' ? 'Title not confirmed; no points until it is.'
        : title === 'lemon' ? 'A lemon brand cuts the price in both channels.'
        : 'Branded titles sell at a discount to dealers; salvage buyers expect them.')]);
  }

  // 2. Drivability (20): the photo model's read of seven items, made worse by what grades, flags and codes show.
  const D = C.drivability, ev = evidence(inp);
  const driveRows: Row[] = [];
  if (inp.drivability) {
    const items = DRIVE_ITEMS.map((k) => {
      const seen = inp.drivability![k], e = ev[k];
      const status = worse(k, seen?.status, e?.status);
      const from = e && status === e.status && status !== seen?.status ? e.why : seen?.note || (status === 'unknown' ? 'not shown in the photos' : '');
      return { k, status, from, blocks: D.blocking[k] === status };
    });
    const blockers = items.filter((i) => i.blocks);
    if (blockers.length) {
      // Weakest link: the blocking items take the whole weight, split by their shares; the rest score 0.
      const share = blockers.reduce((s, i) => s + D.shares[i.k], 0);
      const sentence = (t: string) => (t ? `${t.replace(/[.\s]+$/, '')}. ` : '');
      for (const i of items) driveRows.push(row(`${DRIVE_LABEL[i.k]}: ${words(i.status)}`,
        i.blocks ? -W.drivability * D.shares[i.k] / share : 0, i.blocks ? `${sentence(i.from)}Stops it from being driven.` : `${sentence(i.from)}Doesn't count while something stops the car from driving.`));
    } else {
      for (const i of items) driveRows.push(row(`${DRIVE_LABEL[i.k]}: ${words(i.status)}`, W.drivability * D.shares[i.k] * (D.lean[i.k][i.status] ?? 0), i.from));
    }
  } else {
    const seller = inp.drivable ?? 'unknown';
    if (seller !== 'unknown') {
      driveRows.push(row(seller === 'yes' ? 'seller says it drives' : "seller says it doesn't drive", W.drivability * (D.seller[seller] ?? 0),
        'No photos to check it against, so the seller\'s answer counts for the whole category.'));
    } else {
      // No photos and no answer: only problems the grades, flags or codes show are scored.
      missing.push('drivability (no photos, seller not sure)');
      for (const k of DRIVE_ITEMS) {
        const e = ev[k], lean = e ? D.lean[k][e.status] ?? 0 : 0;
        if (e && lean < 0) driveRows.push(row(`${DRIVE_LABEL[k]}: ${words(e.status)}`, W.drivability * D.shares[k] * lean, e.why));
      }
      if (!driveRows.length) driveRows.push(row('not known', 0, 'No photos and the seller is not sure; no points.'));
    }
  }
  add('drivability', 'Drivability', W.drivability, driveRows);

  // 3. Repair cost and uncertainty (35): the repair estimate, the fault codes priced together, non-engine modules.
  const U = C.costUncertainty, wc = W.cost_uncertainty;
  const clean = inp.clean_wholesale && inp.clean_wholesale > 0 ? inp.clean_wholesale : null;
  const costRows: Row[] = [];
  if (clean) {
    const ratio = (inp.repair.low + inp.repair.high) / 2 / clean;
    const lean = U.repairBands.find((b) => ratio < b.below)!.lean;
    costRows.push(row(`repair about ${pct(ratio)} of clean value (${usd(inp.repair.low)}–${usd(inp.repair.high)})`, wc * U.shares.repair * lean,
      ratio < 0.5 ? 'Repair is small next to the value; worth fixing and selling to dealers.' : 'Repair eats most of the value.'));
  } else {
    missing.push('clean wholesale value');
    costRows.push(row('repair vs value: no clean wholesale value', 0, 'Enter the clean wholesale value to score this.'));
  }
  const codes = (inp.codes ?? []).filter((c) => c.source !== 'invalid');
  const a = inp.code_assessment;
  if (!codes.length) costRows.push(row('no fault codes entered', 0, 'No scan results; nothing to price.'));
  else {
    const [lo, hi] = a ? [a.cost_low, a.cost_high] : [codes.reduce((s, c) => s + (c.cost_low ?? 0), 0), codes.reduce((s, c) => s + (c.cost_high ?? 0), 0)];
    const how = a ? `OpenAI's price for the ${codes.length} code${codes.length > 1 ? 's' : ''} fixed together${a.root_causes.length ? ` (${a.root_causes.length} root cause${a.root_causes.length > 1 ? 's' : ''})` : ''}, ${a.confidence} confidence`
      : 'each code priced on its own (no combined estimate)';
    if (clean) {
      let lean = U.codeBands.find((b) => (lo + hi) / 2 / clean < b.below)!.lean;
      if (a?.confidence === 'low') lean = clamp(lean + U.lowConfidenceShift);
      costRows.push(row(`fault codes together ${usd(lo)}–${usd(hi)}, about ${pct((lo + hi) / 2 / clean)} of clean value`, wc * U.shares.codes * lean, `${how}.`));
    } else costRows.push(row(`fault codes together ${usd(lo)}–${usd(hi)}`, 0, `${how}; needs the clean wholesale value to score.`));
  }
  const replaceWhy = [f.airbags_deployed === true && 'airbags deployed (airbag modules, belts, dash)',
    (f.flood_suspected === true || f.fire_damage === true) && 'flood or fire (electrical modules at risk)',
    ...(a?.modules ?? []).filter((m) => m.status === 'replacement_likely').map((m) => `${words(m.module)} module likely needs replacing`)].filter(Boolean) as string[];
  const faultWhy = a ? a.modules.filter((m) => m.status === 'fault_reported').map((m) => `${words(m.module)} fault (${m.codes.join(', ')})`)
    : codes.filter((c) => c.system === 'airbag/SRS' || c.system === 'brakes/ABS').map((c) => `${c.system} fault (${c.code})`);
  if (replaceWhy.length) costRows.push(row(`non-engine modules: ${replaceWhy.join('; ')}`, wc * U.shares.modules * U.modules.replace, 'Module replacement is costly and hard to price from photos.'));
  else if (faultWhy.length) costRows.push(row(`non-engine modules: ${faultWhy.join('; ')}`, wc * U.shares.modules * U.modules.fault, 'Module faults may be wiring, a sensor or the module itself.'));
  else if (f.airbags_deployed === false) costRows.push(row('non-engine modules: airbags intact, no module faults', wc * U.shares.modules * U.modules.clear, 'No airbag or module work expected.'));
  else costRows.push(row('non-engine modules: not known', 0, "Can't tell if airbags deployed and no module codes; no points."));
  // Repair could cost more than the car is worth after repair: the whole category goes to Copart.
  if (inp.arv_high != null && inp.repair.high > inp.arv_high) {
    add('cost_uncertainty', 'Repair cost and uncertainty', wc, [
      row(`repair up to ${usd(inp.repair.high)} > value after repair ${usd(inp.arv_high)}`, -wc, 'Repair could cost more than the car is worth: Copart marketplace. Outweighs the rest of this category.'),
      ...costRows.map((r) => ({ ...r, acv: 0, copart: 0, reason: `${r.reason} (outweighed)` })),
    ]);
  } else add('cost_uncertainty', 'Repair cost and uncertainty', wc, costRows);

  // 4. Unknown flags (10): what nobody could check. All Copart.
  const UF = C.unknownFlags, wu = W.unknown_flags;
  const unseen = inp.grades.filter((g) => g.grade === 'unknown').length;
  const unknownRows = [
    f.frame_suspected === 'unknown' && row("can't tell about the frame", -wu * UF.shares.frame, 'Unchecked frame is a risk dealers price in.'),
    f.airbags_deployed === 'unknown' && row("can't tell if airbags deployed", -wu * UF.shares.airbags, 'Unknown airbag state is a hidden cost.'),
    f.fluid_leak === 'unknown' && row("can't tell about fluid leaks", -wu * UF.shares.fluid_leak, 'Leaks point to mechanical damage.'),
    f.flood_suspected === 'unknown' && row("can't tell about flood damage", -wu * UF.shares.flood, 'Flood damage shows up late and costs a lot.'),
    unseen >= UF.unseenPartsAt && row(`${unseen} parts not visible`, -wu * UF.shares.unseen_parts, 'Much of the car is unseen.'),
  ].filter(Boolean) as Row[];
  add('unknown_flags', 'Unknown flags', wu, unknownRows.length ? unknownRows : [row('none: everything was checked', 0, 'No unknowns flagged.')]);

  // 5. Market fit (10, unchanged): public listings found by /api/market-fit, and age or mileage.
  const m = inp.market, mf = C.marketFit, wm = W.market_fit;
  const fitRows: Row[] = [];
  if (m && m.ran && (Array.isArray(m.sites) || typeof m.listings === 'number')) {
    const n = m.sites ? m.sites.length : (m.listings ?? 0) > 0 ? 1 : 0;
    const where = m.state ? ` in ${m.state}` : '';
    fitRows.push(row(n ? `listed on ${n} public site${n === 1 ? '' : 's'}${where}${m.sites?.length ? ` (${m.sites.slice(0, 3).join(', ')}${m.sites.length > 3 ? '…' : ''})` : ''}` : `no public listings${where}`,
      wm * mf.shares.listings * (n >= mf.manySites ? mf.sitesLean.many : n === 1 ? mf.sitesLean.one : mf.sitesLean.none),
      n >= mf.manySites ? 'Dealers sell this model locally, so it fits ACV\'s market.'
        : n === 1 ? 'Only one site lists it locally: a thin dealer market.' : 'No local dealer market: more likely a Copart car.'));
  } else {
    missing.push('market fit (state, or listing search unavailable)');
    fitRows.push(row(m?.error ? `not run: ${m.error}` : 'not run', 0,
      !m || m.error === 'no state given' ? 'Pick a state to search public listings.' : 'The listing search was unavailable; no points.'));
  }
  const age = m?.age_years ?? null, miles = m?.mileage ?? null;
  if ((age != null && age > mf.oldYears) || (miles != null && miles > mf.highMileage)) {
    fitRows.push(row([age != null && age > mf.oldYears ? `${age} years old` : '', miles != null && miles > mf.highMileage ? `${miles.toLocaleString('en-US')} miles` : ''].filter(Boolean).join(', '),
      -wm * mf.shares.age, 'Old or high-mileage cars fall outside most dealer wholesale.'));
  }
  add('market_fit', 'Market fit', wm, fitRows);

  const acv = r1(cats.reduce((s, c) => s + c.acv, 0)), copart = r1(cats.reduce((s, c) => s + c.copart, 0));
  const margin = r1(Math.abs(acv - copart));
  const winner = forced ? 'copart' : margin < C.closeMargin ? 'too_close' : acv > copart ? 'acv' : 'copart';
  return { winner, acv, copart, margin, close_margin: C.closeMargin, forced, categories: cats, missing };
}
