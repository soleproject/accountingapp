import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq, and, desc, asc, count, sql, gte } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, notes, tasks, appointments, inboxMessages } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { linkedTaskCounts } from '@/lib/task-links/queries';
import { AutoRefreshOnAiAction } from '@/components/ai-assistant/AutoRefreshOnAiAction';
import { NoteRow } from '../../dashboard/_components/NoteRow';
import { AddContactNoteForm } from './_components/AddContactNoteForm';
import { LogContactConversationCard } from './_components/LogContactConversationCard';
import { RegisterContactPageContext } from './_components/RegisterContactPageContext';

const TASKS_PREVIEW = 8;
const NOTES_PREVIEW = 20;
const APPOINTMENTS_PREVIEW = 6;
const INBOX_PREVIEW = 10;
const CONTACT_PICKER_LIMIT = 100;

interface PageProps {
  params: Promise<{ id: string }>;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function shortDue(due: string | null): string {
  if (!due) return '';
  const dueMs = Date.parse(due);
  if (Number.isNaN(dueMs)) return '';
  const diffDays = Math.floor((dueMs - Date.now()) / 86_400_000);
  if (diffDays < 0) return `${Math.abs(diffDays)}d late`;
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays <= 7) return `${diffDays}d`;
  return new Date(dueMs).toLocaleDateString();
}

