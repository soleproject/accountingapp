import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, telegramChats, telegramConnections, textMessages } from '@/db/schema/schema';
import { verifyTelegramSecret, sendTelegramMessage } from '@/lib/messaging/telegram';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

interface TgUser { id: number; first_name?: string; last_name?: string; username?: string }
interface TgChat { id: number; type: string; title?: string; first_name?: string; username?: string }
interface TgMessage { message_id: number; from?: TgUser; chat: TgChat; text?: string; date: number }
interface TgUpdate { update_id: number; message?: TgMessage }

function displayName(chat: TgChat, from?: TgUser): string {
	if (chat.type !== 'private' && chat.title) return chat.title;
	const parts = [from?.first_name, from?.last_name].filter(Boolean);
	if (parts.length) return parts.join(' ');
	if (from?.username) return `@${from.username}`;
	return `Telegram ${chat.id}`;
}

/** Get or create the contact a Telegram chat routes to, honoring the hidden
 *  UNIQUE(org, is_active, contact_name) constraint by suffixing on collision. */
async function ensureContact(orgId: string, name: string, chatId: string): Promise<string> {
	const base = name.slice(0, 120);
	for (const candidate of [base, `${base} (Telegram ${chatId.slice(-4)})`, `Telegram ${chatId}`]) {
		const id = randomUUID();
		const [row] = await db
			.insert(contacts)
			.values({ id, organizationId: orgId, contactName: candidate, isActive: true })
			.onConflictDoNothing()
			.returning({ id: contacts.id });
		if (row) return row.id;
		// Name taken by an active contact — reuse it if it's clearly this chat's, else try next.
		const [existing] = await db
			.select({ id: contacts.id })
			.from(contacts)
			.where(and(eq(contacts.organizationId, orgId), eq(contacts.contactName, candidate)))
			.limit(1);
		if (existing) return existing.id;
	}
	// Fallback: unnamed contact.
	const id = randomUUID();
	await db.insert(contacts).values({ id, organizationId: orgId, contactName: `Telegram ${randomUUID().slice(0, 8)}`, isActive: true });
	return id;
}

/** Link a chat to an org (idempotent). Returns the linked chat's contactId. */
async function linkChat(orgId: string, chat: TgChat, from: TgUser | undefined): Promise<string> {
	const chatId = String(chat.id);
	const [existing] = await db
		.select({ id: telegramChats.id, contactId: telegramChats.contactId })
		.from(telegramChats)
		.where(and(eq(telegramChats.organizationId, orgId), eq(telegramChats.chatId, chatId)))
		.limit(1);
	if (existing?.contactId) return existing.contactId;

	const contactId = await ensureContact(orgId, displayName(chat, from), chatId);
	if (existing) {
		await db.update(telegramChats).set({ contactId }).where(eq(telegramChats.id, existing.id));
	} else {
		await db.insert(telegramChats).values({
			id: randomUUID(),
			organizationId: orgId,
			chatId,
			chatType: chat.type,
			title: chat.type === 'private' ? null : chat.title ?? null,
			contactId,
		});
	}
	return contactId;
}

export async function POST(req: Request) {
	if (!verifyTelegramSecret(req)) {
		return NextResponse.json({ ok: false }, { status: 401 });
	}
	let update: TgUpdate;
	try {
		update = (await req.json()) as TgUpdate;
	} catch {
		return NextResponse.json({ ok: true }); // ack malformed so Telegram doesn't retry forever
	}
	const msg = update.message;
	if (!msg || !msg.chat) return NextResponse.json({ ok: true });

	const chatId = String(msg.chat.id);
	const text = msg.text ?? '';

	// /start <token> (or /link <token> in a group) → attribute this chat to an org.
	const startMatch = text.match(/^\/(?:start|link)(?:@\w+)?\s+([A-Za-z0-9_-]{8,})/);
	if (startMatch) {
		const inviteToken = startMatch[1];
		const [conn] = await db
			.select({ orgId: telegramConnections.organizationId })
			.from(telegramConnections)
			.where(eq(telegramConnections.inviteToken, inviteToken))
			.limit(1);
		if (!conn) {
			await sendTelegramMessage(chatId, "That link isn't valid or has expired. Please use the Connect Telegram link from your Rocketbooks workspace.");
			return NextResponse.json({ ok: true });
		}
		await linkChat(conn.orgId, msg.chat, msg.from);
		await sendTelegramMessage(chatId, '✅ Connected to Rocketbooks. Messages here will now show up in your workspace, and replies from Rocketbooks will come back to you here.');
		return NextResponse.json({ ok: true });
	}

	// Regular message — route to the org this chat is linked to.
	const [link] = await db
		.select({ orgId: telegramChats.organizationId, contactId: telegramChats.contactId })
		.from(telegramChats)
		.where(eq(telegramChats.chatId, chatId))
		.limit(1);
	if (!link) {
		// Unlinked chat messaging the bot without a token — nudge them to connect.
		if (msg.chat.type === 'private') {
			await sendTelegramMessage(chatId, 'To connect this chat, open Rocketbooks → Texts → Connect Telegram and use the link there.');
		}
		return NextResponse.json({ ok: true });
	}

	if (!text.trim()) return NextResponse.json({ ok: true }); // skip non-text (photos/stickers) in V1

	await db.insert(textMessages).values({
		id: randomUUID(),
		organizationId: link.orgId,
		contactId: link.contactId,
		direction: 'inbound',
		channel: 'telegram',
		fromPhone: `tg:${chatId}`,
		toPhone: 'tg:bot',
		body: text,
		status: 'received',
		providerMessageId: String(msg.message_id),
	});
	logger.info({ orgId: link.orgId, chatId }, 'telegram: stored inbound message');
	return NextResponse.json({ ok: true });
}
