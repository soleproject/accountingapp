import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  appointments,
  contacts,
  notes,
  tasks,
  inboxMessages,
  textMessages,
  organizations,
} from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId, listAccessibleOrgs } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { isTextsEnabled } from '@/lib/texts/access';
import { videoProvider } from '@/lib/video';
import type { AppointmentContext } from '@/app/(organizer)/organizer/calendar/types';

export const runtime = 'nodejs';

const NOTES_LIMIT = 5;
const TASKS_LIMIT = 5;
const EMAILS_LIMIT = 5;
const TEXTS_LIMIT = 8;

/**
 * Context sidebar data for a single organizer appointment: its purpose plus
 * the latest notes, open tasks, emails, and texts for the linked contact.
 * Notes/tasks/emails are per-user (matching the contact drill-in); texts are
 * org-shared and gated behind the Texts feature flag.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();
  const { id } = await ctx.params;

  const [appt] = await db
    .select({
      id: appointments.id,
      title: appointments.title,
      description: appointments.description,
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
      location: appointments.location,
      contactId: appointments.contactId,
      contactName: contacts.contactName,
      googleEventId: appointments.googleEventId,
      videoEnabled: appointments.videoEnabled,
      guestEmails: appointments.guestEmails,
      organizationId: appointments.organizationId,
      organizationName: organizations.name,
    })
    .from(appointments)
    .leftJoin(contacts, eq(contacts.id, appointments.contactId))
    .leftJoin(organizations, eq(organizations.id, appointments.organizationId))
    .where(
      // The calendar is per-USER (events across all the user's companies), so
      // we authorize by ownership, not by the currently-selected org. The
      // shared demo workspace stays org-scoped so seeded examples open for any
      // viewer (mirrors the calendar list query).
      isDemoOrg(orgId)
        ? and(eq(appointments.id, id), eq(appointments.organizationId, orgId))
        : and(eq(appointments.id, id), eq(appointments.userId, userId)),
    )
    .limit(1);

  if (!appt) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const textsEnabled = await isTextsEnabled(user.id);

  // No linked contact → nothing to pull beyond the appointment itself.
  if (!appt.contactId) {
    const empty: AppointmentContext = {
      appointment: appt,
      notes: [],
      tasks: [],
      emails: [],
      texts: [],
      textsEnabled,
    };
    return NextResponse.json(empty);
  }

  const contactId = appt.contactId;
  // Related context (notes/tasks/emails/texts) lives under the appointment's
  // OWN company, which may differ from the org the viewer currently has
  // selected (the calendar shows events across all the user's companies).
  // Scope to the appointment's org so a cross-company event still shows its
  // real linked records. Falls back to the viewer's org for legacy rows.
  const contextOrgId = appt.organizationId ?? orgId;
  // tasks.assigned_to_contacts is a json array of contact ids; cast to jsonb
  // for the @> containment match (mirrors the contact drill-in page).
  const taskContainsContact = sql`${tasks.assignedToContacts}::jsonb @> ${JSON.stringify([contactId])}::jsonb`;

  const [noteRows, taskRows, emailRows, textRows] = await Promise.all([
    db
      .select({
        id: notes.id,
        body: notes.body,
        source: notes.source,
        createdAt: notes.createdAt,
      })
      .from(notes)
      .where(
        and(
          eq(notes.userId, userId),
          eq(notes.organizationId, contextOrgId),
          eq(notes.contactId, contactId),
        ),
      )
      .orderBy(desc(notes.createdAt))
      .limit(NOTES_LIMIT),
    db
      .select({
        id: tasks.id,
        title: tasks.title,
        dueDate: tasks.dueDate,
        priority: tasks.priority,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.organizationId, contextOrgId),
          eq(tasks.userId, userId),
          eq(tasks.status, 'OPEN'),
          taskContainsContact,
        ),
      )
      .orderBy(sql`${tasks.dueDate} IS NULL`, asc(tasks.dueDate), desc(tasks.createdAt))
      .limit(TASKS_LIMIT),
    db
      .select({
        id: inboxMessages.id,
        subject: inboxMessages.subject,
        body: inboxMessages.body,
        source: inboxMessages.source,
        fromName: inboxMessages.fromName,
        fromAddress: inboxMessages.fromAddress,
        receivedAt: inboxMessages.receivedAt,
        status: inboxMessages.status,
      })
      .from(inboxMessages)
      .where(
        and(
          eq(inboxMessages.userId, userId),
          eq(inboxMessages.organizationId, contextOrgId),
          eq(inboxMessages.contactId, contactId),
        ),
      )
      .orderBy(desc(inboxMessages.receivedAt))
      .limit(EMAILS_LIMIT),
    // Texts are org-shared (not per-user) and only when the feature is on.
    textsEnabled
      ? db
          .select({
            id: textMessages.id,
            direction: textMessages.direction,
            body: textMessages.body,
            createdAt: textMessages.createdAt,
          })
          .from(textMessages)
          .where(
            and(
              eq(textMessages.organizationId, contextOrgId),
              eq(textMessages.contactId, contactId),
            ),
          )
          .orderBy(desc(textMessages.createdAt))
          .limit(TEXTS_LIMIT)
      : Promise.resolve([] as AppointmentContext['texts']),
  ]);

  const payload: AppointmentContext = {
    appointment: appt,
    notes: noteRows,
    tasks: taskRows,
    emails: emailRows,
    texts: textRows as AppointmentContext['texts'],
    textsEnabled,
  };
  return NextResponse.json(payload);
}

/** Delete an appointment the caller owns. Best-effort: the matching Google
 *  event (if any) is left alone; the next sync reconciles. */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();
  const { id } = await ctx.params;

  // Demo workspace is read-only.
  if (isDemoOrg(orgId)) {
    return NextResponse.json({ error: "This action isn't available in the demo workspace." }, { status: 403 });
  }

  const deleted = await db
    .delete(appointments)
    .where(
      // Per-user ownership (events span the user's companies); demo workspace
      // stays org-scoped and shared. Mirrors the GET authorization.
      isDemoOrg(orgId)
        ? and(eq(appointments.id, id), eq(appointments.organizationId, orgId))
        : and(eq(appointments.id, id), eq(appointments.userId, userId)),
    )
    .returning({ id: appointments.id });

  if (deleted.length === 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

const PatchSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  startsAt: z.string().datetime({ offset: true }).optional(),
  endsAt: z.string().datetime({ offset: true }).nullish(),
  location: z.string().trim().max(2048).nullish(),
  description: z.string().trim().max(8000).nullish(),
  guestEmails: z.array(z.string().trim().email()).max(50).optional(),
  videoEnabled: z.boolean().optional(),
  // The company this meeting is "regarding". Must be one of the caller's
  // accessible orgs — validated below, not just shape-checked here.
  organizationId: z.string().trim().min(1).optional(),
});

