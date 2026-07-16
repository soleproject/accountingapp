import 'server-only';
import { logger } from '@/lib/logger';
import { classifyPerformanceOutcome } from '@/lib/perf/request-observability-core';
import { currentRequestPerformanceContext, emitPerformanceEvent } from '@/lib/perf/request-observability';

type DbTimingContext = Record<string, string | number | boolean | null | undefined>;

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function configuredSlowThresholdMs(): number {
  const parsed = Number(process.env.DB_SLOW_MS ?? '250');
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 250;
}

function shouldLog(durationMs: number): boolean {
  return process.env.LOG_DB_TIMINGS === '1' || durationMs >= configuredSlowThresholdMs();
}

function inferRowCount(result: unknown): number | undefined {
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === 'object' && 'count' in result) {
    const count = (result as { count?: unknown }).count;
    return typeof count === 'number' ? count : undefined;
  }
  return undefined;
}

function sanitizedContext(context: DbTimingContext): DbTimingContext {
  const safe: DbTimingContext = {};
  for (const key of ['route', 'kind', 'hasQuery', 'limit', 'page']) {
    const value = context[key];
    if (typeof value === 'boolean' || typeof value === 'number') safe[key] = value;
    if (typeof value === 'string' && /^[a-z0-9_./-]{1,100}$/i.test(value)) safe[key] = value;
  }
  return safe;
}

/** Time a database operation without recording SQL, parameters, identities, or customer values. */
export async function timeDb<T>(
  label: string,
  operation: () => Promise<T>,
  context: DbTimingContext = {},
): Promise<T> {
  const started = nowMs();
  try {
    const result = await operation();
    const durationMs = Math.round((nowMs() - started) * 100) / 100;
    const requestContext = await currentRequestPerformanceContext();
    if (requestContext) emitPerformanceEvent(requestContext, 'database_execution', durationMs, 'ok', { operation: label });
    if (shouldLog(durationMs)) {
      logger.info({
        event: 'db_timing',
        label,
        durationMs,
        slowThresholdMs: configuredSlowThresholdMs(),
        rowCount: inferRowCount(result),
        ...sanitizedContext(context),
      }, 'db timing');
    }
    return result;
  } catch (error) {
    const durationMs = Math.round((nowMs() - started) * 100) / 100;
    const outcome = classifyPerformanceOutcome(error);
    const requestContext = await currentRequestPerformanceContext();
    if (requestContext) emitPerformanceEvent(requestContext, 'database_execution', durationMs, outcome, { operation: label });
    logger.warn({
      event: 'db_timing_error',
      label,
      durationMs,
      ...sanitizedContext(context),
      errorClass: outcome,
    }, 'db timing error');
    throw error;
  }
}
