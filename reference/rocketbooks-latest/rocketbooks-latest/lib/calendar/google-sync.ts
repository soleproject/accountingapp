import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { appointments, contacts, oauthConnections } from '@/db/schema/schema';
import { getValidGoogleAccessToken } from '@/lib/calendar/google';
import { logger } from '@/lib/logger';

/**
 * Two-way sync between Google Calendar and the internal appointments
 * table. Read direction lives here; write direction is in create_appointment
 * (lib/ai/tools.ts) and pushes to Google before inserting locally.
 *
 * Strategy: Google's events.list with `syncToken`. First call (token
 * missing) does a full pull over a sensible window (-7 days … +90 days,
 * showDeleted=true) and stores nextSyncToken. Subsequent calls send the
 * token and get only changes since the previous sync — typically a few
 * KB and milliseconds even on busy calendars.
 *
 * Stale-token recovery: Google returns HTTP 410 when a syncToken has
 * expired (~30 days of inactivity, or after an aged-out window). We
 * clear our token and one-shot retry a full pull. If that also fails
 * we surface an error and try again on the next sync attempt.
 *
 * Conflict policy:
 *   - cancelled event → delete the matching internal row if any.
 *   - new/updated event → upsert by (user_id, google_event_id). Rows
 *     without a google_event_id are NOT touched, so AI/manual-only
 *     local rows survive even if their content happens to overlap.
 *   - org_id on inserted rows: we use the user's active org. A future
 *     refinement could honor a per-event org tag from the description
 *     or attendees list.
 */

const FULL_WINDOW_PAST_DAYS = 7;
const FULL_WINDOW_FUTURE_DAYS = 90;
const PAGE_SIZE = 250; // Google caps at 2500, but smaller pages keep
// per-request latency low and let us bail on partial failures cleanly.

export interface SyncResult {
	ok: boolean;
	connected: 'ok' | 'auth_failed' | 'error' | false;
	mode: 'full' | 'incremental' | 'skipped';
	applied: number;
	deleted: number;
	error?: string;
}

interface GoogleApiEvent {
	id: string;
	status?: 'confirmed' | 'tentative' | 'cancelled';
	summary?: string;
	description?: string;
	location?: string;
	htmlLink?: string;
	start?: { dateTime?: string; date?: string; timeZone?: string };
	end?: { dateTime?: string; date?: string; timeZone?: string };
	attendees?: Array<{ email?: string; responseStatus?: string }>;
	organizer?: { email?: string; self?: boolean };
}

interface ListResponse {
	items?: GoogleApiEvent[];
	nextPageToken?: string;
	nextSyncToken?: string;
}

async function fetchUserOrgId(userId: string): Promise<string | null> {
	// Inserted google-only events need an org_id — this is the "regarding
	// company" the event defaults to. Prefer the user's ACTIVE org (the
	// workspace they're currently in), then their primary org. Only as a
	// last resort fall back to whatever org an existing appointment row
	// already uses. Returns null if none resolve — caller skips the insert.
	//
	// (Previously this looked at an existing appointment row FIRST, which
	// caused every synced event to inherit the org of the first row seen —
	// often the wrong company. The user re-assigns per-event in the UI; this
	// just sets a saner default for new pulls.)
	const { users } = await import('@/db/schema/schema');
	const [u] = await db
		.select({ active: users.activeOrganizationId, org: users.organizationId })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (u?.active) return u.active;
	if (u?.org) return u.org;
	const [profile] = await db
		.select({ org: appointments.organizationId })
		.from(appointments)
		.where(eq(appointments.userId, userId))
		.limit(1);
	return profile?.org ?? null;
}

function normalizeTimes(e: GoogleApiEvent): { startsAt: string | null; endsAt: string | null } {
	// Treat all-day events as midnight UTC for storage. The dashboard's
	// "today" bounds compare ISO strings inclusively, so this lines up
	// fine; a tz-aware variant comes when we add per-user timezones.
	const startsAt = e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00Z` : null);
	const endsAt = e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00Z` : null);
	return { startsAt, endsAt };
}

