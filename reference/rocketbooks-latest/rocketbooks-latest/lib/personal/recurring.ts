import 'server-only';
import { randomUUID } from 'crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { personalRecurring, personalTransactions } from '@/db/schema/schema';

export type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual';

const CADENCE_DAYS: Record<Cadence, number> = { weekly: 7, biweekly: 14, monthly: 30, quarterly: 91, annual: 365 };

export function monthlyEquivalent(cadence: string, amount: number): number {
  switch (cadence) {
    case 'weekly': return (amount * 52) / 12;
    case 'biweekly': return (amount * 26) / 12;
    case 'monthly': return amount;
    case 'quarterly': return amount / 3;
    case 'annual': return amount / 12;
    default: return amount;
  }
}

// ---- date helpers (ISO 'YYYY-MM-DD', UTC) ----
const DAY_MS = 86_400_000;
function toMs(iso: string): number { return new Date(iso + 'T00:00:00Z').getTime(); }
function daysBetween(a: string, b: string): number { return Math.round((toMs(b) - toMs(a)) / DAY_MS); }
function addDays(iso: string, n: number): string { return new Date(toMs(iso) + n * DAY_MS).toISOString().slice(0, 10); }
function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function mostCommon<T>(items: T[]): T | undefined {
  const counts = new Map<T, number>();
  let best: T | undefined; let bestN = 0;
  for (const it of items) {
    const n = (counts.get(it) ?? 0) + 1;
    counts.set(it, n);
    if (n > bestN) { bestN = n; best = it; }
  }
  return best;
}

function classifyCadence(medianInterval: number): { cadence: Cadence; intervalDays: number } | null {
  if (medianInterval >= 6 && medianInterval <= 9) return { cadence: 'weekly', intervalDays: 7 };
  if (medianInterval >= 12 && medianInterval <= 18) return { cadence: 'biweekly', intervalDays: 14 };
  if (medianInterval >= 26 && medianInterval <= 35) return { cadence: 'monthly', intervalDays: 30 };
  if (medianInterval >= 80 && medianInterval <= 100) return { cadence: 'quarterly', intervalDays: 91 };
  if (medianInterval >= 330 && medianInterval <= 400) return { cadence: 'annual', intervalDays: 365 };
  return null;
}

