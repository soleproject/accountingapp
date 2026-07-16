'use server';

import { revalidatePath } from 'next/cache';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { executeTaxIntakeTool } from '@/lib/tax/intake-tools';
import { getInputRef } from '@/lib/tax/input-refs';
import { deleteTaxInput, confirmTaxInput } from '@/lib/tax/store';

export interface RecordFactState {
  error?: string;
  ok?: boolean;
  savedAt?: number;
}

/** Coerce a raw form string to the ref's declared value type before recording. */
function coerce(ref: string, raw: string): string | number | boolean | null {
  const def = getInputRef(ref);
  const v = raw.trim();
  if (!def) return v; // tool will reject unknown refs anyway
  switch (def.valueType) {
    case 'currency':
    case 'number': {
      const n = Number(v.replace(/[$,\s]/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    case 'bool':
      return /^(true|yes|1|y)$/i.test(v);
    default:
      return v;
  }
}

/**
 * Record (or update) a single fact from the workspace fact-entry form, then revalidate so
 * the page re-renders with it. Goes through the same record_tax_facts tool the AI chat
 * uses — same validation, same upsert-on-(return,ref,entity_key) semantics.
 */
export async function recordFactAction(
  _prev: RecordFactState | undefined,
  formData: FormData,
): Promise<RecordFactState> {
  await requireSession();
  const orgId = await getCurrentOrgId();

  const returnId = String(formData.get('return_id') ?? '');
  const ref = String(formData.get('ref') ?? '').trim();
  const rawValue = String(formData.get('value') ?? '');
  const entityKey = (formData.get('entity_key') as string | null)?.trim() || undefined;

  if (!returnId) return { error: 'Missing return id.' };
  if (!ref) return { error: 'Choose a fact to record.' };
  if (rawValue.trim() === '') return { error: 'Enter a value.' };

  const value = coerce(ref, rawValue);
  if (value === null) return { error: 'That value isn’t a valid number.' };

  const result = (await executeTaxIntakeTool({ organizationId: orgId }, 'record_tax_facts', {
    return_id: returnId,
    facts: [{ ref, value, ...(entityKey ? { entity_key: entityKey } : {}) }],
  })) as { ok?: boolean; savedCount?: number; rejected?: Array<{ ref: string; reason: string }>; error?: string };

  if (!result?.ok) return { error: result?.error ?? 'Could not record the fact.' };
  if ((result.savedCount ?? 0) === 0) {
    return { error: result.rejected?.[0]?.reason ?? 'Fact was not saved.' };
  }

  revalidatePath(`/taxes/${returnId}`);
  return { ok: true, savedAt: Date.now() };
}

/** Remove a recorded fact from the workspace. */
export async function deleteFactAction(
  _prev: RecordFactState | undefined,
  formData: FormData,
): Promise<RecordFactState> {
  await requireSession();
  const orgId = await getCurrentOrgId();

  const returnId = String(formData.get('return_id') ?? '');
  const ref = String(formData.get('ref') ?? '').trim();
  const entityKeyRaw = (formData.get('entity_key') as string | null)?.trim();
  const entityKey = entityKeyRaw && entityKeyRaw.length > 0 ? entityKeyRaw : null;
  if (!returnId || !ref) return { error: 'Missing fact reference.' };

  await deleteTaxInput(orgId, returnId, ref, entityKey);
  revalidatePath(`/taxes/${returnId}`);
  return { ok: true, savedAt: Date.now() };
}

/** Mark an extracted (unconfirmed) fact as reviewed-and-correct. */
export async function confirmFactAction(
  _prev: RecordFactState | undefined,
  formData: FormData,
): Promise<RecordFactState> {
  await requireSession();
  const orgId = await getCurrentOrgId();

  const returnId = String(formData.get('return_id') ?? '');
  const ref = String(formData.get('ref') ?? '').trim();
  const entityKeyRaw = (formData.get('entity_key') as string | null)?.trim();
  const entityKey = entityKeyRaw && entityKeyRaw.length > 0 ? entityKeyRaw : null;
  if (!returnId || !ref) return { error: 'Missing fact reference.' };

  await confirmTaxInput(orgId, returnId, ref, entityKey);
  revalidatePath(`/taxes/${returnId}`);
  return { ok: true, savedAt: Date.now() };
}
