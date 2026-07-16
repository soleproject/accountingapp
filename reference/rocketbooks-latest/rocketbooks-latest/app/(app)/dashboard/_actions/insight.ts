'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { generateDashboardInsight } from '@/lib/server/dashboard-insight';

export async function generateInsightAction(posture?: string): Promise<{ ok: boolean; summary?: string; at?: string; error?: string }> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  try {
    const r = await generateDashboardInsight(orgId, posture);
    revalidatePath('/dashboard');
    return { ok: true, summary: r.summary, at: r.at };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed to generate' };
  }
}
