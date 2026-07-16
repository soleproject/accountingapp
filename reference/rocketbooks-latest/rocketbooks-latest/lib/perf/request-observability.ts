import { headers } from 'next/headers';
import { logger } from '@/lib/logger';
import {
  classifyPerformanceOutcome,
  createPerformanceEvent,
  isSafeCorrelationId,
  type PerformanceOutcome,
  type PerformancePhase,
  type PerformanceRouteClass,
} from './request-observability-core';

export type RequestPerformanceContext = {
  requestId: string;
  routeClass: PerformanceRouteClass;
  observed: boolean;
  isolateFirstRequest?: boolean;
  colo?: string;
};

export async function currentRequestPerformanceContext(): Promise<RequestPerformanceContext | null> {
  try {
    const values = await headers();
    const requestId = values.get('x-rs-request-id');
    const routeClass = values.get('x-rs-route-class') as PerformanceRouteClass | null;
    if (!isSafeCorrelationId(requestId) || !routeClass) return null;
    return {
      requestId,
      routeClass,
      observed: values.get('x-rs-observe') === '1',
      isolateFirstRequest: values.get('x-rs-isolate-first') === '1',
      colo: values.get('x-rs-colo') ?? undefined,
    };
  } catch {
    return null;
  }
}

export function emitPerformanceEvent(
  context: RequestPerformanceContext,
  phase: PerformancePhase,
  durationMs: number,
  outcome: PerformanceOutcome,
  metrics: { status?: number; count?: number; operation?: string; navigationStartToVisibleMs?: number; domContentLoadedMs?: number; loadEventMs?: number } = {},
) {
  if (!context.observed) return;
  logger.info(createPerformanceEvent({
    ...context,
    phase,
    durationMs,
    outcome,
    deploymentCommit: process.env.NEXT_PUBLIC_GIT_COMMIT,
    buildId: process.env.ROCKETSUITE_BUILD_ID,
    ...metrics,
  }), 'request performance');
}

export async function observeServerPhase<T>(phase: PerformancePhase, operation: () => Promise<T>): Promise<T> {
  const context = await currentRequestPerformanceContext();
  if (!context?.observed) return operation();
  const startedAt = performance.now();
  try {
    const result = await operation();
    emitPerformanceEvent(context, phase, performance.now() - startedAt, 'ok');
    return result;
  } catch (error) {
    emitPerformanceEvent(context, phase, performance.now() - startedAt, classifyPerformanceOutcome(error));
    throw error;
  }
}

export async function observeDeferredApiPhase<T extends Response>(
  operationName: string,
  operation: () => Promise<T>,
): Promise<T> {
  const context = await currentRequestPerformanceContext();
  if (!context?.observed) return operation();
  const startedAt = performance.now();
  try {
    const response = await operation();
    const durationMs = performance.now() - startedAt;
    emitPerformanceEvent(
      context,
      'deferred_api_completion',
      durationMs,
      classifyPerformanceOutcome(undefined, response.status),
      { status: response.status, operation: operationName },
    );
    response.headers.append('Server-Timing', `rs-deferred-api;dur=${durationMs.toFixed(2)}`);
    return response;
  } catch (error) {
    emitPerformanceEvent(
      context,
      'deferred_api_completion',
      performance.now() - startedAt,
      classifyPerformanceOutcome(error),
      { operation: operationName },
    );
    throw error;
  }
}
