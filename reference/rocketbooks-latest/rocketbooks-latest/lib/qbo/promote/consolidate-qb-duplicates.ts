import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  chartOfAccounts,
  qboEntityMap,
  transactions,
  transactionSplits,
  journalEntryLines,
  invoices,
  imports,
  importedTransactions,
  plaidAccounts,
  aiRecommendations,
  qboMirrorSettings,
} from '@/db/schema/schema';
import { normalizeDetailType } from './account-types';
import { logger } from '@/lib/logger';

/**
 * Cleanup for orgs whose QBO migration ran BEFORE promoter normalization
 * landed. Those migrations produced two rows per concept: the seed
 * (snake_case detail_type, gaap='income') and a parallel QBO-created row
 * (PascalCase detail_type, gaap='revenue' for income types) because the
 * slot-match used exact-string comparison. PFC categorization can only
 * resolve to the seed row, so the QBO row was decorative — but it also
 * meant the user saw a doubled chart of accounts.
 *
 * For each org, this:
 *   1. Loads every active CoA row plus its qboEntityMap link (if any)
 *   2. Groups by the *normalized* slot — (gaap_type with revenue→income,
 *      snake_case detail_type)
 *   3. In groups with >1 row, picks a survivor (prefer the unlinked / seed
 *      row, falling back to the one with the seed-style snake_case detail
 *      type) and merges every other row INTO the survivor: repoints every
 *      FK column on the related tables, transfers the qboEntityMap link,
 *      copies the QBO name/number onto the survivor, then deletes the
 *      duplicate row.
 *   4. For surviving rows still on the old gaap='revenue' or PascalCase
 *      detail_type, rewrites those fields in place so future syncs and PFC
 *      lookups find them.
 *
 * Each merge runs inside a transaction so a mid-merge failure rolls back
 * cleanly. Whole-org run is idempotent: re-running after success finds no
 * duplicates and rewrites nothing.
 *
 * dryRun returns the planned actions without touching any data — use it
 * once per org to eyeball the merge plan before applying.
 */

export interface MergePlan {
  survivorId: string;
  survivorName: string;
  survivorNumber: string;
  duplicateId: string;
  duplicateName: string;
  duplicateNumber: string;
  normalizedSlot: { gaapType: string; detailType: string | null };
}

export interface NormalizeInPlacePlan {
  rowId: string;
  accountName: string;
  fromGaap: string;
  toGaap: string;
  fromDetail: string | null;
  toDetail: string | null;
}

export interface ConsolidateResult {
  organizationId: string;
  dryRun: boolean;
  merges: MergePlan[];
  normalizations: NormalizeInPlacePlan[];
  skipped: Array<{ slot: string; reason: string; rowIds: string[] }>;
  errors: Array<{ rowId: string; err: string }>;
}

function normalizeGaap(gaap: string): string {
  return gaap === 'revenue' ? 'income' : gaap;
}

function slotKey(gaap: string, detail: string | null): string {
  return `${normalizeGaap(gaap)}|${normalizeDetailType(detail) ?? ''}`;
}

interface RowState {
  id: string;
  accountName: string;
  accountNumber: string;
  gaapType: string;
  detailType: string | null;
  qboLocalIds: string[]; // qboEntityMap rows pointing AT this row's id (entityType='account')
}

