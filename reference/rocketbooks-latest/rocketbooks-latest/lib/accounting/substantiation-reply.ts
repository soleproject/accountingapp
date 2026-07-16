import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { aiClientOutreach, transactions, transactionSubstantiation, organizations } from '@/db/schema/schema';
import { chatCompletion } from '@/lib/ai/openai';
import { specFor, askFields, type DocType } from './substantiation-types';

export interface ProcessSubstResult {
  ok: boolean;
  provided?: number;
  skipped?: boolean;
  reason?: string;
}

/**
 * Apply a client's reply to a substantiation request: an LLM fills each
 * transaction's required IRS fields from the reply, and we store them on the
 * transaction_substantiation record (status 'provided') linked to the txn.
 * Best-effort; idempotent (marks the outreach resolved).
 */
export async function processSubstantiationReply(outreachId: string, replyText: string): Promise<ProcessSubstResult> {
  const [outreach] = await db
    .select({ orgId: aiClientOutreach.organizationId, issueType: aiClientOutreach.issueType, status: aiClientOutreach.status, context: aiClientOutreach.context })
    .from(aiClientOutreach)
    .where(eq(aiClientOutreach.id, outreachId))
    .limit(1);
  if (!outreach || outreach.issueType !== 'substantiation_request') return { ok: true, skipped: true, reason: 'not_substantiation' };
  if (outreach.status === 'resolved') return { ok: true, skipped: true, reason: 'already_processed' };

  const orgId = outreach.orgId;
  const items = (outreach.context as { items?: { transactionId: string; docType: DocType }[] } | null)?.items ?? [];
  if (items.length === 0) return { ok: true, skipped: true, reason: 'no_items' };

  const txnIds = items.map((i) => i.transactionId);
  const txns = await db
    .select({ id: transactions.id, date: transactions.date, amount: transactions.amount, bankDescription: transactions.bankDescription, description: transactions.description })
    .from(transactions)
    .where(and(eq(transactions.organizationId, orgId), inArray(transactions.id, txnIds)));
  const txnById = new Map(txns.map((t) => [t.id, t]));
  const [org] = await db.select({ ownerUserId: organizations.ownerUserId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const authorId = org?.ownerUserId ?? '';

  // Existing records carry the prefilled auto fields (amount/date/merchant) from
  // the request — merge the reply into them rather than overwrite.
  const existing = await db
    .select({ transactionId: transactionSubstantiation.transactionId, fields: transactionSubstantiation.fields })
    .from(transactionSubstantiation)
    .where(and(eq(transactionSubstantiation.organizationId, orgId), inArray(transactionSubstantiation.transactionId, txnIds)));
  const existingFields = new Map(existing.map((e) => [e.transactionId, (e.fields as Record<string, unknown> | null) ?? {}]));

  const lines = items
    .map((it) => {
      const t = txnById.get(it.transactionId);
      // Only ask the LLM for the fields we don't already know.
      const fieldList = askFields(specFor(it.docType)).map((f) => `${f.key} (${f.label})`).join('; ');
      return `transaction_id=${it.transactionId} | type=${it.docType} | ${t?.date ?? ''} ${t?.bankDescription ?? t?.description ?? ''}\n  fields to extract: ${fieldList}`;
    })
    .join('\n');

  const system = `Extract IRS substantiation details from the client's reply for each transaction. For each transaction the reply addresses, fill the listed required fields using the EXACT field keys. Omit transactions the reply doesn't address; omit fields the reply doesn't provide. Output strict JSON: {"items":[{"transaction_id":"...","fields":{"<key>":"<value>"}}]}`;
  const user = `Transactions + required fields:\n${lines}\n\nClient reply:\n"""${replyText.slice(0, 4000)}"""\n\nReturn JSON.`;

  let extracted: { transaction_id?: string; fields?: Record<string, unknown> }[] = [];
  try {
    const c = await chatCompletion(
      { userId: authorId || null, orgId, actor: 'system', feature: 'substantiation_reply' },
      { model: process.env.AI_CATEGORIZE_MODEL ?? 'gpt-4o', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: { type: 'json_object' }, temperature: 0 },
    );
    extracted = (JSON.parse(c.choices[0]?.message?.content ?? '{}') as { items?: typeof extracted }).items ?? [];
  } catch (e) {
    console.error('substantiation-reply: extraction failed', e);
    return { ok: false, reason: 'ai_failed' };
  }

  const docTypeByTxn = new Map(items.map((i) => [i.transactionId, i.docType]));
  const now = new Date().toISOString();
  let provided = 0;
  for (const ex of extracted) {
    const txnId = ex.transaction_id;
    if (!txnId || !docTypeByTxn.has(txnId)) continue;
    if (!ex.fields || Object.keys(ex.fields).length === 0) continue;
    // Merge the reply into the prefilled known fields (amount/date/merchant).
    const merged = { ...(existingFields.get(txnId) ?? {}), ...ex.fields };
    try {
      await db
        .insert(transactionSubstantiation)
        .values({ id: randomUUID(), organizationId: orgId, transactionId: txnId, docType: docTypeByTxn.get(txnId)!, status: 'provided', fields: merged, providedAt: now })
        .onConflictDoUpdate({
          target: [transactionSubstantiation.organizationId, transactionSubstantiation.transactionId],
          set: { status: 'provided', fields: merged, providedAt: now, updatedAt: now },
        });
      provided++;
    } catch (e) {
      console.error('substantiation-reply: upsert failed', txnId, e);
    }
  }

  await db.update(aiClientOutreach).set({ status: 'resolved', updatedAt: now }).where(eq(aiClientOutreach.id, outreachId));
  return { ok: true, provided };
}
