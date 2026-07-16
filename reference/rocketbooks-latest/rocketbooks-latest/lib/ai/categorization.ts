import 'server-only';
import { z } from 'zod';
import { eq, and, desc, sql, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts, contacts, transactions, categorizationRules } from '@/db/schema/schema';
import { chatCompletion } from './openai';

const SuggestionSchema = z.object({
  account_number: z.string(),
  contact_name: z.string().nullable(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
});

export interface CategorizationContext {
  organizationId: string;
  description: string;
  amount: number;
  type: string;
  date: string;
  /** If the txn already has a contact, pass it to enable contact-based memory matching across merchant string variants */
  contactId?: string | null;
  /** Plaid Personal Finance Category. Strong hint for the AI when present. */
  plaidPfc?: {
    primary?: string | null;
    detailed?: string | null;
    confidenceLevel?: string | null;
  } | null;
  /** For ai_usage_events attribution. Pass when called from a user-initiated path. */
  actorUserId?: string | null;
  actor?: string;
}

export interface CategorizationResult {
  accountId: string | null;
  accountNumber: string | null;
  accountName: string | null;
  contactId: string | null;
  contactName: string | null;
  confidence: number;
  reason: string;
  source: 'memory' | 'ai' | 'none' | 'rule';
}

/**
 * Deterministic rule lookup — the first step of categorization. A rule
 * (categorization_rules) whose `pattern` is a substring of the description wins
 * outright, skipping vendor memory + the AI call entirely. Rules are promoted by
 * the accountant from consistent history (lib/accounting/rule-promotion.ts).
 */
async function lookupRule(ctx: CategorizationContext): Promise<CategorizationResult | null> {
  const description = (ctx.description ?? '').trim();
  if (!description) return null;

  const rules = await db
    .select({
      pattern: categorizationRules.pattern,
      accountId: categorizationRules.categoryAccountId,
      confidence: categorizationRules.confidence,
      transactionType: categorizationRules.transactionType,
    })
    .from(categorizationRules)
    .where(eq(categorizationRules.organizationId, ctx.organizationId));
  if (rules.length === 0) return null;

  const hay = description.toLowerCase();
  // A rule fires only when its direction matches the transaction (or it's a
  // legacy any-type rule) — a deposit-scoped rule won't touch a withdrawal.
  const match = rules.find(
    (r) =>
      r.pattern &&
      r.pattern.length >= 3 &&
      hay.includes(r.pattern.toLowerCase()) &&
      (r.transactionType == null || r.transactionType === ctx.type),
  );
  if (!match) return null;

  const [account] = await db
    .select({
      id: chartOfAccounts.id,
      accountNumber: chartOfAccounts.accountNumber,
      accountName: chartOfAccounts.accountName,
    })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.id, match.accountId), eq(chartOfAccounts.organizationId, ctx.organizationId)))
    .limit(1);
  if (!account) return null;

  return {
    accountId: account.id,
    accountNumber: account.accountNumber,
    accountName: account.accountName,
    contactId: ctx.contactId ?? null,
    contactName: null,
    confidence: match.confidence ?? 0.99,
    reason: `Matched rule “${match.pattern}” → ${account.accountName}`,
    source: 'rule',
  };
}

const SYSTEM_PROMPT = `You are an expert US-GAAP bookkeeper categorizing bank transactions for a small business.

Output strict JSON: {"account_number": "...", "contact_name": "..." | null, "reason": "...", "confidence": 0.0-1.0}.

Decision rules:
- Pick exactly ONE account_number from the chart-of-accounts list. Match by account_number, not name.
- Deposit (money in) → income, refund of expense, or asset accounts. Common: customer payments → revenue; refunds → reverse the original expense; loan proceeds → liability; interest received → interest income.
- Withdrawal (money out) → expense or asset accounts.
- If no candidate is a clear fit, set account_number to null and confidence below 0.4. Do not invent.

Merchant disambiguation (read the memo carefully):
- "Uber" alone or "Uber [reference] POOL/RIDE" → ride-share → Travel/Transportation expense (NOT Meals).
- "Uber Eats", "DoorDash", "Grubhub", "Postmates" → food delivery → Meals.
- "Lyft", taxi services, public transit → Travel/Transportation.
- Airfare ("United", "Delta", "Southwest", "American Airlines"), hotels, car rental → Travel.
- Restaurants, cafes ("Starbucks", "Peet's"), fast food ("McDonald's", "KFC", "Chipotle") → Meals & Entertainment.
- Gas stations ("Shell", "Chevron", "Exxon", "BP", "76") → Auto/Vehicle expense or Travel.
- Office supply stores ("Staples", "Office Depot"), software/SaaS subs → Office expense or Software.
- Hardware stores, building materials → Supplies.
- Bicycle/sporting goods → Supplies (unusual; pick the closest if no Recreation account exists).
- "INTRST PYMNT", "INTEREST CREDIT" deposits → Interest Income.
- "ACH GUSTO", "GUSTO PAY", payroll provider names → Payroll Expenses (or split: Wages, Taxes, Benefits if available).
- "CREDIT CARD ... PAYMENT" outgoing → Credit Card liability paydown (NOT an expense).
- "AUTOMATIC PAYMENT" outgoing without other context → ambiguous, set confidence < 0.5.
- "CD DEPOSIT", "WIRE TRANSFER IN" without context → ambiguous, set confidence < 0.5.

Confidence calibration:
- 0.95+ : merchant is unambiguous and a perfect-fit account exists (e.g. Starbucks → Meals).
- 0.80-0.94 : likely correct but minor ambiguity (e.g. United Airlines deposit could be refund or income).
- 0.50-0.79 : reasonable guess; reviewer should verify.
- < 0.50 : truly ambiguous; flag for human review.

Contact: if a vendor/customer name is identifiable from the memo, set contact_name (e.g. "Uber", "Starbucks"); else null. Strip reference numbers and noise like "072515 SF**POOL**".`;