async function matchContactFromAttendees(
	orgId: string,
	e: GoogleApiEvent,
): Promise<string | null> {
	const candidateEmails = (e.attendees ?? [])
		.map((a) => a.email)
		.filter((x): x is string => !!x)
		.filter((email) => !e.organizer || email !== e.organizer.email);
	if (candidateEmails.length === 0) return null;
	// Bounded match — only resolve if exactly one attendee maps to a
	// known contact in this org. Ambiguous (multiple matches) leaves
	// contactId null; the user can wire it manually if they care.
	for (const email of candidateEmails) {
		const matches = await db
			.select({ id: contacts.id })
			.from(contacts)
			.where(and(eq(contacts.organizationId, orgId), eq(contacts.email, email)))
			.limit(2);
		if (matches.length === 1) return matches[0].id;
	}
	return null;
}

async function listEventsPage(
	accessToken: string,
	params: URLSearchParams,
): Promise<{ ok: true; data: ListResponse } | { ok: false; status: number; detail: string }> {
	const res = await fetch(
		`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
		{ headers: { Authorization: `Bearer ${accessToken}` } },
	);
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		return { ok: false, status: res.status, detail };
	}
	return { ok: true, data: (await res.json()) as ListResponse };
}

async function applyEvent(
	userId: string,
	orgId: string,
	e: GoogleApiEvent,
): Promise<{ deleted?: true; applied?: true }> {
	if (e.status === 'cancelled') {
		const result = await db
			.delete(appointments)
			.where(and(eq(appointments.userId, userId), eq(appointments.googleEventId, e.id)))
			.returning({ id: appointments.id });
		return result.length > 0 ? { deleted: true } : {};
	}

	const { startsAt, endsAt } = normalizeTimes(e);
	if (!startsAt) return {}; // No start time means we can't slot it; skip.

	const [existing] = await db
		.select({
			id: appointments.id,
			contactId: appointments.contactId,
			source: appointments.source,
		})
		.from(appointments)
		.where(and(eq(appointments.userId, userId), eq(appointments.googleEventId, e.id)))
		.limit(1);

	if (existing) {
		await db
			.update(appointments)
			.set({
				title: e.summary ?? '(no title)',
				description: e.description ?? null,
				startsAt,
				endsAt,
				location: e.location ?? null,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(appointments.id, existing.id));
		return { applied: true };
	}

	const contactId = await matchContactFromAttendees(orgId, e);
	await db.insert(appointments).values({
		id: randomUUID(),
		userId,
		organizationId: orgId,
		contactId,
		title: e.summary ?? '(no title)',
		description: e.description ?? null,
		startsAt,
		endsAt,
		location: e.location ?? null,
		source: 'google',
		googleEventId: e.id,
	});
	return { applied: true };
}

export async function syncGoogleCalendarForUser(userId: string): Promise<SyncResult> {
	const status = await getValidGoogleAccessToken(userId);
	if (status.kind === 'no_connection') {
		return { ok: false, connected: false, mode: 'skipped', applied: 0, deleted: 0 };
	}
	if (status.kind === 'auth_failed') {
		return { ok: false, connected: 'auth_failed', mode: 'skipped', applied: 0, deleted: 0 };
	}
	if (status.kind === 'error') {
		return {
			ok: false,
			connected: 'error',
			mode: 'skipped',
			applied: 0,
			deleted: 0,
			error: status.reason,
		};
	}

	const orgId = await fetchUserOrgId(userId);
	if (!orgId) {
		// No org context to attach inserts to. Skip rather than crashing.
		return { ok: false, connected: 'ok', mode: 'skipped', applied: 0, deleted: 0, error: 'no_org' };
	}

	const [conn] = await db
		.select({
			id: oauthConnections.id,
			syncToken: oauthConnections.calendarSyncToken,
		})
		.from(oauthConnections)
		.where(eq(oauthConnections.id, status.connection.id))
		.limit(1);
	if (!conn) {
		return { ok: false, connected: 'error', mode: 'skipped', applied: 0, deleted: 0, error: 'connection_missing' };
	}

	let mode: 'full' | 'incremental' = conn.syncToken ? 'incremental' : 'full';
	let token: string | null | undefined = conn.syncToken ?? null;
	let applied = 0;
	let deleted = 0;
	let attempt = 0;

	while (attempt < 2) {
		attempt += 1;
		let pageToken: string | undefined;
		let lastSyncToken: string | undefined;
		let stalePullForRetry = false;

		do {
			const params = new URLSearchParams({ maxResults: String(PAGE_SIZE), singleEvents: 'true' });
			if (mode === 'incremental' && token) {
				params.set('syncToken', token);
			} else {
				// Full sync window. orderBy/timeMin/timeMax not allowed when
				// syncToken is set — Google enforces this server-side.
				const now = new Date();
				const past = new Date(now.getTime() - FULL_WINDOW_PAST_DAYS * 86_400_000).toISOString();
				const future = new Date(now.getTime() + FULL_WINDOW_FUTURE_DAYS * 86_400_000).toISOString();
				params.set('timeMin', past);
				params.set('timeMax', future);
				params.set('showDeleted', 'true');
			}
			if (pageToken) params.set('pageToken', pageToken);

			const page = await listEventsPage(status.accessToken, params);
			if (!page.ok) {
				if (page.status === 410 && mode === 'incremental') {
					// Sync token expired. Clear it, retry as full sync once.
					logger.info({ userId }, 'google calendar sync token expired; falling back to full sync');
					await db
						.update(oauthConnections)
						.set({
							calendarSyncToken: null,
							calendarSyncTokenUpdatedAt: new Date().toISOString(),
							updatedAt: new Date().toISOString(),
						})
						.where(eq(oauthConnections.id, conn.id));
					mode = 'full';
					token = null;
					stalePullForRetry = true;
					break;
				}
				logger.warn(
					{ userId, kind: 'sync', httpStatus: page.status, detail: page.detail },
					'google calendar sync failed',
				);
				return {
					ok: false,
					connected: page.status === 401 ? 'auth_failed' : 'error',
					mode,
					applied,
					deleted,
					error: `list ${page.status}: ${page.detail.slice(0, 200)}`,
				};
			}

			for (const ev of page.data.items ?? []) {
				try {
					const r = await applyEvent(userId, orgId, ev);
					if (r.applied) applied += 1;
					if (r.deleted) deleted += 1;
				} catch (err) {
					logger.warn(
						{ userId, eventId: ev.id, err: err instanceof Error ? err.message : String(err) },
						'failed to apply event during sync',
					);
				}
			}

			pageToken = page.data.nextPageToken;
			if (page.data.nextSyncToken) lastSyncToken = page.data.nextSyncToken;
		} while (pageToken);

		if (stalePullForRetry) continue; // restart loop in full mode

		if (lastSyncToken) {
			await db
				.update(oauthConnections)
				.set({
					calendarSyncToken: lastSyncToken,
					calendarSyncTokenUpdatedAt: new Date().toISOString(),
					connectionStatus: 'ok',
					connectionError: null,
					lastSyncedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				})
				.where(eq(oauthConnections.id, conn.id));
		} else {
			// Multi-page sync that never returned a nextSyncToken — rare,
			// but possible if Google's pagination ended without one. Don't
			// persist a partial state; next call retries from scratch.
			await db
				.update(oauthConnections)
				.set({ lastSyncedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
				.where(eq(oauthConnections.id, conn.id));
		}

		return { ok: true, connected: 'ok', mode, applied, deleted };
	}

	return { ok: false, connected: 'error', mode, applied, deleted, error: 'retry_exhausted' };
}
