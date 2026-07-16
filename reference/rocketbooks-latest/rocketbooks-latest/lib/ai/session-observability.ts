import { logger } from '@/lib/logger';

export type AiSessionPhase =
  | 'request_received'
  | 'auth_complete'
  | 'context_complete'
  | 'model_round'
  | 'tool_complete'
  | 'stream_complete'
  | 'request_failed';

export function classifyAiError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? 'unknown');
  if (/EMAXCONNSESSION|max clients reached/i.test(message)) return 'db_session_pool_exhausted';
  if (/timeout|timed out|abort/i.test(message)) return 'timeout';
  if (/rate limit|429/i.test(message)) return 'upstream_rate_limited';
  if (/auth|unauthorized|forbidden|401|403/i.test(message)) return 'authorization';
  return 'internal_error';
}

export function createAiSessionObserver(requestId: string, endpoint: string) {
  const startedAt = Date.now();
  return {
    event(phase: AiSessionPhase, fields: { status?: number; round?: number; tool?: string; onboardingPhase?: string | null; errorClass?: string } = {}) {
      logger.info({
        marker: 'AI_SESSION_EVENT',
        requestId,
        endpoint,
        phase,
        durationMs: Date.now() - startedAt,
        ...fields,
      });
    },
    failure(error: unknown, status = 500) {
      this.event('request_failed', { status, errorClass: classifyAiError(error) });
    },
  };
}
