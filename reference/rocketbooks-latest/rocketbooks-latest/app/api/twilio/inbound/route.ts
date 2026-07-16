import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, textMessages } from '@/db/schema/schema';
import { verifyTwilioSignature } from '@/lib/sms/twilio';
import { normalizePhone } from '@/lib/sms/normalize';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Inbound SMS webhook. Twilio POSTs form-encoded body with at minimum:
 *   MessageSid, From, To, Body, AccountSid, NumMedia, NumSegments.
 *
 * We don't know which org "owns" the inbound text from the wire alone —
 * we match by looking up any contact with this phone number. The
 * matching contact's organization_id becomes the row's org. If the
 * From number matches contacts in multiple orgs, we write one row per
 * match so each org sees its own inbound. Unmatched From numbers get a
 * single row with contact_id=NULL and organization_id resolved from the
 * To number's owning org via TWILIO_FROM_NUMBER lookup… punt: write
 * nothing on no-match to avoid leaking across orgs.
 *
 * Signature verification uses TWILIO_AUTH_TOKEN. Without it anyone
 * could POST and inject fake messages.
 */
export async function POST(req: NextRequest) {
	const baseUrl = process.env.NEXT_PUBLIC_APP_URL;
	const url = baseUrl
		? `${baseUrl.replace(/\/$/, '')}/api/twilio/inbound`
		: req.nextUrl.toString();

	const form = await req.formData();
	const params: Record<string, string> = {};
	for (const [k, v] of form.entries()) {
		if (typeof v === 'string') params[k] = v;
	}

	const sigHeader = req.headers.get('x-twilio-signature');
	if (!verifyTwilioSignature(url, params, sigHeader)) {
		logger.warn({ url, sig: sigHeader }, 'twilio inbound signature rejected');
		return new NextResponse('forbidden', { status: 403 });
	}

	const sid = params.MessageSid;
	const from = params.From;
	const to = params.To;
	const body = params.Body ?? '';
	if (!sid || !from || !to) {
		return new NextResponse('bad request', { status: 400 });
	}

	const fromNorm = normalizePhone(from);

	const matchedContacts = await db
		.select({ id: contacts.id, organizationId: contacts.organizationId })
		.from(contacts)
		.where(eq(contacts.phone, fromNorm));

	if (matchedContacts.length === 0) {
		// No contact has this phone. Still record one row with NULL contact_id
		// against every org that has at least one contact — that's too noisy.
		// For Phase 1, drop unmatched inbounds with a log line. The user can
		// add the contact, then text again, and future texts will land.
		logger.info({ from: fromNorm, sid }, 'twilio inbound — no matching contact, dropping');
		return new NextResponse('<Response/>', { status: 200, headers: { 'content-type': 'text/xml' } });
	}

	for (const c of matchedContacts) {
		const exists = await db
			.select({ id: textMessages.id })
			.from(textMessages)
			.where(and(eq(textMessages.providerMessageId, sid), eq(textMessages.organizationId, c.organizationId)))
			.limit(1);
		if (exists.length > 0) continue;

		await db.insert(textMessages).values({
			id: randomUUID(),
			organizationId: c.organizationId,
			contactId: c.id,
			direction: 'inbound',
			fromPhone: fromNorm,
			toPhone: to,
			body,
			status: 'received',
			providerMessageId: sid,
		});
	}

	// Twilio expects TwiML or 200. Empty <Response/> = "do nothing further."
	return new NextResponse('<Response/>', { status: 200, headers: { 'content-type': 'text/xml' } });
}
