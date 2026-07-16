'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';

export interface LetterheadState {
  ok?: boolean;
  error?: string;
}

const Schema = z.object({
  enabled: z.boolean(),
  signatoryName: z.string().trim().max(120),
  signatoryTitle: z.string().trim().max(120),
});

/**
 * Save the org's document letterhead settings — the on/off toggle and the
 * default signatory (name + title) used when the AI drafts letters/resolutions.
 * The letterhead identity (name/address/logo/contact) lives on the org profile
 * and is edited there; this only owns the document-specific bits.
 */
export async function saveLetterheadAction(
  _prev: LetterheadState | undefined,
  formData: FormData,
): Promise<LetterheadState> {
  await requireSession();
  const orgId = await getCurrentOrgId();

  const parsed = Schema.safeParse({
    enabled: formData.get('enabled') === 'on',
    signatoryName: typeof formData.get('signatoryName') === 'string' ? formData.get('signatoryName') : '',
    signatoryTitle: typeof formData.get('signatoryTitle') === 'string' ? formData.get('signatoryTitle') : '',
  });
  if (!parsed.success) return { error: 'Please keep name and title under 120 characters.' };

  const { enabled, signatoryName, signatoryTitle } = parsed.data;
  await db
    .update(organizations)
    .set({
      letterheadEnabled: enabled,
      letterheadSignatoryName: signatoryName.length > 0 ? signatoryName : null,
      letterheadSignatoryTitle: signatoryTitle.length > 0 ? signatoryTitle : null,
    })
    .where(eq(organizations.id, orgId));

  revalidatePath('/organizer/letterhead');
  return { ok: true };
}
