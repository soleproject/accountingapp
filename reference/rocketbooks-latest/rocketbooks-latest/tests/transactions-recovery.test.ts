import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync('app/(app)/transactions/page.tsx', 'utf8');
const layout = readFileSync('app/(app)/layout.tsx', 'utf8');

assert.match(
  layout,
  /AssistantProvider/,
  'app shell must provide AssistantProvider so transactions client registrations and the sidecar can use assistant context',
);

assert.match(
  layout,
  /AIAssistantSidecar/,
  'app shell must mount the AI assistant sidecar on protected app pages',
);

assert.doesNotMatch(
  layout,
  /CoolTourRunner|GuidedTour/,
  'protected app shell must not restore heavy tour startup chrome with the assistant sidecar during stabilization',
);

assert.match(page, /<h1[^>]*>Transactions<\/h1>/, 'transactions page should still render the Transactions heading');

console.log('transactions-recovery: transactions page has assistant provider shell and avoids heavy tour startup');
