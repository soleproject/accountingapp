import 'server-only';
import { eq } from 'drizzle-orm';
import { inngest } from '@/lib/inngest';
import { db } from '@/db/client';
import { plaidAccounts } from '@/db/schema/schema';
import { promotePersonalPlaidAccount } from '@/lib/personal/plaid-promote-personal';
import { logger } from '@/lib/logger';

/**
 * Personal-side promote: when a synced Plaid account is linked to a personal
 * account (linked_personal_id set), mirror its raw transactions into
 * personal_transactions. Runs alongside plaid-promote-on-sync, which handles
 * the business (linked_organization_id) path. Each account is only ever one or
 * the other, so exactly one of the two promoters acts on any given account.
 */
export const plaidPromotePersonalOnSync = inngest.createFunction(
  {
    id: 'plaid-promote-personal-on-sync',
    concurrency: { limit: 1, key: 'event.data.accountId' },
    retries: 2,
    triggers: [{ event: 'plaid/sync.completed' }],
  },
  async ({ event, step }) => {
    const { accountId } = event.data as { accountId: string };

    const account = await step.run('load-account', async () => {
      const [a] = await db
        .select({ id: plaidAccounts.id, linkedPersonalId: plaidAccounts.linkedPersonalId })
        .from(plaidAccounts)
        .where(eq(plaidAccounts.id, accountId))
        .limit(1);
      return a ?? null;
    });

    if (!account) return { skipped: true, reason: 'account_not_found' };
    if (!account.linkedPersonalId) return { skipped: true, reason: 'not_personal' };

    const result = await step.run('promote-personal', () =>
      promotePersonalPlaidAccount({ plaidAccountId: account.id }),
    );

    logger.info({ accountId, promoted: result.promoted, skipped: result.skipped }, 'personal auto-promote done');
    return result;
  },
);
