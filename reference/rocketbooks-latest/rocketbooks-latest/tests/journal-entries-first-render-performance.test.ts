import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync('app/(app)/journal-entries/page.tsx', 'utf8');
const client = readFileSync('app/(app)/journal-entries/_components/JournalEntriesClient.tsx', 'utf8');
const route = readFileSync('app/api/journal-entries/summary/route.ts', 'utf8');
const loader = readFileSync('app/(app)/journal-entries/_lib/loadJournalEntriesSummary.ts', 'utf8');

assert.doesNotMatch(
  page,
  /db\.|getCurrentOrgId\(|journalEntryLines|journalEntries/,
  'journal entries document path must not block on GL DB queries before first paint',
);
assert.match(page, /<JournalEntriesClient query=\{queryString\} \/>/, 'journal entries route should render a shell/client island');
assert.match(client, /fetch\(`\/api\/journal-entries\/summary\$\{query\}`/, 'journal entries client should fetch GL data after first paint');
assert.match(route, /requireSession\(\)/, 'journal entries summary API must stay authenticated');
assert.match(loader, /\.limit\(100\)/, 'journal entries API should cap the visible first slice at 100 rows');
assert.match(client, /prefetch=\{false\}/, 'journal entries list links should disable non-critical RSC prefetch');

console.log('journal-entries-first-render-performance: document route is shell-first; GL data loads through guarded API with capped visible slice');
