/**
 * Pure dashboard "posture" logic — shared by the dashboard page and tests. No
 * db / server-only so it can be unit-checked across org states. Decides the
 * command-center posture (urgent/watch/healthy), the default pill, and the
 * situational headline. Deterministic; the AI only narrates/answers elsewhere.
 */

export type Posture = 'urgent' | 'watch' | 'healthy';
export type PillKey = 'needs' | 'cash' | 'month' | 'ask';

export interface PostureInputs {
  hasActivity: boolean; // any transactions on the books yet
  hasCashData: boolean; // a bank account exists (so cash is tracked)
  cashPosition: number;
  runwayMonths: number | null; // only set when truly burning (cash>0, net<0)
  runwayLabel: string;
  avgNet: number; // trailing-3-month average net
  net6: number; // 6-month net
  taskCount: number;
  overdueAr: number;
  overdueAp: number;
}

export interface DashboardState {
  posture: Posture;
  defaultPill: PillKey;
  headline: string;
}

const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? '' : 's'}`;

export function computeDashboardState(i: PostureInputs): DashboardState {
  // Brand-new / empty org: don't talk about money that isn't there — guide setup.
  if (!i.hasActivity) {
    return {
      posture: 'healthy',
      defaultPill: i.taskCount > 0 ? 'needs' : 'cash',
      headline: "Let's get set up — connect a bank and import your transactions, and your cash, runway, and trends will show up here.",
    };
  }

  const cashNegative = i.hasCashData && i.cashPosition < -0.5;
  const shortRunway = i.runwayMonths != null && i.runwayMonths < 3;
  const profitable = i.avgNet > 0;

  const posture: Posture =
    cashNegative || shortRunway
      ? 'urgent'
      : i.taskCount >= 3 || (i.runwayMonths != null && i.runwayMonths < 6) || i.overdueAr > 0 || i.overdueAp > 0
        ? 'watch'
        : 'healthy';

  const defaultPill: PillKey =
    posture === 'urgent' ? 'cash' : posture === 'watch' ? (i.taskCount > 0 ? 'needs' : 'cash') : i.taskCount > 0 ? 'needs' : 'month';

  let headline: string;
  if (posture === 'urgent') {
    headline = cashNegative
      ? `Cash is negative (${money(i.cashPosition)}). Let's tighten collections and clean up the books first.`
      : `Cash is tight — ${money(i.cashPosition)}, about ${i.runwayLabel} of runway.${i.overdueAr > 0 ? ` Chasing ${money(i.overdueAr)} in overdue invoices would help most.` : ''}`;
  } else if (posture === 'watch') {
    const bits: string[] = [];
    if (i.taskCount > 0) bits.push(`${plural(i.taskCount, 'thing')} need a look`);
    if (i.overdueAr > 0) bits.push(`${money(i.overdueAr)} in invoices are overdue`);
    const lead = profitable ? `You're profitable${i.hasCashData ? ` with ${money(i.cashPosition)} on hand` : ''} — ` : '';
    headline = `${lead}${bits.length ? `${bits.join(' and ')}.` : 'a couple of things to keep an eye on.'}`;
  } else if (i.hasCashData) {
    headline = `You're in good shape — ${money(i.cashPosition)} in the bank${i.runwayMonths != null ? ` (~${i.runwayLabel} runway)` : ''}. ${i.taskCount > 0 ? `${plural(i.taskCount, 'small item')} to review.` : 'Nothing needs you right now.'}`;
  } else {
    const lead = profitable ? `You're profitable — ${money(i.net6)} net over the last 6 months.` : `Net is ${money(i.net6)} over the last 6 months.`;
    headline = `${lead}${i.taskCount > 0 ? ` ${plural(i.taskCount, 'item')} to review.` : ''} Connect a bank to track cash and runway.`;
  }

  return { posture, defaultPill, headline };
}
