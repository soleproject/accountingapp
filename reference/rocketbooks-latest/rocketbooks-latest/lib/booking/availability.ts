import { db } from '@/db/client';
import { appointments } from '@/db/schema/schema';
import {
	bookingProfiles,
	bookingEventTypes,
	bookingAvailabilityRules,
	bookingDateOverrides,
} from '@/db/schema/booking';
import { and, eq, gte, lte } from 'drizzle-orm';
import { zonedWallTimeToUtc, zonedParts, addDaysToDateKey } from './time';

export type BookingProfileRow = typeof bookingProfiles.$inferSelect;
export type BookingEventTypeRow = typeof bookingEventTypes.$inferSelect;

export type OpenSlot = { startUtc: string; endUtc: string };

const DEFAULT_APPT_MINUTES = 30;
const DAY_MS = 86400000;

/**
 * True for an all-day / multi-day event. This codebase normalizes Google
 * all-day events to a UTC-midnight start and a duration that's a whole number
 * of days (see lib/calendar/google.ts `normalize`). Such events are background
 * markers ("Home", birthdays, OOO) — not meeting conflicts — so booking ignores
 * them. A genuine full-day block belongs in a booking date override instead.
 */
function isAllDaySpan(startMs: number, endMs: number): boolean {
	const durationMs = endMs - startMs;
	if (durationMs < DAY_MS) return false;
	const startsAtUtcMidnight = startMs % DAY_MS === 0;
	const wholeDayDuration = durationMs % DAY_MS === 0;
	return startsAtUtcMidnight && wholeDayDuration;
}

type Window = { startMinute: number; endMinute: number };

/**
 * Compute bookable slots for an event type between `fromUtc` and `toUtc`.
 *
 * Honors the profile's timezone, minimum notice, max-days-out and buffer, and
 * subtracts busy time from the host's appointments table — which already holds
 * both manually-created meetings and synced Google Calendar events, so a single
 * pass covers "Google + app" conflict checking.
 */
