// VIN decoder test (api/_lib/vin.ts, the same code /api/decode-vin runs): npm run test:vin
// Test VINs are built from real manufacturer patterns with a correct check digit; the serial numbers are made up.
import 'dotenv/config';
import { decodeVinFull } from '../api/_lib/vin.ts';

const cases = [
  { name: 'valid pickup', vin: '1FTEW1EP4KFA12345', want: (r: any) => r.ok && r.data.bodyClass === 'Pickup' && !r.data.warning },
  { name: 'valid cargo van', vin: '1FTYR1ZMXKKA12345', want: (r: any) => r.ok && r.data.bodyClass === 'Cargo Van' && !r.data.warning },
  { name: 'invalid format (letter O)', vin: '1FTEW1EP4KFA1234O', want: (r: any) => !r.ok && r.status === 400 },
  { name: '17 chars, typo in last digit', vin: '1FTEW1EP4KFA12346', want: (r: any) => r.ok && /check digit/i.test(r.data.warning ?? '') },
];

let failed = 0;
for (const c of cases) {
  const t = Date.now();
  const r = await decodeVinFull(c.vin);
  const ok = c.want(r);
  if (!ok) failed++;
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.vin}  (${Date.now() - t} ms${r.ok && r.cached ? ', from cache' : ''})`);
  console.log(JSON.stringify(r.ok ? r.data : { status: r.status, error: r.error }, null, 2));
}
console.log(failed ? `\n${failed} of ${cases.length} FAILED` : `\nAll ${cases.length} VIN cases pass.`);
process.exit(failed ? 1 : 0);
