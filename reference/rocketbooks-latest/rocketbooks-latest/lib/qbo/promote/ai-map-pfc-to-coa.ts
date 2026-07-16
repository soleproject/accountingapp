import 'server-only';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { chartOfAccounts } from '@/db/schema/schema';
import { PFC_COA_MAPPINGS } from '@/lib/accounting/pfc-coa-mapping';
import { chatCompletion } from '@/lib/ai/openai';
import { logger } from '@/lib/logger';

/**
 * Per-PFC assignment returned by the LLM. coaId === null means the model
 * found no reasonable QB account for this PFC, in which case the caller
 * should un-hide the seed row for the PFC's canonical slot and point the
 * override at it. confidence is the model's own 0-1 self-rated score.
 */
export interface AiMappedPfc {
  pfcDetailed: string;
  coaId: string | null;
  confidence: number;
  reasoning: string;
  aiModel: string;
}

const SYSTEM_PROMPT = `You are an accountant mapping Plaid Personal Finance Category (PFC) codes to a user's chart of accounts. For each PFC code, pick the SINGLE BEST matching chart-of-account row by account_number. NEVER return null — every PFC must land on a real row.

Rules:
- Match by semantic meaning, not exact word match.
- An EXPENSE PFC must map to a gaap_type=expense row (Cost of Goods Sold, Expenses, Other Expense).
- An INCOME PFC must map to a gaap_type=income row.
- A LOAN_DISBURSEMENTS PFC must map to a liability row (notes_payable, loan, credit_card).
- A LOAN_PAYMENTS PFC must map to the SAME liability row as the corresponding disbursement when possible.
- A TRANSFER PFC must map to a bank/asset account; prefer the user's primary checking when ambiguous.
- A PFC the user previously tagged as personal (look at classification='personal' in the input) must map to an equity row like personal_expense or personal_income.
- When multiple rows could fit, prefer the MORE SPECIFIC one (e.g. "Bookkeeper" over generic "Legal & Professional Fees" for accounting/bookkeeping PFCs).
- Fallback when no specific account is a great fit: pick the chart's "Uncategorized Expense", "Uncategorized Income", or "Uncategorized Asset" row depending on side. Many QuickBooks charts have these by default. If even those are missing, pick the broadest residual account on the correct side (e.g. "Other Miscellaneous Expense").
- confidence: 0.9+ for obvious matches, 0.6-0.8 for reasonable matches, 0.3-0.5 when you're forced to use an Uncategorized fallback. Always emit a number.
- reasoning: at most 100 characters. When using a fallback, say so ("no specific match; fell back to Uncategorized Expense").`;

const ResponseSchema = z.object({
  mappings: z.array(
    z.object({
      pfc_detailed: z.string(),
      account_number: z.string().nullable(),
      confidence: z.number().min(0).max(1),
      reasoning: z.string(),
    }),
  ),
});

export async function aiMapPfcToCoa(args: {
  organizationId: string;
  userId?: string | null;
}): Promise<AiMappedPfc[]> {
  const coa = await db
    .select({
      id: chartOfAccounts.id,
      accountNumber: chartOfAccounts.accountNumber,
      accountName: chartOfAccounts.accountName,
      gaapType: chartOfAccounts.gaapType,
      accountType: chartOfAccounts.accountType,
      detailType: chartOfAccounts.detailType,
    })
    .from(chartOfAccounts)
    .where(and(
      eq(chartOfAccounts.organizationId, args.organizationId),
      eq(chartOfAccounts.isActive, true),
    ));

  if (coa.length === 0) {
    logger.warn({ organizationId: args.organizationId }, 'ai map pfc: no active CoA rows; skipping');
    return [];
  }

  // De-dupe account_number — UNIQUE was dropped on (org, gaap, detail) but
  // we still expect accountNumber to be unique per org in practice. If we
  // see a duplicate, log and keep the first (model will return the number
  // but we can't tell which row it meant).
  const byNumber = new Map<string, typeof coa[number]>();
  for (const c of coa) {
    if (byNumber.has(c.accountNumber)) {
      logger.warn(
        { organizationId: args.organizationId, accountNumber: c.accountNumber },
        'ai map pfc: duplicate accountNumber within org — model may pick ambiguously',
      );
      continue;
    }
    byNumber.set(c.accountNumber, c);
  }

  const coaLines = Array.from(byNumber.values())
    .map((c) => `${c.accountNumber} | ${c.accountName} | ${c.gaapType}/${c.detailType ?? '-'}`)
    .join('\n');

  const pfcLines = PFC_COA_MAPPINGS
    .map((m) => `${m.pfcDetailed} | ${m.classification} | ${m.descriptionV2}`)
    .join('\n');

  const userPrompt = `Chart of accounts (account_number | name | gaap_type/detail_type):
${coaLines}

PFC codes to map (pfc_detailed | classification | description):
${pfcLines}

Respond with JSON: { "mappings": [ { "pfc_detailed": "...", "account_number": "..." | null, "confidence": 0.0-1.0, "reasoning": "max 100 chars" }, ... ] }

Include every PFC code from the input. ${PFC_COA_MAPPINGS.length} PFCs total.`;

  const model = process.env.AI_PFC_MAPPING_MODEL ?? 'gpt-4o';
  const completion = await chatCompletion(
    {
      userId: args.userId ?? null,
      orgId: args.organizationId,
      actor: 'system',
      feature: 'ai-pfc-mapping',
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

  const text = completion.choices[0]?.message?.content ?? '{"mappings":[]}';
  let parsed: z.infer<typeof ResponseSchema>;
  try {
    parsed = ResponseSchema.parse(JSON.parse(text));
  } catch (err) {
    logger.warn(
      { organizationId: args.organizationId, err: err instanceof Error ? err.message : String(err) },
      'ai map pfc: model returned malformed JSON',
    );
    return [];
  }

  const seenPfcs = new Set(parsed.mappings.map((m) => m.pfc_detailed));
  const missing = PFC_COA_MAPPINGS.filter((m) => !seenPfcs.has(m.pfcDetailed));
  if (missing.length > 0) {
    logger.warn(
      { organizationId: args.organizationId, missing: missing.length },
      'ai map pfc: model omitted some PFCs — they will fall through to seed fallback',
    );
  }

  const out: AiMappedPfc[] = [];
  for (const m of parsed.mappings) {
    if (m.account_number === null) {
      out.push({
        pfcDetailed: m.pfc_detailed,
        coaId: null,
        confidence: m.confidence,
        reasoning: m.reasoning,
        aiModel: completion.model,
      });
      continue;
    }
    const row = byNumber.get(m.account_number);
    if (!row) {
      logger.warn(
        { organizationId: args.organizationId, pfc: m.pfc_detailed, accountNumber: m.account_number },
        'ai map pfc: model referenced unknown accountNumber — treating as no-match',
      );
      out.push({
        pfcDetailed: m.pfc_detailed,
        coaId: null,
        confidence: 0,
        reasoning: `model returned unknown accountNumber "${m.account_number}"`,
        aiModel: completion.model,
      });
      continue;
    }
    out.push({
      pfcDetailed: m.pfc_detailed,
      coaId: row.id,
      confidence: m.confidence,
      reasoning: m.reasoning,
      aiModel: completion.model,
    });
  }

  return out;
}
