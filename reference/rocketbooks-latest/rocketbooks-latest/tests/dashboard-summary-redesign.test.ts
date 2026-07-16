import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const page = readFileSync('app/(app)/dashboard/page.tsx', 'utf8');
const api = readFileSync('app/api/dashboard/summary/route.ts', 'utf8');
const client = readFileSync('app/(app)/dashboard/_components/DashboardSummaryClient.tsx', 'utf8');
const loader = readFileSync('app/(app)/dashboard/_lib/loadDashboardSummary.ts', 'utf8');

assert.doesNotMatch(page, /timeDb\(/, 'dashboard document path must keep metric SQL in the shared loader');
assert.match(page, /loadDashboardSummary\(/, 'dashboard page request should include the first-visible authorized summary');
assert.match(page, /<DashboardSummaryClient key=\{initial!\.organizationId\} initialSummary=\{initial!\.summary\}/, 'dashboard should pass organization-scoped initial summary to its client island');
assert.match(page, /welcomeDismissedAt/, 'dashboard document path may do only the lightweight user welcome gate read');
assert.match(page, /DashboardWelcome/, 'dashboard must preserve first-run/replay welcome takeover');
assert.match(page, /DashboardSummaryClient/, 'dashboard must render the summary client island');
assert.match(page, /Accounting summary|Company snapshot/, 'dashboard should be positioned as an informative accounting summary, not only command center buttons');

assert.match(api, /requireSession\(\)/, 'dashboard summary API must require an authenticated session');
assert.match(api, /runtime = 'nodejs'/, 'dashboard summary API must use nodejs runtime for DB-backed Drizzle/Postgres reads');
assert.match(api, /loadDashboardSummary\(/, 'dashboard summary API should delegate to a reusable loader');

assert.match(loader, /dashboard\.summaryBundle/, 'dashboard summary reads should be bundled under one timing label');
assert.match(loader, /outstandingInvoices|outstandingBills|transactionsToClassify|cashActivity/, 'loader must provide AR, AP, transaction cleanup, and cash activity metrics');
assert.match(loader, /jsonb_build_object[\s\S]*ar[\s\S]*ap[\s\S]*transactions[\s\S]*cashActivity/, 'loader should return a compact SQL JSON bundle instead of broad page fanout');

assert.match(client, /if \(initialSummary !== null\) return;/, 'client must not repeat the summary request when server initial data exists');
assert.match(client, /fetch\('\/api\/dashboard\/summary'/, 'client must retain guarded API fallback when initial data degrades');
assert.match(client, /Cash activity/, 'first graph should use approved Cash activity wording for transaction-based proxy');
assert.match(client, /Outstanding invoices/, 'client must display AR KPI');
assert.match(client, /Outstanding bills/, 'client must display AP KPI');
assert.match(client, /Transactions to classify/, 'client must display cleanup KPI');
assert.match(client, /aria-label="Cash activity chart"/, 'cash activity graph must have an accessible label');
assert.match(client, /aria-label="AR and AP aging chart"/, 'aging graph must have an accessible label');

console.log('dashboard-summary-redesign: authorized initial summary with API fallback and approved accounting metrics are wired');
