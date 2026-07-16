import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import { appointments, contacts, users, organizations } from '@/db/schema/schema';
import { bookings } from '@/db/schema/booking';
import { and, eq, sql } from 'drizzle-orm';
import { createGoogleEvent } from '@/lib/calendar/google';
import { sendTransactionalEmail } from '@/lib/email/resend';
import { sendTransactionalSms } from '@/lib/sms/twilio';
import { isTextsEnabled } from '@/lib/texts/access';
import { normalizePhone, E164_RE } from '@/lib/sms/normalize';
import { cancelUrl } from './links';
import { formatInTimeZone } from './time';
import { isSlotAvailable, type BookingProfileRow, type BookingEventTypeRow } from './availability';

export type CreateBookingInput = {
	profile: BookingProfileRow;
	eventType: BookingEventTypeRow;
	slotStartUtc: string;
	bookerName: string;
	bookerEmail: string;
	bookerPhone?: string | null;
	notes?: string | null;
};

export type CreateBookingResult =
	| { ok: true; bookingId: string; cancelToken: string; startUtc: string; endUtc: string }
	| { ok: false; error: 'slot_taken' | 'invalid' | 'error'; message?: string };

/**
 * Confirm a booking from a public booking page. Re-validates the slot, links/creates
 * the booker contact, writes the appointment + booking rows, best-effort pushes to
 * Google Calendar, and sends email (+ optional SMS) confirmations.
 */
