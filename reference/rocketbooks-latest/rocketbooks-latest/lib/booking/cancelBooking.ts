import { db } from '@/db/client';
import { appointments, users } from '@/db/schema/schema';
import { bookings } from '@/db/schema/booking';
import { eq } from 'drizzle-orm';
import { deleteGoogleEvent } from '@/lib/calendar/google';
import { sendTransactionalEmail } from '@/lib/email/resend';
import { formatInTimeZone } from './time';

export type BookingForCancel = {
	id: string;
	status: string;
	bookerName: string;
	bookerEmail: string;
	startsAt: string;
	hostUserId: string;
	appointmentId: string | null;
	googleEventId: string | null;
};

/** Look up a booking by its public cancel token. */
export async function getBookingByCancelToken(token: string): Promise<BookingForCancel | null> {
	const rows = await db
		.select({
			id: bookings.id,
			status: bookings.status,
			bookerName: bookings.bookerName,
			bookerEmail: bookings.bookerEmail,
			startsAt: bookings.startsAt,
			hostUserId: bookings.hostUserId,
			appointmentId: bookings.appointmentId,
			googleEventId: bookings.googleEventId,
		})
		.from(bookings)
		.where(eq(bookings.cancelToken, token))
		.limit(1);
	return rows[0] ?? null;
}

export type CancelResult = { ok: true; alreadyCanceled: boolean } | { ok: false; error: 'not_found' };

/** Cancel a booking: remove the appointment + Google event and notify the host. */
export async function cancelBookingByToken(token: string): Promise<CancelResult> {
	const booking = await getBookingByCancelToken(token);
	if (!booking) return { ok: false, error: 'not_found' };
	if (booking.status === 'canceled') return { ok: true, alreadyCanceled: true };

	// Best-effort remove from Google.
	if (booking.googleEventId) {
		try {
			await deleteGoogleEvent(booking.hostUserId, booking.googleEventId);
		} catch {
			/* ignore */
		}
	}

	// Remove the appointment so it leaves the host's calendar.
	if (booking.appointmentId) {
		try {
			await db.delete(appointments).where(eq(appointments.id, booking.appointmentId));
		} catch {
			/* ignore */
		}
	}

	await db
		.update(bookings)
		.set({ status: 'canceled', updatedAt: new Date().toISOString() })
		.where(eq(bookings.id, booking.id));

	// Notify the host (best-effort).
	try {
		const [host] = await db.select({ email: users.email }).from(users).where(eq(users.id, booking.hostUserId)).limit(1);
		if (host?.email) {
			await sendTransactionalEmail({
				to: host.email,
				subject: `Canceled: meeting with ${booking.bookerName}`,
				html: `<p>${booking.bookerName} (${booking.bookerEmail}) canceled their meeting scheduled for ${formatInTimeZone(new Date(booking.startsAt), 'UTC')}.</p>`,
				usage: { userId: booking.hostUserId, orgId: null, actor: 'system', feature: 'booking-cancellation' },
			});
		}
	} catch {
		/* ignore */
	}

	return { ok: true, alreadyCanceled: false };
}
