import 'server-only';
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { personalTransactions, personalRecurring, personalBudgets } from '@/db/schema/schema';
import { monthlyEquivalent } from './recurring';
import { getPersonalCategories } from './categories';

export type Lookback = 3 | 6 | 12;

export interface BudgetSuggestion {
  category: string;
  group: string;
  /** Fixed monthly cost from detected recurring in this category. */
  recurring: number;
  /** Estimated everyday (non-recurring) monthly spend. */
  variable: number;
  /** recurring + variable, rounded. */
  suggested: number;
  confidence: 'high' | 'medium' | 'low';
  /** A single month/charge dominates the history — estimate may be skewed. */
  oneOff: boolean;
  monthsOfData: number;
  /** Last up-to-12 months of total spend for a sparkline. */
  history: number[];
  hasExistingBudget: boolean;
  seasonalUsed: boolean;
}

function ymKey(y: number, m: number): string { return `${y}-${String(m + 1).padStart(2, '0')}`; }
function mean(a: number[]): number { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y); const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
function roundBudget(v: number): number {
  if (v <= 0) return 0;
  if (v < 200) return Math.round(v / 5) * 5;
  if (v < 1000) return Math.round(v / 10) * 10;
  return Math.round(v / 25) * 25;
}

/** Trimmed, recency-weighted mean: drops the single highest month (one-off
 *  guard) then weights remaining months linearly toward the present. */
function recencyEstimate(window: number[]): number {
  if (window.length === 0) return 0;
  let vals = window;
  if (window.length >= 4) {
    const maxIdx = window.indexOf(Math.max(...window));
    vals = window.filter((_, i) => i !== maxIdx);
  }
  let wSum = 0; let acc = 0;
  vals.forEach((v, i) => { const w = i + 1; acc += v * w; wSum += w; });
  return wSum ? acc / wSum : 0;
}

export async function getBudgetSuggestions(userId: string, now: Date, lookback: Lookback = 6): Promise<BudgetSuggestion[]> {
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 23, 1));
  const startISO = windowStart.toISOString().slice(0, 10);

  const [txns, recurringRows, categories, budgetRows] = await Promise.all([
    db
      .select({ date: personalTransactions.date, amount: personalTransactions.amount, category: personalTransactions.category })
      .from(personalTransactions)
      .where(and(eq(personalTransactions.userId, userId), gte(personalTransactions.date, startISO), sql`${personalTransactions.amount} > 0`)),
    db
      .select({ category: personalRecurring.category, cadence: personalRecurring.cadence, avgAmount: personalRecurring.avgAmount, type: personalRecurring.type })
      .from(personalRecurring)
      .where(and(eq(personalRecurring.userId, userId), eq(personalRecurring.status, 'active'))),
    getPersonalCategories(userId, true),
    db.select({ category: personalBudgets.category }).from(personalBudgets).where(eq(personalBudgets.userId, userId)),
  ]);

  const groupByName = new Map(categories.map((c) => [c.name, c.groupName]));
  const existingBudgets = new Set(budgetRows.map((b) => b.category));

  // Exact recurring monthly cost per category (expense series only).
  const recurringByCat = new Map<string, number>();
  for (const r of recurringRows) {
    if (r.type !== 'expense') continue;
    const cat = r.category ?? 'Uncategorized';
    recurringByCat.set(cat, (recurringByCat.get(cat) ?? 0) + monthlyEquivalent(r.cadence, Number(r.avgAmount)));
  }

  // Chronological month axis windowStart..now.
  const months: string[] = [];
  for (let i = 0; i < 24; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 23 + i, 1));
    const k = ymKey(d.getUTCFullYear(), d.getUTCMonth());
    months.push(k);
    if (k === ymKey(now.getUTCFullYear(), now.getUTCMonth())) break;
  }
  const idxOf = new Map(months.map((m, i) => [m, i]));

  // Total monthly spend per category.
  const totalByCat = new Map<string, number[]>();
  for (const t of txns) {
    const idx = idxOf.get(t.date.slice(0, 7));
    if (idx === undefined) continue;
    const cat = t.category ?? 'Uncategorized';
    let a = totalByCat.get(cat);
    if (!a) { a = new Array(months.length).fill(0); totalByCat.set(cat, a); }
    a[idx] += Number(t.amount);
  }

  const candidates = new Set<string>([...totalByCat.keys(), ...recurringByCat.keys()]);
  const nowIdx = months.length - 1;
  const lastYearIdx = nowIdx - 11; // same month, ~a year before the upcoming month

  const out: BudgetSuggestion[] = [];
  for (const cat of candidates) {
    const group = groupByName.get(cat) ?? 'Other';
    if (group === 'Transfers' || group === 'Income') continue;

    const totalSeries = totalByCat.get(cat) ?? new Array(months.length).fill(0);
    const recurring = recurringByCat.get(cat) ?? 0;
    // Implied variable = each month's total minus the steady recurring cost.
    // Floored at 0 so a recurring-only category yields ~0 variable (no double count).
    const series = totalSeries.map((v) => Math.max(0, v - recurring));

    const recencyWindow = series.slice(Math.max(0, series.length - lookback));
    let variableEst = recencyEstimate(recencyWindow);

    const last3 = series.slice(-3);
    const prev3 = series.slice(-6, -3);
    const trend = mean(prev3) > 0 ? clamp(mean(last3) / mean(prev3), 0.8, 1.25) : 1;
    variableEst *= trend;

    let seasonalUsed = false;
    if (lastYearIdx >= 0 && series.length >= 18) {
      const recent6 = series.slice(-6);
      const prior6 = series.slice(lastYearIdx - 5, lastYearIdx + 1);
      const yoy = mean(prior6) > 0 ? clamp(mean(recent6) / mean(prior6), 0.7, 1.4) : 1;
      const seasonalEst = series[lastYearIdx] * yoy;
      if (seasonalEst > 0) { variableEst = 0.5 * variableEst + 0.5 * seasonalEst; seasonalUsed = true; }
    }

    const suggested = roundBudget(recurring + variableEst);
    if (suggested < 5) continue;

    const nonZeroTotal = totalSeries.filter((v) => v > 0);
    const winMean = mean(recencyWindow);
    const cv = winMean > 0 ? Math.sqrt(mean(recencyWindow.map((v) => (v - winMean) ** 2))) / winMean : 0;
    const monthsOfData = nonZeroTotal.length;
    const confidence: BudgetSuggestion['confidence'] =
      monthsOfData >= 6 && cv < 0.35 ? 'high' : (monthsOfData < 3 || cv > 0.8 ? 'low' : 'medium');
    const oneOff = Math.max(...totalSeries, 0) > 2.5 * (median(nonZeroTotal) || 1);

    out.push({
      category: cat,
      group,
      recurring: Math.round(recurring * 100) / 100,
      variable: Math.round(variableEst * 100) / 100,
      suggested,
      confidence,
      oneOff,
      monthsOfData,
      history: totalSeries.slice(-12),
      hasExistingBudget: existingBudgets.has(cat),
      seasonalUsed,
    });
  }

  return out.sort((a, b) => b.suggested - a.suggested);
}
