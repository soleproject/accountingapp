'use server';

import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getPeriodMetrics, type PeriodMetrics } from '@/lib/dashboard/period-metrics';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function loadCustomPeriodAction(
  from: string,
  to: string,
): Promise<{ ok: true; data: PeriodMetrics } | { ok: false; error: string }> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  if (!ISO.test(from) || !ISO.test(to)) return { ok: false, error: 'Pick valid dates.' };
  if (from > to) return { ok: false, error: 'Start date must be on or before the end date.' };
  try {
    const data = await getPeriodMetrics(orgId, from, to);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not load that range.' };
  }
}
