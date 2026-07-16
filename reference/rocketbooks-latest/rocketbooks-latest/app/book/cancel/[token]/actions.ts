'use server';

import { redirect } from 'next/navigation';
import { cancelBookingByToken } from '@/lib/booking/cancelBooking';

/** Server action invoked by the cancel form. Redirects back with a status flag. */
export async function cancelBookingAction(formData: FormData) {
	const token = String(formData.get('token') ?? '');
	if (!token) redirect('/book/cancel/invalid?status=error');
	const result = await cancelBookingByToken(token);
	const status = result.ok ? 'canceled' : 'error';
	redirect(`/book/cancel/${encodeURIComponent(token)}?status=${status}`);
}
