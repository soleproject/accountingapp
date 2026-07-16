import 'server-only';
import { and, count, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  plaidAccounts,
  plaidRawTransactions,
  importedTransactions,
  imports,
  transactions,
} from '@/db/schema/schema';
import { getOrgCoverageWindow } from './entitlements';

/**
 * Per-year count of imports waiting on a year unlock. Both surfaces
 * (Plaid auto-sync + Veryfi PDF bank-statement imports) follow the same
 * coverage rules, so the dashboard banner and /billing show a combined
 * total per year.
 *
 * Unsubscribed orgs return [] from countAllPendingByYear — the gate
 * doesn't apply to them by design, so nothing is technically blocked.
 */
export interface PendingYearCount {
  year: number;
  count: number;
}

/**
 * Un-promoted Plaid raw transactions grouped by year. "Un-promoted" =
 * no transactions row references it via 'plaid:<plaid_transaction_id>'.
 */
export async function countPendingPlaidByYear(orgId: string): Promise<PendingYearCount[]> {
  const rows = await db
    .select({
      year: sql<number>`extract(year from ${plaidRawTransactions.date})::int`.as('year'),
      n: count(),
    })
    .from(plaidRawTransactions)
    .innerJoin(plaidAccounts, eq(plaidAccounts.id, plaidRawTransactions.plaidAccountId))
    .leftJoin(
      transactions,
      and(
        eq(transactions.organizationId, orgId),
        isNotNull(transactions.reference),
        eq(transactions.reference, sql`('plaid:' || ${plaidRawTransactions.plaidTransactionId})`),
      ),
    )
    .where(
      and(
        eq(plaidAccounts.linkedOrganizationId, orgId),
        isNull(transactions.id),
      ),
    )
    .groupBy(sql`extract(year from ${plaidRawTransactions.date})`);

  return rows.map((r) => ({ year: r.year, count: Number(r.n) }));
}

/**
 * Un-promoted Veryfi (PDF bank-statement) imported_transactions grouped
 * by year. "Un-promoted" = promoted_transaction_id IS NULL — the column
 * is set by promoteImport when the row lands in transactions.
 *
 * Joins through `imports` to scope by org (importedTransactions itself
 * doesn't carry organization_id).
 */
export async function countPendingImportedByYear(orgId: string): Promise<PendingYearCount[]> {
  const rows = await db
    .select({
      year: sql<number>`extract(year from ${importedTransactions.date})::int`.as('year'),
      n: count(),
    })
    .from(importedTransactions)
    .innerJoin(imports, eq(imports.id, importedTransactions.importId))
    .where(
      and(
        eq(imports.organizationId, orgId),
        isNull(importedTransactions.promotedTransactionId),
        isNotNull(importedTransactions.date),
      ),
    )
    .groupBy(sql`extract(year from ${importedTransactions.date})`);

  return rows.map((r) => ({ year: r.year, count: Number(r.n) }));
}

/**
 * Combined pending counts across all import surfaces (Plaid auto-sync +
 * Veryfi PDF imports). Filters to years the org doesn't cover via either
 * subscription window OR an active entitlement.
 *
 * The "year not covered" rule is conservative — see the inline comment.
 * Returns [] for unsubscribed orgs.
 */
export async function countAllPendingByYear(orgId: string): Promise<PendingYearCount[]> {
  const coverage = await getOrgCoverageWindow(orgId);
  if (!coverage.subscriptionStart) return [];

  const plaid = await countPendingPlaidByYear(orgId);
  const imported = await countPendingImportedByYear(orgId);

  // Merge by year.
  const byYear = new Map<number, number>();
  for (const r of plaid) byYear.set(r.year, (byYear.get(r.year) ?? 0) + r.count);
  for (const r of imported) byYear.set(r.year, (byYear.get(r.year) ?? 0) + r.count);

  // Filter to uncovered years. The subscription window covers dates
  // >= subStart; a row's year may straddle that line if the row itself
  // is post-start (those wouldn't be un-promoted in normal operation).
  // We conservatively quarantine only when the row's year is fully
  // before — or in the same year as — the sub start, with covered rows
  // having already promoted normally.
  const subYear = coverage.subscriptionStart.getUTCFullYear();
  const out: PendingYearCount[] = [];
  for (const [year, n] of byYear.entries()) {
    if (coverage.unlockedYears.has(year)) continue;
    if (year < subYear || year === subYear) out.push({ year, count: n });
  }
  out.sort((a, b) => b.year - a.year);
  return out;
}

/**
 * Backwards-compatible alias retained for any existing imports. New code
 * should use countAllPendingByYear which includes Veryfi PDF imports too.
 */
export const countPendingPlaidUnlocksByYear = countAllPendingByYear;
