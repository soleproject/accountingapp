import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync('app/(app)/bills/page.tsx', 'utf8');
const client = readFileSync('app/(app)/bills/_components/BillsClient.tsx', 'utf8');
const route = readFileSync('app/api/bills/summary/route.ts', 'utf8');
const loader = readFileSync('app/(app)/bills/_lib/loadBillsSummary.ts', 'utf8');

assert.doesNotMatch(page, /db\.|getCurrentOrgId\(|bill_lines|bill_payment_applications|payments/, 'bills document path must not block on bills DB work before first paint');
assert.match(page, /<BillsClient query=\{queryString\} \/>/, 'bills route should render a shell/client island');
assert.match(client, /fetch\(`\/api\/bills\/summary\$\{query\}`/, 'bills client should fetch bill data after first paint');
assert.match(route, /requireSession\(\)/, 'bills summary API must stay authenticated');
assert.match(loader, /limit \$\{limit\}/, 'bills API should retain paged visible slice');
assert.match(client, /prefetch=\{false\}/, 'bills list links should disable non-critical RSC prefetch');

console.log('bills-first-render-performance: document route is shell-first; bill data loads through guarded API');
