import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { oauthConnections } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { decryptOauthSecret } from '@/lib/oauth/crypto';
import { revokeToken } from '@/lib/oauth/google';
import { logger } from '@/lib/logger';

/**
 * Disconnect the user's Google Calendar:
 *   1. Best-effort revoke at Google (so the grant disappears from the
 *      user's Google account permissions page too).
 *   2. Delete the oauth_connections row.
 *
 * Either step failing alone shouldn't block the other. The row delete
 * is the part that actually stops us from using the connection.
 *
 * POST instead of DELETE so a plain HTML form can submit it without
 * client-side fetch wiring.
 */
export async function POST() {
	await requireSession();
	const userId = await getEffectiveUserId();

	const rows = await db
		.select({
			id: oauthConnections.id,
			encryptedRefreshToken: oauthConnections.encryptedRefreshToken,
			refreshIv: oauthConnections.refreshIv,
			refreshAuthTag: oauthConnections.refreshAuthTag,
			encryptedAccessToken: oauthConnections.encryptedAccessToken,
			accessIv: oauthConnections.accessIv,
			accessAuthTag: oauthConnections.accessAuthTag,
		})
		.from(oauthConnections)
		.where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, 'google')));

	for (const row of rows) {
		// Prefer revoking the refresh token (kills all derived access
		// tokens at once). Fall back to the access token if that's all
		// we have.
		let tokenToRevoke: string | null = null;
		if (row.encryptedRefreshToken && row.refreshIv && row.refreshAuthTag) {
			try {
				tokenToRevoke = decryptOauthSecret({
					ciphertext: row.encryptedRefreshToken,
					iv: row.refreshIv,
					authTag: row.refreshAuthTag,
				});
			} catch (err) {
				logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'failed to decrypt refresh token during disconnect');
			}
		}
		if (!tokenToRevoke) {
			try {
				tokenToRevoke = decryptOauthSecret({
					ciphertext: row.encryptedAccessToken,
					iv: row.accessIv,
					authTag: row.accessAuthTag,
				});
			} catch (err) {
				logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'failed to decrypt access token during disconnect');
			}
		}
		if (tokenToRevoke) await revokeToken(tokenToRevoke);
	}

	await db
		.delete(oauthConnections)
		.where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, 'google')));

	return NextResponse.redirect(new URL('/organizer/dashboard?google=disconnected', process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'));
}
