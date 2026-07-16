import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { oauthConnections } from '@/db/schema/schema';
import { decryptOauthSecret, encryptOauthSecret } from '@/lib/oauth/crypto';
import { refreshAccessToken } from '@/lib/oauth/google';
import { logger } from '@/lib/logger';

/**
 * Google Calendar bridge for the Organizer.
 *
 * Read path: listGoogleEventsForUser fetches events for a window
 * (today, currently) so the dashboard can merge them with internal
 * appointments.
 *
 * Write path: createGoogleEvent pushes an internal appointment to the
 * user's primary calendar; the caller stores the returned event id on
 * the internal row so the read path can dedup the mirror.
 *
 * Both paths share getValidGoogleAccessToken, which loads the
 * connection row, decrypts the access token, refreshes it if it's
 * within a 60s buffer of expiry, and persists the refreshed value.
 */

const REFRESH_BUFFER_MS = 60_000;

export interface GoogleConnectionView {
	id: string;
	accountEmail: string;
}

type TokenStatus =
	| { kind: 'no_connection' }
	| { kind: 'auth_failed'; connection: GoogleConnectionView }
	| { kind: 'error'; connection: GoogleConnectionView; reason: string }
	| { kind: 'ok'; connection: GoogleConnectionView; accessToken: string };

export async function getValidGoogleAccessToken(userId: string): Promise<TokenStatus> {
	const [row] = await db
		.select({
			id: oauthConnections.id,
			accountEmail: oauthConnections.accountEmail,
			encryptedAccessToken: oauthConnections.encryptedAccessToken,
			accessIv: oauthConnections.accessIv,
			accessAuthTag: oauthConnections.accessAuthTag,
			encryptedRefreshToken: oauthConnections.encryptedRefreshToken,
			refreshIv: oauthConnections.refreshIv,
			refreshAuthTag: oauthConnections.refreshAuthTag,
			expiresAt: oauthConnections.expiresAt,
		})
		.from(oauthConnections)
		.where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, 'google')))
		.limit(1);

	if (!row) return { kind: 'no_connection' };
	const connection: GoogleConnectionView = { id: row.id, accountEmail: row.accountEmail };

	let accessToken: string;
	try {
		accessToken = decryptOauthSecret({
			ciphertext: row.encryptedAccessToken,
			iv: row.accessIv,
			authTag: row.accessAuthTag,
		});
	} catch (err) {
		logger.warn({ userId, err: err instanceof Error ? err.message : String(err) }, 'failed to decrypt google access token');
		return { kind: 'error', connection, reason: 'decrypt_failed' };
	}

	const expiresAtMs = row.expiresAt ? Date.parse(row.expiresAt) : 0;
	const isExpired = !expiresAtMs || expiresAtMs - Date.now() < REFRESH_BUFFER_MS;
	if (!isExpired) return { kind: 'ok', connection, accessToken };

	if (!row.encryptedRefreshToken || !row.refreshIv || !row.refreshAuthTag) {
		await db
			.update(oauthConnections)
			.set({ connectionStatus: 'auth_failed', connectionError: 'no refresh token', updatedAt: new Date().toISOString() })
			.where(eq(oauthConnections.id, row.id));
		return { kind: 'auth_failed', connection };
	}

	let refreshToken: string;
	try {
		refreshToken = decryptOauthSecret({
			ciphertext: row.encryptedRefreshToken,
			iv: row.refreshIv,
			authTag: row.refreshAuthTag,
		});
	} catch (err) {
		logger.warn({ userId, err: err instanceof Error ? err.message : String(err) }, 'failed to decrypt google refresh token');
		return { kind: 'error', connection, reason: 'decrypt_failed' };
	}
	try {
		const refreshed = await refreshAccessToken(refreshToken);
		const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
		const enc = encryptOauthSecret(refreshed.access_token);
		const newRefresh = refreshed.refresh_token ? encryptOauthSecret(refreshed.refresh_token) : null;
		await db
			.update(oauthConnections)
			.set({
				encryptedAccessToken: enc.ciphertext,
				accessIv: enc.iv,
				accessAuthTag: enc.authTag,
				...(newRefresh
					? {
							encryptedRefreshToken: newRefresh.ciphertext,
							refreshIv: newRefresh.iv,
							refreshAuthTag: newRefresh.authTag,
					  }
					: {}),
				expiresAt: newExpiresAt,
				connectionStatus: 'ok',
				connectionError: null,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(oauthConnections.id, row.id));
		return { kind: 'ok', connection, accessToken: refreshed.access_token };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn({ userId, err: msg }, 'google token refresh failed');
		const authFailed = /invalid_grant/i.test(msg);
		await db
			.update(oauthConnections)
			.set({
				connectionStatus: authFailed ? 'auth_failed' : 'connect_failed',
				connectionError: msg,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(oauthConnections.id, row.id));
		return authFailed
			? { kind: 'auth_failed', connection }
			: { kind: 'error', connection, reason: msg };
	}
}

/**
 * Lightweight connection-status probe for the dashboard's "Connect"
 * CTA. Doesn't refresh or hit Google — just looks at the row's
 * connection_status and account_email. Use when you only need to
 * decide whether to surface a connect / reconnect button, not to make
 * an actual API call.
 */
export async function getGoogleConnectionStatus(userId: string): Promise<{
	connected: 'ok' | 'auth_failed' | 'error' | false;
	accountEmail: string | null;
}> {
	const [row] = await db
		.select({
			accountEmail: oauthConnections.accountEmail,
			connectionStatus: oauthConnections.connectionStatus,
		})
		.from(oauthConnections)
		.where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, 'google')))
		.limit(1);
	if (!row) return { connected: false, accountEmail: null };
	const s = row.connectionStatus;
	const connected: 'ok' | 'auth_failed' | 'error' =
		s === 'ok' ? 'ok' : s === 'auth_failed' ? 'auth_failed' : 'error';
	return { connected, accountEmail: row.accountEmail };
}

