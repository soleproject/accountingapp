import 'server-only';
import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions } from '@/db/schema/schema';
import { formatAmount, type AuditFinding, type Executor } from './findings';

/**
 * Deterministic duplicate detection over the transactions ledger.
 *
 * The (org, reference) unique index already blocks re-importing the SAME Plaid
 * transaction. This catches CROSS-SOURCE duplicates the index can't: a manual
 * entry that doubles a Plaid txn, the same charge landing from two linked
 * accounts, or a CSV import overlapping a bank feed.
 *
 * Two codes:
 *   DUP_EXACT (warn) — same amount + type, same day, same contact OR identical
 *     description. High confidence.
 *   DUP_NEAR  (info) — same amount + type + contact within ±3 days. Lower
 *     confidence (legitimate recurring charges look like this), so info-only.
 *
 * Flag-only: callers persist via writeFindings and never block on the result.
 */

// transactions.amount is double precision; never compare floats with `=`.
const AMOUNT_EPSILON = 0.005;
const NEAR_DAYS = 3;

export interface TxnCandidate {
  id: string;
  date: string; // 'YYYY-MM-DD'
  amount: number | null;
  type: string | null;
  contactId: string | null;
  description: string | null;
}

/** Canonical, orientation-independent key for a duplicate pair. */
function dupSubjectKey(a: string, b: string): string {
  return a < b ? `dup:${a}:${b}` : `dup:${b}:${a}`;
}

function normDesc(s: string | null): string | null {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  return t.length ? t : null;
}

/** Shared classification so the real-time and batch paths can't diverge. */
function classifyDuplicate(
  sameDay: boolean,
  sameContact: boolean,
  sameDesc: boolean,
): { code: 'DUP_EXACT' | 'DUP_NEAR'; severity: AuditFinding['severity'] } | null {
  if (sameDay && (sameContact || sameDesc)) return { code: 'DUP_EXACT', severity: 'warn' };
  if (sameContact) return { code: 'DUP_NEAR', severity: 'info' };
  return null;
}

function buildDuplicateFinding(
  code: 'DUP_EXACT' | 'DUP_NEAR',
  severity: AuditFinding['severity'],
  keepId: string,
  dupId: string,
  amount: number,
  type: string | null,
  dateA: string,
  dateB: string,
  contactId: string | null,
): AuditFinding {
  return {
    kind: 'duplicate',
    code,
    severity,
    subjectKey: dupSubjectKey(keepId, dupId),
    message:
      code === 'DUP_EXACT'
        ? `Possible duplicate: two ${type ?? ''} transactions of ${formatAmount(amount)} on ${dateA}.`.replace(/\s+/g, ' ')
        : `Possible near-duplicate: ${formatAmount(amount)} for the same contact within ${NEAR_DAYS} days (${dateB} vs ${dateA}).`,
    transactionId: keepId,
    relatedTransactionId: dupId,
    metadata: { amount, type, candidateDate: dateA, matchedDate: dateB, contactId },
  };
}

export async function detectDuplicates(
  organizationId: string,
  candidate: TxnCandidate,
  exec: Executor = db,
): Promise<AuditFinding[]> {
  if (candidate.amount == null) return [];

  const matches = await exec
    .select({
      id: transactions.id,
      date: transactions.date,
      type: transactions.type,
      contactId: transactions.contactId,
      description: transactions.description,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        ne(transactions.id, candidate.id),
        // Skip rows already quarantined by the cross-source dedupe engine — they
        // carry zero GL impact and live in the Removed-duplicates bucket.
        sql`${transactions.dedupeState} = 'active'`,
        sql`abs(${transactions.amount} - ${candidate.amount}) < ${AMOUNT_EPSILON}`,
        candidate.type ? eq(transactions.type, candidate.type) : sql`true`,
        sql`abs(${transactions.date}::date - ${candidate.date}::date) <= ${NEAR_DAYS}`,
      ),
    )
    .limit(25);

  const candDesc = normDesc(candidate.description);
  const findings: AuditFinding[] = [];

  for (const m of matches) {
    const sameDay = m.date === candidate.date;
    const sameContact = !!candidate.contactId && m.contactId === candidate.contactId;
    const sameDesc = !!candDesc && candDesc === normDesc(m.description);

    const cls = classifyDuplicate(sameDay, sameContact, sameDesc);
    if (!cls) continue;

    // Orient the pair deterministically: keep the lexicographically-smaller id
    // as transaction_id, propose the other as the duplicate. (The merge action
    // lets the user override which one to delete.)
    const [keepId, dupId] =
      candidate.id < m.id ? [candidate.id, m.id] : [m.id, candidate.id];

    findings.push(
      buildDuplicateFinding(
        cls.code,
        cls.severity,
        keepId,
        dupId,
        candidate.amount,
        candidate.type,
        candidate.date,
        m.date,
        candidate.contactId,
      ),
    );
  }

  return findings;
}

/**
 * Set-based duplicate scan over an entire org — for the nightly sweep. A single
 * self-join finds all candidate pairs (each pair once via b.id > a.id) instead
 * of N per-row queries, and catches dupes that arrived via paths without the
 * real-time hook (QBO mirror, GHL, CSV import).
 */
export async function detectDuplicatesBatch(
  organizationId: string,
  exec: typeof db = db,
  limit = 1000,
): Promise<AuditFinding[]> {
  const result = await exec.execute(sql`
    SELECT a.id AS a_id, b.id AS b_id,
           (a.date = b.date) AS same_day,
           (a.contact_id IS NOT NULL AND a.contact_id = b.contact_id) AS same_contact,
           (a.description IS NOT NULL AND b.description IS NOT NULL
             AND lower(btrim(a.description)) = lower(btrim(b.description))) AS same_desc,
           a.amount AS amount, a.type AS type, a.date AS a_date, b.date AS b_date,
           a.contact_id AS contact_id
    FROM transactions a
    JOIN transactions b
      ON b.organization_id = a.organization_id
     AND b.id > a.id
     AND a.type = b.type
     AND abs(b.amount - a.amount) < ${AMOUNT_EPSILON}
     AND abs(a.date::date - b.date::date) <= ${NEAR_DAYS}
     AND b.dedupe_state = 'active'
    WHERE a.organization_id = ${organizationId}
      AND a.amount IS NOT NULL
      AND a.dedupe_state = 'active'
      AND (
        (a.date = b.date AND (a.contact_id = b.contact_id
          OR lower(btrim(a.description)) = lower(btrim(b.description))))
        OR (a.contact_id IS NOT NULL AND a.contact_id = b.contact_id)
      )
    LIMIT ${limit}
  `);

  // postgres-js returns a RowList (array-like) of plain objects.
  const rows = result as unknown as Array<{
    a_id: string;
    b_id: string;
    same_day: boolean;
    same_contact: boolean;
    same_desc: boolean;
    amount: number;
    type: string | null;
    a_date: string;
    b_date: string;
    contact_id: string | null;
  }>;

  const findings: AuditFinding[] = [];
  for (const r of rows) {
    const cls = classifyDuplicate(r.same_day, r.same_contact, r.same_desc);
    if (!cls) continue;
    // a.id < b.id by construction, so a is the keep, b is the duplicate.
    findings.push(
      buildDuplicateFinding(
        cls.code,
        cls.severity,
        r.a_id,
        r.b_id,
        r.amount,
        r.type,
        r.a_date,
        r.b_date,
        r.contact_id,
      ),
    );
  }
  return findings;
}
