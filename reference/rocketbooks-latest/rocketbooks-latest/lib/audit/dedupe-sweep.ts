import 'server-only';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions } from '@/db/schema/schema';
import { sourcePrecedence, twinKey, quarantineDuplicate } from './dedupe';

/**
 * Cross-source duplicate SWEEP — the Phase-2 companion to the real-time hooks in
 * plaid-promote / imported-promote. It catches two things the promote-time hooks
 * can't:
 *
 *  1. Backfill — duplicates already in the books before real-time dedup existed.
 *  2. Cross-account clusters — the same real bank imported under DIFFERENT account
 *     labels (e.g. Plaid maps to "Chase Checking", an uploaded statement resolved
 *     to "Statement - Chase 1234"). The real-time hooks require the SAME account;
 *     this infers "same bank" from a heavy same-day+amount overlap between two
 *     accounts, then dedups the overlap.
 *
 * Match key is exact: same direction + same amount (cents) + SAME calendar day.
 * Survivor = higher source precedence (QBO > Plaid > Veryfi > CSV); manual/unknown
 * rows (precedence -1) are never touched. Greedy 1:1 so one survivor can't retire
 * two rows. Dry-run by default: `apply:false` returns the plan and changes nothing.
 */

// Two accounts are treated as the same real bank when their same-day+amount overlap
// clears EITHER of two bars:
//   • high ratio: >=90% of the smaller account's rows (min 5) — a near-total overlap.
//   • strong absolute evidence: >=25 exact same-day matches at >=60% ratio — a lone
//     coincidence can't produce 25+ exact same-day+amount matches between two
//     accounts, so a high absolute count proves "same bank" even when one side has
//     extra rows (off-by-a-day pairs, one-sided charges) that dilute the ratio.
const CLUSTER_MIN_MATCHES = 5;
const CLUSTER_MIN_RATIO = 0.9; // of the SMALLER account's recognized-source rows
const CLUSTER_STRONG_MATCHES = 25;
const CLUSTER_STRONG_RATIO = 0.6;

interface Row {
  id: string;
  accountId: string | null;
  type: string | null;
  amount: number | null;
  date: string;
  reference: string | null;
  prec: number;
}

export interface QuarantinePlan {
  loserId: string;
  survivorId: string;
  loserRef: string | null;
  survivorRef: string | null;
  amount: number;
  scope: 'same-account' | 'cross-account';
}

export interface ClusterInfo {
  accountA: string;
  accountB: string;
  matched: number;
  minCount: number;
  ratio: number;
}

export interface SweepReport {
  organizationId: string;
  scannedRows: number;
  clusters: ClusterInfo[];
  plan: QuarantinePlan[];
  totalQuarantineAmount: number;
  applied: boolean;
}

function keyOf(r: Row): string | null {
  return twinKey(r.accountId, r.type, r.amount == null ? null : Number(r.amount), r.date);
}

/** Group rows by an arbitrary string key. */
function groupBy<T>(rows: T[], key: (r: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (k == null) continue;
    (m.get(k) ?? m.set(k, []).get(k)!).push(r);
  }
  return m;
}

/**
 * Produce (and optionally apply) a de-duplication plan for one org.
 * Pure/read-only when `apply` is false — safe to run for a dry-run report.
 */
