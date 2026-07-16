import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import {
  chartOfAccounts,
  qboEntityMap,
  qboAccountStaging,
  qboMigrationJobs,
} from '@/db/schema/schema';
import { mapQboAccountType, normalizeDetailType } from './account-types';
import { logger } from '@/lib/logger';

/**
 * Recovery for orgs whose QBO migration ran BEFORE the slot-match
 * removal (migration 0024). The old promoter, when N distinct QB
 * accounts shared the same (gaap_type, detail_type) slot (e.g. five
 * EntertainmentMeals accounts in QB), claimed the seed row for all of
 * them — every QB account got a qbo_entity_map row pointing at the
 * same local chart_of_accounts row. The relabel function then ran N
 * times against that one row, with the last QB account in the loop
 * "winning" and stamping its name/number on the row. The other N−1
 * QB accounts were effectively invisible.
 *
 * This script un-collapses that. For each chart_of_accounts row with
 * >1 qbo_entity_map entries pointing at it:
 *   - Identify the "keeper" — the mapping whose qboId is the suffix of
 *     the row's accountNumber (i.e. the relabel winner). Falls back to
 *     the first mapping when the row no longer carries a qbo: prefix.
 *   - For every other mapping (the silenced QB accounts):
 *       - Look up its staging row from the most recent migration that
 *         pulled it
 *       - Insert a fresh chart_of_accounts row using that staging data
 *         (snake_case detail_type, gaap from mapQboAccountType, etc.
 *         — exactly what the new promoter would have done)
 *       - Repoint the qbo_entity_map.localId from the keeper's row to
 *         the new row
 *
 * Idempotent: re-running after success finds every localId has exactly
 * one mapping → no collapsed groups → no-op.
 *
 * dryRun returns the planned splits without writing — eyeball before
 * applying. Counter-intuitive: each "split" creates a new chart_of_
 * accounts row, so total CoA row count goes UP after this runs.
 */

export interface UncollapseResult {
  organizationId: string;
  dryRun: boolean;
  /** Mappings re-pointed to fresh local rows (one per silenced QB account). */
  split: Array<{
    qboId: string;
    oldLocalId: string;
    newLocalId: string;
    accountName: string;
    accountNumber: string;
  }>;
  /** One per collapsed group — the mapping that retained the original row. */
  kept: Array<{
    qboId: string;
    localId: string;
  }>;
  errors: Array<{ qboId: string; err: string }>;
}

