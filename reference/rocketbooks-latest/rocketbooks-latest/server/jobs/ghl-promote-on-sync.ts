import 'server-only';
import { inngest } from '@/lib/inngest';
import { loadConnection } from '@/lib/ghl/connection';
import { promoteGhlConnection } from '@/lib/accounting/ghl-promote';
import { logger } from '@/lib/logger';

// After a sync lands raw payments, promote them to review-only transactions.
// Mirrors plaid-promote-on-sync, minus the COA-mapping / in-scope gates
// (GHL isn't a bank account — promotion just needs the owning org).
export const ghlPromoteOnSync = inngest.createFunction(
  {
    id: 'ghl-promote-on-sync',
    concurrency: { limit: 1, key: 'event.data.connectionId' },
    retries: 2,
    triggers: [{ event: 'ghl/sync.completed' }],
  },
  async ({ event, step }) => {
    const { connectionId } = event.data as { connectionId: string };

    const connection = await step.run('load-connection', async () => {
      const c = await loadConnection(connectionId);
      return c ?? null;
    });

    if (!connection) {
      logger.warn({ connectionId }, 'ghl auto-promote: connection not found');
      return { skipped: true, reason: 'connection_not_found' };
    }

    const result = await step.run('promote', () =>
      promoteGhlConnection({
        organizationId: connection.organizationId,
        ghlConnectionId: connection.id,
      }),
    );

    logger.info(
      { connectionId, promoted: result.promoted, skipped: result.skipped },
      'ghl auto-promote done',
    );
    return result;
  },
);
