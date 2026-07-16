import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, telegramChats, textMessages } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isTextsEnabled } from '@/lib/texts/access';
import { sendTransactionalSms, isTwilioConfigured } from '@/lib/sms/twilio';
import { sendTelegramMessage } from '@/lib/messaging/telegram';
import { E164_RE, normalizePhone } from '@/lib/sms/normalize';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const Schema = z.object({
  contactId: z.string().min(1).max(64),
  body: z.string().min(1).max(1600),
  channel: z.enum(['sms', 'telegram']).optional(),
});

export async function POST(req: Request) {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  if (!(await isTextsEnabled(user.id))) {
    return NextResponse.json({ error: 'texts not enabled' }, { status: 404 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const parsed = Schema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad request', issues: parsed.error.issues }, { status: 400 });
  }
  const { contactId, body, channel } = parsed.data;

  const [contact] = await db
    .select({ id: contacts.id, phone: contacts.phone })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, orgId)))
    .limit(1);
  if (!contact) return NextResponse.json({ error: 'contact not found' }, { status: 404 });

  // Telegram: if this contact is a linked Telegram chat, reply via the bot. Used
  // when the contact has no phone (Telegram-origin contact) or the caller asked
  // for the telegram channel explicitly.
  const [tgChat] = await db
    .select({ chatId: telegramChats.chatId })
    .from(telegramChats)
    .where(and(eq(telegramChats.organizationId, orgId), eq(telegramChats.contactId, contact.id)))
    .limit(1);
  if (tgChat && (channel === 'telegram' || !contact.phone)) {
    const tgId = randomUUID();
    const tg = await sendTelegramMessage(tgChat.chatId, body);
    await db.insert(textMessages).values({
      id: tgId,
      organizationId: orgId,
      contactId: contact.id,
      direction: 'outbound',
      channel: 'telegram',
      fromPhone: 'tg:bot',
      toPhone: `tg:${tgChat.chatId}`,
      body,
      status: tg.sent ? 'sent' : 'failed',
      providerMessageId: tg.id ?? null,
      sentByUserId: user.id,
      error: tg.sent ? null : (tg.error ?? 'unknown'),
    });
    if (!tg.sent) {
      logger.warn({ userId: user.id, contactId, err: tg.error }, 'telegram send failed');
      return NextResponse.json({ id: tgId, status: 'failed', error: tg.error }, { status: 502 });
    }
    return NextResponse.json({ id: tgId, status: 'sent' });
  }

  if (!contact.phone) {
    return NextResponse.json({ error: 'contact has no phone number on file' }, { status: 400 });
  }

  const toPhone = normalizePhone(contact.phone);
  if (!E164_RE.test(toPhone)) {
    return NextResponse.json({ error: `contact phone "${contact.phone}" is not E.164` }, { status: 400 });
  }

  const id = randomUUID();
  const fromPhone = process.env.TWILIO_FROM_NUMBER ?? '';

  if (!isTwilioConfigured()) {
    await db.insert(textMessages).values({
      id,
      organizationId: orgId,
      contactId: contact.id,
      direction: 'outbound',
      fromPhone,
      toPhone,
      body,
      status: 'skipped',
      sentByUserId: user.id,
      error: 'Twilio env not configured',
    });
    return NextResponse.json({ id, status: 'skipped' }, { status: 503 });
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL;
  const statusCallback =
    baseUrl && baseUrl.startsWith('https://')
      ? `${baseUrl.replace(/\/$/, '')}/api/twilio/status`
      : undefined;

  const result = await sendTransactionalSms({
    to: toPhone,
    body,
    statusCallback,
    usage: { userId: user.id, orgId, actor: 'user', feature: 'org-sms' },
  });

  await db.insert(textMessages).values({
    id,
    organizationId: orgId,
    contactId: contact.id,
    direction: 'outbound',
    fromPhone: result.from ?? fromPhone,
    toPhone,
    body,
    status: result.sent ? 'sent' : 'failed',
    providerMessageId: result.id ?? null,
    segments: result.segments ?? null,
    sentByUserId: user.id,
    error: result.sent ? null : (result.error ?? 'unknown'),
  });

  if (!result.sent) {
    logger.warn({ userId: user.id, contactId, err: result.error }, 'texts send failed');
    return NextResponse.json({ id, status: 'failed', error: result.error }, { status: 502 });
  }
  return NextResponse.json({ id, status: 'sent' });
}
