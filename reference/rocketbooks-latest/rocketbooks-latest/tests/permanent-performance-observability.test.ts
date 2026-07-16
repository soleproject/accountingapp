import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyPerformanceOutcome,
  classifyRoute,
  createPerformanceEvent,
  isSafeCorrelationId,
  sanitizePerformanceMetric,
  shouldObserveRequest,
} from '../lib/perf/request-observability-core';

assert.equal(classifyRoute('/login?next=/dashboard'), 'auth');
assert.equal(classifyRoute('/api/dashboard/summary?org=secret'), 'api.dashboard');
assert.equal(classifyRoute('/transactions/abc'), 'app.transactions');
assert.equal(classifyRoute('/some/customer-specific/path'), 'app.other');

assert.equal(isSafeCorrelationId('2f9f0c6e-1e3b-4ff5-8b1a-47c4ad9c7777'), true);
assert.equal(isSafeCorrelationId('not-safe/email@example.com'), false);
assert.equal(classifyPerformanceOutcome(new Error('max clients reached EMAXCONNSESSION')), 'db_pool_exhausted');
assert.equal(classifyPerformanceOutcome(new DOMException('timed out', 'AbortError')), 'timeout');
assert.equal(classifyPerformanceOutcome(null, 200), 'ok');
assert.equal(classifyPerformanceOutcome(null, 503), 'server_error');

assert.deepEqual(sanitizePerformanceMetric({ durationMs: 12.3456, status: 200, count: 3, secret: 'nope' }), {
  durationMs: 12.35,
  status: 200,
  count: 3,
});
assert.equal(shouldObserveRequest('fixed-id', { enabled: false, sampleRate: 1 }), false);
assert.equal(shouldObserveRequest('fixed-id', { enabled: true, sampleRate: 0 }), false);
assert.equal(shouldObserveRequest('fixed-id', { enabled: true, sampleRate: 1 }), true);

const event = createPerformanceEvent({
  requestId: '2f9f0c6e-1e3b-4ff5-8b1a-47c4ad9c7777',
  routeClass: 'app.dashboard',
  phase: 'page_session_validation',
  durationMs: 14.567,
  outcome: 'ok',
  deploymentCommit: 'fd8e7aac-not-secret',
  buildId: '20260714T000000Z',
  colo: 'DFW',
  isolateFirstRequest: true,
});
assert.equal(event.marker, 'RS_PERF_EVENT');
assert.equal(event.durationMs, 14.57);
assert.equal(JSON.stringify(event).includes('email'), false);

const middleware = readFileSync('middleware.ts', 'utf8');
const proxy = readFileSync('lib/supabase/proxy.ts', 'utf8');
const session = readFileSync('lib/auth/session.ts', 'utf8');
const org = readFileSync('lib/auth/org.ts', 'utf8');
const workspace = readFileSync('lib/auth/workspace.ts', 'utf8');
const dbTiming = readFileSync('lib/perf/db-timing.ts', 'utf8');
const rootLayout = readFileSync('app/layout.tsx', 'utf8');
const beaconRoute = readFileSync('app/api/performance/beacon/route.ts', 'utf8');
const config = readFileSync('wrangler.jsonc', 'utf8');
const stagingConfig = readFileSync('wrangler.staging.jsonc', 'utf8');

assert.match(middleware, /createRequestObservation/);
assert.match(proxy, /middleware_auth/);
assert.match(session, /page_session_validation/);
assert.match(org, /organization_resolution/);
assert.match(workspace, /workspace_resolution/);
assert.match(dbTiming, /database_execution/);
assert.doesNotMatch(dbTiming, /err:\s*error/, 'DB timing logs must not serialize raw database errors');
assert.doesNotMatch(rootLayout, /PerformanceBeacon/, 'launch rollback must remove browser performance-beacon work from every page');
assert.match(config, /"head_sampling_rate"\s*:\s*1/);
assert.match(config, /"RS_PERF_OBSERVABILITY"\s*:\s*"0"/, 'production application performance events must remain disabled in the launch rollback candidate');
assert.match(config, /"RS_PERF_SAMPLE_RATE"\s*:\s*"0"/, 'production application-event sampling must remain disabled in the launch rollback candidate');
assert.match(stagingConfig, /"head_sampling_rate"\s*:\s*1/);
assert.match(stagingConfig, /"RS_PERF_OBSERVABILITY"\s*:\s*"0"/);
assert.match(stagingConfig, /"RS_PERF_SAMPLE_RATE"\s*:\s*"0"/);

for (const source of [middleware, proxy, session, org, workspace, dbTiming, beaconRoute]) {
  assert.doesNotMatch(source, /logger\.(?:info|warn|error)\([^\n]*(?:email|cookie|token|sql|userId|orgId)/i);
}

console.log('permanent-performance-observability: privacy-safe phase correlation, browser completion, and retained Cloudflare logs are wired');
