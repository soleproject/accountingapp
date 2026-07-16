import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync('app/(app)/transactions/page.tsx', 'utf8');
const bulkBar = readFileSync('app/(app)/transactions/_components/BulkBar.tsx', 'utf8');
const stepper = readFileSync('app/(app)/transactions/_components/TransactionsStepper.tsx', 'utf8');
const panel = readFileSync('app/(app)/transactions/_components/FiltersPanel.tsx', 'utf8');
const landingClient = readFileSync('app/(app)/transactions/_components/TransactionsLandingClient.tsx', 'utf8');
const landingRoute = readFileSync('app/api/transactions/landing/route.ts', 'utf8');
const landingLoader = readFileSync('app/(app)/transactions/_lib/loadTransactionsLanding.ts', 'utf8');
const tagRoute = readFileSync('app/api/transactions/tag-dimensions/route.ts', 'utf8');

assert.doesNotMatch(
  page,
  /loadAllDimensionOptions|bulkTagDimensions/,
  'transactions first render must not load bulk tag dimensions; BulkBar should fetch them only after rows are selected',
);

assert.match(
  bulkBar,
  /\/api\/transactions\/tag-dimensions/,
  'BulkBar should lazy-load tag dimensions from an API endpoint instead of making the page SSR path fetch them',
);

assert.match(
  tagRoute,
  /requirePermission\('accounting\.transactions\.view'\)/,
  'lazy tag-dimensions endpoint must keep the transactions view permission gate',
);

assert.match(
  page,
  /transactions\.summaryCounts/,
  'transactions page should combine review/stepper summary counters into one DB timing label instead of several independent count queries',
);
assert.doesNotMatch(
  page,
  /transactions\.depositsToReview|transactions\.aiToVerify|transactions\.withdrawalsToReview|transactions\.categorizingCount/,
  'transactions page should not keep separate first-render count queries for each review summary counter',
);

assert.match(
  page,
  /<Link\s+href=\{`\/transactions\/\$\{t\.id\}`\}\s+prefetch=\{false\}/,
  'transactions row detail links must disable Next prefetch so the table does not RSC-prefetch every transaction detail screen',
);
assert.match(
  page,
  /<Link\s+href=\{href\}\s+prefetch=\{false\}/,
  'sortable transaction headers must disable Next prefetch so sort variants do not prefetch during first render',
);
assert.match(
  stepper,
  /<Link\s+href=\{step\.href\}\s+prefetch=\{false\}/,
  'transactions stepper links must disable Next prefetch; they are review actions, not first-render dependencies',
);
assert.match(
  panel,
  /prefetch=\{false\}[\s\S]*role="switch"/,
  'transaction filter toggle links must disable prefetch so each toggle does not create a background RSC request',
);

assert.match(
  page,
  /case when \$\{filter === 'to_review' \|\| filter === 'to_verify'\}::boolean[\s\S]*plaid_raw_transactions/,
  'transactions page should only resolve PFC detail on review/verify views, not the default table first render',
);
assert.match(
  page,
  /case when \$\{!defaultLandingView\}::boolean[\s\S]*transaction_splits[\s\S]*case when \$\{!defaultLandingView\}::boolean[\s\S]*receipt_match_applications/,
  'transactions default landing page should not compute row badge metadata before first paint',
);

assert.match(
  page,
  /limit\(defaultLandingView \? 10 : PAGE_SIZE\)/,
  'transactions default landing page should paint a smaller recent-row slice before richer filtered/review views',
);

assert.match(
  page,
  /if \(defaultLanding\) \{[\s\S]*loadTransactionsLanding\(organizationId\)[\s\S]*return <TransactionsLandingShell organizationId=\{organizationId\} initialRows=\{initialRows\} \/>/,
  'transactions default landing route should reuse its authoritative organization for the visible row slice',
);
assert.match(
  page,
  /const TRANSACTION_VIEW_PARAMS[\s\S]*const defaultLanding = !TRANSACTION_VIEW_PARAMS\.some\(\(key\) => sp\[key\] != null && sp\[key\] !== ''\)/,
  'transactions should ignore unrelated query parameters so tracking/cache-buster parameters cannot force the heavy server-rendered table path',
);
assert.match(
  landingClient,
  /fetch\('\/api\/transactions\/landing'/,
  'transactions landing client should retain the API as a degraded fallback when initial rows are unavailable',
);
assert.match(
  landingLoader,
  /requirePermission\('accounting\.transactions\.view'\)/,
  'shared transactions landing loader must keep the transactions view permission gate',
);
assert.match(landingRoute, /loadTransactionsLanding\(\)/, 'transactions landing API must reuse the guarded loader');

console.log('transactions-first-render-performance: default route includes the visible authorized row slice, API fallback remains, filtered/review routes retain server rendering, and non-critical fanout is disabled');
