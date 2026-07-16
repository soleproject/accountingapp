import Link from 'next/link';
import { eq, and, or, desc, asc, count, sql, gte, lte, isNotNull, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { tasks, notes, contacts, appointments, inboxMessages, meetingFollowups, organizations } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { getGoogleConnectionStatus } from '@/lib/calendar/google';
import { syncGoogleCalendarForUser } from '@/lib/calendar/google-sync';
import { linkedTaskCounts, getLinkedTasksFor } from '@/lib/task-links/queries';
import { logger } from '@/lib/logger';
import { NextUpCard, type NextUpItem } from './_components/NextUpCard';
import { TodaysScheduleCard } from './_components/TodaysScheduleCard';
import { InboxIssuesCard } from './_components/InboxIssuesCard';
import { RecentTextsCard } from './_components/RecentTextsCard';
import { LogConversationPill } from './_components/LogConversationPill';
import { RecentNotesCard } from './_components/RecentNotesCard';
import { OpenTasksCard } from './_components/OpenTasksCard';
import { CardFlipProvider } from './_components/CardFlipContext';
import { FlippableOpenTasks } from './_components/FlippableOpenTasks';
import { DashboardGrid } from './_components/DashboardGrid';
import { FlippableLeftColumn } from './_components/FlippableLeftColumn';
import { CompanyPicker } from './_components/CompanyPicker';
import { RegisterPageContext } from './_components/RegisterPageContext';
import { AutoRefreshOnAiAction } from '@/components/ai-assistant/AutoRefreshOnAiAction';

const TASKS_PREVIEW = 6;
const NOTES_PREVIEW = 5;
const CONTACT_PICKER_LIMIT = 50;
const INBOX_PREVIEW = 5;
const TEXTS_PREVIEW = 5;
const APPOINTMENTS_PREVIEW = 8;

// "Next up" ranking knobs. Once a meeting is this many minutes out (or less) the
// card flips to "prepare for upcoming meeting" regardless of score. Outside that
// window, tasks and the next appointment compete on a blended urgency score, so
// an overdue / high-priority task can outrank a meeting that's still hours away.
// These weights are deliberately simple and live here as plain constants — if we
// ever want users to tune them, lift them into a settings row.
const PREP_WINDOW_MIN = 30;
const PRIORITY_BOOST: Record<string, number> = { high: 25, medium: 12, low: 4 };

/** Spotlight-worthiness of an open task — higher wins. Blends due date + priority. */
function scoreTask(dueDate: string | null, priority: string | null, nowMs: number): number {
  let base = 10; // no / unparseable due date
  if (dueDate) {
    const due = Date.parse(dueDate);
    if (!Number.isNaN(due)) {
      const hours = (due - nowMs) / 3_600_000;
      if (hours < 0) base = 70 + Math.min(30, Math.floor(-hours / 24) * 10); // overdue: older = higher
      else if (hours <= 24) base = 60; // due today-ish
      else if (hours <= 72) base = 40; // due within ~3 days
      else base = 20; // further out
    }
  }
  const boost = priority ? PRIORITY_BOOST[priority.toLowerCase()] ?? 0 : 0;
  return base + boost;
}

/** Spotlight-worthiness of the next appointment (only reached when >30 min out). */
function scoreAppointment(startsAt: string, nowMs: number): number {
  const start = Date.parse(startsAt);
  if (Number.isNaN(start)) return 0;
  const hours = (start - nowMs) / 3_600_000;
  if (hours <= 2) return 55;
  if (hours <= 4) return 45;
  return 35;
}

interface PageProps {
  searchParams?: Promise<{ company?: string }>;
}

export default async function OrganizerDashboard({ searchParams }: PageProps) {
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();
  const sp = (await searchParams) ?? {};
  const requestedCompany = typeof sp.company === 'string' ? sp.company : null;

  // Company filter options. Companies are contacts with a company name; the
  // picker drives the `?company=<contactId>` filter applied to every card.
  const companyRows = await db
    .select({ id: contacts.id, contactName: contacts.contactName, companyName: contacts.companyName })
    .from(contacts)
    .where(and(eq(contacts.organizationId, orgId), eq(contacts.isActive, true), isNotNull(contacts.companyName)))
    .orderBy(asc(contacts.companyName))
    .limit(200);
  const companies = companyRows.map((c) => ({ id: c.id, name: c.companyName ?? c.contactName }));
  // Only honor the filter if it names a real company in this org.
  const selectedCompany = requestedCompany ? companies.find((c) => c.id === requestedCompany) ?? null : null;
  const companyId = selectedCompany?.id ?? null;

  // Per-card company scoping. Notes / appointments / inbox link via contact_id;
  // tasks store the contact in the assigned_to_contacts json array.
  const taskCompanyFilter = companyId ? sql`jsonb_exists(${tasks.assignedToContacts}::jsonb, ${companyId})` : undefined;
  const noteCompanyFilter = companyId ? eq(notes.contactId, companyId) : undefined;
  const apptCompanyFilter = companyId ? eq(appointments.contactId, companyId) : undefined;
  const inboxCompanyFilter = companyId ? eq(inboxMessages.contactId, companyId) : undefined;

  // Pull any Google Calendar changes into the internal appointments
  // table before we render. Incremental sync (via stored syncToken) is
  // typically <100ms and returns zero diffs. First-time / post-410
  // sync does a full window pull. Failures are best-effort — the
  // dashboard still renders against whatever is already in the local
  // table.
  await syncGoogleCalendarForUser(userId).catch((err: unknown) => {
    logger.warn(
      { userId, err: err instanceof Error ? err.message : String(err) },
      'organizer dashboard: google sync threw',
    );
  });

  // In the read-only demo org, data is shared (seeded under the demo system
  // user), so drop the per-viewer user filter and show the whole org. Mirrors
  // the org-scoped accounting demo. Everywhere else this stays a personal view.
  const demo = isDemoOrg(orgId);
  const userScope = demo ? undefined : userId;

  const openTasksWhere = and(
    eq(tasks.organizationId, orgId),
    userScope ? eq(tasks.userId, userScope) : undefined,
    eq(tasks.status, 'OPEN'),
    taskCompanyFilter,
  );

  // "Today" bounds in server local time — same approximation as the AI
  // list_my_appointments tool. Swap to user-tz aware bounds when we add
  // a user timezone field.
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const startOfNextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  // Demo Co is the shared example org: its dashboard messages must never clear
  // no matter what a viewer does, so we drop the "needs attention" filters
  // (status / read) and always surface the seeded examples there.
  const openInboxWhere = and(
    eq(inboxMessages.organizationId, orgId),
    userScope ? eq(inboxMessages.userId, userScope) : undefined,
    demo ? undefined : eq(inboxMessages.status, 'open'),
    inboxCompanyFilter,
  );
  // Texts are org-scoped (no per-user owner) and thread-based: the dashboard
  // surfaces a thread when its LATEST message is inbound (the contact texted
  // last → needs a reply) and it hasn't been manually dismissed. Replying makes
  // the latest message outbound, so the thread auto-clears. Read state is
  // deliberately NOT used — viewing a text must not clear it. Demo Co never
  // clears: there the dismiss action is a no-op (see dismissTextAction), and
  // since we don't key on read, viewing leaves the seeded examples in place.
  const textContactFilter = companyId ? sql`AND t.contact_id = ${companyId}` : sql``;
  const textThreadsSql = sql`
    WITH latest AS (
      SELECT DISTINCT ON (t.contact_id)
        t.id, t.body, t.created_at, t.from_phone, t.contact_id, t.direction, t.dashboard_dismissed_at
      FROM text_messages t
      WHERE t.organization_id = ${orgId} ${textContactFilter}
      ORDER BY t.contact_id, t.created_at DESC
    )
    SELECT l.id, l.body, l.created_at AS "createdAt", l.from_phone AS "fromPhone",
           l.contact_id AS "contactId", c.contact_name AS "contactName"
    FROM latest l
    LEFT JOIN contacts c ON c.id = l.contact_id
    WHERE l.direction = 'inbound' AND l.dashboard_dismissed_at IS NULL
    ORDER BY l.created_at DESC
    LIMIT ${TEXTS_PREVIEW}
  `;
  const textCountSql = sql`
    WITH latest AS (
      SELECT DISTINCT ON (t.contact_id) t.contact_id, t.direction, t.dashboard_dismissed_at, t.created_at
      FROM text_messages t
      WHERE t.organization_id = ${orgId} ${textContactFilter}
      ORDER BY t.contact_id, t.created_at DESC
    )
    SELECT count(*)::int AS n FROM latest
    WHERE direction = 'inbound' AND dashboard_dismissed_at IS NULL
  `;

  const [openTaskRows, [openTaskTotal], noteRows, contactRows, appointmentRows, inboxRows, [inboxTotal], textRowsRaw, textCountRaw, googleStatus] = await Promise.all([
    // Sort: tasks with a due date first (soonest), then undated by recency.
    // Ordering on (dueDate IS NULL, dueDate ASC) keeps the urgent ones up top
    // without burying date-less tasks forever.
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
        id: notes.id,
        body: notes.body,
        source: notes.source,
        createdAt: notes.createdAt,
        contactId: notes.contactId,
        contactName: contacts.contactName,
      })
      .from(notes)
      .leftJoin(contacts, eq(contacts.id, notes.contactId))
      .where(and(eq(notes.organizationId, orgId), userScope ? eq(notes.userId, userScope) : undefined, noteCompanyFilter))
      .orderBy(desc(notes.createdAt))
      .limit(NOTES_PREVIEW),
    db
      .select({ id: contacts.id, name: contacts.contactName })
      .from(contacts)
      .where(and(eq(contacts.organizationId, orgId), eq(contacts.isActive, true)))
      .orderBy(asc(contacts.contactName))
      .limit(CONTACT_PICKER_LIMIT),
    db
      .select({
        id: appointments.id,
        title: appointments.title,
        startsAt: appointments.startsAt,
        endsAt: appointments.endsAt,
        location: appointments.location,
        contactId: appointments.contactId,
        contactName: contacts.contactName,
        googleEventId: appointments.googleEventId,
        organizationId: appointments.organizationId,
        organizationName: organizations.name,
      })
      .from(appointments)
      .leftJoin(contacts, eq(contacts.id, appointments.contactId))
      .leftJoin(organizations, eq(organizations.id, appointments.organizationId))
      .where(
        // Today's schedule is a per-USER view across all the user's companies
        // (each row shows its "regarding" company), so we don't filter by the
        // currently-selected org. The demo workspace stays org-scoped + shared.
        // The company picker (apptCompanyFilter) still narrows by linked
        // contact when one is selected.
        demo
          ? and(
              eq(appointments.organizationId, orgId),
              gte(appointments.startsAt, startOfDay),
              lte(appointments.startsAt, startOfNextDay),
              apptCompanyFilter,
            )
          : and(
              eq(appointments.userId, userId),
              gte(appointments.startsAt, startOfDay),
              lte(appointments.startsAt, startOfNextDay),
              apptCompanyFilter,
            ),
      )
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
        contactId: inboxMessages.contactId,
        contactName: contacts.contactName,
      })
      .from(inboxMessages)
      .leftJoin(contacts, eq(contacts.id, inboxMessages.contactId))
      .where(openInboxWhere)
      .orderBy(desc(inboxMessages.receivedAt))
      .limit(INBOX_PREVIEW),
    db.select({ n: count() }).from(inboxMessages).where(openInboxWhere),
    db.execute(textThreadsSql),
    db.execute(textCountSql),
    // Lightweight probe — just reads the connection row's stored
    // status. The actual event data already landed in the appointments
    // table via the syncGoogleCalendarForUser call above. This is only
    // here so the card can decide whether to show a Connect / Reconnect
    // CTA.
    getGoogleConnectionStatus(userId),
  ]);

  const nextTask = openTaskRows[0] ?? null;
  // Open Tasks shows the full list, not just "the rest after Next Up".
  // With only one task, slicing off the first left the card empty
  // while the header still claimed "1 total" — confusing. The
  // spotlight in Next Up and the full list serve different purposes,
  // so the duplication is intentional.
  const totalOpen = openTaskTotal?.n ?? 0;
  const totalInboxOpen = inboxTotal?.n ?? 0;
  // Raw SQL rows (db.execute) → typed shapes for the Texts card.
  const textRows = (textRowsRaw as unknown as Array<{
    id: string;
    body: string;
    createdAt: string;
    fromPhone: string;
    contactId: string | null;
    contactName: string | null;
  }>);
  const totalUnreadTexts = Number((textCountRaw as unknown as Array<{ n: number }>)[0]?.n ?? 0);
  const contactOptions = contactRows.map((c) => ({ id: c.id, name: c.name }));

  // The appointments table is now the single source of truth — the
  // sync engine kept it fresh against Google before this query ran, so
  // we don't need to merge a separate live Google list here. Rows that
  // have a googleEventId can offer an "open in Google" link in the UI.
  const scheduleRows = appointmentRows.map((a) => ({
    id: a.id,
    title: a.title,
    startsAt: a.startsAt,
    endsAt: a.endsAt,
    location: a.location,
    contactId: a.contactId,
    contactName: a.contactName,
    googleEventId: a.googleEventId,
    organizationName: a.organizationName,
  }));

  // "Next up" rotates through the day and decides *what kind* of nudge to show:
  //
  //  1. Prep mode — when the next appointment is within PREP_WINDOW_MIN, the card
  //     flips to "Prepare for upcoming meeting" and lists that meeting's still-open
  //     linked tasks as a checklist (just the meeting if none are linked).
  //  2. Smart score — otherwise the next appointment and the most date-urgent open
  //     tasks compete on a blended urgency score (due date + priority), so an
  //     overdue / high-priority task can outrank a meeting that's still hours away.
  //
  // Appointments that have already started are skipped (they're "now", not "next").
  const nowMs = now.getTime();
  const nextAppt =
    scheduleRows.find((a) => {
      const t = Date.parse(a.startsAt);
      return !Number.isNaN(t) && t >= nowMs;
    }) ?? null;
  const minsUntilAppt = nextAppt ? (Date.parse(nextAppt.startsAt) - nowMs) / 60_000 : Infinity;

  let nextUp: NextUpItem | null = null;

  if (nextAppt && minsUntilAppt <= PREP_WINDOW_MIN) {
    // Prep mode: the meeting is imminent — surface it with its open prep tasks.
    const linked = await getLinkedTasksFor(orgId, 'appointment', nextAppt.id);
    const prepTasks = linked
      .filter((t) => t.status !== 'DONE')
      .slice(0, 4)
      .map((t) => ({ id: t.id, title: t.title }));
    nextUp = {
      kind: 'appointment',
      prep: true,
      id: nextAppt.id,
      title: nextAppt.title,
      when: nextAppt.startsAt,
      endsAt: nextAppt.endsAt,
      location: nextAppt.location,
      contactId: nextAppt.contactId,
      contactName: nextAppt.contactName,
      prepTasks,
    };
  } else {
    // Smart score: rank the next appointment against the most urgent open tasks.
    const candidates: { item: NextUpItem; score: number; when: number }[] = [];
    if (nextAppt) {
      candidates.push({
        item: {
          kind: 'appointment',
          id: nextAppt.id,
          title: nextAppt.title,
          when: nextAppt.startsAt,
          endsAt: nextAppt.endsAt,
          location: nextAppt.location,
          contactId: nextAppt.contactId,
          contactName: nextAppt.contactName,
        },
        score: scoreAppointment(nextAppt.startsAt, nowMs),
        when: Date.parse(nextAppt.startsAt),
      });
    }
    for (const t of openTaskRows) {
      candidates.push({
        item: { kind: 'task', id: t.id, title: t.title, when: t.dueDate, priority: t.priority },
        score: scoreTask(t.dueDate, t.priority, nowMs),
        when: t.dueDate ? Date.parse(t.dueDate) : Number.POSITIVE_INFINITY,
      });
    }
    // Highest score wins; ties go to whatever lands sooner on the clock.
    candidates.sort((a, b) => b.score - a.score || a.when - b.when);
    nextUp = candidates[0]?.item ?? null;
  }

  // Reverse links: how many tasks point at each visible note / appointment,
  // for the 🔗 badges (the other direction of the task → note/meeting link).
  const [noteLinkMap, apptLinkMap] = await Promise.all([
    linkedTaskCounts(orgId, 'note', noteRows.map((n) => n.id)),
    linkedTaskCounts(orgId, 'appointment', scheduleRows.map((a) => a.id)),
  ]);
  const noteLinkCounts = Object.fromEntries(noteLinkMap);
  const apptLinkCounts = Object.fromEntries(apptLinkMap);

  // Meetings whose follow-up debrief is done — rendered green in the schedule.
  // "Done" = the follow-up reached `completed` OR its Call Debrief task is DONE
  // (so it greens the moment you check the debrief off, before the cron finalizes).
  const debriefDoneIds = scheduleRows.length
    ? (
        await db
          .select({ appointmentId: meetingFollowups.appointmentId })
          .from(meetingFollowups)
          .leftJoin(tasks, eq(tasks.id, meetingFollowups.debriefTaskId))
          .where(
            and(
              eq(meetingFollowups.organizationId, orgId),
              inArray(meetingFollowups.appointmentId, scheduleRows.map((a) => a.id)),
              or(eq(meetingFollowups.state, 'completed'), eq(tasks.status, 'DONE')),
            ),
          )
      ).map((r) => r.appointmentId)
    : [];

  return (
    <div className="flex flex-col gap-4">
      <RegisterPageContext
        openTaskCount={totalOpen}
        recentNoteCount={noteRows.length}
        nextTaskTitle={nextTask?.title ?? null}
        todaysAppointmentCount={appointmentRows.length}
        openInboxCount={totalInboxOpen}
      />
      <AutoRefreshOnAiAction />
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Organizer</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {selectedCompany ? (
              <>Filtered to <span className="font-medium text-zinc-700 dark:text-zinc-300">{selectedCompany.name}</span>.</>
            ) : (
              'Your moving pieces, in one place.'
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/organizer/create"
            className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200/70 bg-gradient-to-br from-indigo-50 to-white px-3.5 py-1.5 text-sm font-medium text-indigo-700 shadow-sm transition-shadow hover:shadow-md dark:border-indigo-900/40 dark:from-indigo-950/30 dark:to-zinc-900 dark:text-indigo-300"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Create
          </Link>
          <LogConversationPill company={selectedCompany} />
          {companies.length > 0 && <CompanyPicker companies={companies} selectedId={companyId} />}
        </div>
      </header>

      <NextUpCard item={nextUp} now={nowMs} />

      <CardFlipProvider>
        <DashboardGrid
          left={
            <FlippableLeftColumn>
              <div className="flex flex-col gap-4">
                <TodaysScheduleCard appointments={scheduleRows} google={googleStatus} linkedTaskCounts={apptLinkCounts} debriefDoneIds={debriefDoneIds} />
                <InboxIssuesCard messages={inboxRows} totalOpen={totalInboxOpen} demo={demo} />
                <RecentTextsCard texts={textRows} totalUnread={totalUnreadTexts} demo={demo} />
                <RecentNotesCard notes={noteRows} contacts={contactOptions} linkedTaskCounts={noteLinkCounts} />
              </div>
            </FlippableLeftColumn>
          }
          right={
            <FlippableOpenTasks contacts={contactOptions}>
              <OpenTasksCard tasks={openTaskRows} totalOpen={totalOpen} />
            </FlippableOpenTasks>
          }
        />
      </CardFlipProvider>
    </div>
  );
}
