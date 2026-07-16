import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Regression guard for the guided-review feature on
// /transactions?filter=to_review&guide=1 (the dashboard "Review N → Show me"
// walkthrough: spotlight the to-review queue + open the AI to triage it).
//
// History (Jun 2026): an emergency "recovery shell" stripped the AssistantProvider
// from the app layout, so a follow-up stripped <GuidedTriage>/<AssistantPageRegistration>
// from this page (they call useAssistant() and would have crashed). The shell was
// later reverted — the provider was restored — but the page render was NOT, silently
// breaking guided review. This guard asserts the full shell is in place so that
// can't happen again unnoticed. (Replaces the obsolete transactions-recovery test
// that asserted the opposite, now-defunct state.)

const page = readFileSync('app/(app)/transactions/page.tsx', 'utf8');
const layout = readFileSync('app/(app)/layout.tsx', 'utf8');

assert.match(
  layout,
  /AssistantProvider/,
  'app shell must mount AssistantProvider — assistant/guide components depend on it',
);

assert.match(
  page,
  /<GuidedTriage/,
  'transactions page must render <GuidedTriage> so guide=1 spotlights the queue + seeds the AI',
);

assert.match(
  page,
  /<AssistantPageRegistration/,
  'transactions page must register page context (guide data) for the assistant',
);

console.log('transactions-guided-review: guided-triage render + AssistantProvider present');
