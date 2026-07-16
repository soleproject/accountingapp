import type { NextRequest } from 'next/server';
import {
  classifyPerformanceOutcome,
  classifyRoute,
  createPerformanceEvent,
  shouldObserveRequest,
  type PerformanceOutcome,
  type PerformancePhase,
  type PerformanceRouteClass,
} from './request-observability-core';

declare global {
  var __rsPerfIsolateHasHandledRequest: boolean | undefined;
}

export type EdgeRequestObservation = {
  requestId: string;
  routeClass: PerformanceRouteClass;
  observed: boolean;
  isolateFirstRequest: boolean;
  colo?: string;
  requestHeaders: Headers;
};

function config() {
  const parsed = Number(process.env.RS_PERF_SAMPLE_RATE ?? '0.1');
  return {
    enabled: process.env.RS_PERF_OBSERVABILITY === '1',
    sampleRate: Number.isFinite(parsed) ? parsed : 0.1,
  };
}

export function createRequestObservation(request: NextRequest): EdgeRequestObservation {
  const requestId = crypto.randomUUID();
  const isolateFirstRequest = globalThis.__rsPerfIsolateHasHandledRequest !== true;
  globalThis.__rsPerfIsolateHasHandledRequest = true;
  const observed = shouldObserveRequest(requestId, config());
  const routeClass = classifyRoute(request.nextUrl.pathname);
  const colo = request.headers.get('cf-ray')?.split('-').at(-1)?.toUpperCase();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-rs-request-id', requestId);
  requestHeaders.set('x-rs-route-class', routeClass);
  requestHeaders.set('x-rs-observe', observed ? '1' : '0');
  requestHeaders.set('x-rs-isolate-first', isolateFirstRequest ? '1' : '0');
  if (colo && /^[A-Z0-9]{3,8}$/.test(colo)) requestHeaders.set('x-rs-colo', colo);
  return { requestId, routeClass, observed, isolateFirstRequest, colo, requestHeaders };
}

export function emitEdgePerformanceEvent(
  observation: EdgeRequestObservation,
  phase: PerformancePhase,
  durationMs: number,
  outcome: PerformanceOutcome,
  metrics: { status?: number; operation?: string } = {},
) {
  if (!observation.observed) return;
  console.info(JSON.stringify(createPerformanceEvent({
    ...observation,
    phase,
    durationMs,
    outcome,
    deploymentCommit: process.env.NEXT_PUBLIC_GIT_COMMIT,
    buildId: process.env.ROCKETSUITE_BUILD_ID,
    ...metrics,
  })));
}

export function edgeOutcome(error?: unknown, status?: number) {
  return classifyPerformanceOutcome(error, status);
}

export function attachObservationHeaders(response: Response, observation: EdgeRequestObservation, middlewareAuthMs?: number) {
  response.headers.set('X-RocketSuite-Request-Id', observation.requestId);
  if (typeof middlewareAuthMs === 'number') response.headers.append('Server-Timing', `rs-middleware-auth;dur=${middlewareAuthMs.toFixed(2)}`);
  return response;
}
