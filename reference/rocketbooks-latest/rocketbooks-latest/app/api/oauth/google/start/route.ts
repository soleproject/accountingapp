import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { requireSession } from '@/lib/auth/session';
import { buildAuthUrl, isGoogleOauthConfigured } from '@/lib/oauth/google';
import { isOauthKeyConfigured } from '@/lib/oauth/crypto';

/**
 * Kicks off the Google OAuth flow. Generates a random `state` value,
 * stashes it in an httpOnly cookie, and 302s the browser to Google's
 * consent screen. The callback handler reads the same cookie and
 * rejects if it doesn't match the `state` Google echoes back.
 */

const STATE_COOKIE = 'rs_google_oauth_state';
const STATE_TTL_SECONDS = 10 * 60; // 10 minutes — way more than any consent flow needs.

export async function GET() {
	await requireSession();

	if (!isGoogleOauthConfigured()) {
		return NextResponse.json(
			{ error: 'Google OAuth is not configured on the server (missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET).' },
			{ status: 503 },
		);
	}
	if (!isOauthKeyConfigured()) {
		return NextResponse.json(
			{ error: 'OAUTH_CREDS_KEY is not set; tokens cannot be encrypted.' },
			{ status: 503 },
		);
	}

	const state = randomBytes(24).toString('base64url');
	const authUrl = buildAuthUrl(state);
	const res = NextResponse.redirect(authUrl);
	res.cookies.set(STATE_COOKIE, state, {
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		path: '/',
		maxAge: STATE_TTL_SECONDS,
	});
	return res;
}