/**
 * Look up prior categorizations of the same merchant AND same transaction type.
 *
 * Match rule: contactId match OR description match (so 'Uber 072515' and
 * 'Uber 063015' that both belong to contact 'Uber' unify, while transactions
 * without a contact still match by exact description).
 *
 * Only counts transactions with a posted JE — our own un-confirmed guesses
 * don't bleed back in.
 *
 * Ordered recency-first (then frequency) — if the same merchant has been
 * categorized inconsistently, the user's latest decision wins, even when a
 * pile of older rows used a different (often wrong) category.
 */
async function lookupVendorMemory(
  ctx: CategorizationContext,
): Promise<{ accountId: string; contactId: string | null; matchCount: number; mostRecent: string | null } | null> {
  const description = ctx.description.trim();
  const contactId = ctx.contactId ?? null;
  if (!description && !contactId) return null;

  const matchByDesc = description
    ? sql`(${transactions.bankDescription} = ${description} OR ${transactions.description} = ${description})`
    : null;
  const matchByContact = contactId ? eq(transactions.contactId, contactId) : null;
  const merchantMatch =
    matchByDesc && matchByContact
      ? sql`(${matchByContact} OR ${matchByDesc})`
      : matchByContact ?? matchByDesc;
  if (!merchantMatch) return null;

  const conditions = [
    eq(transactions.organizationId, ctx.organizationId),
    isNotNull(transactions.categoryAccountId),
    isNotNull(transactions.journalEntryId),
    // Only count rows the user (or AI with high confidence) confirmed.
    // Auto-promote-to-Uncategorized rows have reviewed=false; if those bled
    // into vendor memory, every contact would lock onto Uncategorized as
    // "the past answer" and AI would never get to suggest a real category.
    eq(transactions.reviewed, true),
    merchantMatch,
  ];
  if (ctx.type) conditions.push(eq(transactions.type, ctx.type));

  const rows = await db
    .select({
      categoryAccountId: transactions.categoryAccountId,
      contactId: transactions.contactId,
      n: sql<number>`COUNT(*)::int`.as('n'),
      mostRecent: sql<string>`MAX(${transactions.date})`.as('most_recent'),
    })
    .from(transactions)
    .where(and(...conditions))
    .groupBy(transactions.categoryAccountId, transactions.contactId)
    // Recency-first, then frequency as tiebreak. The user's latest decision
    // must win: if a merchant was mis-categorized many times (e.g. 50 rows in
    // Meals) and the user corrects it once, the corrected row is newer and
    // should drive future categorizations. Count-first ordering would let the
    // 50 stale rows outvote the fix forever, so corrections never propagate.
    .orderBy(desc(sql`MAX(${transactions.date})`), desc(sql`COUNT(*)`));

  if (rows.length === 0) return null;
  const top = rows[0];
  if (!top.categoryAccountId) return null;

  return {
    accountId: top.categoryAccountId,
    contactId: top.contactId,
    matchCount: top.n,
    mostRecent: top.mostRecent,
  };
}

/**
 * Confidence tiered by how many times we've seen the same answer.
 * 1 match  → 0.86 (just above default 0.85 auto-post threshold)
 * 2 matches → 0.92
 * 3+       → 0.99
 *
 * Single match is enough to auto-post — same vendor+type, posted once,
 * inherit the answer. If the original was wrong, the user fixes any later
 * occurrence and the new categorization wins because lookupVendorMemory now
 * orders recency-first (MAX(date)), so the correction outranks the stale rows.
 */
function memoryConfidence(matchCount: number): number {
  if (matchCount >= 3) return 0.99;
  if (matchCount === 2) return 0.92;
  return 0.86;
}