export async function createBooking(input: CreateBookingInput): Promise<CreateBookingResult> {
	const { profile, eventType } = input;

	const bookerName = input.bookerName.trim();
	const bookerEmail = input.bookerEmail.trim().toLowerCase();
	if (!bookerName || !bookerEmail) return { ok: false, error: 'invalid' };

	const start = new Date(input.slotStartUtc);
	if (Number.isNaN(start.getTime())) return { ok: false, error: 'invalid' };

	// Re-check availability at confirm time to avoid races / stale slots.
	const free = await isSlotAvailable({ profile, eventType, slotStartUtc: input.slotStartUtc });
	if (!free) return { ok: false, error: 'slot_taken' };

	const end = new Date(start.getTime() + eventType.durationMinutes * 60000);
	const startIso = start.toISOString();
	const endIso = end.toISOString();
	const orgId = profile.organizationId;
	const hostUserId = profile.userId;
	const phoneE164 = toE164(input.bookerPhone);

	// --- Contact: match existing by email within the org, else create one. ---
	let contactId: string | null = null;
	try {
		const existing = await db
			.select({ id: contacts.id })
			.from(contacts)
			.where(and(eq(contacts.organizationId, orgId), sql`lower(${contacts.email}) = ${bookerEmail}`))
			.limit(1);
		if (existing[0]) {
			contactId = existing[0].id;
		} else {
			const newId = randomUUID();
			const inserted = await db
				.insert(contacts)
				.values({
					id: newId,
					organizationId: orgId,
					contactName: bookerName,
					email: bookerEmail,
					phone: phoneE164 ?? input.bookerPhone ?? null,
					typeTags: ['lead'],
					isActive: true,
				})
				// Respect UNIQUE(org, is_active, contact_name); skip on name clash.
				.onConflictDoNothing()
				.returning({ id: contacts.id });
			if (inserted[0]) {
				contactId = inserted[0].id;
			} else {
				const byName = await db
					.select({ id: contacts.id })
					.from(contacts)
					.where(and(eq(contacts.organizationId, orgId), eq(contacts.contactName, bookerName), eq(contacts.isActive, true)))
					.limit(1);
				contactId = byName[0]?.id ?? null;
			}
		}
	} catch {
		contactId = null; // contact linking is best-effort; never block the booking
	}

	// --- Appointment + booking rows. ---
	const appointmentId = randomUUID();
	const bookingId = randomUUID();
	const cancelToken = randomUUID();

	const descriptionParts = [
		`Booked via ${eventType.name} link.`,
		`Guest: ${bookerName} <${bookerEmail}>${phoneE164 ? ` ${phoneE164}` : ''}`,
	];
	if (input.notes && input.notes.trim()) descriptionParts.push(`Notes: ${input.notes.trim()}`);
	const description = descriptionParts.join('\n');

	try {
		await db.insert(appointments).values({
			id: appointmentId,
			userId: hostUserId,
			organizationId: orgId,
			contactId,
			title: `${eventType.name} with ${bookerName}`,
			description,
			startsAt: startIso,
			endsAt: endIso,
			location: eventType.location ?? null,
			source: 'booking',
			bookingEventTypeId: eventType.id,
			bookerName,
			bookerEmail,
			bookerPhone: phoneE164 ?? input.bookerPhone ?? null,
		});

		await db.insert(bookings).values({
			id: bookingId,
			organizationId: orgId,
			hostUserId,
			bookingEventTypeId: eventType.id,
			appointmentId,
			contactId,
			bookerName,
			bookerEmail,
			bookerPhone: phoneE164 ?? input.bookerPhone ?? null,
			startsAt: startIso,
			endsAt: endIso,
			status: 'confirmed',
			cancelToken,
		});
	} catch (err) {
		return { ok: false, error: 'error', message: err instanceof Error ? err.message : String(err) };
	}

	// --- Host + org details for notifications. ---
	const [host] = await db.select({ email: users.email, fullName: users.fullName }).from(users).where(eq(users.id, hostUserId)).limit(1);
	const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
	const hostName = host?.fullName || org?.name || 'your host';

	// --- Push to Google Calendar (best-effort); dedup future sync via googleEventId. ---
	try {
		const attendees = [bookerEmail];
		if (host?.email) attendees.push(host.email);
		const g = await createGoogleEvent(hostUserId, {
			title: `${eventType.name} with ${bookerName}`,
			startsAt: startIso,
			endsAt: endIso,
			description,
			location: eventType.location ?? null,
			attendees,
		});
		if (g.ok) {
			await db.update(appointments).set({ googleEventId: g.id }).where(eq(appointments.id, appointmentId));
			await db.update(bookings).set({ googleEventId: g.id }).where(eq(bookings.id, bookingId));
		}
	} catch {
		// ignore — local appointment is the source of truth
	}

	// --- Notifications. ---
	const whenHost = formatInTimeZone(start, profile.timezone);
	const cancel = cancelUrl(cancelToken);

	let emailStatus = 'skipped';
	try {
		const bookerHtml = `
			<p>Hi ${escapeHtml(bookerName)},</p>
			<p>Your <strong>${escapeHtml(eventType.name)}</strong> with ${escapeHtml(hostName)} is confirmed.</p>
			<p><strong>When:</strong> ${escapeHtml(whenHost)} (${escapeHtml(profile.timezone)})<br/>
			<strong>Duration:</strong> ${eventType.durationMinutes} minutes${eventType.location ? `<br/><strong>Where:</strong> ${escapeHtml(eventType.location)}` : ''}</p>
			<p>Need to cancel? <a href="${cancel}">Cancel this meeting</a>.</p>`;
		const r1 = await sendTransactionalEmail({
			to: bookerEmail,
			subject: `Confirmed: ${eventType.name} with ${hostName}`,
			html: bookerHtml,
			replyTo: host?.email,
				brandForOrgId: orgId,
				usage: { userId: hostUserId, orgId: null, actor: 'system', feature: 'booking-confirmation' },
		});
		if (host?.email) {
			await sendTransactionalEmail({
				to: host.email,
				subject: `New booking: ${eventType.name} with ${bookerName}`,
				html: `<p>${escapeHtml(bookerName)} (${escapeHtml(bookerEmail)}${phoneE164 ? `, ${escapeHtml(phoneE164)}` : ''}) booked <strong>${escapeHtml(eventType.name)}</strong>.</p><p><strong>When:</strong> ${escapeHtml(whenHost)} (${escapeHtml(profile.timezone)})</p>${input.notes ? `<p><strong>Notes:</strong> ${escapeHtml(input.notes)}</p>` : ''}`,
				replyTo: bookerEmail,
					brandForOrgId: orgId,
					usage: { userId: hostUserId, orgId: null, actor: 'system', feature: 'booking-host-notify' },
			});
		}
		emailStatus = r1.sent ? 'sent' : r1.skipped ? 'skipped' : 'failed';
	} catch {
		emailStatus = 'failed';
	}

	let smsStatus = 'skipped';
	if (phoneE164 && (await isTextsEnabled(hostUserId))) {
		try {
			const res = await sendTransactionalSms({
				to: phoneE164,
				body: `Your ${eventType.name} with ${hostName} is confirmed for ${whenHost}. Cancel: ${cancel}`,
				usage: { userId: hostUserId, orgId: null, actor: 'system', feature: 'booking-confirmation' },
			});
			smsStatus = res.sent ? 'sent' : res.skipped ? 'skipped' : 'failed';
		} catch {
			smsStatus = 'failed';
		}
	}

	try {
		await db.update(bookings).set({ emailStatus, smsStatus }).where(eq(bookings.id, bookingId));
	} catch {
		// non-fatal: delivery-status bookkeeping only
	}

	return { ok: true, bookingId, cancelToken, startUtc: startIso, endUtc: endIso };
}

/** Best-effort E.164 from free-form input; null when it can't be made valid. */
function toE164(input: string | null | undefined): string | null {
	if (!input || !input.trim()) return null;
	const n = normalizePhone(input);
	return E164_RE.test(n) ? n : null;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
