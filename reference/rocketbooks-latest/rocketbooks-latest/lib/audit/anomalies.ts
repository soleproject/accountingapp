import 'server-only';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions, chartOfAccounts, contacts } from '@/db/schema/schema';
import { logger } from '@/lib/logger';
import { formatAmount, type AuditFinding } from './findings';

/**
 * Statistical anomaly detection over an org's transaction history — nightly
 * only (cross-transaction + history-dependent, too heavy/contextual for the
 * import hot path). Flag-only, severity 'info': these are advisory "a bookkeeper
 * would look twice at this" signals, not errors. Conservative thresholds +
 * minimum sample size + an absolute-dollar floor keep false positives down.
 *
 *   ANOM_AMOUNT_OUTLIER — a charge far from the norm for its (vendor, category),
 *     using median + MAD (robust to the very outliers we're hunting).
 *   ANOM_CATEGORY_DRIFT — a vendor with a strong dominant category suddenly
 *     posted to a different one (likely a miscategorization).
 *
 * Tunables live in one object so they can be wired to a Settings control later.
 */
export const ANOMALY_CONFIG = {
  historyDays: 365, // window of history used to establish "normal"
  recentDays: 30, // only flag transactions newer than this (don't re-flag ancient history)
  minSample: 5, // need at least this many prior txns before judging a group
  madMultiplier: 5, // outlier if |amt - median| > madMultiplier * MAD
  absFloor: 100, // ...and the dollar delta is at least this (ignore small noise)
  dominantShare: 0.8, // category counts as "dominant" at this share of a vendor's txns
  scanCap: 20000, // safety cap on rows scanned per org
} as const;

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

interface TxnRow {
  id: string;
  contactId: string;
  categoryAccountId: string | null;
  amount: number;
  date: string;
}

export async function runAnomalySweep(
  organizationId: string,
  exec: typeof db = db,
): Promise<AuditFinding[]> {
  const recentCutoff = new Date(Date.now() - ANOMALY_CONFIG.recentDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const rows = (await exec
    .select({
      id: transactions.id,
      contactId: transactions.contactId,
      categoryAccountId: transactions.categoryAccountId,
      amount: transactions.amount,
      date: transactions.date,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        isNotNull(transactions.contactId),
        isNotNull(transactions.amount),
        sql`${transactions.date} >= current_date - make_interval(days => ${ANOMALY_CONFIG.historyDays})`,
      ),
    )
    .limit(ANOMALY_CONFIG.scanCap + 1)) as TxnRow[];

  if (rows.length > ANOMALY_CONFIG.scanCap) {
    logger.warn(
      { organizationId, scanned: ANOMALY_CONFIG.scanCap },
      'anomaly sweep: history exceeded scanCap — older rows skipped this run',
    );
    rows.length = ANOMALY_CONFIG.scanCap;
  }
  if (rows.length === 0) return [];

  // Name maps for readable messages.
  const acctRows = await exec
    .select({ id: chartOfAccounts.id, name: chartOfAccounts.accountName })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.organizationId, organizationId));
  const acctName = new Map(acctRows.map((a) => [a.id, a.name]));
  const contactRows = await exec
    .select({ id: contacts.id, name: contacts.contactName })
    .from(contacts)
    .where(eq(contacts.organizationId, organizationId));
  const contactName = new Map(contactRows.map((c) => [c.id, c.name]));

  const catLabel = (id: string | null) => (id ? acctName.get(id) ?? 'an account' : 'uncategorized');
  const vendorLabel = (id: string) => contactName.get(id) ?? 'this vendor';

  const findings: AuditFinding[] = [];

  // ── ANOM_AMOUNT_OUTLIER — grouped by (vendor, category) ────────────
  const byVendorCat = new Map<string, TxnRow[]>();
  for (const r of rows) {
    const key = `${r.contactId}|${r.categoryAccountId ?? ''}`;
    (byVendorCat.get(key) ?? byVendorCat.set(key, []).get(key)!).push(r);
  }
  for (const group of byVendorCat.values()) {
    if (group.length < ANOMALY_CONFIG.minSample) continue;
    const amounts = group.map((g) => g.amount);
    const med = median(amounts);
    const mad = median(amounts.map((a) => Math.abs(a - med)));
    for (const t of group) {
      if (t.date < recentCutoff) continue;
      const delta = Math.abs(t.amount - med);
      if (delta < ANOMALY_CONFIG.absFloor) continue;
      const isOutlier = mad > 0 ? delta > ANOMALY_CONFIG.madMultiplier * mad : t.amount !== med;
      if (!isOutlier) continue;
      const dir = t.amount > med ? 'larger' : 'smaller';
      findings.push({
        kind: 'anomaly',
        code: 'ANOM_AMOUNT_OUTLIER',
        severity: 'info',
        subjectKey: `txn:${t.id}`,
        message: `Unusual amount: ${formatAmount(t.amount)} to ${vendorLabel(t.contactId)} is much ${dir} than the usual ${formatAmount(med)} for ${catLabel(t.categoryAccountId)}.`,
        transactionId: t.id,
        metadata: { amount: t.amount, median: med, mad, categoryAccountId: t.categoryAccountId, contactId: t.contactId },
      });
    }
  }

  // ── ANOM_CATEGORY_DRIFT — grouped by vendor ────────────────────────
  const byVendor = new Map<string, TxnRow[]>();
  for (const r of rows) {
    if (!r.categoryAccountId) continue; // need a category to judge drift
    (byVendor.get(r.contactId) ?? byVendor.set(r.contactId, []).get(r.contactId)!).push(r);
  }
  for (const [contactId, group] of byVendor) {
    if (group.length < ANOMALY_CONFIG.minSample) continue;
    const counts = new Map<string, number>();
    for (const t of group) counts.set(t.categoryAccountId!, (counts.get(t.categoryAccountId!) ?? 0) + 1);
    let dominant: string | null = null;
    let dominantCount = 0;
    for (const [cat, n] of counts) if (n > dominantCount) { dominant = cat; dominantCount = n; }
    if (!dominant || dominantCount / group.length < ANOMALY_CONFIG.dominantShare) continue;
    for (const t of group) {
      if (t.date < recentCutoff) continue;
      if (t.categoryAccountId === dominant) continue;
      findings.push({
        kind: 'anomaly',
        code: 'ANOM_CATEGORY_DRIFT',
        severity: 'info',
        subjectKey: `txn:${t.id}`,
        message: `Category drift: ${vendorLabel(contactId)} is usually ${catLabel(dominant)}, but this ${formatAmount(t.amount)} charge was put in ${catLabel(t.categoryAccountId)}.`,
        transactionId: t.id,
        metadata: { amount: t.amount, dominantCategoryId: dominant, categoryAccountId: t.categoryAccountId, contactId },
      });
    }
  }

  return findings;
}
