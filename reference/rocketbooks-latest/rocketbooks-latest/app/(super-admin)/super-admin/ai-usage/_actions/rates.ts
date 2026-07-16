'use server';

import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { usageRates } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { isSuperAdmin } from '@/lib/auth/org';
import { DEFAULT_RATES, type RateKey } from '@/lib/usage/rates';

/**
 * Upsert one per-unit rate. Superadmin-only. Used directly as a <form action>,
 * so it returns void. When the row doesn't exist yet we seed
 * provider/label/unit from the compiled default for the key (those columns are
 * NOT NULL); an unknown key with no default just gets 'unknown'/'unit'.
 * Invalid input is ignored (the input is a constrained number field) so a bad
 * value never throws an error page at the operator.
 */
export async function updateRateAction(formData: FormData): Promise<void> {
  const user = await requireSession();
  if (!(await isSuperAdmin())) return;

  const key = String(formData.get('key') ?? '').trim();
  const raw = String(formData.get('rateUsd') ?? '').trim();
  if (!key) return;

  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate < 0) return;

  const def = DEFAULT_RATES[key as RateKey];
  const updatedBy = user.email ?? user.id ?? null;

  try {
    await db
      .insert(usageRates)
      .values({
        key,
        provider: def?.provider ?? 'unknown',
        label: def?.label ?? key,
        unit: def?.unit ?? 'unit',
        rateUsd: rate.toFixed(8),
        notes: def?.notes ?? null,
        updatedBy,
      })
      .onConflictDoUpdate({
        target: usageRates.key,
        set: { rateUsd: rate.toFixed(8), updatedBy, updatedAt: new Date().toISOString() },
      });
  } catch (err) {
    console.error('[usage-rates] update failed', err);
    return;
  }

  revalidatePath('/super-admin/ai-usage');
}
