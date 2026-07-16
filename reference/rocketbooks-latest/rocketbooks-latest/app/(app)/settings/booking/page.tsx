import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getOrCreateBookingProfile } from '@/lib/booking/profile';
import { appBaseUrl } from '@/lib/booking/links';
import { BookingSettings } from '../_components/BookingSettings';

export const dynamic = 'force-dynamic';

export default async function BookingSettingsPage() {
	const user = await requireSession();
	const orgId = await getCurrentOrgId();

	// The session user is a Supabase auth user (no display name); read the
	// app users row for a nicer initial slug seed.
	const [profileRow] = await db.select({ fullName: users.fullName }).from(users).where(eq(users.id, user.id)).limit(1);

	const bundle = await getOrCreateBookingProfile({
		userId: user.id,
		organizationId: orgId,
		seed: profileRow?.fullName || user.email || 'meet',
	});

	return (
		<div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
			<div>
				<Link href="/organizer/settings" className="text-sm text-muted-foreground hover:underline">
					&larr; Settings
				</Link>
				<h1 className="text-2xl font-semibold mt-2">Booking links</h1>
				<p className="text-sm text-muted-foreground mt-1">
					Define when you&apos;re available and share a link so people can book a time on your calendar.
				</p>
			</div>

			<BookingSettings
				baseUrl={`${appBaseUrl()}/book/`}
				profile={{
					slug: bundle.profile.slug,
					timezone: bundle.profile.timezone,
					minNoticeMinutes: bundle.profile.minNoticeMinutes,
					maxDaysOut: bundle.profile.maxDaysOut,
					bufferMinutes: bundle.profile.bufferMinutes,
					isActive: bundle.profile.isActive,
				}}
				eventTypes={bundle.eventTypes.map((e) => ({
					id: e.id,
					name: e.name,
					slug: e.slug,
					durationMinutes: e.durationMinutes,
					description: e.description,
					location: e.location,
					isActive: e.isActive,
				}))}
				rules={bundle.rules.map((r) => ({ weekday: r.weekday, startMinute: r.startMinute, endMinute: r.endMinute }))}
				overrides={bundle.overrides.map((o) => ({
					id: o.id,
					date: String(o.date),
					isBlocked: o.isBlocked,
					startMinute: o.startMinute,
					endMinute: o.endMinute,
				}))}
			/>
		</div>
	);
}
