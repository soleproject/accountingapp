import 'server-only';
import { randomUUID } from 'crypto';
import QRCode from 'qrcode';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { telegramConnections, telegramChats } from '@/db/schema/schema';
import { isTelegramConfigured, getBotUsername } from './telegram';

export interface TelegramConnectState {
	/** Whether the shared bot is configured (TELEGRAM_BOT_TOKEN set). */
	configured: boolean;
	botUsername: string | null;
	/** t.me/<bot>?start=<orgToken> — share with contacts/groups to connect them. */
	inviteLink: string | null;
	/** Data-URL PNG of the invite link (safe string to pass to the client). */
	qrDataUrl: string | null;
	/** How many Telegram chats are already linked to this org. */
	connectedChats: number;
}

/**
 * Ensure this org has a stable Telegram invite token and return everything the
 * Connect-Telegram UI needs. Idempotent get-or-create (safe on the org's unique
 * index). Degrades cleanly when the bot isn't configured yet.
 */
export async function getTelegramConnectState(orgId: string, userId: string): Promise<TelegramConnectState> {
	const configured = isTelegramConfigured();
	const botUsername = configured ? await getBotUsername() : null;

	let [conn] = await db
		.select({ inviteToken: telegramConnections.inviteToken })
		.from(telegramConnections)
		.where(eq(telegramConnections.organizationId, orgId))
		.limit(1);
	if (!conn) {
		await db
			.insert(telegramConnections)
			.values({
				id: randomUUID(),
				organizationId: orgId,
				inviteToken: randomUUID().replace(/-/g, ''),
				botUsername: botUsername ?? null,
				createdByUserId: userId,
			})
			.onConflictDoNothing();
		[conn] = await db
			.select({ inviteToken: telegramConnections.inviteToken })
			.from(telegramConnections)
			.where(eq(telegramConnections.organizationId, orgId))
			.limit(1);
	}

	const inviteLink = botUsername && conn?.inviteToken ? `https://t.me/${botUsername}?start=${conn.inviteToken}` : null;
	const qrDataUrl = inviteLink ? await QRCode.toDataURL(inviteLink, { margin: 1, width: 220 }) : null;

	const [countRow] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(telegramChats)
		.where(eq(telegramChats.organizationId, orgId));

	return { configured, botUsername, inviteLink, qrDataUrl, connectedChats: Number(countRow?.n ?? 0) };
}
