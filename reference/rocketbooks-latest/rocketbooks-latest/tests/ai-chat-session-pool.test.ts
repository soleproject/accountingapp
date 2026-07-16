import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const chatRoute = readFileSync('app/api/ai/chat/route.ts', 'utf8');
const clientContext = readFileSync('lib/ai/client-context.ts', 'utf8');

assert.match(
  chatRoute,
  /getEnterpriseBranding\(\)\.catch\(\(\) => null\)/,
  '/api/ai/chat must degrade to default branding instead of returning HTTP 500 when the shared DB pool is saturated',
);
assert.match(
  chatRoute,
  /buildChatClientContext\(orgId\)/,
  '/api/ai/chat should use the lightweight chat context that does not derive action cards during every AI turn',
);
assert.match(
  clientContext,
  /export async function buildChatClientContext[\s\S]*?cards:\s*\[\]/,
  'lightweight chat context should preserve onboarding/profile grounding without eager action-card fanout',
);

assert.doesNotMatch(
  chatRoute,
  /const \[branding, clientContext, firstName\] = await Promise\.all\(/,
  '/api/ai/chat must not acquire branding, client context, and first-name DB reads concurrently; production Hyperdrive uses a 15-client session pool',
);

const buildContextBody = clientContext.match(
  /export async function buildClientContext[\s\S]*?\n}\n\n\/\*\*/,
)?.[0] ?? clientContext;
assert.doesNotMatch(
  buildContextBody,
  /await Promise\.all\(/,
  'buildClientContext must not fan out org, onboarding, action-card, and profile DB work concurrently under the production session pool',
);

console.log('ai-chat-session-pool: chat startup DB work is bounded instead of Promise.all fanout');
