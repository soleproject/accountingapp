'use server';

import { and, eq, ne } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { DEMO_ENTERPRISE_ID } from '@/lib/enterprise/demo';
import { validateSubdomain } from '@/lib/enterprise/subdomain';

export type SubdomainState = { ok?: boolean; error?: string; value?: string | null };

/**
 * Set/clear the enterprise's white-label sign-in subdomain. Owner-only (staff
 * can't), demo excluded, private-label required. Validates + enforces global
 * uniqueness. useActionState-shaped.
 */
export async function saveSubdomainAction(_prev: SubdomainState | undefined, formData: FormData): Promise<SubdomainState> {
  const current = await getCurrentEnterprise();
  if (!current || current.id === DEMO_ENTERPRISE_ID) return { ok: false, error: 'Not available here.' };
  if (current.role === 'staff') return { ok: false, error: 'Only the enterprise owner can change the sign-in address.' };

  const [org] = await db
    .select({ privateLabelEnabled: organizations.privateLabelEnabled })
    .from(organizations)
    .where(eq(organizations.id, current.id))
    .limit(1);
  if (!org?.privateLabelEnabled) return { ok: false, error: 'Private label is not enabled for this firm.' };

  const raw = String(formData.get('subdomain') ?? '').trim();
  if (!raw) {
    await db.update(organizations).set({ subdomain: null }).where(eq(organizations.id, current.id));
    revalidatePath('/enterprise/settings');
    return { ok: true, value: null };
  }

  const check = validateSubdomain(raw);
  if (!check.ok) return { ok: false, error: check.error };

  const [clash] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.subdomain, check.value), ne(organizations.id, current.id)))
    .limit(1);
  if (clash) return { ok: false, error: `"${check.value}" is taken — try another.` };

  await db.update(organizations).set({ subdomain: check.value }).where(eq(organizations.id, current.id));
  revalidatePath('/enterprise/settings');
  return { ok: true, value: check.value };
}
