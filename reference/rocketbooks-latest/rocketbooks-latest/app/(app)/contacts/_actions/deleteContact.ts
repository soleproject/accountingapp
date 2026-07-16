'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { eq, and, count, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, transactions, journalEntryLines, generalLedger } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';

const SoftSchema = z.object({ id: z.string().min(1) });
const BulkSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });

export interface DeleteContactState {
  ok?: boolean;
  error?: string;
  /** When refused, how many transactions still reference this contact. */
  txnRefs?: number;
  /** For bulk: how many contacts were archived. */
  archived?: number;
}

/**
 * Soft-delete a contact: flips is_active=false. The row stays in the table
 * so transactions / journal entries / GL rows that reference it keep their
 * historical contact attribution intact. The contact stops appearing in
 * pickers and dropdowns; un-archive by editing it back to active.
 *
 * For destructive removal use mergeContacts (combines into a target) — there
 * is no hard-delete action because the FK web (transactions, JE lines, GL
 * rows, AI recommendations, contact profiles) makes a clean DELETE
 * impractical for any contact that's been used.
 */
export async function softDeleteContact(
  _prev: DeleteContactState | undefined,
  formData: FormData,
): Promise<DeleteContactState> {
  const orgId = await getCurrentOrgId();
  const parsed = SoftSchema.safeParse({ id: formData.get('id') });
  if (!parsed.success) return { error: 'Invalid input' };

  // Quick reference count for the operator's awareness — not a hard block,
  // but useful when surfaced in the UI ("This contact has 17 transactions —
  // archive instead of merge?").
  const [refs] = await db
    .select({ n: count() })
    .from(transactions)
    .where(and(eq(transactions.organizationId, orgId), eq(transactions.contactId, parsed.data.id)));

  const result = await db
    .update(contacts)
    .set({ isActive: false, updatedAt: new Date().toISOString() })
    .where(and(eq(contacts.id, parsed.data.id), eq(contacts.organizationId, orgId)))
    .returning({ id: contacts.id });

  if (result.length === 0) return { error: 'Contact not found in this organization' };

  // Reference references for downstream linters; we don't need them here.
  void journalEntryLines;
  void generalLedger;

  revalidatePath('/contacts');
  return { ok: true, txnRefs: refs?.n ?? 0 };
}

/**
 * Bulk soft-delete (archive). Same semantics as softDeleteContact but for
 * many contacts at once. Used by the MergeBar's Archive button. Like the
 * single-row variant, transactions/JEs/GL keep their references; the
 * contacts just stop appearing in pickers.
 */
export async function bulkArchiveContacts(
  _prev: DeleteContactState | undefined,
  formData: FormData,
): Promise<DeleteContactState> {
  const orgId = await getCurrentOrgId();
  const parsed = BulkSchema.safeParse({
    ids: formData.getAll('sourceIds').map(String).filter(Boolean),
  });
  if (!parsed.success) return { error: 'Pick at least one contact to archive.' };

  const result = await db
    .update(contacts)
    .set({ isActive: false, updatedAt: new Date().toISOString() })
    .where(and(eq(contacts.organizationId, orgId), inArray(contacts.id, parsed.data.ids)))
    .returning({ id: contacts.id });

  revalidatePath('/contacts');
  return { ok: true, archived: result.length };
}

export interface RestoreContactState {
  ok?: boolean;
  error?: string;
  /** For bulk: how many contacts were restored. */
  restored?: number;
}

/**
 * Single-row restore: flip is_active back to true on a previously-archived
 * contact. Mirror of softDeleteContact for the archived view.
 */
export async function restoreContact(
  _prev: RestoreContactState | undefined,
  formData: FormData,
): Promise<RestoreContactState> {
  const orgId = await getCurrentOrgId();
  const parsed = SoftSchema.safeParse({ id: formData.get('id') });
  if (!parsed.success) return { error: 'Invalid input' };

  const result = await db
    .update(contacts)
    .set({ isActive: true, updatedAt: new Date().toISOString() })
    .where(and(eq(contacts.id, parsed.data.id), eq(contacts.organizationId, orgId)))
    .returning({ id: contacts.id });

  if (result.length === 0) return { error: 'Contact not found in this organization' };

  revalidatePath('/contacts');
  return { ok: true };
}

/**
 * Bulk restore. Flip is_active=true on many archived contacts at once.
 * Used by the MergeBar's Restore button when viewing the archived list.
 */
export async function bulkRestoreContacts(
  _prev: RestoreContactState | undefined,
  formData: FormData,
): Promise<RestoreContactState> {
  const orgId = await getCurrentOrgId();
  const parsed = BulkSchema.safeParse({
    ids: formData.getAll('sourceIds').map(String).filter(Boolean),
  });
  if (!parsed.success) return { error: 'Pick at least one contact to restore.' };

  const result = await db
    .update(contacts)
    .set({ isActive: true, updatedAt: new Date().toISOString() })
    .where(and(eq(contacts.organizationId, orgId), inArray(contacts.id, parsed.data.ids)))
    .returning({ id: contacts.id });

  revalidatePath('/contacts');
  return { ok: true, restored: result.length };
}
