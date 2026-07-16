import { getBookingByCancelToken } from '@/lib/booking/cancelBooking';
import { cancelBookingAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function CancelBookingPage({
	params,
	searchParams,
}: {
	params: Promise<{ token: string }>;
	searchParams: Promise<{ status?: string }>;
}) {
	const { token } = await params;
	const { status } = await searchParams;
	const booking = await getBookingByCancelToken(token);

	const wrap = 'mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-4 text-center';
	const cardCls = 'w-full rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950';

	if (!booking) {
		return (
			<main className={wrap}>
				<div className={cardCls}>
					<h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Booking not found</h1>
					<p className="mt-2 text-sm text-zinc-500">This cancellation link is invalid or has expired.</p>
				</div>
			</main>
		);
	}

	if (status === 'canceled' || booking.status === 'canceled') {
		return (
			<main className={wrap}>
				<div className={cardCls}>
					<h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Meeting canceled</h1>
					<p className="mt-2 text-sm text-zinc-500">Your meeting has been canceled. The host has been notified.</p>
				</div>
			</main>
		);
	}

	const when = new Date(booking.startsAt).toLocaleString(undefined, {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	});

	return (
		<main className={wrap}>
			<div className={cardCls}>
				<h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Cancel this meeting?</h1>
				<p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{when} (your local time)</p>
				{status === 'error' && <p className="mt-2 text-sm text-red-600">Something went wrong. Please try again.</p>}
				<form action={cancelBookingAction} className="mt-4">
					<input type="hidden" name="token" value={token} />
					<button
						type="submit"
						className="inline-flex items-center justify-center rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500"
					>
						Cancel meeting
					</button>
				</form>
			</div>
		</main>
	);
}
