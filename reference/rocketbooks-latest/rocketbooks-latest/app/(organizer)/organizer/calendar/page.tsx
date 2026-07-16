import Link from 'next/link';
import { eq, and, asc, gte, lt } from 'drizzle-orm';
import { db } from '@/db/client';
import { appointments, contacts, organizations } from '@/db/schema/schema';
import { getCurrentOrgId, listAccessibleOrgs } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { getGoogleConnectionStatus } from '@/lib/calendar/google';
import { syncGoogleCalendarForUser } from '@/lib/calendar/google-sync';
import { logger } from '@/lib/logger';
import { AutoRefreshOnAiAction } from '@/components/ai-assistant/AutoRefreshOnAiAction';
import { CalendarBody } from './_components/CalendarBody';
import { CreateEventButton } from './_components/CreateEventButton';
import { ViewMenu } from './_components/ViewMenu';
import {
  buildHref,
  dateKey,
  normalizeView,
  parseKey,
  rangeFor,
  shiftAnchor,
  todayMidnight,
  viewLabel,
} from './_components/viewmodel';
import type { CalendarAppointment } from './types';

interface PageProps {
  searchParams: Promise<{ view?: string; month?: string; date?: string }>;
}

/** Resolve the anchor day. Prefers `?date=YYYY-MM-DD`, falls back to the legacy
 *  `?month=YYYY-MM` (anchored to the 1st), else today — all in server local
 *  time (same tz approximation the dashboard and AI appointment tools use). */
function parseAnchor(date: string | undefined, month: string | undefined): Date {
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const d = parseKey(date);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number);
    if (m >= 1 && m <= 12) return new Date(y, m - 1, 1);
  }
  return todayMidnight();
}

function ConnectGoogleButton() {
  return (
    <a
      href="/api/oauth/google/start"
      className="inline-flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      Connect Google Calendar
    </a>
  );
}

export default async function OrganizerCalendarPage({ searchParams }: PageProps) {
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();
  const sp = await searchParams;

  const view = normalizeView(sp.view);
  const anchor = parseAnchor(sp.date, sp.month);

  // Keep the local appointments table fresh against Google before we read.
  // Best-effort: the page still renders against whatever is already stored
  // if the sync fails (mirrors the dashboard).
  await syncGoogleCalendarForUser(userId).catch((err: unknown) => {
    logger.warn(
      { userId, err: err instanceof Error ? err.message : String(err) },
      'organizer calendar: google sync threw',
    );
  });

  // Half-open [start, end) window the active view needs, in local time.
  const { start, end } = rangeFor(view, anchor);
  const rangeStart = start.toISOString();
  const rangeEnd = end.toISOString();

  const [rows, googleStatus, accessibleOrgs] = await Promise.all([
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
        videoEnabled: appointments.videoEnabled,
        guestEmails: appointments.guestEmails,
        organizationId: appointments.organizationId,
        organizationName: organizations.name,
      })
      .from(appointments)
      .leftJoin(contacts, eq(contacts.id, appointments.contactId))
      .leftJoin(organizations, eq(organizations.id, appointments.organizationId))
      .where(
        // The calendar is a per-USER view: it shows all of this user's
        // meetings across every company they work with, not just the org
        // currently selected in the workspace switcher. Each event carries a
        // "regarding {company}" label (its organization_id) instead. In the
        // shared demo workspace we drop the user filter and scope to the org
        // so the seeded examples render for any viewer (mirrors accounting).
        isDemoOrg(orgId)
          ? and(
              eq(appointments.organizationId, orgId),
              gte(appointments.startsAt, rangeStart),
              lt(appointments.startsAt, rangeEnd),
            )
          : and(
              eq(appointments.userId, userId),
              gte(appointments.startsAt, rangeStart),
              lt(appointments.startsAt, rangeEnd),
            ),
      )
      .orderBy(asc(appointments.startsAt)),
    getGoogleConnectionStatus(userId),
    listAccessibleOrgs(),
  ]);

  const appts: CalendarAppointment[] = rows;
  // Orgs the user can re-assign an event's "regarding company" to.
  const regardingOptions = accessibleOrgs.map((o) => ({ id: o.id, name: o.name }));

  const todayKey = dateKey(todayMidnight());
  const anchorKey = dateKey(anchor);
  const prevHref = buildHref(view, dateKey(shiftAnchor(view, anchor, -1)), todayKey);
  const nextHref = buildHref(view, dateKey(shiftAnchor(view, anchor, 1)), todayKey);
  const todayHref = buildHref(view, todayKey, todayKey);
  const label = viewLabel(view, anchor);
  // Demo workspace is read-only — hide create/edit/delete affordances.
  const canWrite = !isDemoOrg(orgId);

  const showConnectCta = googleStatus.connected === false;
  const showReconnectCta = googleStatus.connected === 'auth_failed';

  return (
    <div className="flex flex-col gap-4">
      <AutoRefreshOnAiAction />
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Calendar</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {label} · {appts.length}{' '}
            {appts.length === 1 ? 'appointment' : 'appointments'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canWrite && <CreateEventButton defaultDateKey={anchorKey} />}

          {/* Calendly-style booking links */}
          <Link
            href="/organizer/settings/booking"
            className="inline-flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Booking links
          </Link>

          {/* Date navigation with the view switcher nested between the arrows
              (steps by the active view's unit). */}
          <div className="flex items-center gap-1 rounded-md border border-zinc-200 bg-white p-1 text-sm dark:border-zinc-800 dark:bg-zinc-950">
            <Link
              href={prevHref}
              aria-label="Previous"
              className="rounded px-2 py-1 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
            >
              ←
            </Link>
            <ViewMenu view={view} anchorKey={anchorKey} todayKey={todayKey} bare />
            <Link
              href={nextHref}
              aria-label="Next"
              className="rounded px-2 py-1 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
            >
              →
            </Link>
          </div>

          {/* Today button */}
          <Link
            href={todayHref}
            className="inline-flex items-center rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Today
          </Link>
        </div>
      </header>

      {(showConnectCta || showReconnectCta) && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {showReconnectCta
              ? 'Google Calendar lost authorization — reconnect to keep your events in sync.'
              : 'Connect Google Calendar to see your real appointments here.'}
          </p>
          <ConnectGoogleButton />
        </div>
      )}

      <CalendarBody view={view} anchorKey={anchorKey} todayKey={todayKey} appointments={appts} canWrite={canWrite} regardingOptions={regardingOptions} />
    </div>
  );
}
