'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { notes } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';

const Schema = z.object({
  body: z.string().trim().min(1).max(5000),
  contactId: z.string().min(1).max(64).optional().nullable(),
});

const UpdateSchema = z.object({
  id: z.string().min(1).max(64),
  body: z.string().trim().min(1).max(5000),
  contactId: z.string().min(1).max(64).optional().nullable(),
});

export interface CreateNoteState {
  error?: string;
  ok?: boolean;
}

export type UpdateNoteState = CreateNoteState;
export type DeleteNoteState = CreateNoteState;

export async function createNote(
  _prev: CreateNoteState | undefined,
  formData: FormData,
): Promise<CreateNoteState | undefined> {
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();

  const rawContact = formData.get('contactId');
  const parsed = Schema.safeParse({
    body: formData.get('body'),
    contactId: typeof rawContact === 'string' && rawContact.length > 0 ? rawContact : null,
  });
  if (!parsed.success) return { error: 'Note body is required (max 5000 chars).' };

  await db.insert(notes).values({
    id: randomUUID(),
    userId,
    organizationId: orgId,
    contactId: parsed.data.contactId ?? null,
    body: parsed.data.body,
    source: 'manual',
  });

  revalidatePath('/organizer/dashboard');
  return { ok: true };
}

/**
 * Edit body + linked contact on an existing note. Ownership-scoped to
 * the current user + org so a forged form id can't reach another
 * tenant's data. Used by the inline pencil editor on Recent Notes.
 */
export async function updateNoteAction(
  _prev: UpdateNoteState | undefined,
  formData: FormData,
): Promise<UpdateNoteState | undefined> {
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();

  const rawContact = formData.get('contactId');
  const parsed = UpdateSchema.safeParse({
    id: formData.get('id'),
    body: formData.get('body'),
    contactId: typeof rawContact === 'string' && rawContact.length > 0 ? rawContact : null,
  });
  if (!parsed.success) return { error: 'Note body is required (max 5000 chars).' };

  const updated = await db
    .update(notes)
    .set({
      body: parsed.data.body,
      contactId: parsed.data.contactId ?? null,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(eq(notes.id, parsed.data.id), eq(notes.userId, userId), eq(notes.organizationId, orgId)),
    )
    .returning({ id: notes.id });

  if (updated.length === 0) return { error: 'Note not found.' };

  revalidatePath('/organizer/dashboard');
  revalidatePath('/organizer/contacts/[id]', 'page');
  return { ok: true };
}

/**
 * Delete a note by id. Same ownership discipline as updateNoteAction.
 */
export async function deleteNoteAction(
  _prev: DeleteNoteState | undefined,
  formData: FormData,
): Promise<DeleteNoteState | undefined> {
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();

  const id = String(formData.get('id') ?? '').trim();
  if (!id) return { error: 'id required' };

  const deleted = await db
    .delete(notes)
    .where(and(eq(notes.id, id), eq(notes.userId, userId), eq(notes.organizationId, orgId)))
    .returning({ id: notes.id });
  if (deleted.length === 0) return { error: 'Note not found.' };

  revalidatePath('/organizer/dashboard');
  revalidatePath('/organizer/contacts/[id]', 'page');
  return { ok: true };
}
