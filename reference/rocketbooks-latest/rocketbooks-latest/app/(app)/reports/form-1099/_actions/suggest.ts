'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { hasAnyPermission } from '@/lib/auth/permissions';
import { suggestEligibility } from '@/lib/accounting/form-1099-eligibility';

const ACCOUNTANT = ['accounting.transactions.accountant_review', 'enterprise.dashboard.view', 'enterprise.clients.view'];

async function gate(): Promise<string | null> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  if (!(await hasAnyPermission(ACCOUNTANT))) return null;
  return orgId;
}

/** Run the AI eligibility suggester over the selected year's $600+ vendors. */
export async function runSuggestions(formData: FormData): Promise<void> {
  const orgId = await gate();
  if (!orgId) return;
  const y = Number(formData.get('year'));
  const year = Number.isInteger(y) ? y : new Date().getFullYear();
  await suggestEligibility(orgId, year);
  revalidatePath('/reports/form-1099');
}

/** Accept the AI suggestion: confirm the vendor as 1099-eligible. */
export async function acceptSuggestion(formData: FormData): Promise<void> {
  const orgId = await gate();
  if (!orgId) return;
  const contactId = String(formData.get('contactId') ?? '').trim();
  if (!contactId) return;
  await db
    .update(contacts)
    .set({ is1099Eligible: true, ai1099Suggestion: null, updatedAt: new Date().toISOString() })
    .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, orgId)));
  revalidatePath('/reports/form-1099');
}

/** Dismiss the AI suggestion without flagging the vendor. */
export async function dismissSuggestion(formData: FormData): Promise<void> {
  const orgId = await gate();
  if (!orgId) return;
  const contactId = String(formData.get('contactId') ?? '').trim();
  if (!contactId) return;
  await db
    .update(contacts)
    .set({ ai1099Suggestion: false, updatedAt: new Date().toISOString() })
    .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, orgId)));
  revalidatePath('/reports/form-1099');
}