export function normalizeMerchant(merchant: string | null, description: string | null): string {
  const base = (merchant && merchant.trim()) ? merchant : (description ?? '');
  return base.toLowerCase().replace(/[#*]/g, '').replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
}

export interface InputTxn {
  date: string;
  amount: number; // signed: positive = money out (expense)
  merchant: string | null;
  description: string | null;
  category: string | null;
}

export interface DetectedSeries {
  merchantKey: string;
  displayMerchant: string;
  type: 'expense' | 'income';
  cadence: Cadence;
  intervalDays: number;
  avgAmount: number; // absolute
  lastAmount: number; // absolute
  lastDate: string;
  nextDate: string;
  occurrences: number;
  category: string | null;
}

/**
 * Detect recurring series from a transaction list. A series needs >= 3
 * occurrences at a recognizable cadence (>=50% of gaps near the cadence),
 * and must still be "active" (last seen within ~1.8 intervals of `todayISO`).
 * Pure — no DB — so it's easy to reason about and test.
 */
export function detectSeriesFromTransactions(txns: InputTxn[], todayISO: string): DetectedSeries[] {
  const groups = new Map<string, InputTxn[]>();
  for (const t of txns) {
    const key = normalizeMerchant(t.merchant, t.description);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }

  const out: DetectedSeries[] = [];
  for (const [key, group] of groups) {
    if (group.length < 3) continue;
    const sorted = [...group].sort((a, b) => toMs(a.date) - toMs(b.date));
    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i++) intervals.push(daysBetween(sorted[i - 1].date, sorted[i].date));
    const validIntervals = intervals.filter((d) => d > 0);
    if (validIntervals.length < 2) continue;

    const cad = classifyCadence(median(validIntervals));
    if (!cad) continue;

    // Regularity: at least half the gaps land near the cadence.
    const tol = Math.max(cad.intervalDays * (cad.cadence === 'annual' ? 0.2 : 0.4), 3);
    const near = validIntervals.filter((d) => Math.abs(d - cad.intervalDays) <= tol).length;
    if (near / validIntervals.length < 0.5) continue;

    const lastDate = sorted[sorted.length - 1].date;
    // Active: still recurring (not an ended/cancelled series).
    if (daysBetween(lastDate, todayISO) > cad.intervalDays * 1.8) continue;

    const absAmounts = sorted.map((t) => Math.abs(t.amount));
    const rawMedian = median(sorted.map((t) => t.amount));
    const type: 'expense' | 'income' = rawMedian >= 0 ? 'expense' : 'income';

    let nextDate = addDays(lastDate, cad.intervalDays);
    while (toMs(nextDate) < toMs(todayISO)) nextDate = addDays(nextDate, cad.intervalDays);

    out.push({
      merchantKey: key,
      displayMerchant: mostCommon(sorted.map((t) => (t.merchant && t.merchant.trim()) ? t.merchant.trim() : (t.description ?? key))) ?? key,
      type,
      cadence: cad.cadence,
      intervalDays: cad.intervalDays,
      avgAmount: Math.round(median(absAmounts) * 100) / 100,
      lastAmount: Math.round(absAmounts[absAmounts.length - 1] * 100) / 100,
      lastDate,
      nextDate,
      occurrences: sorted.length,
      category: mostCommon(sorted.map((t) => t.category ?? 'Uncategorized')) ?? null,
    });
  }

  // Largest monthly cost first.
  return out.sort((a, b) => monthlyEquivalent(b.cadence, b.avgAmount) - monthlyEquivalent(a.cadence, a.avgAmount));
}

/** Scan the user's transactions and upsert detected series, preserving any
 *  user-set status (hidden/cancelled) on existing rows. */
export async function scanAndStoreRecurring(userId: string, now: Date): Promise<number> {
  const todayISO = now.toISOString().slice(0, 10);
  const rows = await db
    .select({
      date: personalTransactions.date,
      amount: personalTransactions.amount,
      merchant: personalTransactions.merchant,
      description: personalTransactions.description,
      category: personalTransactions.category,
    })
    .from(personalTransactions)
    .where(eq(personalTransactions.userId, userId));

  const series = detectSeriesFromTransactions(
    rows.map((r) => ({ ...r, amount: Number(r.amount) })),
    todayISO,
  );
  if (series.length === 0) return 0;

  const nowISO = now.toISOString();
  await db
    .insert(personalRecurring)
    .values(
      series.map((s) => ({
        id: randomUUID(),
        userId,
        merchantKey: s.merchantKey,
        displayMerchant: s.displayMerchant,
        type: s.type,
        cadence: s.cadence,
        intervalDays: s.intervalDays,
        avgAmount: String(s.avgAmount),
        lastAmount: String(s.lastAmount),
        lastDate: s.lastDate,
        nextDate: s.nextDate,
        occurrences: s.occurrences,
        category: s.category,
        createdAt: nowISO,
        updatedAt: nowISO,
      })),
    )
    .onConflictDoUpdate({
      target: [personalRecurring.userId, personalRecurring.merchantKey],
      // Refresh detection metrics but leave `status` (user choice) untouched.
      set: {
        displayMerchant: sql`excluded.display_merchant`,
        type: sql`excluded.type`,
        cadence: sql`excluded.cadence`,
        intervalDays: sql`excluded.interval_days`,
        avgAmount: sql`excluded.avg_amount`,
        lastAmount: sql`excluded.last_amount`,
        lastDate: sql`excluded.last_date`,
        nextDate: sql`excluded.next_date`,
        occurrences: sql`excluded.occurrences`,
        category: sql`excluded.category`,
        updatedAt: sql`now()`,
      },
    });
  return series.length;
}

export interface RecurringRow {
  id: string;
  displayMerchant: string;
  type: string;
  cadence: string;
  avgAmount: number;
  lastAmount: number;
  lastDate: string;
  nextDate: string;
  occurrences: number;
  category: string | null;
  status: string;
  monthlyCost: number;
}

export async function getRecurring(userId: string, includeHidden = false): Promise<RecurringRow[]> {
  const rows = await db
    .select()
    .from(personalRecurring)
    .where(eq(personalRecurring.userId, userId))
    .orderBy(asc(personalRecurring.nextDate));
  return rows
    .filter((r) => includeHidden || r.status === 'active')
    .map((r) => ({
      id: r.id,
      displayMerchant: r.displayMerchant,
      type: r.type,
      cadence: r.cadence,
      avgAmount: Number(r.avgAmount),
      lastAmount: Number(r.lastAmount),
      lastDate: r.lastDate,
      nextDate: r.nextDate,
      occurrences: r.occurrences,
      category: r.category,
      status: r.status,
      monthlyCost: Math.round(monthlyEquivalent(r.cadence, Number(r.avgAmount)) * 100) / 100,
    }));
}

export async function setRecurringStatus(userId: string, id: string, status: 'active' | 'hidden' | 'cancelled'): Promise<void> {
  await db
    .update(personalRecurring)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(and(eq(personalRecurring.id, id), eq(personalRecurring.userId, userId)));
}

/** Whether the user has ever run a scan (any rows exist). */
export async function hasRecurringRows(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: personalRecurring.id })
    .from(personalRecurring)
    .where(eq(personalRecurring.userId, userId))
    .limit(1);
  return !!row;
}
