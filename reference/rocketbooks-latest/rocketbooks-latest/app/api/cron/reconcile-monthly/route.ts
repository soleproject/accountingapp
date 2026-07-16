import { NextRequest, NextResponse } from 'next/server';
import { and, eq, gte, lte } from 'drizzle-orm';
import { db } from '@/db/client';
import { imports, plaidAccounts, plaidRawTransactions } from '@/db/schema/schema';
import { isAuthorizedCron } from '@/lib/cron';
import { safeSend } from '@/lib/inngest';
import { previousMonth, monthBounds } from '@/lib/reconciliation/dates';
import { logger } from '@/lib/logger';

export const maxDuration = 120;

/**
 * Month-end fan-out: once a month, dispatch a reconciliation event for every
 * bank account (across all orgs) that has source data for the just-closed
 * prior month — a bank-statement import closing in the month, or an in-scope
 * Plaid account with transactions in the month. The heavy lifting happens in
 * the per-account Inngest `reconcile` job; this route just enumerates + emits.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return new NextResponse('forbidden', { status: 401 });

  const now = new Date();
  const { year, month } = previousMonth(now.getUTCFullYear(), now.getUTCMonth() + 1);
  const { startDate, endDate } = monthBounds(year, month);

  const stmtAccts = await db
    .selectDistinct({ accountId: imports.accountId, organizationId: imports.organizationId })
    .from(imports)
    .where(
      and(eq(imports.importMethod, 'bank_statement'), gte(imports.endDate, startDate), lte(imports.endDate, endDate)),
    );

  const plaidAccts = await db
    .selectDistinct({ accountId: plaidAccounts.chartOfAccountId, organizationId: plaidAccounts.linkedOrganizationId })
    .from(plaidAccounts)
    .innerJoin(plaidRawTransactions, eq(plaidRawTransactions.plaidAccountId, plaidAccounts.id))
    .where(
      and(eq(plaidAccounts.inScope, true), gte(plaidRawTransactions.date, startDate), lte(plaidRawTransactions.date, endDate)),
    );

  const seen = new Set<string>();
  let dispatched = 0;
  for (const r of [...stmtAccts, ...plaidAccts]) {
    if (!r.accountId || !r.organizationId) continue;
    const key = `${r.organizationId}:${r.accountId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await safeSend({
      name: 'reconciliation/run.requested',
      data: { organizationId: r.organizationId, accountId: r.accountId, year, month, triggeredBy: 'cron' },
    });
    dispatched++;
  }

  logger.info({ year, month, dispatched }, 'reconcile-monthly: dispatched');
  return NextResponse.json({ ok: true, year, month, dispatched });
}