// ---- Read: list events ----

export interface NormalizedGoogleEvent {
	source: 'google';
	id: string; // prefixed: 'g:' + google event id
	googleEventId: string; // raw, no prefix — used for dedup against internal rows
	title: string;
	startsAt: string;
	endsAt: string | null;
	location: string | null;
	contactId: null;
	contactName: null;
	htmlLink: string | null;
}

export interface ListResult {
	connected: 'ok' | 'auth_failed' | 'error' | false;
	accountEmail: string | null;
	events: NormalizedGoogleEvent[];
}

export async function listGoogleEventsForUser(
	userId: string,
	opts: { timeMin: string; timeMax: string; maxResults?: number },
): Promise<ListResult> {
	const status = await getValidGoogleAccessToken(userId);
	if (status.kind === 'no_connection') return { connected: false, accountEmail: null, events: [] };
	if (status.kind === 'auth_failed')
		return { connected: 'auth_failed', accountEmail: status.connection.accountEmail, events: [] };
	if (status.kind === 'error')
		return { connected: 'error', accountEmail: status.connection.accountEmail, events: [] };

	const params = new URLSearchParams({
		timeMin: opts.timeMin,
		timeMax: opts.timeMax,
		singleEvents: 'true',
		orderBy: 'startTime',
		maxResults: String(opts.maxResults ?? 20),
	});

	try {
		const res = await fetch(
			`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
			{ headers: { Authorization: `Bearer ${status.accessToken}` } },
		);
		if (!res.ok) {
			const detail = await res.text().catch(() => '');
			logger.warn({ userId, kind: 'list', httpStatus: res.status, detail }, 'google calendar list failed');
			await db
				.update(oauthConnections)
				.set({
					connectionStatus: res.status === 401 ? 'auth_failed' : 'connect_failed',
					connectionError: `list ${res.status}: ${detail.slice(0, 200)}`,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(oauthConnections.id, status.connection.id));
			return {
				connected: res.status === 401 ? 'auth_failed' : 'error',
				accountEmail: status.connection.accountEmail,
				events: [],
			};
		}
		const json = (await res.json()) as { items?: GoogleApiEvent[] };
		const events: NormalizedGoogleEvent[] = (json.items ?? [])
			.filter((e) => e.status !== 'cancelled')
			.map((e) => normalize(e))
			.filter((e): e is NormalizedGoogleEvent => e !== null);

		await db
			.update(oauthConnections)
			.set({ connectionStatus: 'ok', connectionError: null, lastSyncedAt: new Date().toISOString() })
			.where(eq(oauthConnections.id, status.connection.id));

		return { connected: 'ok', accountEmail: status.connection.accountEmail, events };
	} catch (err) {
		logger.warn({ userId, err: err instanceof Error ? err.message : String(err) }, 'google calendar fetch threw');
		return { connected: 'error', accountEmail: status.connection.accountEmail, events: [] };
	}
}

interface GoogleApiEvent {
	id: string;
	status?: string;
	summary?: string;
	location?: string;
	htmlLink?: string;
	start?: { dateTime?: string; date?: string; timeZone?: string };
	end?: { dateTime?: string; date?: string; timeZone?: string };
}

function normalize(e: GoogleApiEvent): NormalizedGoogleEvent | null {
	const start = e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00Z` : null);
	if (!start) return null;
	const end = e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00Z` : null);
	return {
		source: 'google',
		id: `g:${e.id}`,
		googleEventId: e.id,
		title: e.summary ?? '(no title)',
		startsAt: start,
		endsAt: end,
		location: e.location ?? null,
		contactId: null,
		contactName: null,
		htmlLink: e.htmlLink ?? null,
	};
}

// ---- Write: create event ----

export interface CreateEventInput {
	title: string;
	startsAt: string; // ISO
	endsAt?: string | null;
	description?: string | null;
	location?: string | null;
	/** Optional attendee emails (e.g. the linked contact's email). */
	attendees?: string[];
}

export interface CreateEventResult {
	ok: boolean;
	id?: string;
	htmlLink?: string;
	/** Set when ok=false; one of 'no_connection' | 'auth_failed' | 'error'. */
	reason?: 'no_connection' | 'auth_failed' | 'error';
	error?: string;
}

export interface PatchEventInput {
	title?: string;
	startsAt?: string;
	endsAt?: string | null;
	description?: string | null;
	location?: string | null;
}

export interface MutateEventResult {
	ok: boolean;
	id?: string;
	htmlLink?: string;
	/**
	 * 'gone' means Google returned 404/410 — the event isn't there
	 * anymore. Treat the same as success for delete; for update it's
	 * still a soft-success since the row is effectively cancelled.
	 */
	reason?: 'no_connection' | 'auth_failed' | 'gone' | 'error';
	error?: string;
}

export async function updateGoogleEvent(
	userId: string,
	googleEventId: string,
	patch: PatchEventInput,
): Promise<MutateEventResult> {
	const status = await getValidGoogleAccessToken(userId);
	if (status.kind === 'no_connection') return { ok: false, reason: 'no_connection' };
	if (status.kind === 'auth_failed') return { ok: false, reason: 'auth_failed' };
	if (status.kind === 'error') return { ok: false, reason: 'error', error: status.reason };

	// Build a sparse body — Google's PATCH only touches fields present
	// in the request, so omitted = keep current. Explicit null on
	// description/location clears the value on Google's side.
	const body: Record<string, unknown> = {};
	if (patch.title !== undefined) body.summary = patch.title;
	if (patch.startsAt !== undefined) body.start = { dateTime: patch.startsAt };
	if (patch.endsAt !== undefined) {
		body.end = patch.endsAt ? { dateTime: patch.endsAt } : null;
	}
	if (patch.description !== undefined) body.description = patch.description;
	if (patch.location !== undefined) body.location = patch.location;

	try {
		const res = await fetch(
			`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(googleEventId)}`,
			{
				method: 'PATCH',
				headers: {
					Authorization: `Bearer ${status.accessToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
			},
		);
		if (res.status === 404 || res.status === 410) {
			return { ok: false, reason: 'gone' };
		}
		if (!res.ok) {
			const detail = await res.text().catch(() => '');
			logger.warn({ userId, kind: 'patch', httpStatus: res.status, detail }, 'google calendar patch failed');
			if (res.status === 401) {
				await db
					.update(oauthConnections)
					.set({
						connectionStatus: 'auth_failed',
						connectionError: `patch ${res.status}: ${detail.slice(0, 200)}`,
						updatedAt: new Date().toISOString(),
					})
					.where(eq(oauthConnections.id, status.connection.id));
				return { ok: false, reason: 'auth_failed', error: detail.slice(0, 500) };
			}
			return { ok: false, reason: 'error', error: detail.slice(0, 500) };
		}
		const json = (await res.json()) as { id?: string; htmlLink?: string };
		await db
			.update(oauthConnections)
			.set({ lastSyncedAt: new Date().toISOString() })
			.where(eq(oauthConnections.id, status.connection.id));
		return { ok: true, id: json.id, htmlLink: json.htmlLink };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn({ userId, err: msg }, 'google calendar patch threw');
		return { ok: false, reason: 'error', error: msg };
	}
}