export async function uncollapseQbAccounts(args: {
  organizationId: string;
  dryRun?: boolean;
}): Promise<UncollapseResult> {
  const dryRun = args.dryRun ?? true;
  const result: UncollapseResult = {
    organizationId: args.organizationId,
    dryRun,
    split: [],
    kept: [],
    errors: [],
  };

  const mappings = await db
    .select({
      id: qboEntityMap.id,
      qboId: qboEntityMap.qboId,
      realmId: qboEntityMap.realmId,
      localId: qboEntityMap.localId,
    })
    .from(qboEntityMap)
    .where(and(
      eq(qboEntityMap.organizationId, args.organizationId),
      eq(qboEntityMap.entityType, 'account'),
    ));

  if (mappings.length === 0) {
    logger.info({ organizationId: args.organizationId }, 'qbo uncollapse: no account mappings');
    return result;
  }

  // Group by localId; only groups with >1 entry need work.
  const byLocalId = new Map<string, typeof mappings>();
  for (const m of mappings) {
    const list = byLocalId.get(m.localId) ?? [];
    list.push(m);
    byLocalId.set(m.localId, list);
  }
  const collapsedGroups = Array.from(byLocalId.entries()).filter(([, group]) => group.length > 1);
  if (collapsedGroups.length === 0) {
    logger.info({ organizationId: args.organizationId }, 'qbo uncollapse: no collapsed local rows');
    return result;
  }

  // Need each collapsed local row's accountNumber to pick the keeper.
  const localIds = collapsedGroups.map(([id]) => id);
  const localRows = await db
    .select({ id: chartOfAccounts.id, accountNumber: chartOfAccounts.accountNumber })
    .from(chartOfAccounts)
    .where(inArray(chartOfAccounts.id, localIds));
  const localById = new Map(localRows.map((r) => [r.id, r]));

  // Pull every staging row across this org's migration jobs so we can
  // rebuild silenced rows from the original QB payload. Last-write wins
  // per (realmId, rawQboId) so re-migrations supersede earlier pulls.
  const jobs = await db
    .select({ id: qboMigrationJobs.id })
    .from(qboMigrationJobs)
    .where(eq(qboMigrationJobs.orgId, args.organizationId));
  const jobIds = jobs.map((j) => j.id);
  const stagingRows = jobIds.length > 0
    ? await db.select().from(qboAccountStaging).where(inArray(qboAccountStaging.migrationJobId, jobIds))
    : [];
  const stagingByKey = new Map<string, typeof stagingRows[number]>();
  for (const s of [...stagingRows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))) {
    const key = `${s.realmId}|${s.rawQboId}`;
    if (!stagingByKey.has(key)) stagingByKey.set(key, s);
  }

  for (const [winnerLocalId, group] of collapsedGroups) {
    const local = localById.get(winnerLocalId);
    if (!local) {
      // FK should prevent this — log and skip.
      result.errors.push({ qboId: group[0].qboId, err: `local row ${winnerLocalId} missing` });
      continue;
    }

    const suffix = local.accountNumber.startsWith('qbo:') ? local.accountNumber.slice(4) : null;
    const matchedKeeper = suffix ? group.find((m) => m.qboId === suffix) : undefined;
    const keeper = matchedKeeper ?? group[0];
    result.kept.push({ qboId: keeper.qboId, localId: keeper.localId });

    const losers = group.filter((m) => m.id !== keeper.id);

    for (const loser of losers) {
      try {
        const staging = stagingByKey.get(`${loser.realmId}|${loser.qboId}`);
        if (!staging) {
          result.errors.push({
            qboId: loser.qboId,
            err: `no staging row for realm ${loser.realmId} qbo ${loser.qboId} — cannot reconstruct`,
          });
          continue;
        }

        const taxonomy = mapQboAccountType(staging.type);
        const raw = staging.rawJson as { AcctNum?: string; AccountSubType?: string };
        const detailType = normalizeDetailType(staging.subtype ?? raw.AccountSubType ?? null);
        const accountNumber = raw.AcctNum?.toString().trim() || `qbo:${staging.rawQboId}`;
        const newLocalId = randomUUID();

        result.split.push({
          qboId: loser.qboId,
          oldLocalId: loser.localId,
          newLocalId,
          accountName: staging.name,
          accountNumber,
        });

        if (dryRun) continue;

        await db.transaction(async (tx) => {
          await tx.insert(chartOfAccounts).values({
            id: newLocalId,
            organizationId: args.organizationId,
            accountNumber,
            accountName: staging.name,
            gaapType: taxonomy.gaapType,
            accountType: taxonomy.accountType,
            detailType,
            normalBalance: taxonomy.normalBalance,
            isActive: staging.isActive,
            passedNameContactCheck: false,
          });
          await tx
            .update(qboEntityMap)
            .set({ localId: newLocalId, updatedAt: new Date().toISOString() })
            .where(eq(qboEntityMap.id, loser.id));
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { organizationId: args.organizationId, qboId: loser.qboId, err: msg },
          'qbo uncollapse split failed',
        );
        result.errors.push({ qboId: loser.qboId, err: msg });
      }
    }
  }

  logger.info(
    {
      organizationId: args.organizationId,
      dryRun,
      collapsedGroups: collapsedGroups.length,
      split: result.split.length,
      kept: result.kept.length,
      errors: result.errors.length,
    },
    'qbo uncollapse finished',
  );

  return result;
}
