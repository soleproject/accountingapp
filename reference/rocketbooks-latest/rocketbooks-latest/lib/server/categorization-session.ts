import 'server-only';
import { randomUUID } from 'crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  categorizationSessions,
  categorizationSessionContacts,
} from '@/db/schema/categorization';
import { chartOfAccounts, contacts, transactions } from '@/db/schema/schema';
import { categorizeTransaction } from '@/lib/accounting/categorize';
import { resolveAccount } from '@/lib/accounting/resolve-account';
import {
  recommendByRules,
  type RuleRecommendation,
} from '@/lib/accounting/default-categorizations';
import { logger } from '@/lib/logger';

/**
 * Session lifecycle: createOrResume → applyContact / skipContact (loop) →
 * completeSession when no pending rows remain. The session and its contacts
 * persist in the DB so the user can resume across browser sessions.
 *
 * One active session per (orgId, userId). Snapshot of uncategorized contacts
 * is captured at session-start time. Subsequent uncategorized rows that
 * appear after session start (e.g. fresh bank-feed sync) won't show in the
 * session — user opens a new session for those.
 */

export type ContactStatus = 'pending' | 'done' | 'skipped' | 'failed';

export interface SessionContactView {
  id: string;
  contactId: string | null;
  contactName: string | null;
  status: ContactStatus;
  recommendedAccountId: string | null;
  recommendedSource: 'rules' | 'ai' | 'manual' | null;
  recommendedNewAccount: {
    accountName: string;
    accountNumber: string;
    gaapType: string;
    description: string;
  } | null;
  recommendationLabel: string | null;
  appliedAccountId: string | null;
  appliedAccountName: string | null;
  appliedAt: string | null;
  transactionCount: number;
  totalAmount: number;
  oldestDate: string | null;
  newestDate: string | null;
  /**
   * Direction tint for the row — withdrawal → red, deposit → green. Computed
   * from the contact's still-uncategorized transactions. Defaults to
   * 'withdrawal' when there's no clear signal (ties, or zero rows remaining
   * — most vendor contacts are expense-side anyway).
   */
  direction: 'deposit' | 'withdrawal';
}

export interface SessionView {
  sessionId: string;
  status: 'active' | 'completed' | 'abandoned';
  contacts: SessionContactView[];
  totalContacts: number;
  pendingCount: number;
  doneCount: number;
  skippedCount: number;
}

/**
 * Find an active session for (orgId, userId) and return its full view, or
 * create a fresh session by snapshotting all uncategorized contacts.
 */
export async function createOrResumeSession(args: {
  organizationId: string;
  userId: string;
}): Promise<SessionView> {
  const { organizationId: orgId, userId } = args;

  const [existing] = await db
    .select()
    .from(categorizationSessions)
    .where(
      and(
        eq(categorizationSessions.organizationId, orgId),
        eq(categorizationSessions.userId, userId),
        eq(categorizationSessions.status, 'active'),
      ),
    )
    .orderBy(sql`${categorizationSessions.createdAt} DESC`)
    .limit(1);
  if (existing) return await loadSessionView(existing.id, orgId);

  return await createFreshSession(orgId, userId);
}

