// One-off price check for a vehicle's parts: our table vs eBay (what /api/decide uses) vs factory parts on dealer sites.
//   npm run check:parts -- 2019 Toyota Tacoma [body_type] [part ...]
//   e.g. npm run check:parts -- 2017 Chevrolet "Silverado 1500" pickup right_headlight tailgate_or_rear_doors
// Default parts: front_bumper grille right_headlight right_front_fender.
// Dealer prices come from one Firecrawl search per part that opens up to 3 pages and reads the price (~5 credits a
// page), so this is for checking the table by hand, not for every vehicle check. Never eBay or auction sites.
// Needs EBAY_CLIENT_ID / EBAY_CLIENT_SECRET and FIRECRAWL_API_KEY in .env.
import 'dotenv/config';
import { repairBand } from '../api/_lib/decision.js';
import { ebayPartPrices, partSpec } from '../api/_lib/parts-prices.js';

const BODY_TYPES = ['sedan', 'coupe', 'hatchback', 'wagon', 'suv', 'pickup', 'minivan'];
const [year, make, model, ...rest] = process.argv.slice(2);
if (!year || !make || !model) { console.error('usage: npm run check:parts -- <year> <make> <model> [body_type] [part ...]'); process.exit(1); }
const bodyType = rest.find((a) => BODY_TYPES.includes(a)) ?? null;
const asked = rest.filter((a) => !BODY_TYPES.includes(a));
const parts = asked.length ? asked : ['front_bumper', 'grille', 'right_headlight', 'right_front_fender'];
const EXCLUDE = ['ebay.com', 'copart.com', 'iaai.com', 'acvauctions.com', 'manheim.com', 'adesa.com', 'amazon.com', 'walmart.com', 'youtube.com', 'reddit.com', 'facebook.com', 'pinterest.com'];
const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const range = (p?: [number, number] | null) => (p ? `${money(p[0])}-${money(p[1])}` : '-');

const SCHEMA = {
  type: 'object',
  properties: {
    price_usd: { type: ['number', 'null'], description: 'price of ONE unit of the main product on the page in US dollars; null if no price is shown' },
    product: { type: 'string' },
    is_factory_part: { type: 'boolean', description: 'genuine OEM part from the vehicle maker (part number from the maker), not aftermarket' },
    is_stock_replacement: { type: 'boolean', description: 'the stock body/lighting part itself, not an accessory, upgrade, off-road or styling part' },
    side: { type: 'string', enum: ['left', 'right', 'pair', 'none', 'unknown'] },
    fits_vehicle: { type: 'boolean', description: `the page says it fits a ${year} ${make} ${model}` },
  },
  required: ['price_usd', 'product', 'is_factory_part', 'is_stock_replacement', 'side', 'fits_vehicle'],
};

async function dealerPrices(part: string, q: string) {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return { rows: [], note: 'no FIRECRAWL_API_KEY' };
  const res = await fetch('https://api.firecrawl.dev/v2/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      query: `${year} ${make} ${model} ${q} genuine OEM part ${EXCLUDE.map((s) => `-site:${s}`).join(' ')}`, limit: 3,
      scrapeOptions: { formats: [{ type: 'json', schema: SCHEMA, prompt: `The main product on this page should be a ${q} for a ${year} ${make} ${model}. Return its price for one unit.` }], onlyMainContent: true },
    }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j.success === false) return { rows: [], note: `Firecrawl ${res.status}: ${String(j.error ?? '').slice(0, 100)}` };
  const hits: any[] = Array.isArray(j.data) ? j.data : j.data?.web ?? [];
  const side = part.startsWith('left_') ? 'left' : part.startsWith('right_') ? 'right' : null;
  const rows = hits.map((h) => {
    const x = h.json ?? {};
    const keep = x.price_usd >= 20 && x.price_usd <= 5000 && x.is_factory_part && x.is_stock_replacement && x.fits_vehicle && x.side !== 'pair' && (!side || x.side === side || x.side === 'unknown');
    return { site: new URL(h.url ?? h.metadata?.sourceURL ?? 'http://x').hostname.replace(/^www\./, ''), price: x.price_usd ?? null, keep, product: String(x.product ?? '').slice(0, 50) };
  });
  return { rows, note: j.creditsUsed ? `${j.creditsUsed} credits` : '' };
}

const ebay = await ebayPartPrices({ year, make, model, body_type: bodyType }, parts);
console.log(`${year} ${make} ${model}${bodyType ? ` (${bodyType})` : ''}: parts cost for one replacement part\n`);
for (const part of parts) {
  const spec = partSpec(part, bodyType);
  const table = repairBand({ grades: [{ part, grade: 'replace' }] }, 95).lines[0]?.parts_cost ?? null;
  const e = ebay[part];
  const d = spec ? await dealerPrices(part, spec.q) : { rows: [], note: 'no eBay category for this part' };
  const kept = d.rows.filter((r) => r.keep).map((r) => r.price as number).sort((a, b) => a - b);
  console.log(`${part}`);
  console.log(`  table           ${range(table)}`);
  console.log(`  eBay            ${e ? `${range([e.low, e.high])}  (${e.listings} listings fit ${e.vehicle}${e.oem_median ? `, OEM median ${money(e.oem_median)}` : ''})` : 'not enough listings, or no category'}`);
  console.log(`  dealer (OEM)    ${kept.length ? range([kept[0], kept[kept.length - 1]]) : '-'}  ${d.note}`);
  for (const r of d.rows) console.log(`      ${r.keep ? 'kept   ' : 'dropped'} ${r.price != null ? money(r.price) : 'no price'}  ${r.site}  ${r.product}`);
}
