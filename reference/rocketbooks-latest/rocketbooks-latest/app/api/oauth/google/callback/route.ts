import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { oauthConnections } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { exchangeCodeForTokens, getUserInfo, GOOGLE_SCOPES } from '@/lib/oauth/google';
import { encryptOauthSecret } from '@/lib/oauth/crypto';
import { logger } from '@/lib/logger';

const STATE_COOKIE = 'rs_google_oauth_state';
const FINAL_REDIRECT = '/organizer/dashboard';

/**
 * Google sends the browser back here with ?code=… and the same
 * `state` we generated in /start. We:
 *   1. Verify state matches the cookie. Mismatch = CSRF; bail.
 *   2. Exchange code → tokens.
 *   3. Hit userinfo to capture the account email.
 *   4. Encrypt tokens, upsert into oauth_connections.
 *   5. Redirect to /organizer/dashboard.
 */
export async function GET(req: Request) {
	const user = await requireSession();
	const userId = await getEffectiveUserId();
	const url = new URL(req.url);
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const errorParam = url.searchParams.get('error');

	const stateCookie = req.headers
		.get('cookie')
		?.split(';')
		.map((c) => c.trim())
		.find((c) => c.startsWith(`${STATE_COOKIE}=`))
		?.slice(STATE_COOKIE.length + 1);

	const clearStateCookie = (res: NextResponse) => {
		res.cookies.set(STATE_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
		return res;
	};

	if (errorParam) {
		// User clicked "Cancel" on the consent screen, or Google rejected
		// the request. Send them back with a flag so the dashboard can
		// surface a non-scary message.
		return clearStateCookie(
			NextResponse.redirect(new URL(`${FINAL_REDIRECT}?google=denied`, req.url)),
		);
	}
	if (!code || !state) {
		return clearStateCookie(
			NextResponse.redirect(new URL(`${FINAL_REDIRECT}?google=invalid`, req.url)),
		);
	}
	if (!stateCookie || stateCookie !== state) {
		return clearStateCookie(
			NextResponse.redirect(new URL(`${FINAL_REDIRECT}?google=state_mismatch`, req.url)),
		);
	}

	try {
		const tokens = await exchangeCodeForTokens(code);
		const info = await getUserInfo(tokens.access_token);

		const encAccess = encryptOauthSecret(tokens.access_token);
		const encRefresh = tokens.refresh_token ? encryptOauthSecret(tokens.refresh_token) : null;
		const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
		const scope = tokens.scope || GOOGLE_SCOPES.join(' ');

		// Upsert keyed on (user_id, provider, account_email). Replacing
		// tokens on re-connect is intentional — if the user re-authorizes,
		// the new grant should win and we want a fresh access token.
		const existing = await db
			.select({ id: oauthConnections.id })
			.from(oauthConnections)
			.where(
				and(
					eq(oauthConnections.userId, userId),
					eq(oauthConnections.provider, 'google'),
					eq(oauthConnections.accountEmail, info.email),
				),
			)
			.limit(1);

		const baseValues = {
			provider: 'google',
			accountEmail: info.email,
			scope,
			encryptedAccessToken: encAccess.ciphertext,
			accessIv: encAccess.iv,
			accessAuthTag: encAccess.authTag,
			encryptedRefreshToken: encRefresh?.ciphertext ?? null,
			refreshIv: encRefresh?.iv ?? null,
			refreshAuthTag: encRefresh?.authTag ?? null,
			expiresAt,
			connectionStatus: 'ok',
			connectionError: null,
			updatedAt: new Date().toISOString(),
		};

		if (existing.length === 0) {
			await db.insert(oauthConnections).values({
				id: randomUUID(),
				userId,
				...baseValues,
				connectedAt: new Date().toISOString(),
			});
		} else {
			// Preserve the existing refresh token if Google didn't return
			// a new one (the access_type=offline + prompt=consent combo in
			// the start route should always give us one, but defend
			// anyway). Without this, a re-connect that omits the refresh
			// token would null the column and break future refreshes.
			const {
				encryptedRefreshToken: _r1,
				refreshIv: _r2,
				refreshAuthTag: _r3,
				...baseWithoutRefresh
			} = baseValues;
			void _r1; void _r2; void _r3;
			const updateValues = encRefresh ? baseValues : baseWithoutRefresh;
			await db
				.update(oauthConnections)
				.set(updateValues)
				.where(eq(oauthConnections.id, existing[0].id));
		}

		logger.info({ userId: user.id, accountEmail: info.email }, 'google calendar connected');
		return clearStateCookie(
			NextResponse.redirect(new URL(`${FINAL_REDIRECT}?google=connected`, req.url)),
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn({ userId: user.id, err: msg }, 'google oauth callback failed');
		return clearStateCookie(
			NextResponse.redirect(
				new URL(`${FINAL_REDIRECT}?google=error&detail=${encodeURIComponent(msg)}`, req.url),
			),
		);
	}
}
