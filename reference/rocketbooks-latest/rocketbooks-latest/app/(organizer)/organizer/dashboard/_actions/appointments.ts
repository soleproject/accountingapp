'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { appointments, contacts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';

const Schema = z.object({
  appointmentId: z.string().min(1).max(64),
  // Empty string clears the link; a non-empty id links that contact.
  contactId: z.string().max(64),
});

export interface LinkAppointmentContactResult {
  ok?: boolean;
  error?: string;
}

/**
 * Attach (or clear) the contact linked to an appointment. Ownership-scoped to
 * the current user + org so a forged id can't reach another tenant's row, and
 * the contact must belong to the same org. Linking is what unlocks the
 * appointment's related notes / tasks / emails / texts in the detail panel.
 */
export async function linkAppointmentContactAction(
  input: { appointmentId: string; contactId: string },
): Promise<LinkAppointmentContactResult> {
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();

  const parsed = Schema.safeParse(input);
  if (!parsed.success) return { error: 'Invalid request.' };
  const contactId = parsed.data.contactId.trim();

  // Validate the appointment belongs to this user + org.
  const [appt] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.id, parsed.data.appointmentId),
        eq(appointments.userId, userId),
        eq(appointments.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!appt) return { error: 'Appointment not found.' };

  // When linking (non-empty), the contact must exist in this org.
  if (contactId) {
    const [c] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, orgId)))
      .limit(1);
    if (!c) return { error: 'Contact not found.' };
  }

  await db
    .update(appointments)
    .set({ contactId: contactId || null, updatedAt: new Date().toISOString() })
    .where(eq(appointments.id, parsed.data.appointmentId));

  revalidatePath('/organizer/dashboard');
  revalidatePath('/organizer/calendar');
  revalidatePath('/organizer/contacts/[id]', 'page');
  return { ok: true };
}
