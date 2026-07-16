import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { adminSms } from '@/db/schema/schema';
import { verifyTwilioSignature } from '@/lib/sms/twilio';
import { logger } from '@/lib/logger';

// Twilio webhook — body is form-encoded and signature is computed
// over the raw URL we asked Twilio to call, so route caching must
// be off and we must run on Node (Edge has no node:crypto).
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Status callback for messages sent from /super-admin/texts.
 *
 * Twilio POSTs this URL once per status transition:
 *   queued → sending → sent → delivered (or undelivered/failed)
 *
 * We update the matching admin_sms row in place — keyed by
 * MessageSid (provider_message_id). If we get a delivery update
 * for a SID we don't know about, we 200 and ignore it: returning
 * 4xx makes Twilio retry, which is wasted work on an unknown row.
 *
 * Signature verification uses TWILIO_AUTH_TOKEN — without it
 * anyone could POST status updates and corrupt the audit log.
 */
export async function POST(req: NextRequest) {
	// Reconstruct the exact URL Twilio signed against. We told Twilio
	// to call `${NEXT_PUBLIC_APP_URL}/api/twilio/status` so we must
	// validate against the same value, not req.url (which may include
	// proxy-mangled query strings).
	const baseUrl = process.env.NEXT_PUBLIC_APP_URL;
	if (!baseUrl) {
		// We can't have set a StatusCallback without a base URL, so
		// arriving here means misconfiguration. Reject loudly.
		return new NextResponse('NEXT_PUBLIC_APP_URL not configured', { status: 500 });
	}
	const expectedUrl = `${baseUrl.replace(/\/$/, '')}/api/twilio/status`;

	const formData = await req.formData();
	const params: Record<string, string> = {};
	for (const [k, v] of formData.entries()) params[k] = String(v);

	const signature = req.headers.get('x-twilio-signature');
	if (!verifyTwilioSignature(expectedUrl, params, signature)) {
		logger.warn({ sid: params.MessageSid }, 'twilio status webhook signature rejected');
		return new NextResponse('bad signature', { status: 401 });
	}

	const messageSid = params.MessageSid;
	const messageStatus = params.MessageStatus;
	const errorCodeRaw = params.ErrorCode;

	if (!messageSid || !messageStatus) {
		return new NextResponse('missing MessageSid or MessageStatus', { status: 400 });
	}

	// CHECK constraint only allows the documented Twilio states; if
	// Twilio ever sends a new one we'd 500 on the update. Defend by
	// dropping unknown statuses on the floor (still acked) so a new
	// Twilio state doesn't take the webhook offline until we ship a
	// schema change.
	const KNOWN = new Set([
		'queued',
		'accepted',
		'scheduled',
		'sending',
		'sent',
		'delivered',
		'undelivered',
		'failed',
		'canceled',
	]);
	if (!KNOWN.has(messageStatus)) {
		logger.warn({ sid: messageSid, status: messageStatus }, 'twilio unknown status — ignoring');
		return NextResponse.json({ ok: true, ignored: 'unknown_status' });
	}

	const errorCode = errorCodeRaw ? Number(errorCodeRaw) : null;
	// Twilio only sets ErrorMessage on some carrier failures; the
	// numeric code is the actionable identifier (lookup table at
	// https://www.twilio.com/docs/api/errors). Keep error free-form
	// so legacy 'sent' rows that later go 'undelivered' still get a
	// human hint.
	const error = errorCode ? `Twilio error ${errorCode}` : null;

	const updated = await db
		.update(adminSms)
		.set({
			status: messageStatus,
			errorCode: Number.isFinite(errorCode) ? errorCode : null,
			error,
		})
		.where(eq(adminSms.providerMessageId, messageSid))
		.returning({ id: adminSms.id });

	if (updated.length === 0) {
		// Unknown SID — could be a stale retry, a message sent from
		// outside this app, or a misrouted webhook. Don't 4xx (Twilio
		// would retry); just log.
		logger.info({ sid: messageSid, status: messageStatus }, 'twilio status for unknown sid');
		return NextResponse.json({ ok: true, ignored: 'unknown_sid' });
	}

	logger.info({ sid: messageSid, status: messageStatus, errorCode }, 'twilio status updated');
	return NextResponse.json({ ok: true });
}
