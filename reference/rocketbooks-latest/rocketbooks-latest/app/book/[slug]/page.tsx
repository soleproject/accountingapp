import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema/schema';
import { getProfileBySlug, getEventTypes } from '@/lib/booking/availability';

export const dynamic = 'force-dynamic';

/** Public landing for a booking link: choose a meeting type. */
export default async function BookingLandingPage({ params }: { params: Promise<{ slug: string }> }) {
	const { slug } = await params;
	const profile = await getProfileBySlug(slug);
	if (!profile) notFound();

	const [host] = await db.select({ fullName: users.fullName }).from(users).where(eq(users.id, profile.userId)).limit(1);
	const eventTypes = await getEventTypes(profile.id);
	const hostName = host?.fullName ?? 'this host';

	return (
		<main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-4 py-12">
			<header>
				<h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Book time with {hostName}</h1>
				<p className="mt-1 text-sm text-zinc-500">Choose a meeting type to see available times.</p>
			</header>

			{eventTypes.length === 0 ? (
				<p className="rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
					This person isn&apos;t accepting bookings right now.
				</p>
			) : (
				<ul className="flex flex-col gap-3">
					{eventTypes.map((et) => (
						<li key={et.id}>
							<Link
								href={`/book/${encodeURIComponent(slug)}/${encodeURIComponent(et.slug)}`}
								className="flex items-center justify-between gap-4 rounded-lg border border-zinc-200 bg-white p-4 transition hover:border-blue-400 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
							>
								<div>
									<div className="font-medium text-zinc-900 dark:text-zinc-100">{et.name}</div>
									{et.description && <div className="mt-0.5 text-sm text-zinc-500">{et.description}</div>}
								</div>
								<div className="shrink-0 text-sm text-zinc-500">{et.durationMinutes} min &rarr;</div>
							</Link>
						</li>
					))}
				</ul>
			)}

			<footer className="mt-auto pt-8 text-center text-xs text-zinc-400">Powered by Rocketbooks</footer>
		</main>
	);
}
