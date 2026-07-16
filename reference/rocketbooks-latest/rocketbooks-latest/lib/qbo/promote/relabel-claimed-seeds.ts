import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { qboEntityMap, qboAccountStaging, chartOfAccounts } from '@/db/schema/schema';
import { logger } from '@/lib/logger';
import type { PromoteResult } from './promoter';

interface RelabelCtx {
  organizationId: string;
  realmId: string;
  migrationJobId: string;
}

/**
 * Force every QB-claimed local CoA row to use QB's accountName and
 * accountNumber. Runs after promoteAccounts so qboEntityMap is populated.
 * Targets the slot-merge case in promoter.ts where the seed row was reused
 * and kept its original "6010 Entertainment Meals" label even though QB
 * calls it something else. User chose QB as source of truth at connection
 * time, so overwrite unconditionally — manually-edited names are replaced
 * too. Only touches accountName/accountNumber; slot fields stay put so the
 * unique(org, gaapType, detailType) constraint and PFC resolution don't
 * shift under us.
 *
 * `created` in the return is the count of rows actually changed, matching
 * the "did this phase do useful work" semantics the migration's final-status
 * check uses (qbo-migration.ts:545-546).
 */
export async function relabelClaimedSeeds(ctx: RelabelCtx): Promise<PromoteResult> {
  const stagingRows = await db
    .select()
    .from(qboAccountStaging)
    .where(eq(qboAccountStaging.migrationJobId, ctx.migrationJobId));

  let relabeled = 0;
  let skipped = 0;
  let errored = 0;

  for (const row of stagingRows) {
    try {
      const [mapping] = await db
        .select({ localId: qboEntityMap.localId })
        .from(qboEntityMap)
        .where(and(
          eq(qboEntityMap.organizationId, ctx.organizationId),
          eq(qboEntityMap.realmId, ctx.realmId),
          eq(qboEntityMap.entityType, 'account'),
          eq(qboEntityMap.qboId, row.rawQboId),
        ))
        .limit(1);
      if (!mapping) {
        skipped++;
        continue;
      }

      const raw = row.rawJson as { AcctNum?: string };
      const qboNumber = raw.AcctNum?.toString().trim() || `qbo:${row.rawQboId}`;
      const qboName = row.name;

      const [current] = await db
        .select({
          accountName: chartOfAccounts.accountName,
          accountNumber: chartOfAccounts.accountNumber,
        })
        .from(chartOfAccounts)
        .where(eq(chartOfAccounts.id, mapping.localId))
        .limit(1);
      if (!current) {
        logger.warn(
          { qboId: row.rawQboId, localId: mapping.localId },
          'qbo relabel: mapped local CoA row not found, skipping',
        );
        skipped++;
        continue;
      }

      if (current.accountName === qboName && current.accountNumber === qboNumber) {
        skipped++;
        continue;
      }

      await db
        .update(chartOfAccounts)
        .set({ accountName: qboName, accountNumber: qboNumber })
        .where(eq(chartOfAccounts.id, mapping.localId));
      relabeled++;
    } catch (err) {
      errored++;
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { qboId: row.rawQboId, name: row.name, err: msg },
        'qbo relabel claimed seed failed',
      );
    }
  }

  return { created: relabeled, skipped, errored };
}
