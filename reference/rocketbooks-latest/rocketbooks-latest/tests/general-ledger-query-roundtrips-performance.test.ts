import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync('app/(app)/general-ledger/page.tsx', 'utf8');

assert.match(page, /count\(\*\)\s+over\s*\(\)/i, 'row query must carry the filtered total count');
assert.match(
  page,
  /sum\(\$\{generalLedger\.debit\}\)\s+over\s*\(\)/i,
  'row query must carry filtered debit totals',
);
assert.match(
  page,
  /sum\(\$\{generalLedger\.credit\}\)\s+over\s*\(\)/i,
  'row query must carry filtered credit totals',
);
assert.equal(
  (page.match(/\.from\(generalLedger\)/g) ?? []).length,
  1,
  'General Ledger page must issue one ledger-table query rather than separate count, totals, and row queries',
);

console.log('general-ledger-query-roundtrips: rows and aggregate totals share one filtered query');
