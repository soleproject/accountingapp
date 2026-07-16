import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync('app/(app)/general-ledger/page.tsx', 'utf8');

assert.match(
  page,
  /<Link\s+href=\{`\/journal-entries\/\$\{r\.journalEntryId\}`\}\s+prefetch=\{false\}/,
  'General Ledger row links must not automatically prefetch Journal Entry detail routes',
);

console.log('general-ledger-prefetch: row detail navigation remains click-driven');
