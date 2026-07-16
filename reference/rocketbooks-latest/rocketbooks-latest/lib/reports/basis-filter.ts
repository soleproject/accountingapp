import 'server-only';
import { eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { journalEntries, journalEntryLines, generalLedger, organizations } from '@/db/schema/schema';
import type { SQL } from 'drizzle-orm';

export type ReportBasis = 'accrual' | 'cash';

/**
 * Strict cash-basis filter: excludes any JE whose sourceType is 'invoice' or
 * 'bill'. The result is that AR / AP recognition disappears from reports —
 * revenue and expense are only recognized through transaction-level JEs
 * (i.e. the cash side actually moved).
 *
 * KNOWN LIMITATION: orgs that record bank-transaction payments by applying
 * them to AR / AP (instead of categorizing them directly to revenue/expense)
 * will lose revenue/expense recognition under this filter. Re-recognizing
 * each paid invoice / bill on its payment date is the v2 fix.
 */
export function parseBasis(input: string | null | undefined): ReportBasis {
  return input === 'cash' ? 'cash' : 'accrual';
}

/** Read the org's saved accounting method. Falls back to 'accrual' if the
 *  row is missing or the column has an unexpected value. Used as the
 *  default when a report page receives no `basis` query param. */
export async function getOrgBasis(orgId: string): Promise<ReportBasis> {
  const [row] = await db
    .select({ method: organizations.accountingMethod })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return parseBasis(row?.method);
}

/** Same but: takes the URL param first, falls back to the org default. */
export async function resolveBasis(
  orgId: string,
  paramValue: string | null | undefined,
): Promise<ReportBasis> {
  if (paramValue === 'cash' || paramValue === 'accrual') return paramValue;
  return getOrgBasis(orgId);
}

const EXCLUDED_SOURCE_TYPES = ['invoice', 'bill'] as const;

/** Subquery: JE IDs that should be INCLUDED in cash basis (i.e. not invoice
 *  or bill). NULL sourceType counts as include. */
function cashBasisIncludedJeIds() {
  return db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      or(
        isNull(journalEntries.sourceType),
        notInArray(journalEntries.sourceType, EXCLUDED_SOURCE_TYPES as unknown as string[]),
      ),
    );
}

/** WHERE clause for queries against generalLedger. NULL journalEntryId
 *  is kept (legacy rows / direct postings). */
export function generalLedgerBasisFilter(basis: ReportBasis): SQL | undefined {
  if (basis === 'accrual') return undefined;
  return or(
    isNull(generalLedger.journalEntryId),
    inArray(generalLedger.journalEntryId, cashBasisIncludedJeIds()),
  );
}

/** WHERE clause for queries against journalEntryLines. */
export function journalEntryLinesBasisFilter(basis: ReportBasis): SQL | undefined {
  if (basis === 'accrual') return undefined;
  return inArray(journalEntryLines.journalEntryId, cashBasisIncludedJeIds());
}

/** Inline filter for queries that already join journalEntries — slightly
 *  cheaper than a subquery when available. */
export function inlineBasisFilter(basis: ReportBasis): SQL | undefined {
  if (basis === 'accrual') return undefined;
  return or(
    isNull(journalEntries.sourceType),
    notInArray(journalEntries.sourceType, EXCLUDED_SOURCE_TYPES as unknown as string[]),
  );
}

/** True/false test in JS for non-SQL contexts (e.g., post-query filtering). */
export function jeAllowedUnderBasis(sourceType: string | null, basis: ReportBasis): boolean {
  if (basis === 'accrual') return true;
  if (sourceType == null) return true;
  return !(EXCLUDED_SOURCE_TYPES as readonly string[]).includes(sourceType);
}

// Avoid unused-import warnings for `eq` and `sql` if helpers shrink.
void eq;
void sql;
