import 'server-only';
import { inngest } from '@/lib/inngest';
import { safeSend } from '@/lib/inngest';

/**
 * Thin Inngest shim for QBO sync/promote requests.
 *
 * The browser/API path emits qbo/sync.requested or qbo/promote.requested and
 * returns immediately. This function runs outside the hot request path and
 * forwards into the existing qbo/migration.requested worker, which already
 * performs both pull and promote phases with per-step checkpoints.
 */
export const qboSyncFunction = inngest.createFunction(
  {
    id: 'qbo-sync-request',
    concurrency: { limit: 1, key: 'event.data.organizationId' },
    retries: 2,
    triggers: [{ event: 'qbo/sync.requested' }],
  },
  async ({ event, step }) => {
    const { organizationId, realmId, userId } = event.data as {
      organizationId: string;
      realmId: string;
      userId: string;
    };

    const accepted = await step.run('queue-existing-qbo-migration', async () =>
      safeSend({
        name: 'qbo/migration.requested',
        data: { organizationId, realmId, userId },
      }),
    );

    return { queued: accepted, organizationId, realmId };
  },
);

export const qboPromoteFunction = inngest.createFunction(
  {
    id: 'qbo-promote-request',
    concurrency: { limit: 1, key: 'event.data.organizationId' },
    retries: 2,
    triggers: [{ event: 'qbo/promote.requested' }],
  },
  async ({ event, step }) => {
    const { organizationId, realmId, userId } = event.data as {
      organizationId: string;
      realmId: string;
      userId: string;
    };

    // The current QBO migration worker's promote phase is coupled to its pull
    // phase and idempotent. Until promote-only helpers are split out, keep this
    // request asynchronous and reuse the proven checkpointed worker instead of
    // loading QBO/promoter modules in the API route.
    const accepted = await step.run('queue-existing-qbo-migration', async () =>
      safeSend({
        name: 'qbo/migration.requested',
        data: { organizationId, realmId, userId },
      }),
    );

    return { queued: accepted, organizationId, realmId };
  },
);
