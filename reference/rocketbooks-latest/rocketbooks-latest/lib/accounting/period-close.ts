import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { accountingPeriods } from '@/db/schema/schema';
import { JournalEntryError } from './posting';

/**
 * Month-end close ladder lock. A month with an accounting_periods row in
 * status 'closed' is locked: assertPeriodOpen throws, and since
 * createJournalEntry/reverseJournalEntry are the single chokepoint for all GL
 * writes, this blocks every posting/edit dated in that month. An absent row =
 * open (default), so nothing is blocked until a month is explicitly closed.
 *
 * NOTE: import cycle with posting.ts (for JournalEntryError) is call-time only
 * — neither module references the other at top level.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export type PeriodStatus = 'open' | 'reviewed' | 'closed';

function ym(dateISO: string): { year: number; month: number } {
  return { year: parseInt(dateISO.slice(0, 4), 10), month: parseInt(dateISO.slice(5, 7), 10) };
}

export async function getPeriodStatus(
  orgId: string,
  year: number,
  month: number,
  exec: Executor = db,
): Promise<PeriodStatus> {
  const [row] = await exec
    .select({ status: accountingPeriods.status })
    .from(accountingPeriods)
    .where(
      and(
        eq(accountingPeriods.organizationId, orgId),
        eq(accountingPeriods.year, year),
        eq(accountingPeriods.month, month),
      ),
    )
    .limit(1);
  return (row?.status as PeriodStatus) ?? 'open';
}

export async function isPeriodClosed(orgId: string, dateISO: string, exec: Executor = db): Promise<boolean> {
  const { year, month } = ym(dateISO);
  return (await getPeriodStatus(orgId, year, month, exec)) === 'closed';
}

/** Throws JournalEntryError if the month containing dateISO is closed. */
export async function assertPeriodOpen(orgId: string, dateISO: string, exec: Executor = db): Promise<void> {
  if (await isPeriodClosed(orgId, dateISO, exec)) {
    const { year, month } = ym(dateISO);
    throw new JournalEntryError(
      `This month (${year}-${String(month).padStart(2, '0')}) is closed — reopen the period in Close the Books to post or edit transactions dated then.`,
    );
  }
}
