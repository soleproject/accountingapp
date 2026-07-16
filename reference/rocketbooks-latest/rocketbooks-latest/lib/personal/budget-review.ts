import 'server-only';
import { chatCompletion } from '@/lib/ai/openai';
import { logger } from '@/lib/logger';
import type { BudgetSuggestion } from './budget-suggest';

export interface BudgetReview {
  category: string;
  verdict: 'ok' | 'high' | 'low' | 'uncertain';
  /** AI-recommended budget if it differs from the system suggestion; else null. */
  adjustedAmount: number | null;
  /** 0-100: how likely the budget covers a typical month. */
  probability: number;
  note: string;
}

export interface BudgetReviewResult {
  summary: string;
  reviews: BudgetReview[];
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    reviews: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          category: { type: 'string' },
          verdict: { type: 'string', enum: ['ok', 'high', 'low', 'uncertain'] },
          adjustedAmount: { type: ['number', 'null'] },
          probability: { type: 'number' },
          note: { type: 'string' },
        },
        required: ['category', 'verdict', 'adjustedAmount', 'probability', 'note'],
      },
    },
  },
  required: ['summary', 'reviews'],
} as const;

function buildPrompt(items: BudgetSuggestion[]): string {
  const lines = items.map((s) => {
    const hist = s.history.map((h) => Math.round(h)).join(',');
    return `- ${s.category} (${s.group}): suggested $${s.suggested} [recurring $${Math.round(s.recurring)} + variable $${Math.round(s.variable)}], confidence=${s.confidence}, oneOffFlag=${s.oneOff}, monthsOfData=${s.monthsOfData}, last12moTotals=[${hist}]`;
  });
  return `You are reviewing an automatically-computed PERSONAL monthly budget. Each line is one spending category with a system-suggested monthly amount, its recurring vs variable split, a confidence level, a one-off flag, and the last up-to-12 months of TOTAL spend in that category.

Your job is a plausibility check, NOT to recompute from scratch:
- If the history is steady and the suggestion fits, verdict "ok" and adjustedAmount null.
- If a one-time spike (e.g. a surgery, a furniture purchase, a tax bill) inflates the average, verdict "high" and propose a lower adjustedAmount that reflects a TYPICAL month (look at the median of non-spike months).
- If spending is clearly trending up and the suggestion looks short, verdict "low" with a higher adjustedAmount.
- If the data is too sparse/erratic to trust, verdict "uncertain".
- probability: 0-100, your estimate that the (adjusted, else suggested) amount actually covers a typical upcoming month.
- note: ONE short sentence (max ~120 chars), plain English, explaining your reasoning. No fluff.

Only set adjustedAmount when you genuinely disagree with the suggestion; otherwise null. Base everything on the numbers given — do not invent transactions.

Categories:
${lines.join('\n')}

Return JSON with { summary, reviews: [{ category, verdict, adjustedAmount, probability, note }] }. Include EVERY category exactly once, using its exact name. summary = one or two sentences on the overall budget's realism.`;
}

/**
 * Optional AI review layer over the deterministic budget suggestions. The
 * system produces the numbers; this asks an LLM to sanity-check them, flag
 * one-offs, and estimate how likely each budget holds. Advisory only — the
 * user decides whether to accept any adjustment.
 */
export async function reviewBudgetSuggestions(userId: string, items: BudgetSuggestion[]): Promise<BudgetReviewResult> {
  // Bound cost/latency: review the most material categories.
  const subset = [...items].sort((a, b) => b.suggested - a.suggested).slice(0, 40);

  const response = await chatCompletion(
    { userId, orgId: null, actor: 'user', feature: 'personal-budget-review' },
    {
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [{ role: 'user', content: buildPrompt(subset) }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'BudgetReview', strict: true, schema: SCHEMA },
      },
    },
  );

  const raw = response.choices[0]?.message?.content ?? '';
  let parsed: BudgetReviewResult;
  try {
    parsed = JSON.parse(raw) as BudgetReviewResult;
  } catch {
    logger.warn({ raw: raw.slice(0, 500) }, 'budget review: non-JSON');
    return { summary: 'Could not complete the AI review — try again.', reviews: [] };
  }

  // Clamp/sanitize.
  const valid = new Set(items.map((i) => i.category));
  const reviews = (parsed.reviews ?? [])
    .filter((r) => valid.has(r.category))
    .map((r) => ({
      category: r.category,
      verdict: (['ok', 'high', 'low', 'uncertain'] as const).includes(r.verdict) ? r.verdict : 'uncertain',
      adjustedAmount: typeof r.adjustedAmount === 'number' && r.adjustedAmount >= 0 ? Math.round(r.adjustedAmount) : null,
      probability: Math.max(0, Math.min(100, Math.round(Number(r.probability) || 0))),
      note: String(r.note ?? '').slice(0, 200),
    }));
  return { summary: String(parsed.summary ?? '').slice(0, 400), reviews };
}
