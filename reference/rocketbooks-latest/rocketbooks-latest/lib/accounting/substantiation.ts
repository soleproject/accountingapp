import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions, chartOfAccounts, transactionSubstantiation } from '@/db/schema/schema';
import { detectDocType, specFor, askFields, autoFieldValues, type DocType } from './substantiation-types';

/**
 * Detect transactions that need IRS substantiation (meals, travel, lodging,
 * gifts, vehicle, charitable) and surface stored substantiation records.
 * Detection is by category name + description keyword match (substantiation-types.ts).
 */

export interface NeedingItem {
  txnId: string;
  docType: DocType;
  date: string | null;
  amount: number | null;
  description: string | null;
  categoryName: string | null;
}

export async function findTxnsNeedingSubstantiation(orgId: string, days = 7): Promise<NeedingItem[]> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      amount: transactions.amount,
      bankDescription: transactions.bankDescription,
      description: transactions.description,
      categoryName: chartOfAccounts.accountName,
      substId: transactionSubstantiation.id,
    })
    .from(transactions)
    .leftJoin(chartOfAccounts, eq(transactions.categoryAccountId, chartOfAccounts.id))
    .leftJoin(transactionSubstantiation, eq(transactionSubstantiation.transactionId, transactions.id))
    .where(
      and(
        eq(transactions.organizationId, orgId),
        sql`${transactions.createdAt} >= ${cutoff}`,
        isNull(transactionSubstantiation.id), // not already tracked
      ),
    );

  const out: NeedingItem[] = [];
  for (const r of rows) {
    // Detect from the CATEGORY (authoritative) — not the description, which
    // produces false positives (e.g. "AUTOPAY" → auto). A txn must be
    // categorized into a substantiation-relevant account to be flagged.
    const docType = r.categoryName ? detectDocType(r.categoryName) : null;
    if (!docType) continue;
    out.push({
      txnId: r.id,
      docType,
      date: r.date,
      amount: r.amount,
      description: r.bankDescription ?? r.description ?? null,
      categoryName: r.categoryName ?? null,
    });
  }
  return out;
}

export interface SubstRecord {
  id: string;
  transactionId: string;
  docType: DocType;
  status: string;
  fields: Record<string, unknown> | null;
  date: string | null;
  amount: number | null;
  description: string | null;
}

export async function listSubstantiationRecords(orgId: string, limit = 200): Promise<SubstRecord[]> {
  const rows = await db
    .select({
      id: transactionSubstantiation.id,
      transactionId: transactionSubstantiation.transactionId,
      docType: transactionSubstantiation.docType,
      status: transactionSubstantiation.status,
      fields: transactionSubstantiation.fields,
      date: transactions.date,
      amount: transactions.amount,
      bankDescription: transactions.bankDescription,
      description: transactions.description,
    })
    .from(transactionSubstantiation)
    .leftJoin(transactions, eq(transactions.id, transactionSubstantiation.transactionId))
    .where(eq(transactionSubstantiation.organizationId, orgId))
    .orderBy(desc(transactionSubstantiation.updatedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    transactionId: r.transactionId,
    docType: r.docType as DocType,
    status: r.status,
    fields: (r.fields as Record<string, unknown> | null) ?? null,
    date: r.date ?? null,
    amount: r.amount ?? null,
    description: r.bankDescription ?? r.description ?? null,
  }));
}

export interface SaveSubstResult {
  ok: boolean;
  status?: string;
  error?: string;
}

/**
 * Upsert the IRS-documentation fields for one transaction: merge the client-
 * provided ASK fields with the auto-known values (amount/date/merchant) and store
 * them. Status flips to 'provided' once every required field is filled, else
 * 'needed'. Shared by the page's save action + the assistant's save tool.
 */
export async function saveSubstantiationFields(
  orgId: string,
  transactionId: string,
  docType: DocType,
  provided: Record<string, string>,
): Promise<SaveSubstResult> {
  const spec = specFor(docType);
  if (!spec) return { ok: false, error: 'Unknown documentation type' };

  const [txn] = await db
    .select({ amount: transactions.amount, date: transactions.date, description: transactions.description })
    .from(transactions)
    .where(and(eq(transactions.id, transactionId), eq(transactions.organizationId, orgId)))
    .limit(1);
  if (!txn) return { ok: false, error: 'Transaction not found' };

  const clean: Record<string, string> = {};
  for (const f of askFields(spec)) {
    const v = (provided[f.key] ?? '').toString().trim();
    if (v) clean[f.key] = v;
  }
  const merged = {
    ...autoFieldValues(spec, {
      amount: txn.amount == null ? null : Number(txn.amount),
      date: txn.date ?? null,
      merchant: txn.description ?? null,
    }),
    ...clean,
  };
  const complete = askFields(spec)
    .filter((f) => !f.optional)
    .every((f) => !!clean[f.key]);
  const status = complete ? 'provided' : 'needed';
  const now = new Date().toISOString();

  await db
    .insert(transactionSubstantiation)
    .values({
      id: randomUUID(),
      organizationId: orgId,
      transactionId,
      docType,
      status,
      fields: merged,
      providedAt: complete ? now : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [transactionSubstantiation.organizationId, transactionSubstantiation.transactionId],
      set: { fields: merged, status, providedAt: complete ? now : null, updatedAt: now, docType },
    });
  return { ok: true, status };
}

export interface SubstTarget {
  transactionId: string;
  docType: DocType;
  docLabel: string;
  date: string | null;
  amount: number | null;
  description: string | null;
  askFields: { key: string; label: string; optional: boolean }[];
  values: Record<string, string>;
}

function toTarget(
  txnId: string,
  docType: DocType,
  date: string | null,
  amount: number | null,
  description: string | null,
  fields: Record<string, unknown> | null,
): SubstTarget {
  const spec = specFor(docType);
  const ask = askFields(spec);
  const ordered = [...ask.filter((f) => !f.optional), ...ask.filter((f) => f.optional)];
  const values: Record<string, string> = {};
  if (fields) {
    for (const f of ordered) {
      const v = fields[f.key];
      if (v != null && v !== '') values[f.key] = String(v);
    }
  }
  return {
    transactionId: txnId,
    docType,
    docLabel: spec.label,
    date,
    amount,
    description,
    askFields: ordered.map((f) => ({ key: f.key, label: f.label, optional: !!f.optional })),
    values,
  };
}

/** The next transaction still needing documentation (skip `excludeTxnId`), or null. */
export async function getNextSubstantiationTarget(orgId: string, excludeTxnId?: string): Promise<SubstTarget | null> {
  const [needing, records] = await Promise.all([
    findTxnsNeedingSubstantiation(orgId, 30),
    listSubstantiationRecords(orgId),
  ]);
  const pending: SubstTarget[] = [
    ...needing.map((n) => toTarget(n.txnId, n.docType, n.date, n.amount, n.description, null)),
    ...records
      .filter((r) => r.status !== 'provided')
      .map((r) => toTarget(r.transactionId, r.docType, r.date, r.amount, r.description, r.fields ?? null)),
  ].filter((t) => t.transactionId !== excludeTxnId);
  return pending[0] ?? null;
}
