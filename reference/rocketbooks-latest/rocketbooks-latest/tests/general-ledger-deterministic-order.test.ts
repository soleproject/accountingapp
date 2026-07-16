import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync('app/(app)/general-ledger/page.tsx', 'utf8');

assert.match(
  page,
  /\.orderBy\(desc\(generalLedger\.date\), desc\(generalLedger\.createdAt\), desc\(generalLedger\.id\)\)/,
  'General Ledger pagination must use a deterministic primary-key tie-breaker',
);

console.log('general-ledger-ordering: pagination is deterministic across query plans');
