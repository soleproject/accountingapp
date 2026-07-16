'use server';

import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { answerFinanceQuestion, type FinanceAnswer } from '@/lib/server/finance-query';

export async function askFinanceAction(question: string): Promise<{ ok: boolean; answer?: FinanceAnswer; error?: string }> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  if (!question || !question.trim()) return { ok: false, error: 'Ask a question.' };
  return answerFinanceQuestion(orgId, question.trim());
}
