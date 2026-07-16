import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, ne, or, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { aiClientOutreach, transactions, chartOfAccounts, notes, organizations } from '@/db/schema/schema';
import { chatCompletion } from '@/lib/ai/openai';
import { categorizeTransaction } from './categorize';
import { findOrCreateContact } from './ensure-contact';
import { promoteRule } from './rule-promotion';

const BACKFILL_CAP = 25;
const MIN_TOKEN_LEN = 4;
// A distinctive party token shouldn't appear across a large share of memos.
// Account-holder / processor names (e.g. PayPal "INST XFER" shows only the
// account holder) blow past these — so we skip back-prop + rule for them.
const BROAD_ABS = 40;
const BROAD_FRACTION = 0.03;

export interface ProcessReplyResult {
  ok: boolean;
  applied?: number;
  backfilled?: number;
  rules?: number;
  skipped?: boolean;
  reason?: string;
}

interface ExtractItem {
  transaction_id?: string;
  account_number?: string;
  contact_name?: string;
  contact_relationship?: string;
  match_token?: string;
  make_rule?: boolean;
}

/**
 * Apply a client's reply to a contact-inquiry. The LLM maps the reply → category
 * + the REAL party (even behind a processor like PayPal) + a match_token (how
 * that party appears in bank descriptions). For each addressed transaction we:
 *   1. resolve-or-reuse the real contact (findOrCreateContact dedupes by name),
 *   2. categorize the addressed txn + attach the contact + note the relationship,
 *   3. back-propagate: find OTHER unreviewed txns whose description contains the
 *      token, AI-confirm which are truly this party, and reassign + categorize them,
 *   4. promote a precise token-keyed rule (so future ones auto-apply) — not a
 *      broad processor-name rule.
 * Only unreviewed transactions are touched (never overrides confirmed books).
 * Best-effort; idempotent (marks the outreach resolved).
 */
