import 'server-only';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { reconciliationPeriods, statementLines, reconciliationMatches } from '@/db/schema/schema';
import type { SourceData, Match } from './types';

function money(n: number | null | undefined): string | null {
  return n == null ? null : n.toFixed(2);
}

/**
 * Idempotent upsert of a reconciliation period + its statement lines + matches,
 * in one transaction. Finds the period by its natural key (org, account, start,
 * end) — the unique index guarantees one row — and wipes-and-rewrites the
 * engine-owned children.
 *
 * NOTE (Phase 1): the engine fully owns lines/matches. Once manual override UI
 * lands, this must preserve user-EXCLUDED lines and user-forced RECONCILED
 * status; for now there's no way to create those, so a full rewrite is safe.
 */
export async function persistReconciliation(args: {
  organizationId: string;
  accountId: string;
  startDate: string;
  endDate: string;
  sourceData: SourceData;
  ledgerOpening: number | null;
  ledgerClosing: number;
  matches: Match[];
  difference: number | null;
  status: 'OPEN' | 'RECONCILED';
  explanation: string;
  excludedExternalIds: Set<string>;
  manuallyReconciled: boolean;
}): Promise<string> {
  const matchByExt = new Map(args.matches.map((m) => [m.sourceExternalId, m]));
  const excluded = args.excludedExternalIds;
  const now = new Date().toISOString();

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: reconciliationPeriods.id })
      .from(reconciliationPeriods)
      .where(
        and(
          eq(reconciliationPeriods.organizationId, args.organizationId),
          eq(reconciliationPeriods.accountId, args.accountId),
          eq(reconciliationPeriods.startDate, args.startDate),
          eq(reconciliationPeriods.endDate, args.endDate),
        ),
      )
      .limit(1);

    const periodFields = {
      statementOpeningBalance: money(args.sourceData.openingBalance),
      statementClosingBalance: money(args.sourceData.closingBalance),
      ledgerOpeningBalance: money(args.ledgerOpening),
      ledgerClosingBalance: money(args.ledgerClosing),
      difference: money(args.difference),
      status: args.status,
      aiExplanation: args.explanation || null,
      manuallyReconciled: args.manuallyReconciled,
      updatedAt: now,
    };

    let periodId: string;
    if (existing) {
      periodId = existing.id;
      await tx.update(reconciliationPeriods).set(periodFields).where(eq(reconciliationPeriods.id, periodId));
      await tx.delete(reconciliationMatches).where(eq(reconciliationMatches.reconciliationPeriodId, periodId));
      await tx.delete(statementLines).where(eq(statementLines.reconciliationPeriodId, periodId));
    } else {
      periodId = randomUUID();
      await tx.insert(reconciliationPeriods).values({
        id: periodId,
        organizationId: args.organizationId,
        accountId: args.accountId,
        startDate: args.startDate,
        endDate: args.endDate,
        createdAt: now,
        ...periodFields,
      });
    }

    for (const s of args.sourceData.lines) {
      const lineId = randomUUID();
      const isExcluded = excluded.has(s.externalId);
      const m = isExcluded ? undefined : matchByExt.get(s.externalId);
      await tx.insert(statementLines).values({
        id: lineId,
        reconciliationPeriodId: periodId,
        organizationId: args.organizationId,
        accountId: args.accountId,
        statementDate: s.date,
        descriptionRaw: s.description,
        amount: s.signedAmount.toFixed(2),
        runningBalance: money(s.runningBalance),
        externalId: s.externalId,
        status: isExcluded ? 'EXCLUDED' : m ? 'MATCHED' : 'UNMATCHED',
        matchedTransactionId: m?.transactionId ?? null,
        createdAt: now,
        updatedAt: now,
      });
      if (m) {
        await tx.insert(reconciliationMatches).values({
          id: randomUUID(),
          reconciliationPeriodId: periodId,
          statementLineId: lineId,
          transactionId: m.transactionId,
          matchType: m.matchType,
          score: m.score,
          createdBy: m.createdBy,
          createdAt: now,
        });
      }
    }

    return periodId;
  });
}
