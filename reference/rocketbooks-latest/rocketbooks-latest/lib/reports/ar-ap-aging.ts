import 'server-only';
import { getOutstandingInvoices } from '@/lib/accounting/invoices-outstanding';
import { getOutstandingBills } from '@/lib/accounting/bills-outstanding';

export interface AgingBuckets {
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90plus: number;
  total: number;
}

export interface ArApAging {
  ar: AgingBuckets;
  ap: AgingBuckets;
}

function empty(): AgingBuckets {
  return { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0, total: 0 };
}

function bucket(rows: { dueDate: string | null; balance: number }[], todayMs: number): AgingBuckets {
  const b = empty();
  for (const r of rows) {
    if (r.balance <= 0) continue;
    b.total += r.balance;
    if (!r.dueDate) {
      b.current += r.balance;
      continue;
    }
    const dpd = Math.floor((todayMs - Date.parse(`${r.dueDate}T00:00:00`)) / 86_400_000);
    if (dpd <= 0) b.current += r.balance;
    else if (dpd <= 30) b.d1_30 += r.balance;
    else if (dpd <= 60) b.d31_60 += r.balance;
    else if (dpd <= 90) b.d61_90 += r.balance;
    else b.d90plus += r.balance;
  }
  return b;
}

/**
 * Accounts-receivable and accounts-payable aging for the dashboard: outstanding
 * invoice/bill balances bucketed by days past due. Reuses the existing
 * outstanding-balance queries (line totals minus applied payments).
 */
export async function loadArApAging(orgId: string): Promise<ArApAging> {
  // Keep these serialized for Cloudflare/Hyperdrive stability; callers such as
  // /dashboard already perform several DB reads in one request.
  const invoices = await getOutstandingInvoices(orgId);
  const bills = await getOutstandingBills(orgId);
  const todayMs = Date.now();
  return {
    ar: bucket(invoices.map((i) => ({ dueDate: i.dueDate, balance: i.balance })), todayMs),
    ap: bucket(bills.map((b) => ({ dueDate: b.dueDate, balance: b.balance })), todayMs),
  };
}
