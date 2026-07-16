import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const assistantRoute = readFileSync('app/api/ai/assistant/chat/route.ts', 'utf8');
const openerRoute = readFileSync('app/api/ai/opener/route.ts', 'utf8');
const sidecar = readFileSync('components/ai-assistant/AIAssistantSidecar.tsx', 'utf8');
const aiChatPage = readFileSync('app/(app)/ai-chat/page.tsx', 'utf8');
const aiChatWorkspace = readFileSync('app/(app)/ai-chat/_components/AiChatWorkspace.tsx', 'utf8');

assert.doesNotMatch(
  assistantRoute,
  /chatCompletionStream/,
  'assistant chat route must not do a second OpenAI streaming call after a no-tool completion; stream the first completion content as SSE deltas instead',
);
assert.match(
  assistantRoute,
  /skipUsage:\s*true/,
  'assistant chat route should skip fire-and-forget DB usage writes during production stabilization to avoid waitUntil cancellation/pool pressure',
);

const usageModule = readFileSync('lib/ai/usage.ts', 'utf8');
assert.match(
  usageModule,
  /ctx\.metadata\?\.skipUsage\s*===\s*true/,
  'AI usage recorder should honor skipUsage metadata for stabilization paths',
);

assert.match(
  openerRoute,
  /searchParams\.get\('light'\)|searchParams\.get\("light"\)/,
  'AI opener route must support a lightweight mode for sidecar first-open that avoids heavy DB/context work',
);

assert.match(
  sidecar,
  /new URLSearchParams\(\{ light: '1' \}\)/,
  'AI sidecar must construct lightweight opener query params by default',
);
assert.match(
  sidecar,
  /fetch\(`\/api\/ai\/opener\?\$\{query\.toString\(\)\}`\)/,
  'AI sidecar must request the lightweight opener by default so opening the assistant does not add DB pool pressure',
);

assert.match(
  aiChatPage,
  /AiChatWorkspace/,
  'AI chat page must keep the rich workspace mounted; replacing it with a dead shell is feature loss',
);
assert.doesNotMatch(
  aiChatPage,
  /fetchInitialCards|fetchInitialOutlook|getActionCards|getOutlook\(|isSuperAdmin\(|getFirstName\(/,
  'AI chat page first render must not perform DB-backed cards/outlook/admin/name reads during production stabilization',
);
assert.match(
  aiChatWorkspace,
  /fetch\('\/api\/ai-chat\/bootstrap'/,
  'AI chat workspace should lazy-load optional name/realtime capability after first paint',
);
assert.match(
  aiChatWorkspace,
  /fetch\('\/api\/ai\/opener\?light=1'/,
  'AI chat workspace should use lightweight opener on first paint',
);

console.log('ai-assistant-performance: assistant avoids double OpenAI call and keeps /ai-chat lightweight without removing workspace');