export default async function ContactDrillIn({ params }: PageProps) {
  const { id } = await params;
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();

  const [contact] = await db
    .select({
      id: contacts.id,
      contactName: contacts.contactName,
      companyName: contacts.companyName,
      email: contacts.email,
      phone: contacts.phone,
      isActive: contacts.isActive,
    })
    .from(contacts)
    .where(and(eq(contacts.id, id), eq(contacts.organizationId, orgId)))
    .limit(1);

  if (!contact) notFound();

  // tasks.assigned_to_contacts is a json column storing an array of contact
  // ids; cast to jsonb for the @> containment operator. Filter to user's
  // open tasks so we don't show closed history (a future "history" toggle
  // could relax this).
  const taskContainsContact = sql`${tasks.assignedToContacts}::jsonb @> ${JSON.stringify([id])}::jsonb`;
  const openTasksWhere = and(
    eq(tasks.organizationId, orgId),
    eq(tasks.userId, userId),
    eq(tasks.status, 'OPEN'),
    taskContainsContact,
  );

  const upcomingAppointmentsWhere = and(
    eq(appointments.organizationId, orgId),
    eq(appointments.userId, userId),
    eq(appointments.contactId, id),
    gte(appointments.startsAt, new Date().toISOString()),
  );

  const inboxWhere = and(
    eq(inboxMessages.organizationId, orgId),
    eq(inboxMessages.userId, userId),
    eq(inboxMessages.contactId, id),
  );

  const [noteRows, [noteTotal], taskRows, [taskTotal], appointmentRows, inboxRows, allContacts] = await Promise.all([
    db
      .select({
        id: notes.id,
        body: notes.body,
        source: notes.source,
        createdAt: notes.createdAt,
      })
      .from(notes)
      .where(and(eq(notes.userId, userId), eq(notes.organizationId, orgId), eq(notes.contactId, id)))
      .orderBy(desc(notes.createdAt))
      .limit(NOTES_PREVIEW),
    db
      .select({ n: count() })
      .from(notes)
      .where(and(eq(notes.userId, userId), eq(notes.organizationId, orgId), eq(notes.contactId, id))),
    db
      .select({
        id: tasks.id,
        title: tasks.title,
        dueDate: tasks.dueDate,
        priority: tasks.priority,
      })
      .from(tasks)
      .where(openTasksWhere)
      .orderBy(sql`${tasks.dueDate} IS NULL`, asc(tasks.dueDate), desc(tasks.createdAt))
      .limit(TASKS_PREVIEW),
    db.select({ n: count() }).from(tasks).where(openTasksWhere),
    db
      .select({
        id: appointments.id,
        title: appointments.title,
        startsAt: appointments.startsAt,
        endsAt: appointments.endsAt,
        location: appointments.location,
      })
      .from(appointments)
      .where(upcomingAppointmentsWhere)
      .orderBy(asc(appointments.startsAt))
      .limit(APPOINTMENTS_PREVIEW),
    db
      .select({
        id: inboxMessages.id,
        source: inboxMessages.source,
        fromAddress: inboxMessages.fromAddress,
        fromName: inboxMessages.fromName,
        subject: inboxMessages.subject,
        body: inboxMessages.body,
        receivedAt: inboxMessages.receivedAt,
        status: inboxMessages.status,
      })
      .from(inboxMessages)
      .where(inboxWhere)
      .orderBy(desc(inboxMessages.receivedAt))
      .limit(INBOX_PREVIEW),
    // Org contacts for the note edit form's contact dropdown — lets
    // the user re-link or unlink a note from the drill-in view.
    db
      .select({ id: contacts.id, name: contacts.contactName })
      .from(contacts)
      .where(and(eq(contacts.organizationId, orgId), eq(contacts.isActive, true)))
      .orderBy(asc(contacts.contactName))
      .limit(CONTACT_PICKER_LIMIT),
  ]);

  const totalNotes = noteTotal?.n ?? 0;
  const totalOpenTasks = taskTotal?.n ?? 0;
  const noteLinkMap = await linkedTaskCounts(orgId, 'note', noteRows.map((n) => n.id));

  return (
    <div className="flex flex-col gap-4">
      <RegisterContactPageContext
        contactId={contact.id}
        contactName={contact.contactName}
        email={contact.email}
        phone={contact.phone}
        openTaskCount={totalOpenTasks}
        noteCount={totalNotes}
        upcomingAppointmentCount={appointmentRows.length}
        recentInboxCount={inboxRows.length}
      />
      <AutoRefreshOnAiAction />

      <div>
        <Link
          href="/organizer/dashboard"
          className="text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          ← Back to Organizer
        </Link>
        <header className="mt-2">
          <h1 className="text-2xl font-semibold">{contact.contactName}</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {[contact.companyName, contact.email, contact.phone].filter(Boolean).join(' · ') || 'No contact info on file.'}
          </p>
          {!contact.isActive && (
            <span className="mt-1 inline-block rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
              Archived
            </span>
          )}
        </header>
      </div>

      <LogContactConversationCard contactId={contact.id} contactName={contact.contactName} />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Open tasks
            </h2>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{totalOpenTasks} total</span>
          </div>
          {taskRows.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">No open tasks for this contact.</p>
          ) : (
            <ul className="mt-2 flex flex-col divide-y divide-zinc-100 dark:divide-zinc-900">
              {taskRows.map((t) => {
                const due = shortDue(t.dueDate);
                const overdue = t.dueDate ? Date.parse(t.dueDate) < Date.now() - 86_400_000 : false;
                return (
                  <li key={t.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                    <span className="flex-1 truncate text-zinc-800 dark:text-zinc-200">{t.title}</span>
                    {due && (
                      <span
                        className={`shrink-0 text-xs ${
                          overdue ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-500 dark:text-zinc-400'
                        }`}
                      >
                        {due}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Upcoming appointments
          </h2>
          {appointmentRows.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Nothing on the calendar with this contact.</p>
          ) : (
            <ul className="mt-2 flex flex-col divide-y divide-zinc-100 dark:divide-zinc-900">
              {appointmentRows.map((a) => (
                <li key={a.id} className="py-2 text-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-zinc-800 dark:text-zinc-200">{a.title}</span>
                    <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{fmtTime(a.startsAt)}</span>
                  </div>
                  {a.location && (
                    <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-500">{a.location}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Notes
          </h2>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{totalNotes} total</span>
        </div>

        {noteRows.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            No notes yet — jot one below or have the AI log a conversation.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-3">
            {noteRows.map((n) => (
              <NoteRow
                key={n.id}
                note={{
                  id: n.id,
                  body: n.body,
                  source: n.source,
                  createdAt: n.createdAt,
                  contactId: contact.id,
                  contactName: contact.contactName,
                }}
                contacts={allContacts}
                hideContactMetadata
                linkedTaskCount={noteLinkMap.get(n.id) ?? 0}
              />
            ))}
          </ul>
        )}

        <AddContactNoteForm contactId={contact.id} />
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Recent inbox messages
        </h2>
        {inboxRows.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">No messages from this contact yet.</p>
        ) : (
          <ul className="mt-2 flex flex-col divide-y divide-zinc-100 dark:divide-zinc-900">
            {inboxRows.map((m) => (
              <li key={m.id} className="py-2 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-zinc-800 dark:text-zinc-200">
                    {m.subject ?? '(no subject)'}
                  </span>
                  <span className="shrink-0 text-[11px] text-zinc-500 dark:text-zinc-500">
                    {m.source} · {timeAgo(m.receivedAt)}
                    {m.status !== 'open' ? ` · ${m.status}` : ''}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-500">
                  {m.body.slice(0, 180)}{m.body.length > 180 ? '…' : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
