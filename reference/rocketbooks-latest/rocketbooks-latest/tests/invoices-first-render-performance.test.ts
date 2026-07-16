import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync('app/(app)/invoices/page.tsx', 'utf8');
const client = readFileSync('app/(app)/invoices/_components/InvoicesClient.tsx', 'utf8');
const route = readFileSync('app/api/invoices/summary/route.ts', 'utf8');
const loader = readFileSync('app/(app)/invoices/_lib/loadInvoicesSummary.ts', 'utf8');

assert.doesNotMatch(page, /db\.|getCurrentOrgId\(|invoiceLines|payments|contacts/, 'invoices document path must not block on invoice DB work before first paint');
assert.match(page, /<InvoicesClient query=\{queryString\} \/>/, 'invoices route should render a shell/client island');
assert.match(client, /fetch\(`\/api\/invoices\/summary\$\{query\}`/, 'invoices client should fetch invoice data after first paint');
assert.match(route, /requireSession\(\)/, 'invoices summary API must stay authenticated');
assert.match(loader, /\.limit\(PAGE_SIZE\)/, 'invoices API should retain paged visible slice');
assert.match(client, /prefetch=\{false\}/, 'invoices list links should disable non-critical RSC prefetch');

console.log('invoices-first-render-performance: document route is shell-first; invoice data loads through guarded API');
