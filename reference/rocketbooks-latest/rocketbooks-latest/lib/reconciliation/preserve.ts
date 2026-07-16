import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { reconciliationPeriods, statementLines, reconciliationMatches } from '@/db/schema/schema';
import type { MatchKind } from './types';

/** Authors the engine owns; everything else is a user manual edit to preserve. */
const ENGINE_AUTHORS = new Set(['engine', 'ai', 'demo-seed']);

export interface Preservation {
  periodId: string | null;
  /** externalIds the user marked EXCLUDED (sticky across re-runs). */
  excludedExternalIds: Set<string>;
  /** externalId → the user's manual match (re-applied on re-run). */
  userMatches: Map<string, { transactionId: string; matchType: MatchKind; score: number; createdBy: string }>;
  manuallyReconciled: boolean;
  /** Hand-started reconciliation — the engine must not overwrite it. */
  isManual: boolean;
}

const EMPTY: Preservation = {
  periodId: null,
  excludedExternalIds: new Set(),
  userMatches: new Map(),
  manuallyReconciled: false,
  isManual: false,
};

/**
 * Read the user-owned state of an existing period so an engine re-run doesn't
 * clobber it: EXCLUDED lines, manual matches (created_by = a real user), and a
 * force-reconciled lock.
 */
export async function readPreservation(
  organizationId: string,
  accountId: string,
  startDate: string,
  endDate: string,
): Promise<Preservation> {
  const [p] = await db
    .select({ id: reconciliationPeriods.id, manuallyReconciled: reconciliationPeriods.manuallyReconciled, isManual: reconciliationPeriods.isManual })
    .from(reconciliationPeriods)
    .where(
      and(
        eq(reconciliationPeriods.organizationId, organizationId),
        eq(reconciliationPeriods.accountId, accountId),
        eq(reconciliationPeriods.startDate, startDate),
        eq(reconciliationPeriods.endDate, endDate),
      ),
    )
    .limit(1);
  if (!p) return EMPTY;

  const lines = await db
    .select({ externalId: statementLines.externalId, status: statementLines.status })
    .from(statementLines)
    .where(eq(statementLines.reconciliationPeriodId, p.id));
  const excludedExternalIds = new Set<string>();
  for (const l of lines) if (l.status === 'EXCLUDED' && l.externalId) excludedExternalIds.add(l.externalId);

  const matches = await db
    .select({
      externalId: statementLines.externalId,
      transactionId: reconciliationMatches.transactionId,
      matchType: reconciliationMatches.matchType,
      score: reconciliationMatches.score,
      createdBy: reconciliationMatches.createdBy,
    })
    .from(reconciliationMatches)
    .innerJoin(statementLines, eq(statementLines.id, reconciliationMatches.statementLineId))
    .where(eq(reconciliationMatches.reconciliationPeriodId, p.id));
  const userMatches = new Map<string, { transactionId: string; matchType: MatchKind; score: number; createdBy: string }>();
  for (const m of matches) {
    if (!m.externalId || !m.createdBy || ENGINE_AUTHORS.has(m.createdBy)) continue;
    userMatches.set(m.externalId, {
      transactionId: m.transactionId,
      matchType: m.matchType as MatchKind,
      score: m.score == null ? 1 : Number(m.score),
      createdBy: m.createdBy,
    });
  }

  return { periodId: p.id, excludedExternalIds, userMatches, manuallyReconciled: p.manuallyReconciled, isManual: p.isManual };
}
