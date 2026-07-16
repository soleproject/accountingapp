import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync('app/(app)/transactions/page.tsx', 'utf8');
const panel = readFileSync('app/(app)/transactions/_components/FiltersPanel.tsx', 'utf8');
const route = readFileSync('app/api/transactions/filter-options/route.ts', 'utf8');

assert.doesNotMatch(
  page,
  /transactions\.activeContacts|contactsList/,
  'transactions first render must not load the full active contact list; contact filter options should be lazy-loaded',
);
assert.doesNotMatch(
  page,
  /transactions\.activeAccounts|bankAccountsForFilter|categoryAccountsForFilter/,
  'transactions first render must not load account/category filter lists; account options should be lazy-loaded',
);

assert.match(
  panel,
  /\/api\/transactions\/filter-options\?/,
  'FiltersPanel should lazy-load filter options when filters open instead of receiving them from SSR',
);
assert.match(
  panel,
  /kind: 'contacts'/,
  'FiltersPanel should request the contacts option kind from the lazy filter-options endpoint',
);
assert.match(
  panel,
  /kind: 'accounts'/,
  'FiltersPanel should request account/category option lists from the lazy filter-options endpoint',
);
assert.doesNotMatch(
  panel,
  /if \(!open \|\| accountOptionsLoaded\) return;/,
  'FiltersPanel must not auto-fetch account options just because filters are open; fetch only after user focus intent',
);
assert.doesNotMatch(
  panel,
  /if \(!open\) return;[\s\S]*kind: 'contacts'/,
  'FiltersPanel must not auto-fetch contact options just because filters are open; fetch only after user focus/search intent',
);
assert.match(
  panel,
  /onFocus=\{loadAccountOptions\}/,
  'account/category options should load when the user focuses account/category controls',
);
assert.match(
  panel,
  /onFocus=\{\(\) => loadContactOptions\(\)\}/,
  'contact options should load when the user focuses contact controls',
);

assert.match(
  route,
  /requirePermission\('accounting\.transactions\.view'\)/,
  'lazy filter-options endpoint must keep the transactions view permission gate',
);

assert.match(
  route,
  /\.limit\(100\)/,
  'lazy contact options should be bounded so large contact lists do not flood the page or DB',
);
assert.match(
  route,
  /kind !== 'contacts' && kind !== 'accounts'/,
  'lazy filter-options endpoint should support account/category option loading as well as contacts',
);
assert.match(
  route,
  /transactions\.filterOptions\.accounts/,
  'lazy account/category options should be timed separately from contacts',
);

console.log('transactions-lazy-filter-options: contact and account/category filter options are lazy, permission-gated, and bounded');