export async function sweepOrgDuplicates(
  organizationId: string,
  opts: { apply?: boolean; crossAccount?: boolean } = {},
): Promise<SweepReport> {
  const apply = opts.apply === true;
  // Cross-account CLUSTER inference is the looser, inference-based pass — it's
  // opt-out so callers that want only the exact same-account backfill (e.g. the
  // post-QBO-migration auto-dedup) can pass crossAccount:false.
  const doCrossAccount = opts.crossAccount !== false;

  const raw = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      type: transactions.type,
      amount: transactions.amount,
      date: transactions.date,
      reference: transactions.reference,
    })
    .from(transactions)
    .where(and(eq(transactions.organizationId, organizationId), ne(transactions.dedupeState, 'duplicate')));

  // Only recognized feed/statement sources take part; manual/unknown are protected.
  const rows: Row[] = raw
    .map((r) => ({ ...r, prec: sourcePrecedence(r.reference) }))
    .filter((r) => r.prec >= 0 && r.amount != null && r.type);

  const claimed = new Set<string>(); // ids already assigned as loser OR survivor
  const plan: QuarantinePlan[] = [];

  const pushPlan = (survivor: Row, loser: Row, scope: QuarantinePlan['scope']) => {
    claimed.add(survivor.id);
    claimed.add(loser.id);
    plan.push({
      loserId: loser.id,
      survivorId: survivor.id,
      loserRef: loser.reference,
      survivorRef: survivor.reference,
      amount: Math.abs(Number(loser.amount)),
      scope,
    });
  };

  // ---- Pass 1: same-account cross-source duplicates (the backfill) ----
  const byAccount = groupBy(rows, (r) => r.accountId ?? '∅');
  for (const [, acctRows] of byAccount) {
    const byKey = groupBy(acctRows, keyOf);
    for (const [, group] of byKey) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => b.prec - a.prec);
      // How many DISTINCT real charges does this (account, day, amount, type)
      // bucket represent? A single source can't exact-dup itself (the
      // (org,reference) unique index blocks that), so it records each real
      // charge at most once — the largest per-source count is the number of
      // genuine charges. Keep that many highest-precedence rows; everything
      // below is a cross-source duplicate. This handles 3-way overlaps
      // (QBO+Plaid+Veryfi → keep QBO, drop the other two), which a greedy 1:1
      // pairing would miss (it would leave the third row behind).
      const perSource = new Map<number, number>();
      for (const r of sorted) perSource.set(r.prec, (perSource.get(r.prec) ?? 0) + 1);
      const keepN = Math.max(...perSource.values());
      const survivors = sorted.slice(0, keepN);
      const losers = sorted.slice(keepN);
      if (losers.length === 0) continue;
      const survivor = survivors[0]; // highest-precedence kept row
      for (const s of survivors) claimed.add(s.id);
      for (const loser of losers) pushPlan(survivor, loser, 'same-account');
    }
  }

  // ---- Pass 2: cross-account clusters (same bank, different label) ----
  const clusters: ClusterInfo[] = [];
  const accounts = doCrossAccount ? [...byAccount.keys()].filter((a) => a !== '∅') : [];
  for (let i = 0; i < accounts.length; i++) {
    for (let j = i + 1; j < accounts.length; j++) {
      const A = byAccount.get(accounts[i])!.filter((r) => !claimed.has(r.id));
      const B = byAccount.get(accounts[j])!.filter((r) => !claimed.has(r.id));
      if (A.length === 0 || B.length === 0) continue;

      // Greedy same-key matching across the two accounts (note: twinKey embeds the
      // accountId, so re-key on the cross-account tuple type|amount|date only).
      const crossKey = (r: Row) => `${r.type}|${Math.round(Math.abs(Number(r.amount)) * 100)}|${r.date}`;
      const bByKey = groupBy(B, crossKey);
      const pairs: { a: Row; b: Row }[] = [];
      const usedB = new Set<string>();
      for (const a of A) {
        const bucket = bByKey.get(crossKey(a));
        if (!bucket) continue;
        const b = bucket.find((x) => !usedB.has(x.id));
        if (b) {
          usedB.add(b.id);
          pairs.push({ a, b });
        }
      }
      const minCount = Math.min(A.length, B.length);
      const ratio = minCount === 0 ? 0 : pairs.length / minCount;
      const isCluster =
        (pairs.length >= CLUSTER_MIN_MATCHES && ratio >= CLUSTER_MIN_RATIO) ||
        (pairs.length >= CLUSTER_STRONG_MATCHES && ratio >= CLUSTER_STRONG_RATIO);
      if (isCluster) {
        clusters.push({ accountA: accounts[i], accountB: accounts[j], matched: pairs.length, minCount, ratio });
        for (const { a, b } of pairs) {
          if (claimed.has(a.id) || claimed.has(b.id)) continue;
          if (a.prec === b.prec) continue; // ambiguous — leave for manual review
          const [survivor, loser] = a.prec > b.prec ? [a, b] : [b, a];
          pushPlan(survivor, loser, 'cross-account');
        }
      }
    }
  }

  const totalQuarantineAmount = plan.reduce((s, p) => s + p.amount, 0);

  if (apply) {
    for (const p of plan) {
      await quarantineDuplicate({ organizationId, loserId: p.loserId, survivorId: p.survivorId });
    }
  }

  return {
    organizationId,
    scannedRows: rows.length,
    clusters,
    plan,
    totalQuarantineAmount,
    applied: apply,
  };
}
