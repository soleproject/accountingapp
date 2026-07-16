export type PerformanceOutcome =
  | 'ok'
  | 'unauthenticated'
  | 'timeout'
  | 'rate_limited'
  | 'db_pool_exhausted'
  | 'client_disconnect'
  | 'client_error'
  | 'server_error'
  | 'internal_error';

export type PerformanceRouteClass =
  | 'auth'
  | 'public'
  | 'health'
  | 'api.auth'
  | 'api.dashboard'
  | 'api.transactions'
  | 'api.billing'
  | 'api.settings'
  | 'api.other'
  | 'app.dashboard'
  | 'app.transactions'
  | 'app.billing'
  | 'app.settings'
  | 'app.enterprise'
  | 'app.organizer'
  | 'app.other';

export type PerformancePhase =
  | 'request_start'
  | 'middleware_auth'
  | 'supabase_auth'
  | 'page_session_validation'
  | 'organization_resolution'
  | 'workspace_resolution'
  | 'database_execution'
  | 'server_response'
  | 'deferred_api_completion'
  | 'browser_visible_completion';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_OPERATION_PATTERN = /^[a-z][a-z0-9_.-]{0,79}$/;

export function isSafeCorrelationId(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function classifyRoute(rawPath: string): PerformanceRouteClass {
  const path = rawPath.split(/[?#]/, 1)[0] || '/';
  if (path === '/login' || path === '/signup' || path === '/forgot-password' || path === '/reset') return 'auth';
  if (path === '/api/health' || path === '/api/readiness') return 'health';
  if (path.startsWith('/api/auth/')) return 'api.auth';
  if (path.startsWith('/api/dashboard/')) return 'api.dashboard';
  if (path.startsWith('/api/transactions/')) return 'api.transactions';
  if (path.startsWith('/api/billing/')) return 'api.billing';
  if (path.startsWith('/api/settings/')) return 'api.settings';
  if (path.startsWith('/api/')) return 'api.other';
  if (path === '/dashboard' || path.startsWith('/dashboard/')) return 'app.dashboard';
  if (path === '/transactions' || path.startsWith('/transactions/')) return 'app.transactions';
  if (path === '/billing' || path.startsWith('/billing/')) return 'app.billing';
  if (path === '/settings' || path.startsWith('/settings/')) return 'app.settings';
  if (path.startsWith('/enterprise/')) return 'app.enterprise';
  if (path.startsWith('/organizer/')) return 'app.organizer';
  if (path.startsWith('/legal/') || path === '/') return 'public';
  return 'app.other';
}

export function classifyPerformanceOutcome(error?: unknown, status?: number): PerformanceOutcome {
  if (!error) {
    if (status === 401 || status === 403 || status === 307) return 'unauthenticated';
    if (status === 429) return 'rate_limited';
    if (typeof status === 'number' && status >= 500) return 'server_error';
    if (typeof status === 'number' && status >= 400) return 'client_error';
    return 'ok';
  }
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? '');
  if (/EMAXCONNSESSION|max clients reached/i.test(message)) return 'db_pool_exhausted';
  if (/AbortError|timeout|timed out|abort/i.test(message)) return 'timeout';
  if (/disconnect|closed connection/i.test(message)) return 'client_disconnect';
  if (/rate limit|429/i.test(message)) return 'rate_limited';
  return 'internal_error';
}

export function sanitizePerformanceMetric(input: Record<string, unknown>): Record<string, number | boolean> {
  const output: Record<string, number | boolean> = {};
  for (const key of ['durationMs', 'status', 'count', 'navigationStartToVisibleMs', 'domContentLoadedMs', 'loadEventMs'] as const) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      output[key] = key.endsWith('Ms') ? Math.round(value * 100) / 100 : Math.round(value);
    }
  }
  if (typeof input.isolateFirstRequest === 'boolean') output.isolateFirstRequest = input.isolateFirstRequest;
  return output;
}

function stableFraction(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

export function shouldObserveRequest(requestId: string, config: { enabled: boolean; sampleRate: number }): boolean {
  if (!config.enabled) return false;
  const sampleRate = Math.min(1, Math.max(0, config.sampleRate));
  return sampleRate === 1 || (sampleRate > 0 && stableFraction(requestId) < sampleRate);
}

export function safeOperation(value: string | undefined): string | undefined {
  return value && SAFE_OPERATION_PATTERN.test(value) ? value : undefined;
}

export function createPerformanceEvent(input: {
  requestId: string;
  routeClass: PerformanceRouteClass;
  phase: PerformancePhase;
  durationMs: number;
  outcome: PerformanceOutcome;
  deploymentCommit?: string;
  buildId?: string;
  colo?: string;
  isolateFirstRequest?: boolean;
  status?: number;
  count?: number;
  operation?: string;
  navigationStartToVisibleMs?: number;
  domContentLoadedMs?: number;
  loadEventMs?: number;
}) {
  const safeCommit = input.deploymentCommit?.match(/^[0-9a-f]{7,40}$/i)?.[0];
  const safeBuild = input.buildId?.match(/^[0-9TZ_-]{8,32}$/)?.[0];
  const safeColo = input.colo?.match(/^[A-Z0-9]{3,8}$/)?.[0];
  const metrics = sanitizePerformanceMetric(input);
  return {
    marker: 'RS_PERF_EVENT' as const,
    schemaVersion: 1,
    requestId: input.requestId,
    routeClass: input.routeClass,
    phase: input.phase,
    outcome: input.outcome,
    durationMs: Math.round(input.durationMs * 100) / 100,
    ...(typeof metrics.status === 'number' ? { status: metrics.status } : {}),
    ...(typeof metrics.count === 'number' ? { count: metrics.count } : {}),
    ...(typeof metrics.navigationStartToVisibleMs === 'number' ? { navigationStartToVisibleMs: metrics.navigationStartToVisibleMs } : {}),
    ...(typeof metrics.domContentLoadedMs === 'number' ? { domContentLoadedMs: metrics.domContentLoadedMs } : {}),
    ...(typeof metrics.loadEventMs === 'number' ? { loadEventMs: metrics.loadEventMs } : {}),
    ...(typeof metrics.isolateFirstRequest === 'boolean' ? { isolateFirstRequest: metrics.isolateFirstRequest } : {}),
    ...(safeCommit ? { deploymentCommit: safeCommit } : {}),
    ...(safeBuild ? { buildId: safeBuild } : {}),
    ...(safeColo ? { colo: safeColo } : {}),
    ...(safeOperation(input.operation) ? { operation: safeOperation(input.operation) } : {}),
  };
}
