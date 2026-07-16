import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync('app/(app)/contacts/page.tsx', 'utf8');
const client = readFileSync('app/(app)/contacts/_components/ContactsClient.tsx', 'utf8');
const loaded = readFileSync('app/(app)/contacts/_components/ContactsLoaded.tsx', 'utf8');
const route = readFileSync('app/api/contacts/summary/route.ts', 'utf8');
const loader = readFileSync('app/(app)/contacts/_lib/loadContactsSummary.ts', 'utf8');

assert.doesNotMatch(page, /db\.|getCurrentOrgId\(|requirePermission\(|contacts\./, 'contacts document path must not block on contact DB/permission work before first paint');
assert.match(page, /<ContactsClient query=\{queryString\} \/>/, 'contacts route should render a shell/client island');

assert.match(client, /fetch\(`\/api\/contacts\/summary\$\{query\}`/, 'contacts client should fetch contact data after first paint');
assert.match(route, /requirePermission\('accounting\.contacts\.view'\)/, 'contacts summary API must keep permission gate');
assert.match(loader, /\.limit\(PAGE_SIZE\)/, 'contacts API should retain paged visible slice');
assert.match(
  loader,
  /const allContactsForMerge = rows\.map\(\(row\) => \(\{ id: row\.id, contactName: row\.contactName \}\)\)/,
  'contacts first load should derive merge options from the visible page instead of issuing an unbounded organization-wide contact query',
);
assert.doesNotMatch(
  loader,
  /db\.select\(\{ id: contacts\.id, contactName: contacts\.contactName \}\)/,
  'contacts first load must not restore a separate organization-wide merge-options query',
);

assert.match(loaded, /prefetch=\{false\}/, 'contacts filter links should disable non-critical RSC prefetch');
assert.match(client, /dynamic\(\(\) => import\('\.\/ContactsLoaded'\)/, 'contacts heavy table/actions should be split out of the initial client chunk');

console.log('contacts-first-render-performance: document route is shell-first; contact data loads through guarded API');
