// Live parts prices from eBay's official Browse API: what ONE replacement part for this exact vehicle is listed for.
// Used for parts graded "replace"; data/repair_costs.csv stays the fallback when there are no keys, the vehicle is
// unknown, the part has no eBay category, eBay is slow, or too few listings fit. These are asking prices of active
// listings (new, mostly aftermarket, and used); eBay's sold prices need partner approval. No AI, no scraping.
// Keys: EBAY_CLIENT_ID and EBAY_CLIENT_SECRET (production keyset, client-credentials token).

type PartSpec = { category: string; q: string; must?: RegExp; avoid?: RegExp };
const DOOR_PIECES = /\b(glass|window|regulator|panel|lock|speaker|mirror|switch|actuator|trim|card|skin)\b/i;
const REAR_PIECES = /\b(cover|board|table|panel|harness|wir(e|ing)|bushings?|screws?|shocks?|absorbers?|filler|bedbridge|trim|pad|plate|camera|grommets?|assist|damper|net|lock|step|bumper|lights?|motor)\b/i;

export const PARTS_PRICE_CONFIG = {
  api: 'https://api.ebay.com',
  categoryTree: '100',        // eBay Motors US
  lookupCategory: '33710',    // headlight assemblies: every passenger vehicle has them, so its make/model lists are complete
  minListings: 5,             // fewer fitting listings than this -> the table
  band: [0.25, 0.75] as [number, number],  // middle half of the fitting listings
  minOem: 2,                  // at least this many OEM/genuine listings -> their median can raise the top of the band
  priceRange: [20, 5000] as [number, number],
  requestMs: 4000,            // per eBay call
  overallMs: 7000,            // whole lookup; past this the table is used
  cacheHours: 6,
  // eBay Motors category, search words and title checks per part (`must`: the title names the part; `avoid`: pieces
  // and accessories sold in the same category). Parts without an entry (roof, interior, engine bay, underbody, wheels
  // and tires) always use the table. tailgate_or_rear_doors depends on the body type, see partSpec().
  parts: {
    front_bumper: { category: '262146', q: 'front bumper cover', avoid: /\b(reinforcement|absorber|step|pad|insert|valance|tow|hitch)\b/i },
    rear_bumper: { category: '262146', q: 'rear bumper cover', avoid: /\b(reinforcement|absorber|step|pad|insert|valance|tow|hitch)\b/i },
    hood: { category: '33646', q: 'hood', must: /\bhood\b/i, avoid: /\b(shocks?|scoop|deflector|bug|insulation|release|vent|bra)\b/i },
    grille: { category: '33645', q: 'grille' },
    windshield: { category: '33684', q: 'windshield', must: /windshield/i, avoid: /\b(wiper|washer|visor|shade|sunshade|trim)\b/i },
    left_headlight: { category: '33710', q: 'driver headlight', avoid: /\b(cover|film|bezel|harness|socket|ballast)\b/i },
    right_headlight: { category: '33710', q: 'passenger headlight', avoid: /\b(cover|film|bezel|harness|socket|ballast)\b/i },
    left_taillight: { category: '33716', q: 'driver tail light', avoid: /\b(cover|film|bezel|harness|socket)\b/i },
    right_taillight: { category: '33716', q: 'passenger tail light', avoid: /\b(cover|film|bezel|harness|socket)\b/i },
    left_front_fender: { category: '33644', q: 'driver front fender', must: /\bfender\b/i, avoid: /\b(well|vent|trim)\b/i },
    right_front_fender: { category: '33644', q: 'passenger front fender', must: /\bfender\b/i, avoid: /\b(well|vent|trim)\b/i },
    left_front_door: { category: '179850', q: 'front driver door shell', must: /\bdoor\b/i, avoid: DOOR_PIECES },
    right_front_door: { category: '179850', q: 'front passenger door shell', must: /\bdoor\b/i, avoid: DOOR_PIECES },
    left_rear_door: { category: '179850', q: 'rear driver door shell', must: /\bdoor\b/i, avoid: DOOR_PIECES },
    right_rear_door: { category: '179850', q: 'rear passenger door shell', must: /\bdoor\b/i, avoid: DOOR_PIECES },
    left_mirror: { category: '262161', q: 'driver side mirror', must: /\bmirror\b/i, avoid: /\b(cover|signal|lens|light)\b/i },
    right_mirror: { category: '262161', q: 'passenger side mirror', must: /\bmirror\b/i, avoid: /\b(cover|signal|lens|light)\b/i },
    left_rear_quarter: { category: '262166', q: 'driver quarter panel', must: /quarter|bed ?side/i, avoid: /\b(glass|window|trim|vent)\b/i },
    right_rear_quarter: { category: '262166', q: 'passenger quarter panel', must: /quarter|bed ?side/i, avoid: /\b(glass|window|trim|vent)\b/i },
  } as Record<string, PartSpec>,
  rearByBody: {
    pickup: { category: '262178', q: 'tailgate', must: /tailgate/i, avoid: REAR_PIECES },
    sedan: { category: '33656', q: 'trunk lid', must: /trunk|deck ?lid/i, avoid: REAR_PIECES },
    coupe: { category: '33656', q: 'trunk lid', must: /trunk|deck ?lid/i, avoid: REAR_PIECES },
    suv: { category: '33647', q: 'liftgate', must: /liftgate|lift gate|hatch/i, avoid: REAR_PIECES },
    minivan: { category: '33647', q: 'liftgate', must: /liftgate|lift gate|hatch/i, avoid: REAR_PIECES },
    hatchback: { category: '33647', q: 'liftgate', must: /liftgate|lift gate|hatch/i, avoid: REAR_PIECES },
    wagon: { category: '33647', q: 'liftgate', must: /liftgate|lift gate|hatch/i, avoid: REAR_PIECES },
  } as Record<string, PartSpec>,
  // Listings that are not one whole replacement part, for every part
  noise: /\b(pairs?|set|kit|flares?|liners?|moldings?|brackets?|bulbs?|emblems?|stickers?|decals?|guards?|overlay|wrap|protectors?|tint|lens only|glass only|cover only|for parts|not working|handles?|caps?|cables?|struts?|hinges?|latch(es)?|spoilers?|seals?|weatherstrip|garnish)\b/i,
  // Keep listings within this factor of the median price (drops small pieces and whole-assembly bundles the words miss)
  aroundMedian: 3,
};

