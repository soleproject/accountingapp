import 'server-only';
import { and, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions, chartOfAccounts, contacts, organizations } from '@/db/schema/schema';
import { chatCompletion } from '@/lib/ai/openai';
import { FORM_1099_THRESHOLD } from '@/lib/reports/form-1099-data';

/**
 * AI-suggest 1099-NEC eligibility for an org's vendors. Deterministic part: only
 * consider vendors paid >= $600 in expenses for the year that aren't already
 * confirmed eligible. Fuzzy part (the LLM): from the vendor name + the expense
 * categories they're booked to, judge whether they look like an individual /
 * sole-prop / LLC providing services (→ likely 1099) vs. a corporation or a
 * goods/retail/utility/SaaS vendor (→ exempt). Stores a SUGGESTION only — the
 * accountant confirms via Accept (which flips is_1099_eligible).
 */

const EXPENSE_GAAP_TYPES = ['expense', 'cost_of_goods_sold', 'cogs'];
const BATCH = 40;

interface Candidate {
  contactId: string;
  name: string;
  paid: number;
  categories: string[];
}

export interface SuggestResult {
  ok: boolean;
  evaluated: number;
  suggestedEligible: number;
  error?: string;
}

export async function suggestEligibility(orgId: string, year: number): Promise<SuggestResult> {
  const fromDate = `${year}-01-01`;
  const toDate = `${year}-12-31`;

  const rows = await db
    .select({
      contactId: transactions.contactId,
      paid: sql<string>`COALESCE(SUM(ABS(${transactions.amount})), 0)`.as('paid'),
      categories: sql<string[]>`ARRAY_AGG(DISTINCT ${chartOfAccounts.accountName})`.as('cats'),
    })
    .from(transactions)
    .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, transactions.categoryAccountId))
    .where(
      and(
        eq(transactions.organizationId, orgId),
        isNotNull(transactions.contactId),
        inArray(chartOfAccounts.gaapType, EXPENSE_GAAP_TYPES),
        gte(transactions.date, fromDate),
        sql`${transactions.date} <= ${toDate}`,
      ),
    )
    .groupBy(transactions.contactId)
    .having(sql`SUM(ABS(${transactions.amount})) >= ${FORM_1099_THRESHOLD}`);

  if (rows.length === 0) return { ok: true, evaluated: 0, suggestedEligible: 0 };

  // Drop vendors already confirmed eligible — no need to suggest.
  const ids = rows.map((r) => r.contactId).filter((x): x is string => !!x);
  const meta = await db
    .select({ id: contacts.id, name: contacts.contactName, eligible: contacts.is1099Eligible })
    .from(contacts)
    .where(and(eq(contacts.organizationId, orgId), inArray(contacts.id, ids)));
  const metaById = new Map(meta.map((m) => [m.id, m]));

  const candidates: Candidate[] = rows
    .filter((r) => r.contactId && metaById.get(r.contactId) && !metaById.get(r.contactId)!.eligible)
    .map((r) => ({
      contactId: r.contactId!,
      name: metaById.get(r.contactId!)!.name,
      paid: Number(r.paid),
      categories: (r.categories ?? []).filter(Boolean).slice(0, 6),
    }));

  if (candidates.length === 0) return { ok: true, evaluated: 0, suggestedEligible: 0 };

  const [org] = await db.select({ ownerUserId: organizations.ownerUserId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);

  const system =
    `You classify whether a US vendor likely requires a Form 1099-NEC. A 1099-NEC is generally required when the payee is an individual, sole proprietor, partnership, or LLC paid $600+ for SERVICES. Corporations (Inc/Corp) are generally EXEMPT (exception: attorneys/law firms are reportable). Large retailers, marketplaces, utilities, telecom, banks, insurance, software/SaaS, and goods-only vendors are NOT 1099-NEC. ` +
    `Use the vendor name and the expense categories as signals. A personal name or a small trade (consulting, subcontractor, cleaning, design, repair, legal) → eligible true. A recognizable company/retailer/utility/SaaS → eligible false. When genuinely unsure, set eligible true and say why. ` +
    `Return strict JSON: {"items":[{"i":<number>,"eligible":<boolean>,"reason":"<short, <=12 words>"}]} with one entry per input index.`;

  let evaluated = 0;
  let suggestedEligible = 0;
  const now = new Date().toISOString();

  for (let start = 0; start < candidates.length; start += BATCH) {
    const chunk = candidates.slice(start, start + BATCH);
    const list = chunk
      .map((c, i) => `${i}. name="${c.name}" categories="${c.categories.join(', ') || 'n/a'}" paid=$${Math.round(c.paid)}`)
      .join('\n');

    let items: { i?: number; eligible?: boolean; reason?: string }[] = [];
    try {
      const resp = await chatCompletion(
        { userId: org?.ownerUserId ?? null, orgId, actor: 'system', feature: 'form_1099_eligibility' },
        { model: process.env.AI_CATEGORIZE_MODEL ?? 'gpt-4o', messages: [{ role: 'system', content: system }, { role: 'user', content: `Vendors:\n${list}\n\nReturn JSON.` }], response_format: { type: 'json_object' }, temperature: 0 },
      );
      items = (JSON.parse(resp.choices[0]?.message?.content ?? '{}') as { items?: typeof items }).items ?? [];
    } catch (e) {
      console.error('form-1099-eligibility: AI call failed', e);
      continue;
    }

    for (const it of items) {
      if (typeof it.i !== 'number' || it.i < 0 || it.i >= chunk.length) continue;
      const cand = chunk[it.i];
      const eligible = !!it.eligible;
      try {
        await db
          .update(contacts)
          .set({ ai1099Suggestion: eligible, ai1099Reason: (it.reason ?? '').slice(0, 200), ai1099SuggestedAt: now, updatedAt: now })
          .where(and(eq(contacts.id, cand.contactId), eq(contacts.organizationId, orgId)));
        evaluated++;
        if (eligible) suggestedEligible++;
      } catch (e) {
        console.error('form-1099-eligibility: update failed', cand.contactId, e);
      }
    }
  }

  return { ok: true, evaluated, suggestedEligible };
}
