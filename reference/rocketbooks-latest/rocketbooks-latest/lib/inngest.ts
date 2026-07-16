import { Inngest } from 'inngest';
import { logger } from './logger';

export type Events = {
  'plaid/sync.requested': {
    data: { accountId: string; trigger: string };
  };
  'plaid/sync.completed': {
    data: { accountId: string; added: number; modified: number; removed: number };
  };
  'plaid/promote.completed': {
    data: { organizationId: string; plaidAccountId: string; transactionIds: string[] };
  };
  'transactions/auto-categorize.requested': {
    data: { organizationId: string; transactionIds: string[] };
  };
  'qbo/migration.requested': {
    data: { organizationId: string; realmId: string; userId: string };
  };
  'qbo/webhook.received': {
    data: { eventIds: string[] };
  };
  'qbo/outbound.enqueued': {
    data: { queueIds?: string[]; realmId?: string };
  };
  'qbo/sync.requested': {
    data: { organizationId: string; realmId: string; userId: string };
  };
  'qbo/promote.requested': {
    data: { organizationId: string; realmId: string; userId: string };
  };
  'pdf/generate.requested': {
    data: { jobId: string; documentRecordId: string; organizationId: string };
  };
  'ghl/sync.requested': {
    data: { connectionId: string; trigger: string };
  };
  'ghl/sync.completed': {
    data: { connectionId: string; added: number };
  };
  'trust/dob-correction.requested': {
    data: { jobId: string };
  };
  'trust/resolution.requested': {
    data: { documentRecordId: string };
  };
  'reconciliation/run.requested': {
    data: {
      organizationId: string;
      accountId: string;
      year: number;
      month: number;
      triggeredBy: 'cron' | 'statement-upload' | 'manual' | 'backfill';
      userId?: string;
    };
  };
  'audit/sweep.requested': {
    data: { organizationId: string; triggeredBy?: 'cron' | 'manual' };
  };
  'digest/weekly.requested': {
    data: { organizationId: string; triggeredBy?: 'cron' | 'manual' };
  };
};

export const inngest = new Inngest({
  id: 'rocketsuite',
  name: 'RocketSuite',
});

type EventName = keyof Events;
type SendArg<N extends EventName> = { name: N } & Events[N];

/**
 * Send an Inngest event without letting a queue outage break the user-facing
 * flow. The Inngest SDK throws when `INNGEST_EVENT_KEY` is missing, when the
 * Inngest API is unreachable, or on transport errors. None of those should
 * propagate into a server action / route handler — at worst the background
 * work is retried by the next trigger or cron.
 *
 * Returns true when the event was accepted, false otherwise. Callers that
 * care can branch on the return value (e.g. surface a "queued" toast).
 */
export async function safeSend<N extends EventName>(event: SendArg<N>): Promise<boolean> {
  try {
    // The base Inngest client isn't generically typed with our Events map;
    // SendArg is the type-safe shape for callers, and we cast at the
    // boundary so safeSend stays the single concentration of `any`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await inngest.send(event as any);
    return true;
  } catch (err) {
    logger.error({ event: event.name, err }, 'inngest.send failed; flow continues without queueing');
    return false;
  }
}
