import 'server-only';
import { logger } from '@/lib/logger';

/**
 * Google OAuth 2.0 helpers for the Calendar integration. No SDK
 * dependency — plain fetch against Google's OAuth + UserInfo endpoints.
 *
 * Flow:
 *   1. /api/oauth/google/start  → builds auth URL with `state` cookie,
 *      302s the browser to Google.
 *   2. Google redirects back to /api/oauth/google/callback?code=…&state=…
 *   3. Callback verifies state, calls exchangeCodeForTokens, calls
 *      getUserInfo to capture account_email, encrypts, persists.
 *
 * Refresh:
 *   Access tokens expire after ~1 hour. refreshAccessToken hits the
 *   token endpoint with grant_type=refresh_token. If Google returns
 *   invalid_grant the refresh token is dead (user revoked) and the
 *   caller should mark the connection auth_failed.
 *
 * Revoke:
 *   POST to https://oauth2.googleapis.com/revoke?token=… on disconnect
 *   so Google forgets the grant. Best-effort — we delete the row
 *   regardless so the user isn't stuck with a half-revoked state.
 */

export const GOOGLE_SCOPES = [
	// calendar.events grants read + write on events on every calendar the
	// user owns. We started with calendar.readonly when sync was one-way;
	// once create_appointment + update_appointment + delete_appointment
	// went in we need the write permission too. Users connected under
	// the old scope must disconnect + reconnect to grant the new one.
	'https://www.googleapis.com/auth/calendar.events',
	'https://www.googleapis.com/auth/userinfo.email',
	'openid',
] as const;

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

function clientCreds(): { clientId: string; clientSecret: string } {
	const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
	const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
	if (!clientId || !clientSecret) {
		throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET not set.');
	}
	return { clientId, clientSecret };
}

export function isGoogleOauthConfigured(): boolean {
	return !!process.env.GOOGLE_OAUTH_CLIENT_ID && !!process.env.GOOGLE_OAUTH_CLIENT_SECRET;
}

export function googleRedirectUri(): string {
	// NEXT_PUBLIC_APP_URL is the canonical base; fall back to localhost
	// for dev. The same value MUST be registered on the Google Cloud
	// OAuth client's "Authorized redirect URIs" list.
	const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
	return `${base.replace(/\/$/, '')}/api/oauth/google/callback`;
}

export function buildAuthUrl(state: string): string {
	const { clientId } = clientCreds();
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: googleRedirectUri(),
		response_type: 'code',
		scope: GOOGLE_SCOPES.join(' '),
		// access_type=offline + prompt=consent are what gets us a refresh
		// token. Without prompt=consent, Google returns refresh_token only
		// on the user's first authorization — re-connects with the same
		// scope return access_token only and we end up without a way to
		// refresh after the access token expires.
		access_type: 'offline',
		prompt: 'consent',
		include_granted_scopes: 'true',
		state,
	});
	return `${AUTH_URL}?${params.toString()}`;
}

export interface GoogleTokenResponse {
	access_token: string;
	expires_in: number; // seconds from now
	refresh_token?: string;
	scope: string;
	token_type: 'Bearer';
	id_token?: string;
}

export async function exchangeCodeForTokens(code: string): Promise<GoogleTokenResponse> {
	const { clientId, clientSecret } = clientCreds();
	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			code,
			client_id: clientId,
			client_secret: clientSecret,
			redirect_uri: googleRedirectUri(),
			grant_type: 'authorization_code',
		}).toString(),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`Google token exchange failed (${res.status}): ${detail}`);
	}
	return (await res.json()) as GoogleTokenResponse;
}

export interface RefreshResult {
	access_token: string;
	expires_in: number;
	scope: string;
	token_type: 'Bearer';
	/** Present only on rare re-issues. Usually the refresh token is reused. */
	refresh_token?: string;
}

export async function refreshAccessToken(refreshToken: string): Promise<RefreshResult> {
	const { clientId, clientSecret } = clientCreds();
	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			refresh_token: refreshToken,
			client_id: clientId,
			client_secret: clientSecret,
			grant_type: 'refresh_token',
		}).toString(),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`Google token refresh failed (${res.status}): ${detail}`);
	}
	return (await res.json()) as RefreshResult;
}

export interface GoogleUserInfo {
	sub: string;
	email: string;
	email_verified?: boolean;
	name?: string;
	picture?: string;
}

export async function getUserInfo(accessToken: string): Promise<GoogleUserInfo> {
	const res = await fetch(USERINFO_URL, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`Google userinfo failed (${res.status}): ${detail}`);
	}
	return (await res.json()) as GoogleUserInfo;
}

export async function revokeToken(token: string): Promise<boolean> {
	// Best-effort — the calling endpoint deletes the row whether this
	// succeeds or not. Logging the failure is enough; the user has done
	// their part by clicking "disconnect".
	try {
		const res = await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		});
		if (!res.ok) {
			const detail = await res.text().catch(() => '');
			logger.warn({ status: res.status, detail }, 'google revoke returned non-2xx');
		}
		return res.ok;
	} catch (err) {
		logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'google revoke threw');
		return false;
	}
}