export async function categorizeTransaction(ctx: CategorizationContext): Promise<CategorizationResult> {
  // Step 0: deterministic rules — an accountant-promoted rule wins outright and
  // skips both vendor memory and the AI call.
  const rule = await lookupRule(ctx);
  if (rule) return rule;

  // Step 1: vendor memory lookup
  const memory = await lookupVendorMemory(ctx);
  if (memory) {
    const [account] = await db
      .select({
        id: chartOfAccounts.id,
        accountNumber: chartOfAccounts.accountNumber,
        accountName: chartOfAccounts.accountName,
      })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.id, memory.accountId), eq(chartOfAccounts.organizationId, ctx.organizationId)))
      .limit(1);
    if (account) {
      let contactName: string | null = null;
      if (memory.contactId) {
        const [c] = await db
          .select({ name: contacts.contactName })
          .from(contacts)
          .where(eq(contacts.id, memory.contactId))
          .limit(1);
        contactName = c?.name ?? null;
      }
      return {
        accountId: account.id,
        accountNumber: account.accountNumber,
        accountName: account.accountName,
        contactId: memory.contactId,
        contactName,
        confidence: memoryConfidence(memory.matchCount),
        reason: `Matched ${memory.matchCount} prior ${ctx.type} transaction(s) for this merchant; most recent ${memory.mostRecent ?? 'unknown'}`,
        source: 'memory',
      };
    }
  }

  // Step 2: fall back to AI
  const accounts = await db
    .select({
      id: chartOfAccounts.id,
      accountNumber: chartOfAccounts.accountNumber,
      accountName: chartOfAccounts.accountName,
      gaapType: chartOfAccounts.gaapType,
      accountType: chartOfAccounts.accountType,
    })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.organizationId, ctx.organizationId), eq(chartOfAccounts.isActive, true)));

  const existingContacts = await db
    .select({ id: contacts.id, name: contacts.contactName })
    .from(contacts)
    .where(and(eq(contacts.organizationId, ctx.organizationId), eq(contacts.isActive, true)));

  const candidateText = accounts
    .map((a) => `${a.accountNumber} | ${a.accountName} | ${a.gaapType}${a.accountType ? ` / ${a.accountType}` : ''}`)
    .join('\n');

  const pfcLines = ctx.plaidPfc
    ? [
        ctx.plaidPfc.primary ? `- plaid_pfc_primary: ${ctx.plaidPfc.primary}` : null,
        ctx.plaidPfc.detailed ? `- plaid_pfc_detailed: ${ctx.plaidPfc.detailed}` : null,
        ctx.plaidPfc.confidenceLevel ? `- plaid_pfc_confidence: ${ctx.plaidPfc.confidenceLevel}` : null,
      ].filter(Boolean)
    : [];

  const userPrompt = `Transaction:
- date: ${ctx.date}
- type: ${ctx.type}
- amount: ${ctx.amount}
- description: ${ctx.description || '(no memo)'}
${pfcLines.length > 0 ? pfcLines.join('\n') + '\n\nPlaid PFC is a strong hint about the merchant category. Use it to disambiguate (e.g. TRANSPORTATION_TAXIS_AND_RIDE_SHARES → Travel, not Meals). When confidence is VERY_HIGH or HIGH, weight it heavily.\n' : ''}
Chart of accounts (account_number | name | gaap_type / detail_type):
${candidateText}

Respond with JSON: {"account_number": "...", "contact_name": "..." | null, "reason": "...", "confidence": 0.0-1.0}`;

  const model = process.env.AI_CATEGORIZE_MODEL ?? 'gpt-4o';
  const completion = await chatCompletion(
    {
      userId: ctx.actorUserId ?? null,
      orgId: ctx.organizationId,
      actor: ctx.actor ?? 'system',
      feature: 'ai-categorize',
    },
    {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
    },
  );

  const text = completion.choices[0]?.message?.content ?? '{}';
  let parsed: z.infer<typeof SuggestionSchema>;
  try {
    parsed = SuggestionSchema.parse(JSON.parse(text));
  } catch {
    return {
      accountId: null,
      accountNumber: null,
      accountName: null,
      contactId: null,
      contactName: null,
      confidence: 0,
      reason: 'AI returned malformed response',
      source: 'none',
    };
  }

  const matchedAccount = accounts.find((a) => a.accountNumber === parsed.account_number) ?? null;

  let contactId: string | null = null;
  let contactName: string | null = null;
  if (parsed.contact_name) {
    contactName = parsed.contact_name;
    const fuzzy = existingContacts.find((c) => c.name.toLowerCase() === parsed.contact_name!.toLowerCase());
    if (fuzzy) contactId = fuzzy.id;
  }

  return {
    accountId: matchedAccount?.id ?? null,
    accountNumber: matchedAccount?.accountNumber ?? null,
    accountName: matchedAccount?.accountName ?? null,
    contactId,
    contactName,
    confidence: parsed.confidence,
    reason: parsed.reason,
    source: 'ai',
  };
}
