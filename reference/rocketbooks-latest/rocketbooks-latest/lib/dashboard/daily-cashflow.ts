import 'server-only';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts, generalLedger } from '@/db/schema/schema';

/**
 * Per-day cash movement on bank accounts for the current month — money in
 * (debits to cash) vs money out (credits), plus a running cumulative net.
 *
 * "Cash" = bank accounts (accountType='bank'), with the same legacy
 * name-keyword fallback the Pulse loader uses so untagged orgs still resolve.
 * This is real cash movement (ignores accrual/cash basis), so it ties to the
 * Command Center's "Cash on hand" tile rather than to P&L revenue/expense.
 */

const CASH_KEYWORDS = ['cash', 'checking', 'savings', 'bank', 'money market', 'venmo', 'paypal'];

export interface DailyCashflowPoint {
  date: string; // YYYY-MM-DD
  cashIn: number;
  cashOut: number;
  net: number; // cashIn - cashOut
  cumulative: number; // running sum of net within the month
}

export interface MonthlyCashflow {
  monthLabel: string;
  points: DailyCashflowPoint[];
  totalIn: number;
  totalOut: number;
  net: number;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function getDailyCashflowThisMonth(orgId: string): Promise<MonthlyCashflow> {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const monthStart = isoDay(new Date(Date.UTC(y, m, 1)));
  const today = isoDay(now);
  const monthLabel = new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  // Resolve cash/bank account ids (canonical type first, keyword fallback).
  const accts = await db
    .select({ id: chartOfAccounts.id, name: chartOfAccounts.accountName, type: chartOfAccounts.accountType })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.organizationId, orgId));
  const byType = accts.filter((a) => a.type === 'bank').map((a) => a.id);
  const cashIds =
    byType.length > 0
      ? byType
      : accts
          .filter((a) => CASH_KEYWORDS.some((kw) => (a.name ?? '').toLowerCase().includes(kw)))
          .map((a) => a.id);

  // Pre-seed every day of the month up to today so the chart never gap-interpolates.
  const byDay = new Map<string, DailyCashflowPoint>();
  for (let d = 1; d <= now.getUTCDate(); d++) {
    const iso = isoDay(new Date(Date.UTC(y, m, d)));
    byDay.set(iso, { date: iso, cashIn: 0, cashOut: 0, net: 0, cumulative: 0 });
  }

  if (cashIds.length > 0) {
    const rows = await db
      .select({
        day: sql<string>`TO_CHAR(${generalLedger.date}, 'YYYY-MM-DD')`.as('day'),
        cashIn: sql<string>`COALESCE(SUM(${generalLedger.debit}), 0)`.as('cash_in'),
        cashOut: sql<string>`COALESCE(SUM(${generalLedger.credit}), 0)`.as('cash_out'),
      })
      .from(generalLedger)
      .where(
        and(
          eq(generalLedger.organizationId, orgId),
          inArray(generalLedger.accountId, cashIds),
          gte(generalLedger.date, `${monthStart}T00:00:00`),
          lte(generalLedger.date, `${today}T23:59:59`),
        ),
      )
      .groupBy(sql`TO_CHAR(${generalLedger.date}, 'YYYY-MM-DD')`);

    for (const r of rows) {
      const p = byDay.get(r.day);
      if (!p) continue;
      p.cashIn = Number(r.cashIn);
      p.cashOut = Number(r.cashOut);
      p.net = p.cashIn - p.cashOut;
    }
  }

  let running = 0;
  let totalIn = 0;
  let totalOut = 0;
  const points = Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date));
  for (const p of points) {
    running += p.net;
    p.cumulative = running;
    totalIn += p.cashIn;
    totalOut += p.cashOut;
  }

  return { monthLabel, points, totalIn, totalOut, net: totalIn - totalOut };
}