export type VehicleId = { year?: string | number | null; make?: string | null; model?: string | null; body_type?: string | null };
export type PartPrice = { low: number; high: number; listings: number; oem_median: number | null; source: 'ebay'; vehicle: string; searched: string };

const C = PARTS_PRICE_CONFIG;
export function partSpec(part: string, bodyType?: string | null) {
  return part === 'tailgate_or_rear_doors' ? C.rearByBody[bodyType ?? ''] ?? null : C.parts[part] ?? null;
}

let token: { value: string; until: number } | null = null;
async function appToken(): Promise<string | null> {
  const id = process.env.EBAY_CLIENT_ID, secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (token && token.until > Date.now() + 60_000) return token.value;
  const res = await fetch(`${C.api}/identity/v1/oauth2/token`, {
    method: 'POST', signal: AbortSignal.timeout(C.requestMs),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64') },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`eBay token ${res.status}: ${j.error_description ?? j.error ?? ''}`);
  token = { value: j.access_token, until: Date.now() + Number(j.expires_in ?? 7200) * 1000 };
  return token.value;
}

async function ebay(path: string): Promise<any> {
  const res = await fetch(C.api + path, {
    signal: AbortSignal.timeout(C.requestMs),
    headers: { Authorization: `Bearer ${await appToken()}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`eBay ${res.status}: ${j.errors?.[0]?.message ?? ''}`);
  return j;
}

const cache = new Map<string, { at: number; value: any }>();
async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < C.cacheHours * 3600_000) return hit.value;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// eBay only matches its own spelling ("Toyota", "F-150", "Silverado 1500"); the VIN decoder says "TOYOTA", a photo may say "F150".
const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function pickName(options: string[], wanted: string): string | null {
  const w = norm(wanted);
  if (!w) return null;
  const exact = options.find((o) => norm(o) === w);
  if (exact) return exact;
  const longer = options.filter((o) => norm(o).startsWith(w)).sort((a, b) => norm(a).length - norm(b).length)[0];   // "Silverado" -> "Silverado 1500"
  if (longer) return longer;
  return options.filter((o) => norm(o).length >= 3 && w.startsWith(norm(o))).sort((a, b) => norm(b).length - norm(a).length)[0] ?? null; // "Tacoma TRD" -> "Tacoma"
}

const propValues = (prop: string, filter: string) => cached(`prop:${prop}:${filter}`, async () =>
  ((await ebay(`/commerce/taxonomy/v1/category_tree/${C.categoryTree}/get_compatibility_property_values?category_id=${C.lookupCategory}&compatibility_property=${prop}&filter=${encodeURIComponent(filter)}`))
    .compatibilityPropertyValues ?? []).map((x: { value: string }) => x.value) as string[]);

async function ebayVehicle(v: VehicleId) {
  const year = Number.parseInt(String(v.year ?? ''), 10);
  if (!(year > 1980) || !v.make || !v.model) return null;
  const make = pickName(await propValues('Make', `Year:${year}`), v.make);
  if (!make) return null;
  const models = await propValues('Model', `Year:${year},Make:${make}`);
  // The VIN decoder says "Mazda3" / "Mazda6" where eBay says "3" / "6": also try the model without the make in front.
  const bare = norm(v.model).startsWith(norm(make)) ? norm(v.model).slice(norm(make).length) : '';
  const model = pickName(models, v.model) ?? (bare ? models.find((o) => norm(o) === bare) ?? null : null);
  return model ? { year, make, model } : null;
}

const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const LEFT = /\b(left|lh|driver)\b/i, RIGHT = /\b(right|rh|passenger)\b/i;

async function priceOne(veh: { year: number; make: string; model: string }, part: string, bodyType?: string | null): Promise<PartPrice | null> {
  const spec = partSpec(part, bodyType);
  if (!spec) return null;
  return cached(`price:${veh.year}|${veh.make}|${veh.model}|${part}|${spec.q}`, async () => {
    const qs = new URLSearchParams({
      q: spec.q, category_ids: spec.category, limit: '100',
      filter: 'conditions:{NEW|USED},buyingOptions:{FIXED_PRICE},priceCurrency:USD',
      compatibility_filter: `Year:${veh.year};Make:${veh.make};Model:${veh.model}`,
    });
    const items: any[] = (await ebay(`/buy/browse/v1/item_summary/search?${qs}`)).itemSummaries ?? [];
    const [want, avoid] = part.startsWith('left_') ? [LEFT, RIGHT] : part.startsWith('right_') ? [RIGHT, LEFT] : [null, null];
    const fits = items.filter((i) => i.compatibilityMatch === 'EXACT' && !C.noise.test(i.title)
      && (!spec.must || spec.must.test(i.title)) && (!spec.avoid || !spec.avoid.test(i.title))
      && (!want || (want.test(i.title) && !avoid!.test(i.title))));
    // Price plus shipping when eBay gives it (big panels ship freight).
    const cost = (i: any) => Number(i.price?.value) + (Number(i.shippingOptions?.[0]?.shippingCost?.value) || 0);
    const ok = (n: number) => n >= C.priceRange[0] && n <= C.priceRange[1];
    const all = fits.map(cost).filter(ok).sort((a, b) => a - b);
    const mid = pct(all, 0.5), near = (n: number) => n >= mid / C.aroundMedian && n <= mid * C.aroundMedian;
    const prices = all.filter(near);
    if (prices.length < C.minListings) return null;
    const oem = fits.filter((i) => /\b(oem|genuine)\b/i.test(i.title)).map(cost).filter((n) => ok(n) && near(n)).sort((a, b) => a - b);
    const oemMedian = oem.length >= C.minOem ? Math.round(pct(oem, 0.5)) : null;
    return {
      low: Math.round(pct(prices, C.band[0])), high: Math.round(Math.max(pct(prices, C.band[1]), oemMedian ?? 0)),
      listings: prices.length, oem_median: oemMedian, source: 'ebay' as const, vehicle: `${veh.year} ${veh.make} ${veh.model}`, searched: spec.q,
    };
  });
}

/** eBay prices for the given parts of one vehicle. Never throws; parts it can't price are left out (the table prices them). */
export async function ebayPartPrices(v: VehicleId | null | undefined, parts: string[]): Promise<Record<string, PartPrice>> {
  const out: Record<string, PartPrice> = {};
  if (!v || !parts.length || !process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET) return out;
  const work = (async () => {
    const veh = await ebayVehicle(v);
    if (!veh) return;
    await Promise.all([...new Set(parts)].map(async (part) => {
      try { const p = await priceOne(veh, part, v.body_type); if (p) out[part] = p; } catch (e) { console.warn(`eBay price for ${part}: ${(e as Error).message}`); }
    }));
  })().catch((e) => console.warn(`eBay prices: ${(e as Error).message}`));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise((ok) => { timer = setTimeout(ok, C.overallMs); })]);
  clearTimeout(timer);
  return { ...out };
}
