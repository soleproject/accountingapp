'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth/session';
import { getBudgetSuggestions, type BudgetSuggestion, type Lookback } from '@/lib/personal/budget-suggest';
import { reviewBudgetSuggestions, type BudgetReviewResult } from '@/lib/personal/budget-review';
import { createBudget } from '@/lib/personal/budgets';

export async function fetchSuggestionsAction(lookback: unknown): Promise<BudgetSuggestion[]> {
  const user = await requireSession();
  const lb = z.union([z.literal(3), z.literal(6), z.literal(12)]).parse(lookback) as Lookback;
  return getBudgetSuggestions(user.id, new Date(), lb);
}

export async function reviewSuggestionsAction(lookback: unknown): Promise<BudgetReviewResult> {
  const user = await requireSession();
  const lb = z.union([z.literal(3), z.literal(6), z.literal(12)]).parse(lookback) as Lookback;
  const suggestions = await getBudgetSuggestions(user.id, new Date(), lb);
  return reviewBudgetSuggestions(user.id, suggestions);
}

export async function applySuggestionsAction(input: unknown): Promise<{ ok?: boolean; applied?: number; error?: string }> {
  const user = await requireSession();
  const items = z
    .array(z.object({
      category: z.string().min(1).max(120),
      amount: z.number().nonnegative().finite(),
      ai: z.object({
        verdict: z.string().max(20),
        probability: z.number(),
        note: z.string().max(200),
      }).nullish(),
    }))
    .max(200)
    .parse(input);
  for (const it of items) {
    await createBudget({ userId: user.id, category: it.category, monthlyLimit: it.amount, rollover: false, ai: it.ai ?? null });
  }
  revalidatePath('/personal/budget');
  revalidatePath('/personal');
  return { ok: true, applied: items.length };
}
