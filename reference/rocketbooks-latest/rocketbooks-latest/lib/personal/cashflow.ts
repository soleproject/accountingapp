import 'server-only';
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { personalTransactions, personalRecurring } from '@/db/schema/schema';
import { getPersonalAccounts, getMonthCashflow, isLiability, currentMonthStartISO } from './queries';
import { normalizeMerchant } from './recurring';

/** Account types that count as liquid cash for a cash-balance projection. */
function isCash(type: string): boolean {
  const t = type.toLowerCase();
  return !isLiability(type) && t !== 'investment' && t !== 'brokerage';
}

export interface CashflowDay {
  day: number;
  /** Net cash change for the day (in − out). Projected days = baseline + recurring. */
  net: number;
  /** Running cash balance at end of day (reconstructed for the past, projected ahead). */
  balance: number;
  projected: boolean;
}

export interface ScheduledRecurring {
  date: string;
  label: string;
  amount: number; // absolute
  type: 'expense' | 'income';
}

export interface CashflowProjection {
  monthLabel: string;
  daysInMonth: number;
  today: number;
  currentCash: number;
  startOfMonthBalance: number;
  monthToDate: { income: number; spending: number; net: number };
  /** Overall trailing-90d average daily net (reference). */
  avgDailyNet: number;
  /** Everyday (non-recurring) trailing-90d average daily net used for the projection floor. */
  baselineDailyNet: number;
  /** Recurring charges/income scheduled into the remaining days of this month. */
  recurringInMonth: ScheduledRecurring[];
  projectedMonthNet: number;
  projectedMonthEndBalance: number;
  days: CashflowDay[];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_MS = 86_400_000;
const toMs = (iso: string) => new Date(iso + 'T00:00:00Z').getTime();
const addDays = (iso: string, n: number) => new Date(toMs(iso) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * Month-to-date + projected cash-flow view, sharpened with detected recurring.
 *
 * The running balance is anchored on the user's CURRENT cash balance (today)
 * and reconstructed backward through this month's actual daily nets. The
 * projection forward to month-end is:
 *   baselineDailyNet  (everyday, non-recurring spend, from trailing 90d)
 * + scheduled recurring charges/income on their actual due dates.
 *
 * Recurring transactions are excluded from the baseline so they aren't counted
 * twice. With no detected recurring, baseline = the overall average and the
 * projection degrades to a flat trailing-average line.
 */
export async function getCashflowProjection(userId: string, now: Date): Promise<CashflowProjection> {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const today = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const monthStart = currentMonthStartISO(now);
  const todayISO = now.toISOString().slice(0, 10);
  const monthEndISO = new Date(Date.UTC(y, m, daysInMonth)).toISOString().slice(0, 10);

  const ninetyAgo = new Date(now);
  ninetyAgo.setUTCDate(ninetyAgo.getUTCDate() - 90);
  const ninetyISO = ninetyAgo.toISOString().slice(0, 10);

  const [accounts, monthCf, dailyRows, trailingTxns, recurringRows] = await Promise.all([
    getPersonalAccounts(userId),
    getMonthCashflow(userId, monthStart),
    db
      .select({
        day: sql<string>`extract(day from ${personalTransactions.date})`,
        sum: sql<string>`coalesce(sum(${personalTransactions.amount}), 0)`,
      })
      .from(personalTransactions)
      .where(and(eq(personalTransactions.userId, userId), gte(personalTransactions.date, monthStart)))
      .groupBy(sql`extract(day from ${personalTransactions.date})`),
    db
      .select({ amount: personalTransactions.amount, merchant: personalTransactions.merchant, description: personalTransactions.description })
      .from(personalTransactions)
      .where(and(eq(personalTransactions.userId, userId), gte(personalTransactions.date, ninetyISO))),
    db
      .select({
        merchantKey: personalRecurring.merchantKey,
        displayMerchant: personalRecurring.displayMerchant,
        type: personalRecurring.type,
        intervalDays: personalRecurring.intervalDays,
        avgAmount: personalRecurring.avgAmount,
        nextDate: personalRecurring.nextDate,
      })
      .from(personalRecurring)
      .where(and(eq(personalRecurring.userId, userId), eq(personalRecurring.status, 'active'))),
  ]);

  const currentCash = accounts.filter((a) => isCash(a.type)).reduce((s, a) => s + a.balance, 0);

  const netByDay = new Map<number, number>();
  for (const r of dailyRows) netByDay.set(Number(r.day), -Number(r.sum));

  // Overall trailing average (for reference) and the non-recurring baseline.
  const recurringKeys = new Set(recurringRows.map((r) => r.merchantKey));
  let trailingTotal = 0;
  let trailingNonRecurring = 0;
  for (const t of trailingTxns) {
    const amt = Number(t.amount);
    trailingTotal += amt;
    if (!recurringKeys.has(normalizeMerchant(t.merchant, t.description))) trailingNonRecurring += amt;
  }
  const avgDailyNet = -trailingTotal / 90;
  const baselineDailyNet = -trailingNonRecurring / 90;

  // Schedule active recurring occurrences into the remaining days of the month.
  const recurringNetByDay = new Map<number, number>();
  const recurringInMonth: ScheduledRecurring[] = [];
  for (const r of recurringRows) {
    const amount = Number(r.avgAmount);
    const sign = r.type === 'income' ? 1 : -1;
    let occ = r.nextDate;
    // Advance to the first occurrence strictly after today.
    while (toMs(occ) <= toMs(todayISO)) occ = addDays(occ, r.intervalDays);
    while (toMs(occ) <= toMs(monthEndISO)) {
      const day = new Date(occ + 'T00:00:00Z').getUTCDate();
      recurringNetByDay.set(day, (recurringNetByDay.get(day) ?? 0) + sign * amount);
      recurringInMonth.push({ date: occ, label: r.displayMerchant, amount, type: r.type === 'income' ? 'income' : 'expense' });
      occ = addDays(occ, r.intervalDays);
    }
  }
  recurringInMonth.sort((a, b) => toMs(a.date) - toMs(b.date));

  // Reconstruct/project the running balance.
  const balanceEnd = new Array<number>(daysInMonth + 1).fill(0);
  balanceEnd[today] = currentCash;
  for (let d = today - 1; d >= 1; d--) balanceEnd[d] = balanceEnd[d + 1] - (netByDay.get(d + 1) ?? 0);
  for (let d = today + 1; d <= daysInMonth; d++) {
    balanceEnd[d] = balanceEnd[d - 1] + baselineDailyNet + (recurringNetByDay.get(d) ?? 0);
  }
  const startOfMonthBalance = balanceEnd[1] - (netByDay.get(1) ?? 0);

  const days: CashflowDay[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const projected = d > today;
    days.push({
      day: d,
      net: projected ? baselineDailyNet + (recurringNetByDay.get(d) ?? 0) : netByDay.get(d) ?? 0,
      balance: balanceEnd[d],
      projected,
    });
  }

  return {
    monthLabel: `${MONTHS[m]} ${y}`,
    daysInMonth,
    today,
    currentCash,
    startOfMonthBalance,
    monthToDate: { income: monthCf.income, spending: monthCf.spending, net: monthCf.net },
    avgDailyNet,
    baselineDailyNet,
    recurringInMonth,
    projectedMonthNet: balanceEnd[daysInMonth] - startOfMonthBalance,
    projectedMonthEndBalance: balanceEnd[daysInMonth],
    days,
  };
}
