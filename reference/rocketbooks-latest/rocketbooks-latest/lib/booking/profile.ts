import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import {
	bookingProfiles,
	bookingEventTypes,
	bookingAvailabilityRules,
	bookingDateOverrides,
} from '@/db/schema/booking';
import { eq, asc } from 'drizzle-orm';
import { DEFAULT_TIMEZONE, slugify } from './constants';

export type BookingProfileRow = typeof bookingProfiles.$inferSelect;
export type BookingEventTypeRow = typeof bookingEventTypes.$inferSelect;
export type AvailabilityRuleRow = typeof bookingAvailabilityRules.$inferSelect;
export type DateOverrideRow = typeof bookingDateOverrides.$inferSelect;

export type BookingBundle = {
	profile: BookingProfileRow;
	eventTypes: BookingEventTypeRow[];
	rules: AvailabilityRuleRow[];
	overrides: DateOverrideRow[];
};

async function isSlugTaken(slug: string, exceptProfileId?: string): Promise<boolean> {
	const rows = await db.select({ id: bookingProfiles.id }).from(bookingProfiles).where(eq(bookingProfiles.slug, slug)).limit(2);
	return rows.some((r) => r.id !== exceptProfileId);
}

/** Pick a unique slug derived from a seed (name/email), appending a short suffix on clash. */
async function uniqueSlug(seed: string): Promise<string> {
	const base = slugify(seed) || 'meet';
	if (!(await isSlugTaken(base))) return base;
	for (let i = 0; i < 20; i++) {
		const candidate = `${base}-${randomUUID().slice(0, 4)}`;
		if (!(await isSlugTaken(candidate))) return candidate;
	}
	return `${base}-${randomUUID().slice(0, 8)}`;
}

/**
 * Load the user's booking bundle, creating a sensible default profile on first use:
 * a unique slug, Mon–Fri 9–5 availability, and one 30-minute event type so the link
 * works immediately.
 */
export async function getOrCreateBookingProfile(opts: {
	userId: string;
	organizationId: string;
	seed: string; // full name or email used to derive the initial slug
}): Promise<BookingBundle> {
	const existing = await db.select().from(bookingProfiles).where(eq(bookingProfiles.userId, opts.userId)).limit(1);
	let profile = existing[0];

	if (!profile) {
		const id = randomUUID();
		const slug = await uniqueSlug(opts.seed);
		const inserted = await db
			.insert(bookingProfiles)
			.values({
				id,
				userId: opts.userId,
				organizationId: opts.organizationId,
				slug,
				timezone: DEFAULT_TIMEZONE,
			})
			.onConflictDoNothing()
			.returning();
		profile = inserted[0];
		if (!profile) {
			// Lost a race; re-read.
			const reread = await db.select().from(bookingProfiles).where(eq(bookingProfiles.userId, opts.userId)).limit(1);
			profile = reread[0];
		} else {
			// Seed Mon–Fri 9:00–17:00 and a default event type.
			await db.insert(bookingAvailabilityRules).values(
				[1, 2, 3, 4, 5].map((weekday) => ({
					id: randomUUID(),
					bookingProfileId: profile!.id,
					weekday,
					startMinute: 9 * 60,
					endMinute: 17 * 60,
				})),
			);
			await db.insert(bookingEventTypes).values({
				id: randomUUID(),
				bookingProfileId: profile.id,
				organizationId: opts.organizationId,
				name: '30 Minute Meeting',
				slug: '30min',
				durationMinutes: 30,
				description: null,
				sortOrder: 0,
			});
		}
	}

	if (!profile) throw new Error('failed to create booking profile');

	const [eventTypes, rules, overrides] = await Promise.all([
		db.select().from(bookingEventTypes).where(eq(bookingEventTypes.bookingProfileId, profile.id)).orderBy(asc(bookingEventTypes.sortOrder)),
		db.select().from(bookingAvailabilityRules).where(eq(bookingAvailabilityRules.bookingProfileId, profile.id)).orderBy(asc(bookingAvailabilityRules.weekday)),
		db.select().from(bookingDateOverrides).where(eq(bookingDateOverrides.bookingProfileId, profile.id)).orderBy(asc(bookingDateOverrides.date)),
	]);

	return { profile, eventTypes, rules, overrides };
}

export { isSlugTaken };