export async function processContactInquiryReply(
  outreachId: string,
  replyText: string,
): Promise<ProcessReplyResult> {
  const [outreach] = await db
    .select({
      orgId: aiClientOutreach.organizationId,
      issueType: aiClientOutreach.issueType,
      status: aiClientOutreach.status,
      context: aiClientOutreach.context,
    })
    .from(aiClientOutreach)
    .where(eq(aiClientOutreach.id, outreachId))
    .limit(1);
  if (!outreach || outreach.issueType !== 'contact_inquiry') return { ok: true, skipped: true, reason: 'not_contact_inquiry' };
  if (outreach.status === 'resolved') return { ok: true, skipped: true, reason: 'already_processed' };

  const orgId = outreach.orgId;
  const txnIds = (outreach.context as { transactionIds?: string[] } | null)?.transactionIds ?? [];
  if (txnIds.length === 0) return { ok: true, skipped: true, reason: 'no_txns' };

  const txns = await db
    .select({
      id: transactions.id,
      contactId: transactions.contactId,
      type: transactions.type,
      amount: transactions.amount,
      date: transactions.date,
      bankDescription: transactions.bankDescription,
      description: transactions.description,
    })
    .from(transactions)
    .where(and(eq(transactions.organizationId, orgId), inArray(transactions.id, txnIds)));
  if (txns.length === 0) return { ok: true, skipped: true, reason: 'txns_gone' };

  const accounts = await db
    .select({ id: chartOfAccounts.id, number: chartOfAccounts.accountNumber, name: chartOfAccounts.accountName, gaapType: chartOfAccounts.gaapType, accountType: chartOfAccounts.accountType })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.isActive, true)));
  const [org] = await db.select({ ownerUserId: organizations.ownerUserId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const authorId = org?.ownerUserId ?? '';
  const model = process.env.AI_CATEGORIZE_MODEL ?? 'gpt-4o';

  const txnList = txns
    .map((t) => `id=${t.id} | ${t.date} | ${t.type} | $${Math.abs(Number(t.amount ?? 0))} | ${t.bankDescription ?? t.description ?? ''}`)
    .join('\n');
  const coaList = accounts.map((a) => `${a.number} | ${a.name} | ${a.gaapType}${a.accountType ? ` / ${a.accountType}` : ''}`).join('\n');

  const system = `You map a client's free-text reply about bank transactions to bookkeeping decisions. For each listed transaction the reply actually addresses, return:
- account_number: the best chart-of-accounts number from the provided list only.
- contact_name: the REAL other party (e.g. "John Smith"), even when the bank shows a payment processor (PayPal/Venmo/Zelle/etc.). Take it from the reply, or the transaction description if the reply refers to it.
- contact_relationship: one short line on who they are.
- match_token: a distinctive substring as it appears in the BANK DESCRIPTION identifying this party (e.g. "JOHN SMITH"), used to find that party's other transactions. Prefer the description's spelling; omit if none is identifiable.
- make_rule: true if future transactions for this party should auto-categorize the same way.
Only include transactions the reply addresses. Output strict JSON: {"items":[{"transaction_id","account_number","contact_name","contact_relationship","match_token","make_rule"}]}`;
  const user = `Transactions:\n${txnList}\n\nChart of accounts (number | name | type):\n${coaList}\n\nClient reply:\n"""${replyText.slice(0, 4000)}"""\n\nReturn JSON.`;

  let items: ExtractItem[] = [];
  try {
    const c = await chatCompletion(
      { userId: authorId || null, orgId, actor: 'system', feature: 'contact_inquiry_reply' },
      { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: { type: 'json_object' }, temperature: 0 },
    );
    items = (JSON.parse(c.choices[0]?.message?.content ?? '{}') as { items?: ExtractItem[] }).items ?? [];
  } catch (e) {
    console.error('contact-inquiry-reply: extraction failed', e);
    return { ok: false, reason: 'ai_failed' };
  }

  const txnById = new Map(txns.map((t) => [t.id, t]));
  let applied = 0;
  let backfilled = 0;
  let rules = 0;

  for (const it of items) {
    const t = it.transaction_id ? txnById.get(it.transaction_id) : undefined;
    if (!t || !it.account_number) continue;
    const acct = accounts.find((a) => a.number === it.account_number);
    if (!acct) continue;
    const contactName = (it.contact_name ?? '').trim() || (t.bankDescription ?? t.description ?? '').trim();
    try {
      // Resolve-or-reuse the REAL party (findOrCreateContact dedupes by normalized name).
      const contactId = await findOrCreateContact({ organizationId: orgId, merchantName: contactName, type: t.type ?? null });
      if (contactId) await db.update(transactions).set({ contactId }).where(eq(transactions.id, t.id));
      await categorizeTransaction({ organizationId: orgId, transactionId: t.id, categoryAccountId: acct.id });
      applied++;
      if (contactId && it.contact_relationship && authorId) {
        try {
          await db.insert(notes).values({ id: randomUUID(), userId: authorId, organizationId: orgId, contactId, body: it.contact_relationship.slice(0, 500), source: 'ai' });
        } catch { /* note is a nicety */ }
      }

      // Back-propagate to sibling unreviewed transactions for the same party —
      // but ONLY when the token is distinctive. Guard against account-holder /
      // processor tokens that appear across many memos (they'd mass-misapply).
      const token = (it.match_token ?? '').trim();
      let tokenDistinctive = false;
      if (contactId && token.length >= MIN_TOKEN_LEN) {
        const [stats] = await db
          .select({
            matches: sql<number>`count(*) filter (where coalesce(${transactions.bankDescription}, ${transactions.description}) ilike ${'%' + token + '%'})::int`,
            total: sql<number>`count(*)::int`,
          })
          .from(transactions)
          .where(eq(transactions.organizationId, orgId));
        tokenDistinctive = stats.matches <= BROAD_ABS && (stats.total === 0 || stats.matches / stats.total <= BROAD_FRACTION);
        if (!tokenDistinctive) {
          console.warn(`contact-inquiry-reply: token "${token}" matches ${stats.matches}/${stats.total} txns — not distinctive; skipping back-prop + rule`);
        }
      }

      if (contactId && tokenDistinctive) {
        const candidates = await db
          .select({ id: transactions.id, desc: sql<string>`coalesce(${transactions.bankDescription},${transactions.description})` })
          .from(transactions)
          .where(and(
            eq(transactions.organizationId, orgId),
            or(eq(transactions.reviewed, false), isNull(transactions.reviewed)),
            ne(transactions.id, t.id),
            sql`coalesce(${transactions.bankDescription},${transactions.description}) ilike ${'%' + token + '%'}`,
          ))
          .limit(BACKFILL_CAP);

        let confirmIds: string[] = [];
        if (candidates.length > 0) {
          // AI-confirm — the token may be an account holder/processor, not the
          // counterparty, so only accept memos clearly for this party.
          try {
            const cl = candidates.map((c) => `id=${c.id} | ${c.desc}`).join('\n');
            const cc = await chatCompletion(
              { userId: authorId || null, orgId, actor: 'system', feature: 'contact_inquiry_backfill' },
              { model, messages: [
                { role: 'system', content: `The text "${token}" may be an account-holder or payment-processor name present in many memos, NOT the counterparty. Return only ids where the actual OTHER PARTY (payee/payer) is clearly "${contactName}". If a memo only shows an account holder/processor + a transfer id with no clear counterparty, do NOT include it. Be conservative. Output strict JSON: {"ids":["..."]}` },
                { role: 'user', content: cl },
              ], response_format: { type: 'json_object' }, temperature: 0 },
            );
            const parsed = JSON.parse(cc.choices[0]?.message?.content ?? '{}') as { ids?: string[] };
            confirmIds = Array.isArray(parsed.ids) ? parsed.ids.filter((id) => candidates.some((c) => c.id === id)) : [];
          } catch (e) {
            console.error('contact-inquiry-reply: backfill confirm failed', e);
            confirmIds = [];
          }
        }
        for (const id of confirmIds) {
          try {
            await db.update(transactions).set({ contactId }).where(eq(transactions.id, id));
            await categorizeTransaction({ organizationId: orgId, transactionId: id, categoryAccountId: acct.id });
            backfilled++;
          } catch (e) {
            console.error('contact-inquiry-reply: backfill apply failed', id, e);
          }
        }

        if (it.make_rule) {
          const r = await promoteRule(orgId, token.slice(0, 80), acct.id);
          if (r.ok) rules++;
        }
      }
    } catch (e) {
      console.error('contact-inquiry-reply: apply failed for txn', t.id, e);
    }
  }

  await db.update(aiClientOutreach).set({ status: 'resolved', updatedAt: new Date().toISOString() }).where(eq(aiClientOutreach.id, outreachId));
  return { ok: true, applied, backfilled, rules };
}
