import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema/schema';
import { getProfileBySlug, getEventType } from '@/lib/booking/availability';
import { BookingWidget } from './_components/BookingWidget';

export const dynamic = 'force-dynamic';

export default async function EventBookingPage({ params }: { params: Promise<{ slug: string; eventType: string }> }) {
	const { slug, eventType: eventSlug } = await params;
	const profile = await getProfileBySlug(slug);
	if (!profile) notFound();
	const eventType = await getEventType(profile.id, eventSlug);
	if (!eventType) notFound();

	const [host] = await db.select({ fullName: users.fullName }).from(users).where(eq(users.id, profile.userId)).limit(1);

	return (
		<main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-12">
			<header>
				<Link href={`/book/${encodeURIComponent(slug)}`} className="text-sm text-zinc-500 hover:underline">
					&larr; All meeting types
				</Link>
				<h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{eventType.name}</h1>
				<p className="mt-1 text-sm text-zinc-500">
					{eventType.durationMinutes} min with {host?.fullName ?? 'your host'}
					{eventType.location ? ` · ${eventType.location}` : ''}
				</p>
				{eventType.description && <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{eventType.description}</p>}
			</header>

			<BookingWidget
				slug={slug}
				eventSlug={eventSlug}
				durationMinutes={eventType.durationMinutes}
				hostTimezone={profile.timezone}
				maxDaysOut={profile.maxDaysOut}
			/>

			<footer className="mt-auto pt-8 text-center text-xs text-zinc-400">Powered by Rocketbooks</footer>
		</main>
	);
}