async function createFreshSession(orgId: string, userId: string): Promise<SessionView> {
  const sessionId = randomUUID();
  const now = new Date().toISOString();

  // Snapshot uncategorized contacts: same shape as list_uncategorized_by_contact
  // (count, total, dates) but persisted per-row in this session.
  const groups = await db
    .select({
      contactId: transactions.contactId,
      contactName: contacts.contactName,
      transactionCount: sql<number>`COUNT(*)::int`.as('transaction_count'),
      totalAmount: sql<string>`COALESCE(SUM(ABS(${transactions.amount})), 0)::numeric(14,2)`.as('total_amount'),
      oldestDate: sql<string | null>`MIN(${transactions.date})`.as('oldest_date'),
      newestDate: sql<string | null>`MAX(${transactions.date})`.as('newest_date'),
    })
    .from(transactions)
    .leftJoin(contacts, eq(contacts.id, transactions.contactId))
    .where(
      and(
        eq(transactions.organizationId, orgId),
        sql`${transactions.categoryAccountId} IS NULL`,
      ),
    )
    .groupBy(transactions.contactId, contacts.contactName)
    .orderBy(sql`COUNT(*) DESC, MAX(${transactions.date}) DESC`);

  // Pull org's active accounts once for the rules engine.
  const orgAccounts = await db
    .select({
      id: chartOfAccounts.id,
      accountNumber: chartOfAccounts.accountNumber,
      accountName: chartOfAccounts.accountName,
      gaapType: chartOfAccounts.gaapType,
    })
    .from(chartOfAccounts)
    .where(
      and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.isActive, true)),
    );

  await db.insert(categorizationSessions).values({
    id: sessionId,
    organizationId: orgId,
    userId,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });

  if (groups.length > 0) {
    const contactRows = groups.map((g) => {
      const recommendation = g.contactName
        ? recommendByRules(g.contactName, orgAccounts)
        : null;
      const r = mapRecommendation(recommendation);
      return {
        id: randomUUID(),
        sessionId,
        contactId: g.contactId,
        contactNameSnapshot: g.contactName,
        status: 'pending' as const,
        recommendedAccountId: r.recommendedAccountId,
        recommendedSource: r.recommendedSource,
        recommendedNewAccount: r.recommendedNewAccount,
        appliedAccountId: null as string | null,
        appliedAt: null as string | null,
        transactionCount: Number(g.transactionCount),
        totalAmount: String(g.totalAmount),
        oldestDate: g.oldestDate,
        newestDate: g.newestDate,
        createdAt: now,
        updatedAt: now,
      };
    });
    await db.insert(categorizationSessionContacts).values(contactRows);
  }

  logger.info(
    { sessionId, orgId, userId, contactCount: groups.length },
    'categorization session created',
  );

  return await loadSessionView(sessionId, orgId);
}

function mapRecommendation(rec: RuleRecommendation | null): {
  recommendedAccountId: string | null;
  recommendedSource: 'rules' | null;
  recommendedNewAccount: SessionContactView['recommendedNewAccount'];
} {
  if (!rec) {
    return {
      recommendedAccountId: null,
      recommendedSource: null,
      recommendedNewAccount: null,
    };
  }
  if (rec.kind === 'existing-account') {
    return {
      recommendedAccountId: rec.account.id,
      recommendedSource: 'rules',
      recommendedNewAccount: null,
    };
  }
  return {
    recommendedAccountId: null,
    recommendedSource: 'rules',
    recommendedNewAccount: rec.proposed,
  };
}

/**
 * Build the SessionView from the DB. Joins applied account names for display.
 */