/** Update an appointment the caller owns. Only the provided keys change; a
 *  `location` omitted while video stays on preserves the provisioned room URL. */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();
  const { id } = await ctx.params;

  // Demo workspace is read-only.
  if (isDemoOrg(orgId)) {
    return NextResponse.json({ error: "This action isn't available in the demo workspace." }, { status: 403 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad request', issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;

  if (body.videoEnabled === true && !videoProvider.isConfigured()) {
    return NextResponse.json({ error: 'video calling is not configured' }, { status: 503 });
  }

  // Re-assigning the "regarding" company: only allow orgs the caller can
  // actually access, so a PATCH can't move an event into an arbitrary org.
  if (body.organizationId !== undefined) {
    const accessible = await listAccessibleOrgs();
    if (!accessible.some((o) => o.id === body.organizationId)) {
      return NextResponse.json({ error: 'invalid organization' }, { status: 400 });
    }
  }

  // Build the update from only the keys actually present in the request.
  const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (body.title !== undefined) set.title = body.title;
  if (body.startsAt !== undefined) set.startsAt = body.startsAt;
  if (body.endsAt !== undefined) set.endsAt = body.endsAt;
  if (body.location !== undefined) set.location = body.location;
  if (body.description !== undefined) set.description = body.description;
  if (body.videoEnabled !== undefined) set.videoEnabled = body.videoEnabled;
  if (body.organizationId !== undefined) set.organizationId = body.organizationId;
  if (body.guestEmails !== undefined) {
    set.guestEmails = body.guestEmails.length > 0 ? body.guestEmails.join(', ') : null;
  }

  const updated = await db
    .update(appointments)
    .set(set)
    .where(
      // Per-user ownership (events span the user's companies); demo workspace
      // stays org-scoped and shared. Mirrors the GET authorization.
      isDemoOrg(orgId)
        ? and(eq(appointments.id, id), eq(appointments.organizationId, orgId))
        : and(eq(appointments.id, id), eq(appointments.userId, userId)),
    )
    .returning({ id: appointments.id });

  if (updated.length === 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