export async function getOpenSlots(opts: {
	profile: BookingProfileRow;
	// Only the duration is read here, so callers without a real event type
	// (e.g. the AI availability tools) can pass a synthetic `{ durationMinutes }`.
	eventType: Pick<BookingEventTypeRow, 'durationMinutes'>;
	fromUtc: Date;
	toUtc: Date;
	now?: Date;
}): Promise<OpenSlot[]> {
	const { profile, eventType } = opts;
	const tz = profile.timezone;
	const duration = eventType.durationMinutes;
	const buffer = profile.bufferMinutes;
	const now = opts.now ?? new Date();

	// Effective booking window: respect minimum notice and max-days-out.
	const minStart = new Date(Math.max(opts.fromUtc.getTime(), now.getTime() + profile.minNoticeMinutes * 60000));
	const maxOut = new Date(now.getTime() + profile.maxDaysOut * 86400000);
	const maxEnd = new Date(Math.min(opts.toUtc.getTime(), maxOut.getTime()));
	if (minStart >= maxEnd) return [];

	// Weekly rules grouped by weekday.
	const rules = await db
		.select()
		.from(bookingAvailabilityRules)
		.where(eq(bookingAvailabilityRules.bookingProfileId, profile.id));
	const weeklyByWeekday = new Map<number, Window[]>();
	for (const r of rules) {
		const list = weeklyByWeekday.get(r.weekday) ?? [];
		list.push({ startMinute: r.startMinute, endMinute: r.endMinute });
		weeklyByWeekday.set(r.weekday, list);
	}

	// Date overrides keyed by YYYY-MM-DD.
	const overrides = await db
		.select()
		.from(bookingDateOverrides)
		.where(eq(bookingDateOverrides.bookingProfileId, profile.id));
	const overridesByDate = new Map<string, typeof overrides>();
	for (const o of overrides) {
		const key = String(o.date); // date column is 'YYYY-MM-DD'
		const list = overridesByDate.get(key) ?? [];
		list.push(o);
		overridesByDate.set(key, list);
	}

	// Busy intervals from the host's calendar (manual + google + prior bookings).
	const busyRows = await db
		.select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt })
		.from(appointments)
		.where(
			and(
				eq(appointments.userId, profile.userId),
				lte(appointments.startsAt, maxEnd.toISOString()),
				gte(appointments.startsAt, new Date(minStart.getTime() - 24 * 3600000).toISOString()),
			),
		);
	const busy = busyRows
		.map((b) => {
			const start = new Date(b.startsAt).getTime();
			const end = b.endsAt ? new Date(b.endsAt).getTime() : start + DEFAULT_APPT_MINUTES * 60000;
			return { start, end };
		})
		// Skip all-day / multi-day background events (Google "Home", birthdays,
		// OOO markers). This codebase normalizes Google all-day events to a
		// `00:00:00Z` start with a whole-day duration, so they'd otherwise blanket
		// every slot (an all-day event at 00:00 ET = the whole working day). A real
		// full-day block is better expressed as a booking date override.
		.filter((b) => !isAllDaySpan(b.start, b.end));

	const slots: OpenSlot[] = [];
	const startKey = zonedParts(minStart, tz).dateKey;
	const endKey = zonedParts(maxEnd, tz).dateKey;

	for (let dateKey = startKey; dateKey <= endKey; dateKey = addDaysToDateKey(dateKey, 1)) {
		const [year, month, day] = dateKey.split('-').map(Number);
		const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

		const dayOverrides = overridesByDate.get(dateKey);
		let windows: Window[];
		if (dayOverrides && dayOverrides.length > 0) {
			if (dayOverrides.some((o) => o.isBlocked)) {
				windows = [];
			} else {
				windows = dayOverrides
					.filter((o) => o.startMinute != null && o.endMinute != null)
					.map((o) => ({ startMinute: o.startMinute as number, endMinute: o.endMinute as number }));
			}
		} else {
			windows = weeklyByWeekday.get(weekday) ?? [];
		}

		for (const win of windows) {
			// Step by the slot duration; only emit slots that fit inside the window.
			for (let s = win.startMinute; s + duration <= win.endMinute; s += duration) {
				const startDt = zonedWallTimeToUtc(year, month, day, s, tz);
				const endDt = new Date(startDt.getTime() + duration * 60000);
				if (startDt < minStart || endDt > maxEnd) continue;

				const sMs = startDt.getTime();
				const eMs = endDt.getTime();
				const conflicts = busy.some(
					(b) => sMs - buffer * 60000 < b.end && eMs + buffer * 60000 > b.start,
				);
				if (conflicts) continue;

				slots.push({ startUtc: startDt.toISOString(), endUtc: endDt.toISOString() });
			}
		}
	}

	slots.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
	return slots;
}

/** Resolve a profile by public slug (active only). */
export async function getProfileBySlug(slug: string): Promise<BookingProfileRow | null> {
	const rows = await db
		.select()
		.from(bookingProfiles)
		.where(and(eq(bookingProfiles.slug, slug), eq(bookingProfiles.isActive, true)))
		.limit(1);
	return rows[0] ?? null;
}

/** Active event types for a profile, ordered for display. */
export async function getEventTypes(profileId: string): Promise<BookingEventTypeRow[]> {
	return db
		.select()
		.from(bookingEventTypes)
		.where(and(eq(bookingEventTypes.bookingProfileId, profileId), eq(bookingEventTypes.isActive, true)))
		.orderBy(bookingEventTypes.sortOrder);
}

/** Resolve a single active event type within a profile by its slug. */
export async function getEventType(profileId: string, eventSlug: string): Promise<BookingEventTypeRow | null> {
	const rows = await db
		.select()
		.from(bookingEventTypes)
		.where(
			and(
				eq(bookingEventTypes.bookingProfileId, profileId),
				eq(bookingEventTypes.slug, eventSlug),
				eq(bookingEventTypes.isActive, true),
			),
		)
		.limit(1);
	return rows[0] ?? null;
}

/** True if `slotStartUtc` is still a valid, free slot for the event type. */
export async function isSlotAvailable(opts: {
	profile: BookingProfileRow;
	eventType: BookingEventTypeRow;
	slotStartUtc: string;
}): Promise<boolean> {
	const start = new Date(opts.slotStartUtc);
	if (Number.isNaN(start.getTime())) return false;
	const from = new Date(start.getTime() - 60000);
	const to = new Date(start.getTime() + opts.eventType.durationMinutes * 60000 + 60000);
	const open = await getOpenSlots({ profile: opts.profile, eventType: opts.eventType, fromUtc: from, toUtc: to });
	return open.some((s) => s.startUtc === start.toISOString());
}
