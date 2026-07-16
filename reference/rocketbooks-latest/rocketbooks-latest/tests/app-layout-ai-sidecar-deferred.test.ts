import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const layout = readFileSync('app/(app)/layout.tsx', 'utf8');
const lazyWrapper = readFileSync('components/ai-assistant/LazyAIAssistantSidecar.tsx', 'utf8');
const sidecar = readFileSync('components/ai-assistant/AIAssistantSidecar.tsx', 'utf8');
const ruleCard = readFileSync('components/ai-assistant/RulePinnedCard.tsx', 'utf8');
const contactCard = readFileSync('components/ai-assistant/ContactPinnedCard.tsx', 'utf8');
const mutationGuard = readFileSync('app/api/transactions/_lib/mutation-route.ts', 'utf8');
const requestGuard = readFileSync('app/api/transactions/_lib/request-guard.ts', 'utf8');
const verifyRoute = readFileSync('app/api/transactions/verify-guide/route.ts', 'utf8');
const ruleRoute = readFileSync('app/api/transactions/accept-rule/route.ts', 'utf8');
const contactRoute = readFileSync('app/api/transactions/accept-contact-categorization/route.ts', 'utf8');

assert.match(layout, /AssistantProvider/, 'authenticated app layout must retain AssistantProvider');
assert.doesNotMatch(
  layout,
  /from ['"]@\/components\/ai-assistant\/AIAssistantSidecar['"]/,
  'authenticated document layout must not directly import the heavy AI sidecar graph',
);
assert.match(
  layout,
  /<LazyAIAssistantSidecar orgId=\{currentOrg\.id\} \/>/,
  'authenticated layout should preserve the floating assistant through its lazy client boundary',
);
assert.match(lazyWrapper, /^['"]use client['"];?/m, 'AI sidecar lazy boundary must be a client component');
assert.match(
  lazyWrapper,
  /dynamic\(\s*\(\) => import\(['"]\.\/AIAssistantSidecar['"]\)[\s\S]*ssr:\s*false/,
  'AI sidecar must load after hydration with SSR disabled',
);

assert.doesNotMatch(
  sidecar,
  /^import .*from ['"]@\/app\/\(app\)\/transactions\/_actions\/approveTransaction['"]/m,
  'AI sidecar client graph must not directly import the transaction server-action module',
);
assert.match(
  sidecar,
  /fetch\(['"]\/api\/transactions\/verify-guide['"]/,
  'guided verification should invoke its guarded API only when the user confirms',
);

assert.doesNotMatch(ruleCard, /^import .*_actions\/approveTransaction/m, 'rule card must not statically import transaction actions');
assert.match(ruleCard, /fetch\(['"]\/api\/transactions\/accept-rule['"]/, 'rule decision card should invoke its guarded API on demand');
assert.match(ruleCard, /router\.refresh\(\)/, 'rule mutation must refresh server-rendered guided-review data');
assert.doesNotMatch(contactCard, /^import .*_actions\/approveTransaction/m, 'contact card must not statically import transaction actions');
assert.match(contactCard, /fetch\(['"]\/api\/transactions\/accept-contact-categorization['"]/, 'contact decision card should invoke its guarded API on demand');
assert.match(contactCard, /router\.refresh\(\)/, 'contact mutation must refresh server-rendered guided-review data');

assert.match(requestGuard, /contentType !== 'application\/json'/, 'mutation routes must reject non-JSON content types');
assert.match(requestGuard, /originHost !== host/, 'mutation routes must enforce Origin/Host equality');
assert.match(mutationGuard, /requirePermission\('accounting\.transactions\.view'\)/, 'mutation routes must enforce transaction permission');
assert.match(mutationGuard, /error instanceof DemoModeError/, 'mutation routes must preserve a stable demo-mode response');
for (const route of [verifyRoute, ruleRoute, contactRoute]) {
  assert.match(route, /authorizeJsonTransactionMutation\(request\)/, 'every transaction mutation route must run the shared security guard');
  assert.match(route, /\.strict\(\)/, 'every transaction mutation body must reject unknown fields');
  assert.match(route, /transactionMutationError\(error\)/, 'every transaction mutation route must return stable JSON errors');
}
assert.match(verifyRoute, /z\.string\(\)\.uuid\(\)/, 'verification IDs must be UUID bounded');
assert.match(ruleRoute, /categoryAccountId: z\.string\(\)\.uuid\(\)/, 'rule category ID must be UUID bounded');
assert.match(contactRoute, /contactId: z\.string\(\)\.uuid\(\)/, 'contact ID must be UUID bounded');

console.log('app-layout-ai-sidecar-deferred: closed AI sidecar and transaction action graph are excluded from authenticated document SSR');
