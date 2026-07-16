import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const billingPage = readFileSync('app/(app)/billing/page.tsx', 'utf8');
const billingClient = readFileSync('app/(app)/billing/_components/BillingClient.tsx', 'utf8');
const billingLoaded = readFileSync('app/(app)/billing/_components/BillingLoaded.tsx', 'utf8');
const billingLoader = readFileSync('app/(app)/billing/_lib/loadBillingSummary.ts', 'utf8');
const billingSummaryRoute = readFileSync('app/api/billing/summary/route.ts', 'utf8');
const billingActions = readFileSync('app/(app)/billing/_actions/billing.ts', 'utf8');
const deferredSections = readFileSync('app/(app)/billing/_components/DeferredBillingSections.tsx', 'utf8');
const deferredRoute = readFileSync('app/api/billing/deferred/route.ts', 'utf8');
const pendingImportsSection = readFileSync('components/billing/PendingImportsSection.tsx', 'utf8');

assert.doesNotMatch(billingPage, /db\.|timeDb\(|requireSession\(|getCurrentOrgId\(|isSuperAdmin\(|billing\.firstRenderBundle/, '/billing document path must not block on billing DB/auth work before first paint');
assert.match(billingPage, /<BillingClient query=\{queryString\} \/>/, '/billing route should render a shell/client island');
assert.match(billingClient, /fetch\(`\/api\/billing\/summary\$\{query\}`/, '/billing client should fetch top billing data after first paint');
assert.match(billingSummaryRoute, /loadBillingSummary/, '/billing top summary data should live behind a guarded API');
assert.match(billingLoader, /requireSession\(\)[\s\S]*getCurrentOrgId\(\)[\s\S]*billing\.summaryBundle/, '/billing summary API should retain auth/org gating and bundled SQL read');
assert.match(billingLoader, /client_billing_mode[\s\S]*firmPaidClient/, '/billing summary bundle should resolve firm-paid/client-plan state without a separate helper query');
assert.doesNotMatch(billingLoader, /await\s+Promise\.all/, '/billing summary API must not fan out DB reads through Promise.all on Cloudflare Hyperdrive');
assert.doesNotMatch(billingLoader, /getClientBillingPlan\(/, '/billing summary API must not call getClientBillingPlan; firm-paid status belongs in the bundled SQL');

assert.doesNotMatch(billingPage, /PendingImportsSection|countAllPendingByYear|resolveUnlockProduct/, '/billing first render must not run pending-import/year-unlock scan helpers');
assert.match(pendingImportsSection, /countAllPendingByYear/, 'pending-import year unlock scan remains available to mount on a deferred surface later');
assert.match(deferredSections, /startUnlockCheckoutAction/, 'manual year-unlock checkout action must remain available from the deferred year-unlocks section');
assert.match(deferredRoute, /billing\.deferredDetails[\s\S]*organizationEntitlements[\s\S]*billingProducts/, '/billing below-fold entitlement/product catalog data should live behind the deferred API');

assert.match(billingClient, /dynamic\(\(\) => import\('\.\/BillingLoaded'\)/, '/billing heavy plan/forms/deferred action surface should be split out of the initial client chunk');
assert.match(billingLoaded, /href=\{`\/billing\?tab=\$\{id\}`\}/, '/billing tabs should use explicit tab query params so browser navigation can switch back to Accounting from partner tab');
assert.doesNotMatch(billingActions, /^import .*@\/lib\/stripe\//m, '/billing server-action module must not eagerly import Stripe helpers during GET render; import them inside POST actions');
assert.match(billingActions, /await import\('@\/lib\/stripe\/checkout'\)/, '/billing checkout helpers should be lazy-imported only when a checkout action is posted');

console.log('billing-first-render-performance: billing document route is shell-first, DB/auth summary is deferred behind guarded API, DB fanout avoided, Stripe imports deferred, and tabs remain navigable');
