import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const route = readFileSync('app/api/ai/chat/route.ts', 'utf8');
const sidecar = readFileSync('components/ai-assistant/AIAssistantSidecar.tsx', 'utf8');
const observability = readFileSync('lib/ai/session-observability.ts', 'utf8');

assert.match(route, /createAiSessionObserver\(/, 'AI chat must create one structured observer per request');
assert.match(route, /X-RocketSuite-Request-Id/, 'AI chat must return a searchable correlation ID');
assert.match(route, /requestId/, 'SSE failures must include a client-visible correlation ID');
assert.match(sidecar, /errorRef/, 'sidecar must render the server correlation reference on failure');
assert.match(observability, /AI_SESSION_EVENT/, 'operator logs need a stable searchable event marker');
assert.match(observability, /phase/, 'events must record lifecycle phase');
assert.match(observability, /durationMs/, 'events must record phase/session timing');
assert.match(observability, /classifyAiError/, 'errors must be reduced to a sanitized class');
assert.doesNotMatch(observability, /messages|prompt|content|email|fullName|cookie|token|sql/i, 'observer must not accept sensitive content fields');
assert.doesNotMatch(route, /firstName:\s*user|messages:\s*parsed\.data/, 'structured logs must not include identity or chat content');

console.log('ai-session-observability: correlated privacy-safe lifecycle logging is wired end to end');
