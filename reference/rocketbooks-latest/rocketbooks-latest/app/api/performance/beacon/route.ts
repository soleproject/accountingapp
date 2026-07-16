import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import {
  createPerformanceEvent,
  isSafeCorrelationId,
  sanitizePerformanceMetric,
  type PerformanceRouteClass,
} from '@/lib/perf/request-observability-core';

const ROUTE_CLASSES = new Set<PerformanceRouteClass>([
  'auth', 'public', 'health', 'api.auth', 'api.dashboard', 'api.transactions', 'api.billing', 'api.settings', 'api.other',
  'app.dashboard', 'app.transactions', 'app.billing', 'app.settings', 'app.enterprise', 'app.organizer', 'app.other',
]);

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  if (!body || typeof body !== 'object') return NextResponse.json({ ok: false }, { status: 400 });
  const candidate = body as Record<string, unknown>;
  const requestId = typeof candidate.requestId === 'string' ? candidate.requestId : null;
  const routeClass = typeof candidate.routeClass === 'string' && ROUTE_CLASSES.has(candidate.routeClass as PerformanceRouteClass)
    ? candidate.routeClass as PerformanceRouteClass
    : null;
  if (!isSafeCorrelationId(requestId) || !routeClass) return NextResponse.json({ ok: false }, { status: 400 });

  const metrics = sanitizePerformanceMetric(candidate);
  const visibleMs = typeof metrics.navigationStartToVisibleMs === 'number' ? metrics.navigationStartToVisibleMs : 0;
  logger.info(createPerformanceEvent({
    requestId,
    routeClass,
    phase: 'browser_visible_completion',
    durationMs: visibleMs,
    outcome: 'ok',
    deploymentCommit: process.env.NEXT_PUBLIC_GIT_COMMIT,
    buildId: process.env.ROCKETSUITE_BUILD_ID,
    navigationStartToVisibleMs: visibleMs,
    domContentLoadedMs: typeof metrics.domContentLoadedMs === 'number' ? metrics.domContentLoadedMs : undefined,
    loadEventMs: typeof metrics.loadEventMs === 'number' ? metrics.loadEventMs : undefined,
  }), 'request performance');
  return new NextResponse(null, { status: 204 });
}
