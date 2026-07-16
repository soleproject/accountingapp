import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { categorizationRules } from '@/db/schema/schema';

/**
 * Categorization rule promotion — turn consistent past categorizations into
 * explicit, deterministic rules the accountant controls. Rules are applied by
 * the categorizer (lib/ai/categorization.ts lookupRule, before vendor memory)
 * so a match skips the AI call entirely: cheaper, faster, 100% consistent.
 *
 * A rule is `ruleType='contains'` + a `pattern` matched case-insensitively as a
 * substring of the transaction description. Promoted from history where one
 * merchant has been categorized to the SAME account >= MIN_HITS times.
 */

const MIN_HITS = 3;
const MIN_PATTERN_LEN = 3;
const RULE_CONFIDENCE = 0.99;

export interface ExistingRule {
  id: string;
  pattern: string;
  categoryAccountId: string;
  categoryName: string | null;
  confidence: number;
  /** 'deposit' | 'withdrawal' — scopes the rule to one direction. null = any. */
  transactionType: string | null;
}

export interface SuggestedRule {
  pattern: string;
  categoryAccountId: string;
  categoryName: string;
  count: number;
  /** The direction this suggestion is scoped to ('deposit'|'withdrawal'|null). */
  transactionType: string | null;
}

export async function listRules(orgId: string): Promise<ExistingRule[]> {
  const rows = (await db.execute(sql`
    select r.id, r.pattern, r.category_account_id, r.confidence, r.transaction_type, coa.account_name
    from categorization_rules r
    left join chart_of_accounts coa on coa.id = r.category_account_id
    where r.organization_id = ${orgId}
    order by r.created_at desc nulls last
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    pattern: String(r.pattern ?? ''),
    categoryAccountId: String(r.category_account_id ?? ''),
    categoryName: r.account_name ? String(r.account_name) : null,
    confidence: Number(r.confidence ?? 0),
    transactionType: r.transaction_type ? String(r.transaction_type) : null,
  }));
}

/**
 * Suggest rules from history: merchants categorized consistently (one account,
 * >= MIN_HITS confirmed+posted times) that no existing rule already covers.
 */
export async function suggestRules(orgId: string): Promise<SuggestedRule[]> {
  const rows = (await db.execute(sql`
    select
      coalesce(c.contact_name, t.bank_description, t.description) as merchant,
      t.type as txn_type,
      t.category_account_id as account_id,
      coa.account_name as account_name,
      count(*)::int as n
    from transactions t
    left join contacts c on c.id = t.contact_id
    join chart_of_accounts coa on coa.id = t.category_account_id
    where t.organization_id = ${orgId}
      and t.reviewed = true
      and t.journal_entry_id is not null
      and t.category_account_id is not null
      and coa.account_name not in ('Uncategorized Expense', 'Uncategorized Income')
    group by merchant, t.type, t.category_account_id, coa.account_name
    having count(*) >= ${MIN_HITS}
    order by count(*) desc
  `)) as unknown as Array<Record<string, unknown>>;

  // Collapse by (merchant, type); only suggest a (merchant, direction) pair that
  // maps CONSISTENTLY to one account. Deposits and withdrawals for the same
  // merchant stay separate (a refund deposit can differ from a purchase).
  const byKey = new Map<string, { merchant: string; type: string | null; accountId: string; accountName: string; n: number }[]>();
  for (const r of rows) {
    const merchant = (r.merchant ? String(r.merchant) : '').trim();
    if (merchant.length < MIN_PATTERN_LEN) continue;
    const type = r.txn_type ? String(r.txn_type) : null;
    const key = `${type ?? ''}::${merchant.toLowerCase()}`;
    const list = byKey.get(key) ?? [];
    list.push({ merchant, type, accountId: String(r.account_id), accountName: String(r.account_name), n: Number(r.n) });
    byKey.set(key, list);
  }

  const existing = await listRules(orgId);

  const out: SuggestedRule[] = [];
  for (const accts of byKey.values()) {
    if (accts.length !== 1) continue;
    const a = accts[0];
    const m = a.merchant.toLowerCase();
    // Covered if an existing rule whose pattern is a substring of this merchant
    // applies to this direction (same type, or an any-type rule).
    const covered = existing.some(
      (e) => e.pattern && m.includes(e.pattern.toLowerCase()) && (e.transactionType == null || e.transactionType === a.type),
    );
    if (covered) continue;
    out.push({ pattern: a.merchant, categoryAccountId: a.accountId, categoryName: a.accountName, count: a.n, transactionType: a.type });
  }
  out.sort((x, y) => y.count - x.count);
  return out.slice(0, 25);
}

/**
 * Is there a pending (not-yet-created) rule suggestion for ONE transaction's
 * merchant? Targeted version of suggestRules — checks only this transaction's
 * merchant so it's cheap to run on a verify click. Returns the suggestion the
 * user can one-click accept, or null.
 */
export async function pendingRuleForTransaction(
  orgId: string,
  transactionId: string,
): Promise<SuggestedRule | null> {
  const [txRow] = (await db.execute(sql`
    select coalesce(c.contact_name, t.bank_description, t.description) as merchant, t.type as txn_type
    from transactions t
    left join contacts c on c.id = t.contact_id
    where t.id = ${transactionId} and t.organization_id = ${orgId}
    limit 1
  `)) as unknown as Array<Record<string, unknown>>;
  const merchant = (txRow?.merchant ? String(txRow.merchant) : '').trim();
  const txnType = txRow?.txn_type ? String(txRow.txn_type) : null;
  if (merchant.length < MIN_PATTERN_LEN) return null;

  // The merchant's confirmed history FOR THIS DIRECTION — must map CONSISTENTLY
  // to one account >= MIN_HITS. Deposits and withdrawals are scoped separately.
  const accts = (await db.execute(sql`
    select t.category_account_id as account_id, coa.account_name, count(*)::int as n
    from transactions t
    left join contacts c on c.id = t.contact_id
    join chart_of_accounts coa on coa.id = t.category_account_id
    where t.organization_id = ${orgId}
      and t.reviewed = true
      and t.journal_entry_id is not null
      and t.category_account_id is not null
      and coa.account_name not in ('Uncategorized Expense', 'Uncategorized Income')
      and t.type is not distinct from ${txnType}
      and lower(coalesce(c.contact_name, t.bank_description, t.description)) = lower(${merchant})
    group by t.category_account_id, coa.account_name
  `)) as unknown as Array<Record<string, unknown>>;
  if (accts.length !== 1) return null;
  const r = accts[0];
  if (Number(r.n) < MIN_HITS) return null;

  // Skip if an existing rule already covers this merchant for this direction
  // (a same-type rule, or a legacy any-type rule).
  const [existing] = (await db.execute(sql`
    select 1 from categorization_rules
    where organization_id = ${orgId} and lower(${merchant}) like '%' || lower(pattern) || '%'
      and (transaction_type is null or transaction_type = ${txnType})
    limit 1
  `)) as unknown as Array<unknown>;
  if (existing) return null;

  return {
    pattern: merchant,
    categoryAccountId: String(r.account_id),
    categoryName: String(r.account_name),
    count: Number(r.n),
    transactionType: txnType,
  };
}

export interface ContactCategorizeSuggestion {
  contactId: string;
  contactName: string;
  categoryAccountId: string;
  categoryName: string;
  count: number;
  /** The direction being aligned ('deposit'|'withdrawal'|null) — only other
   *  same-direction transactions for the contact are offered. */
  transactionType: string | null;
}

/**
 * After verifying a transaction that has a real contact + category (and no
 * pending rule), are there OTHER UNVERIFIED transactions for the same contact
 * not yet on that category? If so the user can one-click align them. Only
 * unverified rows are touched, so a human's prior decision is never overwritten.
 */
export async function pendingContactCategorization(
  orgId: string,
  transactionId: string,
): Promise<ContactCategorizeSuggestion | null> {
  const [txRow] = (await db.execute(sql`
    select t.contact_id, t.category_account_id, t.type as txn_type, c.contact_name, coa.account_name
    from transactions t
    left join contacts c on c.id = t.contact_id
    left join chart_of_accounts coa on coa.id = t.category_account_id
    where t.id = ${transactionId} and t.organization_id = ${orgId}
    limit 1
  `)) as unknown as Array<Record<string, unknown>>;
  const contactId = txRow?.contact_id ? String(txRow.contact_id) : '';
  const categoryAccountId = txRow?.category_account_id ? String(txRow.category_account_id) : '';
  const contactName = txRow?.contact_name ? String(txRow.contact_name) : '';
  const categoryName = txRow?.account_name ? String(txRow.account_name) : '';
  const txnType = txRow?.txn_type ? String(txRow.txn_type) : null;
  if (!contactId || !categoryAccountId || !contactName) return null;
  if (categoryName === 'Uncategorized Expense' || categoryName === 'Uncategorized Income') return null;

  // Only OTHER SAME-DIRECTION transactions for the contact — a contact's deposits
  // and withdrawals can belong on different accounts.
  const [cnt] = (await db.execute(sql`
    select count(*)::int as n
    from transactions t
    where t.organization_id = ${orgId}
      and t.contact_id = ${contactId}
      and t.id <> ${transactionId}
      and t.verified = false
      and t.type is not distinct from ${txnType}
      and t.category_account_id is distinct from ${categoryAccountId}
  `)) as unknown as Array<Record<string, unknown>>;
  const count = Number(cnt?.n ?? 0);
  if (count === 0) return null;

  return { contactId, contactName, categoryAccountId, categoryName, count, transactionType: txnType };
}

export async function promoteRule(
  orgId: string,
  pattern: string,
  categoryAccountId: string,
  transactionType: string | null = null,
): Promise<{ ok: boolean; error?: string }> {
  const p = pattern.trim();
  if (p.length < MIN_PATTERN_LEN) return { ok: false, error: 'Pattern is too short' };
  const type = transactionType === 'deposit' || transactionType === 'withdrawal' ? transactionType : null;

  const [acct] = (await db.execute(
    sql`select 1 from chart_of_accounts where id = ${categoryAccountId} and organization_id = ${orgId} limit 1`,
  )) as unknown as Array<unknown>;
  if (!acct) return { ok: false, error: 'Category not in this organization' };

  // A (pattern, category, direction) triple is unique — a deposit rule and a
  // withdrawal rule for the same merchant can coexist.
  const [dup] = (await db.execute(
    sql`select 1 from categorization_rules where organization_id = ${orgId} and lower(pattern) = lower(${p}) and category_account_id = ${categoryAccountId} and transaction_type is not distinct from ${type} limit 1`,
  )) as unknown as Array<unknown>;
  if (dup) return { ok: true };

  await db.insert(categorizationRules).values({
    id: randomUUID(),
    organizationId: orgId,
    ruleType: 'contains',
    pattern: p,
    categoryAccountId,
    confidence: RULE_CONFIDENCE,
    createdAt: new Date().toISOString(),
    transactionType: type,
  });
  return { ok: true };
}

export async function deleteRule(orgId: string, ruleId: string): Promise<{ ok: boolean }> {
  await db
    .delete(categorizationRules)
    .where(and(eq(categorizationRules.id, ruleId), eq(categorizationRules.organizationId, orgId)));
  return { ok: true };
}
