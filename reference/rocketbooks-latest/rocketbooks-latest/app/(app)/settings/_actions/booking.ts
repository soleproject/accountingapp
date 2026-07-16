'use server';

import { randomUUID } from 'crypto';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { db } from '@/db/client';
import {
	bookingProfiles,
	bookingEventTypes,
	bookingAvailabilityRules,
	bookingDateOverrides,
} from '@/db/schema/booking';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { slugify } from '@/lib/booking/constants';
import { isSlugTaken } from '@/lib/booking/profile';

async function loadOwnProfile() {
	const user = await requireSession();
	const orgId = await getCurrentOrgId();
	const [profile] = await db.select().from(bookingProfiles).where(eq(bookingProfiles.userId, user.id)).limit(1);
	return { user, orgId, profile };
}

const profileSchema = z.object({
	slug: z.string().min(1).max(60),
	timezone: z.string().min(1).max(64),
	minNoticeMinutes: z.number().int().min(0).max(20160),
	maxDaysOut: z.number().int().min(1).max(365),
	bufferMinutes: z.number().int().min(0).max(120),
	isActive: z.boolean(),
});

export async function saveBookingProfileAction(input: unknown) {
	const parsed = profileSchema.safeParse(input);
	if (!parsed.success) return { ok: false as const, error: 'invalid' };
	const { profile } = await loadOwnProfile();
	if (!profile) return { ok: false as const, error: 'no_profile' };

	const slug = slugify(parsed.data.slug);
	if (!slug) return { ok: false as const, error: 'invalid_slug' };
	if (await isSlugTaken(slug, profile.id)) return { ok: false as const, error: 'slug_taken' };

	await db
		.update(bookingProfiles)
		.set({
			slug,
			timezone: parsed.data.timezone,
			minNoticeMinutes: parsed.data.minNoticeMinutes,
			maxDaysOut: parsed.data.maxDaysOut,
			bufferMinutes: parsed.data.bufferMinutes,
			isActive: parsed.data.isActive,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(bookingProfiles.id, profile.id));

	revalidatePath('/organizer/settings/booking');
	return { ok: true as const, slug };
}

const ruleSchema = z.object({ weekday: z.number().int().min(0).max(6), startMinute: z.number().int().min(0).max(1439), endMinute: z.number().int().min(1).max(1440) });
const availabilitySchema = z.object({ rules: z.array(ruleSchema).max(100) });

export async function saveAvailabilityAction(input: unknown) {
	const parsed = availabilitySchema.safeParse(input);
	if (!parsed.success) return { ok: false as const, error: 'invalid' };
	const { profile } = await loadOwnProfile();
	if (!profile) return { ok: false as const, error: 'no_profile' };

	const valid = parsed.data.rules.filter((r) => r.endMinute > r.startMinute);

	// Replace the whole weekly rule set.
	await db.delete(bookingAvailabilityRules).where(eq(bookingAvailabilityRules.bookingProfileId, profile.id));
	if (valid.length > 0) {
		await db.insert(bookingAvailabilityRules).values(
			valid.map((r) => ({
				id: randomUUID(),
				bookingProfileId: profile.id,
				weekday: r.weekday,
				startMinute: r.startMinute,
				endMinute: r.endMinute,
			})),
		);
	}

	revalidatePath('/organizer/settings/booking');
	return { ok: true as const };
}

const eventTypeSchema = z.object({
	name: z.string().min(1).max(120),
	durationMinutes: z.number().int().min(5).max(480),
	description: z.string().max(2000).optional().nullable(),
	location: z.string().max(500).optional().nullable(),
});

export async function createEventTypeAction(input: unknown) {
	const parsed = eventTypeSchema.safeParse(input);
	if (!parsed.success) return { ok: false as const, error: 'invalid' };
	const { profile, orgId } = await loadOwnProfile();
	if (!profile) return { ok: false as const, error: 'no_profile' };

	// Derive a unique-per-profile slug.
	const base = slugify(parsed.data.name) || 'meeting';
	let slug = base;
	const existing = await db.select({ slug: bookingEventTypes.slug }).from(bookingEventTypes).where(eq(bookingEventTypes.bookingProfileId, profile.id));
	const taken = new Set(existing.map((e) => e.slug));
	let n = 2;
	while (taken.has(slug)) slug = `${base}-${n++}`;

	await db.insert(bookingEventTypes).values({
		id: randomUUID(),
		bookingProfileId: profile.id,
		organizationId: orgId,
		name: parsed.data.name,
		slug,
		durationMinutes: parsed.data.durationMinutes,
		description: parsed.data.description ?? null,
		location: parsed.data.location ?? null,
		sortOrder: existing.length,
	});

	revalidatePath('/organizer/settings/booking');
	return { ok: true as const };
}

const updateEventTypeSchema = eventTypeSchema.extend({ id: z.string().min(1), isActive: z.boolean() });

export async function updateEventTypeAction(input: unknown) {
	const parsed = updateEventTypeSchema.safeParse(input);
	if (!parsed.success) return { ok: false as const, error: 'invalid' };
	const { profile } = await loadOwnProfile();
	if (!profile) return { ok: false as const, error: 'no_profile' };

	await db
		.update(bookingEventTypes)
		.set({
			name: parsed.data.name,
			durationMinutes: parsed.data.durationMinutes,
			description: parsed.data.description ?? null,
			location: parsed.data.location ?? null,
			isActive: parsed.data.isActive,
			updatedAt: new Date().toISOString(),
		})
		.where(and(eq(bookingEventTypes.id, parsed.data.id), eq(bookingEventTypes.bookingProfileId, profile.id)));

	revalidatePath('/organizer/settings/booking');
	return { ok: true as const };
}

export async function deleteEventTypeAction(input: unknown) {
	const parsed = z.object({ id: z.string().min(1) }).safeParse(input);
	if (!parsed.success) return { ok: false as const, error: 'invalid' };
	const { profile } = await loadOwnProfile();
	if (!profile) return { ok: false as const, error: 'no_profile' };

	await db.delete(bookingEventTypes).where(and(eq(bookingEventTypes.id, parsed.data.id), eq(bookingEventTypes.bookingProfileId, profile.id)));
	revalidatePath('/organizer/settings/booking');
	return { ok: true as const };
}

const overrideSchema = z
	.object({
		date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
		isBlocked: z.boolean(),
		startMinute: z.number().int().min(0).max(1439).optional().nullable(),
		endMinute: z.number().int().min(1).max(1440).optional().nullable(),
	})
	.refine((v) => v.isBlocked || (v.startMinute != null && v.endMinute != null && v.endMinute > v.startMinute), {
		message: 'custom_hours_required',
	});

export async function saveDateOverrideAction(input: unknown) {
	const parsed = overrideSchema.safeParse(input);
	if (!parsed.success) return { ok: false as const, error: 'invalid' };
	const { profile } = await loadOwnProfile();
	if (!profile) return { ok: false as const, error: 'no_profile' };

	// One override row per date: clear any existing, then insert.
	await db.delete(bookingDateOverrides).where(and(eq(bookingDateOverrides.bookingProfileId, profile.id), eq(bookingDateOverrides.date, parsed.data.date)));
	await db.insert(bookingDateOverrides).values({
		id: randomUUID(),
		bookingProfileId: profile.id,
		date: parsed.data.date,
		isBlocked: parsed.data.isBlocked,
		startMinute: parsed.data.isBlocked ? null : parsed.data.startMinute ?? null,
		endMinute: parsed.data.isBlocked ? null : parsed.data.endMinute ?? null,
	});

	revalidatePath('/organizer/settings/booking');
	return { ok: true as const };
}

export async function deleteDateOverrideAction(input: unknown) {
	const parsed = z.object({ id: z.string().min(1) }).safeParse(input);
	if (!parsed.success) return { ok: false as const, error: 'invalid' };
	const { profile } = await loadOwnProfile();
	if (!profile) return { ok: false as const, error: 'no_profile' };

	await db.delete(bookingDateOverrides).where(and(eq(bookingDateOverrides.id, parsed.data.id), eq(bookingDateOverrides.bookingProfileId, profile.id)));
	revalidatePath('/organizer/settings/booking');
	return { ok: true as const };
}
