import 'server-only';
import { and, desc, eq, ilike, inArray, isNull, or } from 'drizzle-orm';
import { db } from '@/db/client';
import { aiClientOutreach, emailInbound, transactions } from '@/db/schema/schema';

/**
 * Unified email-communications log: every outbound AI/system email to a client
 * (from ai_client_outreach) threaded with the client's inbound replies (from
 * email_inbound), with the transactions each thread is about resolved to links.
 * Read-only; org-scoped. Searchable across subject/body/sender/issue/txn.
 */

export interface CommMessage {
  direction: 'outbound' | 'inbound';
  from: string | null; // sender email for inbound; null = the AI/system
  subject: string | null;
  body: string | null;
  at: string | null; // ISO
}

export interface CommTxnLink {
  id: string;
  label: string;
}

export interface CommThread {
  id: string;
  issueType: string;
  channel: string | null;
  status: string;
  lastAt: string | null; // ISO of the most recent message in the thread
  messages: CommMessage[];
  transactions: CommTxnLink[];
}

/** Pull every transaction id this outreach is about, across the context shapes
 * different issue types use (contact_inquiry, substantiation_request, …). */
function txnIdsFromContext(ctx: unknown): string[] {
  if (!ctx || typeof ctx !== 'object') return [];
  const c = ctx as Record<string, unknown>;
  const ids = new Set<string>();
  if (Array.isArray(c.transactionIds)) for (const x of c.transactionIds) if (typeof x === 'string') ids.add(x);
  if (Array.isArray(c.items)) for (const it of c.items) { const t = (it as { transactionId?: unknown })?.transactionId; if (typeof t === 'string') ids.add(t); }
  if (Array.isArray(c.groups)) for (const g of c.groups) { const tx = (g as { txnIds?: unknown })?.txnIds; if (Array.isArray(tx)) for (const t of tx) if (typeof t === 'string') ids.add(t); }
  return [...ids];
}

const OUTREACH_LIMIT = 1000;
const INBOUND_LIMIT = 2000;

export async function listCommunications(orgId: string, q?: string): Promise<CommThread[]> {
  // Outbound: email outreach for this org (skip pure-SMS).
  const outreach = await db
    .select({
      id: aiClientOutreach.id,
      issueType: aiClientOutreach.issueType,
      channel: aiClientOutreach.channel,
      status: aiClientOutreach.status,
      subject: aiClientOutreach.lastMessageSubject,
      body: aiClientOutreach.lastMessageBody,
      sentAt: aiClientOutreach.lastContactAt,
      createdAt: aiClientOutreach.createdAt,
      context: aiClientOutreach.context,
    })
    .from(aiClientOutreach)
    .where(
      and(
        eq(aiClientOutreach.organizationId, orgId),
        or(isNull(aiClientOutreach.channel), ilike(aiClientOutreach.channel, '%email%')),
      ),
    )
    .orderBy(desc(aiClientOutreach.lastContactAt))
    .limit(OUTREACH_LIMIT);

  // Inbound: client replies for this org.
  const inbound = await db
    .select({
      id: emailInbound.id,
      outreachId: emailInbound.outreachId,
      fromEmail: emailInbound.fromEmail,
      subject: emailInbound.subject,
      body: emailInbound.body,
      receivedAt: emailInbound.receivedAt,
    })
    .from(emailInbound)
    .where(eq(emailInbound.organizationId, orgId))
    .orderBy(desc(emailInbound.receivedAt))
    .limit(INBOUND_LIMIT);

  const repliesByOutreach = new Map<string, typeof inbound>();
  const orphanInbound: typeof inbound = [];
  const outreachIds = new Set(outreach.map((o) => o.id));
  for (const r of inbound) {
    if (r.outreachId && outreachIds.has(r.outreachId)) {
      const arr = repliesByOutreach.get(r.outreachId) ?? [];
      arr.push(r);
      repliesByOutreach.set(r.outreachId, arr);
    } else {
      orphanInbound.push(r);
    }
  }

  // Resolve transaction labels for every txn referenced across threads.
  const allTxnIds = [...new Set(outreach.flatMap((o) => txnIdsFromContext(o.context)))];
  const txnLabels = new Map<string, string>();
  if (allTxnIds.length) {
    const rows = await db
      .select({
        id: transactions.id,
        date: transactions.date,
        amount: transactions.amount,
        bankDescription: transactions.bankDescription,
        description: transactions.description,
      })
      .from(transactions)
      .where(and(eq(transactions.organizationId, orgId), inArray(transactions.id, allTxnIds)));
    for (const t of rows) {
      const desc = t.bankDescription ?? t.description ?? 'Transaction';
      const amt = t.amount != null ? ` · $${Math.abs(Number(t.amount)).toFixed(2)}` : '';
      txnLabels.set(t.id, `${t.date ?? ''} ${desc}${amt}`.trim());
    }
  }

  const threads: CommThread[] = [];

  for (const o of outreach) {
    const replies = (repliesByOutreach.get(o.id) ?? []).slice().sort((a, b) => (a.receivedAt ?? '').localeCompare(b.receivedAt ?? ''));
    const messages: CommMessage[] = [];
    // Outbound exists if we captured a subject or body.
    if (o.subject || o.body) {
      messages.push({ direction: 'outbound', from: null, subject: o.subject, body: o.body, at: o.sentAt ?? o.createdAt });
    }
    for (const r of replies) {
      messages.push({ direction: 'inbound', from: r.fromEmail, subject: r.subject, body: r.body, at: r.receivedAt });
    }
    if (messages.length === 0) continue;
    const txns = txnIdsFromContext(o.context)
      .map((id) => ({ id, label: txnLabels.get(id) ?? '' }))
      .filter((t) => t.label);
    const lastAt = messages.reduce<string | null>((acc, m) => (m.at && (!acc || m.at > acc) ? m.at : acc), null);
    // issue_type/status are notNull in schema but the live DB has drift — coerce
    // so downstream string ops (label, .replace) never hit null/undefined.
    threads.push({ id: o.id, issueType: o.issueType ?? 'other', channel: o.channel, status: o.status ?? 'drafted', lastAt, messages, transactions: txns });
  }

  // Orphan inbound (reply we couldn't tie to a known outreach) — show standalone.
  for (const r of orphanInbound) {
    threads.push({
      id: `inbound:${r.id}`,
      issueType: 'reply',
      channel: 'email',
      status: 'received',
      lastAt: r.receivedAt,
      messages: [{ direction: 'inbound', from: r.fromEmail, subject: r.subject, body: r.body, at: r.receivedAt }],
      transactions: [],
    });
  }

  threads.sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));

  if (q && q.trim()) {
    const needle = q.trim().toLowerCase();
    return threads.filter((t) => {
      if (t.issueType.toLowerCase().includes(needle)) return true;
      if (t.transactions.some((x) => x.label.toLowerCase().includes(needle))) return true;
      return t.messages.some(
        (m) =>
          (m.subject ?? '').toLowerCase().includes(needle) ||
          (m.body ?? '').toLowerCase().includes(needle) ||
          (m.from ?? '').toLowerCase().includes(needle),
      );
    });
  }

  return threads;
}