export async function loadSessionView(
  sessionId: string,
  orgId: string,
): Promise<SessionView> {
  const [session] = await db
    .select()
    .from(categorizationSessions)
    .where(
      and(
        eq(categorizationSessions.id, sessionId),
        eq(categorizationSessions.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!session) throw new Error('Session not found');

  // Pull contacts joined with applied account name and recommended account name
  const contactRows = await db
    .select({
      id: categorizationSessionContacts.id,
      contactId: categorizationSessionContacts.contactId,
      contactName: categorizationSessionContacts.contactNameSnapshot,
      status: categorizationSessionContacts.status,
      recommendedAccountId: categorizationSessionContacts.recommendedAccountId,
      recommendedSource: categorizationSessionContacts.recommendedSource,
      recommendedNewAccount: categorizationSessionContacts.recommendedNewAccount,
      appliedAccountId: categorizationSessionContacts.appliedAccountId,
      appliedAt: categorizationSessionContacts.appliedAt,
      transactionCount: categorizationSessionContacts.transactionCount,
      totalAmount: categorizationSessionContacts.totalAmount,
      oldestDate: categorizationSessionContacts.oldestDate,
      newestDate: categorizationSessionContacts.newestDate,
    })
    .from(categorizationSessionContacts)
    .where(eq(categorizationSessionContacts.sessionId, sessionId))
    .orderBy(
      asc(
        sql`CASE ${categorizationSessionContacts.status}
          WHEN 'pending' THEN 0
          WHEN 'failed' THEN 1
          WHEN 'done' THEN 2
          WHEN 'skipped' THEN 3
          ELSE 4 END`,
      ),
      sql`${categorizationSessionContacts.transactionCount} DESC`,
    );

  // Live direction aggregation per contact. Uses still-uncategorized
  // transactions only — already-categorized rows drop out so a "done" row's
  // direction will read null and the UI uses status-driven styling instead.
  // GROUP BY contact_id naturally rolls up the null-bucket too.
  const directionRows = await db
    .select({
      contactId: transactions.contactId,
      deposits: sql<number>`SUM(CASE WHEN ${transactions.type} = 'deposit' THEN 1 ELSE 0 END)::int`.as(
        'deposits',
      ),
      withdrawals: sql<number>`SUM(CASE WHEN ${transactions.type} = 'withdrawal' THEN 1 ELSE 0 END)::int`.as(
        'withdrawals',
      ),
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, orgId),
        sql`${transactions.categoryAccountId} IS NULL`,
      ),
    )
    .groupBy(transactions.contactId);
  const NULL_KEY = '__null_contact__';
  const directionMap = new Map<string, { deposits: number; withdrawals: number }>();
  for (const r of directionRows) {
    const key = r.contactId ?? NULL_KEY;
    directionMap.set(key, { deposits: Number(r.deposits), withdrawals: Number(r.withdrawals) });
  }

  // Join account names for both recommended and applied account ids in one shot.
  const accountIds = Array.from(
    new Set(
      contactRows
        .flatMap((r) => [r.recommendedAccountId, r.appliedAccountId])
        .filter((id): id is string => !!id),
    ),
  );
  const accountMap = new Map<
    string,
    { accountNumber: string; accountName: string }
  >();
  if (accountIds.length > 0) {
    const accountList = await db
      .select({
        id: chartOfAccounts.id,
        accountNumber: chartOfAccounts.accountNumber,
        accountName: chartOfAccounts.accountName,
      })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.organizationId, orgId),
          sql`${chartOfAccounts.id} IN (${sql.join(
            accountIds.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        ),
      );
    for (const a of accountList) {
      accountMap.set(a.id, { accountNumber: a.accountNumber, accountName: a.accountName });
    }
  }

  let pendingCount = 0;
  let doneCount = 0;
  let skippedCount = 0;
  const contactsView: SessionContactView[] = contactRows.map((r) => {
    if (r.status === 'pending' || r.status === 'failed') pendingCount++;
    else if (r.status === 'done') doneCount++;
    else if (r.status === 'skipped') skippedCount++;

    const recommendedAccount = r.recommendedAccountId
      ? accountMap.get(r.recommendedAccountId)
      : null;
    const appliedAccount = r.appliedAccountId
      ? accountMap.get(r.appliedAccountId)
      : null;
    const recommendedNewAccount = r.recommendedNewAccount as
      | SessionContactView['recommendedNewAccount']
      | null;

    let recommendationLabel: string | null = null;
    if (recommendedAccount) {
      recommendationLabel = `${recommendedAccount.accountNumber} · ${recommendedAccount.accountName}`;
    } else if (recommendedNewAccount) {
      recommendationLabel = `Create ${recommendedNewAccount.accountNumber} · ${recommendedNewAccount.accountName}`;
    }

    // Binary direction signal: deposits-only → 'deposit', anything else →
    // 'withdrawal' (covers withdrawals-only, mixed, and zero rows). Most
    // vendor contacts are expense-side; defaulting to 'withdrawal' for the
    // ambiguous cases keeps the table consistent.
    const dir = directionMap.get(r.contactId ?? NULL_KEY);
    const direction: 'deposit' | 'withdrawal' =
      dir && dir.deposits > 0 && dir.withdrawals === 0 ? 'deposit' : 'withdrawal';

    return {
      id: r.id,
      contactId: r.contactId,
      contactName: r.contactName,
      status: r.status as ContactStatus,
      recommendedAccountId: r.recommendedAccountId,
      recommendedSource: (r.recommendedSource as 'rules' | 'ai' | 'manual' | null) ?? null,
      recommendedNewAccount,
      recommendationLabel,
      appliedAccountId: r.appliedAccountId,
      appliedAccountName: appliedAccount
        ? `${appliedAccount.accountNumber} · ${appliedAccount.accountName}`
        : null,
      appliedAt: r.appliedAt,
      transactionCount: r.transactionCount,
      totalAmount: Number(r.totalAmount ?? 0),
      oldestDate: r.oldestDate,
      newestDate: r.newestDate,
      direction,
    };
  });

  return {
    sessionId: session.id,
    status: session.status as 'active' | 'completed' | 'abandoned',
    contacts: contactsView,
    totalContacts: contactsView.length,
    pendingCount,
    doneCount,
    skippedCount,
  };
}

/**
 * Apply a category to all of a session-contact's uncategorized transactions.
 * The session-contact row tracks one contact (or the no-contact bucket); the
 * dispatcher fetches that contact's still-uncategorized transactions from
 * the live DB at apply time so resume works correctly even if rows were
 * categorized via another path between session start and apply.
 */
export async function applySessionContact(args: {
  organizationId: string;
  sessionId: string;
  sessionContactId: string;
  accountIdCandidate: string;
  source: 'rules' | 'ai' | 'manual';
}): Promise<{
  ok: true;
  posted: number;
  updated: number;
  failed: number;
  appliedAccountName: string;
} | { ok: false; error: string }> {
  const { organizationId: orgId, sessionId, sessionContactId, accountIdCandidate, source } = args;

  const [row] = await db
    .select()
    .from(categorizationSessionContacts)
    .where(
      and(
        eq(categorizationSessionContacts.id, sessionContactId),
        eq(categorizationSessionContacts.sessionId, sessionId),
      ),
    )
    .limit(1);
  if (!row) return { ok: false, error: 'Session contact not found' };
  if (row.status === 'done') return { ok: false, error: 'Contact already categorized' };

  const account = await resolveAccount(orgId, accountIdCandidate);
  if (!account) return { ok: false, error: 'Account not in this organization' };

  // Fetch live uncategorized rows for this contact (re-query in case state changed)
  const txnConds = [
    eq(transactions.organizationId, orgId),
    sql`${transactions.categoryAccountId} IS NULL`,
  ];
  if (row.contactId === null) {
    txnConds.push(sql`${transactions.contactId} IS NULL`);
  } else {
    txnConds.push(eq(transactions.contactId, row.contactId));
  }
  const liveRows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(...txnConds));

  let posted = 0;
  let updated = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const t of liveRows) {
    const result = await categorizeTransaction({
      organizationId: orgId,
      transactionId: t.id,
      categoryAccountId: account.id,
    });
    if (!result.ok) {
      failed++;
      if (errors.length < 3) errors.push(result.error);
      continue;
    }
    if (result.mode === 'posted') posted++;
    else updated++;
  }

  const now = new Date().toISOString();
  if (posted + updated > 0) {
    await db
      .update(categorizationSessionContacts)
      .set({
        status: 'done',
        appliedAccountId: account.id,
        appliedAt: now,
        recommendedSource: source,
        updatedAt: now,
      })
      .where(eq(categorizationSessionContacts.id, sessionContactId));
    logger.info(
      { sessionId, sessionContactId, accountId: account.id, posted, updated, failed, source },
      'session contact categorized',
    );
  } else {
    await db
      .update(categorizationSessionContacts)
      .set({ status: 'failed', updatedAt: now })
      .where(eq(categorizationSessionContacts.id, sessionContactId));
    logger.warn(
      { sessionId, sessionContactId, accountId: account.id, failed, errors },
      'session contact categorize failed',
    );
    return {
      ok: false,
      error: `Categorization failed for all ${liveRows.length} transactions. ${errors[0] ?? ''}`,
    };
  }

  await touchSession(sessionId);
  return { ok: true, posted, updated, failed, appliedAccountName: account.accountName };
}

export async function skipSessionContact(args: {
  sessionId: string;
  sessionContactId: string;
}): Promise<{ ok: boolean }> {
  const { sessionId, sessionContactId } = args;
  const now = new Date().toISOString();
  await db
    .update(categorizationSessionContacts)
    .set({ status: 'skipped', updatedAt: now })
    .where(
      and(
        eq(categorizationSessionContacts.id, sessionContactId),
        eq(categorizationSessionContacts.sessionId, sessionId),
      ),
    );
  await touchSession(sessionId);
  return { ok: true };
}

export async function unskipSessionContact(args: {
  sessionId: string;
  sessionContactId: string;
}): Promise<{ ok: boolean }> {
  const now = new Date().toISOString();
  await db
    .update(categorizationSessionContacts)
    .set({ status: 'pending', updatedAt: now })
    .where(
      and(
        eq(categorizationSessionContacts.id, args.sessionContactId),
        eq(categorizationSessionContacts.sessionId, args.sessionId),
      ),
    );
  await touchSession(args.sessionId);
  return { ok: true };
}

export async function completeSession(args: {
  organizationId: string;
  sessionId: string;
}): Promise<{ ok: boolean }> {
  const { organizationId: orgId, sessionId } = args;
  const now = new Date().toISOString();
  await db
    .update(categorizationSessions)
    .set({ status: 'completed', updatedAt: now })
    .where(
      and(
        eq(categorizationSessions.id, sessionId),
        eq(categorizationSessions.organizationId, orgId),
      ),
    );
  return { ok: true };
}

async function touchSession(sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(categorizationSessions)
    .set({ updatedAt: now })
    .where(eq(categorizationSessions.id, sessionId));
}