export async function consolidateQbDuplicates(args: {
  organizationId: string;
  dryRun?: boolean;
}): Promise<ConsolidateResult> {
  const dryRun = args.dryRun ?? true;
  const result: ConsolidateResult = {
    organizationId: args.organizationId,
    dryRun,
    merges: [],
    normalizations: [],
    skipped: [],
    errors: [],
  };

  const rows = await db
    .select({
      id: chartOfAccounts.id,
      accountName: chartOfAccounts.accountName,
      accountNumber: chartOfAccounts.accountNumber,
      gaapType: chartOfAccounts.gaapType,
      detailType: chartOfAccounts.detailType,
      isActive: chartOfAccounts.isActive,
    })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.organizationId, args.organizationId));

  const activeRows = rows.filter((r) => r.isActive !== false);

  // Which rows are QB-linked? One query, joined back in memory.
  const links = await db
    .select({ id: qboEntityMap.id, localId: qboEntityMap.localId })
    .from(qboEntityMap)
    .where(and(
      eq(qboEntityMap.organizationId, args.organizationId),
      eq(qboEntityMap.entityType, 'account'),
    ));
  const linksByLocalId = new Map<string, string[]>();
  for (const l of links) {
    const list = linksByLocalId.get(l.localId) ?? [];
    list.push(l.id);
    linksByLocalId.set(l.localId, list);
  }

  const states: RowState[] = activeRows.map((r) => ({
    id: r.id,
    accountName: r.accountName,
    accountNumber: r.accountNumber,
    gaapType: r.gaapType,
    detailType: r.detailType,
    qboLocalIds: linksByLocalId.get(r.id) ?? [],
  }));

  // Group by normalized slot. Rows whose detailType normalizes to null
  // (empty/missing) can never collide with each other under the unique
  // constraint, so they're effectively single-row groups — pass through.
  const groups = new Map<string, RowState[]>();
  for (const s of states) {
    const key = slotKey(s.gaapType, s.detailType);
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }

  // ── Phase 1: merge duplicates ─────────────────────────────────────────
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    // Survivor preference order:
    //   1. Row with no qboEntityMap link AND snake_case detailType (seed)
    //   2. Row with snake_case detailType
    //   3. Row with no qboEntityMap link
    //   4. Lowest id (stable tiebreaker)
    const sorted = [...group].sort((a, b) => {
      const aSeed = a.qboLocalIds.length === 0 ? 0 : 1;
      const bSeed = b.qboLocalIds.length === 0 ? 0 : 1;
      if (aSeed !== bSeed) return aSeed - bSeed;
      const aSnake = a.detailType && normalizeDetailType(a.detailType) === a.detailType ? 0 : 1;
      const bSnake = b.detailType && normalizeDetailType(b.detailType) === b.detailType ? 0 : 1;
      if (aSnake !== bSnake) return aSnake - bSnake;
      return a.id.localeCompare(b.id);
    });
    const survivor = sorted[0];
    const duplicates = sorted.slice(1);

    // Skip the unusual case where multiple QB-linked rows landed in the
    // same normalized slot. That means QB itself has overlapping accounts
    // and we shouldn't pick a winner automatically.
    const qbLinkedCount = group.filter((g) => g.qboLocalIds.length > 0).length;
    if (qbLinkedCount > 1) {
      result.skipped.push({
        slot: key,
        reason: `multiple QB-linked rows in same normalized slot — needs manual review`,
        rowIds: group.map((g) => g.id),
      });
      continue;
    }

    for (const dup of duplicates) {
      const plan: MergePlan = {
        survivorId: survivor.id,
        survivorName: survivor.accountName,
        survivorNumber: survivor.accountNumber,
        duplicateId: dup.id,
        duplicateName: dup.accountName,
        duplicateNumber: dup.accountNumber,
        normalizedSlot: {
          gaapType: normalizeGaap(survivor.gaapType),
          detailType: normalizeDetailType(survivor.detailType),
        },
      };
      result.merges.push(plan);

      if (dryRun) continue;

      try {
        await db.transaction(async (tx) => {
          // Repoint every FK column on related tables. UPDATE statements
          // are no-ops if no row references the duplicate, so it's safe to
          // run all of them unconditionally.
          await tx.update(transactions)
            .set({ categoryAccountId: survivor.id })
            .where(eq(transactions.categoryAccountId, dup.id));
          await tx.update(transactionSplits)
            .set({ categoryAccountId: survivor.id })
            .where(eq(transactionSplits.categoryAccountId, dup.id));
          await tx.update(journalEntryLines)
            .set({ accountId: survivor.id })
            .where(eq(journalEntryLines.accountId, dup.id));
          await tx.update(invoices)
            .set({ arAccountId: survivor.id })
            .where(eq(invoices.arAccountId, dup.id));
          await tx.update(imports)
            .set({ accountId: survivor.id })
            .where(eq(imports.accountId, dup.id));
          await tx.update(importedTransactions)
            .set({ accountId: survivor.id })
            .where(eq(importedTransactions.accountId, dup.id));
          await tx.update(plaidAccounts)
            .set({ chartOfAccountId: survivor.id })
            .where(eq(plaidAccounts.chartOfAccountId, dup.id));
          await tx.update(aiRecommendations)
            .set({ currentCategoryAccountId: survivor.id })
            .where(eq(aiRecommendations.currentCategoryAccountId, dup.id));
          await tx.update(aiRecommendations)
            .set({ currentCoaAccountId: survivor.id })
            .where(eq(aiRecommendations.currentCoaAccountId, dup.id));
          await tx.update(aiRecommendations)
            .set({ suggestedCategoryAccountId: survivor.id })
            .where(eq(aiRecommendations.suggestedCategoryAccountId, dup.id));
          await tx.update(aiRecommendations)
            .set({ suggestedCoaAccountId: survivor.id })
            .where(eq(aiRecommendations.suggestedCoaAccountId, dup.id));
          await tx.update(qboMirrorSettings)
            .set({ defaultAccountId: survivor.id })
            .where(eq(qboMirrorSettings.defaultAccountId, dup.id));
          // chart_of_accounts self-FKs: anyone whose parent or
          // suggested-match pointed at the duplicate now points at the
          // survivor.
          await tx.update(chartOfAccounts)
            .set({ parentAccountId: survivor.id })
            .where(eq(chartOfAccounts.parentAccountId, dup.id));
          await tx.update(chartOfAccounts)
            .set({ suggestedMatchCoaId: survivor.id })
            .where(eq(chartOfAccounts.suggestedMatchCoaId, dup.id));

          // Transfer the qboEntityMap link. The duplicate held the QB
          // identity for this account; survivor inherits it.
          if (dup.qboLocalIds.length > 0) {
            await tx.update(qboEntityMap)
              .set({ localId: survivor.id })
              .where(eq(qboEntityMap.localId, dup.id));
          }

          // Copy QB's name/number onto the survivor. Same intent as the
          // relabel phase, applied retroactively for orgs that migrated
          // before relabel existed.
          await tx.update(chartOfAccounts)
            .set({
              accountName: dup.accountName,
              accountNumber: dup.accountNumber,
            })
            .where(eq(chartOfAccounts.id, survivor.id));

          // All references repointed — safe to delete the duplicate.
          await tx.delete(chartOfAccounts).where(eq(chartOfAccounts.id, dup.id));
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { organizationId: args.organizationId, survivorId: survivor.id, duplicateId: dup.id, err: msg },
          'qbo consolidate merge failed',
        );
        result.errors.push({ rowId: dup.id, err: msg });
      }
    }
  }

  // ── Phase 2: rewrite stragglers in place ──────────────────────────────
  // After the merge phase, any remaining row with gaap='revenue' or a
  // PascalCase detail_type is a single-occupant of its normalized slot,
  // so rewriting in place can't violate the unique constraint.
  const after = await db
    .select({
      id: chartOfAccounts.id,
      accountName: chartOfAccounts.accountName,
      gaapType: chartOfAccounts.gaapType,
      detailType: chartOfAccounts.detailType,
      isActive: chartOfAccounts.isActive,
    })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.organizationId, args.organizationId));

  for (const r of after) {
    if (r.isActive === false) continue;
    const toGaap = normalizeGaap(r.gaapType);
    const toDetail = normalizeDetailType(r.detailType);
    if (toGaap === r.gaapType && toDetail === r.detailType) continue;

    const plan: NormalizeInPlacePlan = {
      rowId: r.id,
      accountName: r.accountName,
      fromGaap: r.gaapType,
      toGaap,
      fromDetail: r.detailType,
      toDetail,
    };
    result.normalizations.push(plan);

    if (dryRun) continue;

    try {
      await db.update(chartOfAccounts)
        .set({ gaapType: toGaap, detailType: toDetail })
        .where(eq(chartOfAccounts.id, r.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { organizationId: args.organizationId, rowId: r.id, err: msg },
        'qbo consolidate in-place normalize failed',
      );
      result.errors.push({ rowId: r.id, err: msg });
    }
  }

  logger.info(
    {
      organizationId: args.organizationId,
      dryRun,
      merges: result.merges.length,
      normalizations: result.normalizations.length,
      skipped: result.skipped.length,
      errors: result.errors.length,
    },
    'qbo consolidate duplicates finished',
  );

  return result;
}
