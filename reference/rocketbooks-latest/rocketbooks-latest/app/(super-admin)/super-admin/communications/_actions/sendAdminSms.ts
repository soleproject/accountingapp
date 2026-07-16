'use server';

import { randomUUID } from 'crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { adminSms } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { isSuperAdmin } from '@/lib/auth/org';
import { sendTransactionalSms, isTwilioConfigured } from '@/lib/sms/twilio';
import { logger } from '@/lib/logger';

// E.164 — leading '+', country code, up to 15 digits total. Twilio
// rejects anything not in this shape; we pre-check so the operator
// gets an inline error instead of a Twilio API failure row.
const E164_RE = /^\+[1-9]\d{6,14}$/;

/**
 * Loosely normalize what the operator typed into E.164. We accept the
 * common shapes — "(555) 123-4567", "555-123-4567", "5551234567",
 * "+1 555 123 4567" — and default to US (+1) when no country code is
 * present. This is intentionally conservative; anything ambiguous is
 * returned as-is so E164_RE rejects it and surfaces a clear error.
 */
function normalizePhone(input: string): string {
	const trimmed = input.trim();
	if (trimmed.startsWith('+')) {
		// Already has country code — just strip non-digits after the '+'.
		return '+' + trimmed.slice(1).replace(/\D/g, '');
	}
	const digits = trimmed.replace(/\D/g, '');
	// US numbers come in as either 10 digits or 11 digits with a leading 1.
	if (digits.length === 10) return '+1' + digits;
	if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
	return trimmed; // let validation fail loudly
}

/**
 * Manual SMS send from the Texts tab on /super-admin/communications.
 * Re-asserts SuperAdmin (defense in depth — server actions are routable
 * independently of the layout that normally gates the page). Always
 * writes a row to admin_sms regardless of outcome so the UI can show
 * "skipped — Twilio not configured" alongside real sends/failures.
 */
export async function sendAdminSmsAction(formData: FormData): Promise<void> {
	const user = await requireSession();
	if (!(await isSuperAdmin())) throw new Error('forbidden');

	const toPhoneRaw = String(formData.get('toPhone') ?? '').trim();
	const body = String(formData.get('body') ?? '').trim();

	if (!toPhoneRaw) throw new Error('Recipient phone number is required');
	const toPhone = normalizePhone(toPhoneRaw);
	if (!E164_RE.test(toPhone)) {
		throw new Error(`Phone number "${toPhoneRaw}" is not a valid E.164 number (expected e.g. +15551234567)`);
	}
	if (!body) throw new Error('Message body is required');
	// Twilio enforces 1600 chars per request; warn earlier so we don't
	// silently fan-out into a dozen billed segments.
	if (body.length > 1600) throw new Error('Message body exceeds 1600 characters');

	const id = randomUUID();

	if (!isTwilioConfigured()) {
		await db.insert(adminSms).values({
			id,
			sentByUserId: user.id,
			toPhone,
			fromPhone: process.env.TWILIO_FROM_NUMBER ?? null,
			body,
			status: 'skipped',
			error: 'Twilio env not configured (need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER)',
		});
		revalidatePath('/super-admin/communications');
		redirect(`/super-admin/communications/text/${id}`);
	}

	// Only set StatusCallback when we have a public URL Twilio can
	// reach. On localhost (no NEXT_PUBLIC_APP_URL or a non-https one)
	// we skip it — the send still works, the row just stays at 'sent'
	// since the carrier-side outcome never arrives.
	const baseUrl = process.env.NEXT_PUBLIC_APP_URL;
	const statusCallback =
		baseUrl && baseUrl.startsWith('https://')
			? `${baseUrl.replace(/\/$/, '')}/api/twilio/status`
			: undefined;

	const result = await sendTransactionalSms({
		to: toPhone,
		body,
		statusCallback,
		usage: { userId: user.id, orgId: null, actor: 'super-admin', feature: 'admin-sms' },
	});

	await db.insert(adminSms).values({
		id,
		sentByUserId: user.id,
		toPhone,
		fromPhone: result.from ?? process.env.TWILIO_FROM_NUMBER ?? null,
		body,
		status: result.sent ? 'sent' : 'failed',
		providerMessageId: result.id ?? null,
		segments: result.segments ?? null,
		error: result.sent ? null : (result.error ?? 'unknown'),
	});

	if (!result.sent) {
		logger.warn({ toPhone, err: result.error }, 'admin manual sms failed');
	}

	revalidatePath('/super-admin/communications');
	redirect(`/super-admin/communications/text/${id}`);
}