export async function deleteGoogleEvent(
	userId: string,
	googleEventId: string,
): Promise<MutateEventResult> {
	const status = await getValidGoogleAccessToken(userId);
	if (status.kind === 'no_connection') return { ok: false, reason: 'no_connection' };
	if (status.kind === 'auth_failed') return { ok: false, reason: 'auth_failed' };
	if (status.kind === 'error') return { ok: false, reason: 'error', error: status.reason };

	try {
		const res = await fetch(
			`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(googleEventId)}`,
			{
				method: 'DELETE',
				headers: { Authorization: `Bearer ${status.accessToken}` },
			},
		);
		// 204 = deleted, 404 = never existed, 410 = already gone.
		// All three are success-equivalent for delete — the row should
		// not be on Google after this call no matter what.
		if (res.status === 204) {
			return { ok: true };
		}
		if (res.status === 404 || res.status === 410) {
			return { ok: false, reason: 'gone' };
		}
		const detail = await res.text().catch(() => '');
		logger.warn({ userId, kind: 'delete', httpStatus: res.status, detail }, 'google calendar delete failed');
		if (res.status === 401) {
			await db
				.update(oauthConnections)
				.set({
					connectionStatus: 'auth_failed',
					connectionError: `delete ${res.status}: ${detail.slice(0, 200)}`,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(oauthConnections.id, status.connection.id));
			return { ok: false, reason: 'auth_failed', error: detail.slice(0, 500) };
		}
		return { ok: false, reason: 'error', error: detail.slice(0, 500) };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn({ userId, err: msg }, 'google calendar delete threw');
		return { ok: false, reason: 'error', error: msg };
	}
}

export async function createGoogleEvent(
	userId: string,
	input: CreateEventInput,
): Promise<CreateEventResult> {
	const status = await getValidGoogleAccessToken(userId);
	if (status.kind === 'no_connection') return { ok: false, reason: 'no_connection' };
	if (status.kind === 'auth_failed') return { ok: false, reason: 'auth_failed' };
	if (status.kind === 'error') return { ok: false, reason: 'error', error: status.reason };

	// Calendar API needs end time. If the caller omits it, default to a
	// 30-minute slot — a sensible "meeting block" length that mirrors
	// Google's own quick-add behavior.
	const endsAt = input.endsAt ?? new Date(Date.parse(input.startsAt) + 30 * 60 * 1000).toISOString();
	const body: Record<string, unknown> = {
		summary: input.title,
		description: input.description ?? undefined,
		location: input.location ?? undefined,
		start: { dateTime: input.startsAt },
		end: { dateTime: endsAt },
	};
	if (input.attendees && input.attendees.length > 0) {
		body.attendees = input.attendees.map((email) => ({ email }));
	}

	try {
		const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${status.accessToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const detail = await res.text().catch(() => '');
			logger.warn({ userId, kind: 'insert', httpStatus: res.status, detail }, 'google calendar insert failed');
			const reason = res.status === 401 ? 'auth_failed' : 'error';
			if (res.status === 401) {
				await db
					.update(oauthConnections)
					.set({
						connectionStatus: 'auth_failed',
						connectionError: `insert ${res.status}: ${detail.slice(0, 200)}`,
						updatedAt: new Date().toISOString(),
					})
					.where(eq(oauthConnections.id, status.connection.id));
			}
			return { ok: false, reason, error: detail.slice(0, 500) };
		}
		const json = (await res.json()) as { id?: string; htmlLink?: string };
		await db
			.update(oauthConnections)
			.set({ lastSyncedAt: new Date().toISOString() })
			.where(eq(oauthConnections.id, status.connection.id));
		return { ok: true, id: json.id, htmlLink: json.htmlLink };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn({ userId, err: msg }, 'google calendar create threw');
		return { ok: false, reason: 'error', error: msg };
	}
}
