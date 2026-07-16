'use server';

import { redirect } from 'next/navigation';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { executeTaxIntakeTool } from '@/lib/tax/intake-tools';

export interface CreateReturnState {
  error?: string;
}

/**
 * Start a new tax return from the page's quick-create form, then redirect into its
 * workspace. Reuses the same classify_tax_return tool the AI chat uses, so the page and
 * the assistant stay in lockstep on how a return is created.
 */
export async function createReturnAction(
  _prev: CreateReturnState | undefined,
  formData: FormData,
): Promise<CreateReturnState | undefined> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const userId = await getEffectiveUserId();

  const returnType = String(formData.get('return_type') ?? '');
  const taxYear = Number(formData.get('tax_year'));
  const entityType = (formData.get('entity_type') as string | null)?.trim() || undefined;
  const stateCode = (formData.get('state') as string | null)?.trim().toUpperCase() || '';

  if (returnType !== 'personal' && returnType !== 'business') return { error: 'Choose personal or business.' };
  if (!Number.isInteger(taxYear)) return { error: 'Enter a valid tax year.' };
  if (returnType === 'business' && !entityType) return { error: 'Choose an entity type for a business return.' };

  const jurisdictions = stateCode && /^[A-Z]{2}$/.test(stateCode) ? ['US', stateCode] : ['US'];

  const result = (await executeTaxIntakeTool(
    { organizationId: orgId, userId },
    'classify_tax_return',
    { return_type: returnType, tax_year: taxYear, entity_type: entityType, jurisdictions },
  )) as { ok?: boolean; returnId?: string; error?: string };

  if (!result?.ok || !result.returnId) return { error: result?.error ?? 'Could not create the return.' };
  redirect(`/taxes/${result.returnId}`);
}
