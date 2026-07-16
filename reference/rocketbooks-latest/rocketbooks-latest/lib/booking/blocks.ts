import 'server-only';
import { randomUUID } from 'crypto';
import { and, eq, gte, lt } from 'drizzle-orm';
import { db } from '@/db/client';
import { appointments } from '@/db/schema/schema';
import { bookingDateOverrides } from '@/db/schema/booking';
import { createGoogleEvent, deleteGoogleEvent } from '@/lib/calendar/google';
import { getOpenSlots, type OpenSlot } from './availability';
import { getOrCreateBookingProfile, type BookingBundle } from './profile';
import { zonedWallTimeToUtc, formatInTimeZone, addDaysToDateKey } from './time';
import { minutesToHHMM } from './constants';

// "Block" / availability tools for the inline AI assistant. These let the user
// say "block Friday", "block tomorrow 1–3pm", "am I free at 2pm?", or "what's
// open next week" and have the assistant act on their booking availability.
//
// Per the product decision, a block is applied in BOTH places at once:
//   • a booking date override (so the public /book page stops offering the
//     time — whole-day blocks NEED this because all-day calendar events are
//     intentionally ignored by the slot engine), and
//   • a visible "Busy" appointment (so it shows on the calendar and syncs to
//     Google, and is reversible like any event).
// Both are tagged so `unblockDate` can find and undo them together.

const BLOCK_SOURCE = 'booking_block';
const DAY_MS = 86400000;
const DEFAULT_CHECK_DURATION = 30;

type Window = { startMinute: number; endMinute: number };

/** Mirror of availability.ts `isAllDaySpan`: skip all-day background markers. */
function isAllDaySpan(startMs: number, endMs: number): boolean {
	const durationMs = endMs - startMs;
	if (durationMs < DAY_MS) return false;
	return startMs % DAY_MS === 0 && durationMs % DAY_MS === 0;
}

/** Effective available windows for one date: a date override (if present) wins
 * over the weekly rules. Returns `blocked` when the whole day is overridden off. */
function windowsForDate(bundle: BookingBundle, dateKey: string): { blocked: boolean; windows: Window[] } {
	const [y, m, d] = dateKey.split('-').map(Number);
	const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
	const dayOverrides = bundle.overrides.filter((o) => String(o.date) === dateKey);
	if (dayOverrides.length > 0) {
		if (dayOverrides.some((o) => o.isBlocked)) return { blocked: true, windows: [] };
		return {
			blocked: false,
			windows: dayOverrides
				.filter((o) => o.startMinute != null && o.endMinute != null)
				.map((o) => ({ startMinute: o.startMinute as number, endMinute: o.endMinute as number })),
		};
	}
	return {
		blocked: false,
		windows: bundle.rules
			.filter((r) => r.weekday === weekday)
			.map((r) => ({ startMinute: r.startMinute, endMinute: r.endMinute })),
	};
}

/** Remove [bStart, bEnd) from each window, splitting where it lands inside. */
function subtractWindow(windows: Window[], bStart: number, bEnd: number): Window[] {
	const out: Window[] = [];
	for (const w of windows) {
		if (bEnd <= w.startMinute || bStart >= w.endMinute) {
			out.push(w); // no overlap
			continue;
		}
		if (bStart > w.startMinute) out.push({ startMinute: w.startMinute, endMinute: bStart });
		if (bEnd < w.endMinute) out.push({ startMinute: bEnd, endMinute: w.endMinute });
	}
	return out.filter((w) => w.endMinute > w.startMinute);
}

/** Busy appointments (manual + Google + bookings) overlapping a local day. */
async function busyForDate(userId: string, organizationId: string, dateKey: string, tz: string) {
	const [y, m, d] = dateKey.split('-').map(Number);
	const dayStart = zonedWallTimeToUtc(y, m, d, 0, tz);
	const dayEnd = new Date(dayStart.getTime() + DAY_MS);
	// Widen the lower bound by a day so a meeting that started late the prior
	// evening but spills into this morning is still considered.
	const rows = await db
		.select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt })
		.from(appointments)
		.where(
			and(
				eq(appointments.userId, userId),
				eq(appointments.organizationId, organizationId),
				gte(appointments.startsAt, new Date(dayStart.getTime() - DAY_MS).toISOString()),
				lt(appointments.startsAt, dayEnd.toISOString()),
			),
		);
	return rows
		.map((r) => {
			const start = new Date(r.startsAt).getTime();
			const end = r.endsAt ? new Date(r.endsAt).getTime() : start + DEFAULT_CHECK_DURATION * 60000;
			return { start, end };
		})
		.filter((b) => !isAllDaySpan(b.start, b.end));
}

/** Create a visible "Busy" appointment for a block, pushing to Google if connected. */
async function createBusyAppointment(opts: {
	userId: string;
	organizationId: string;
	title: string;
	startUtc: Date;
	endUtc: Date;
}): Promise<{ id: string; googleSynced: boolean }> {
	const id = randomUUID();
	const startIso = opts.startUtc.toISOString();
	const endIso = opts.endUtc.toISOString();

	// Push to Google first, then insert with the id already set (same race-safe
	// ordering as create_appointment in lib/ai/tools.ts).
	let googleEventId: string | null = null;
	const g = await createGoogleEvent(opts.userId, {
		title: opts.title,
		startsAt: startIso,
		endsAt: endIso,
		description: 'Blocked via RocketBooks assistant — not available for booking.',
		location: null,
		attendees: [],
	});
	if (g.ok && g.id) googleEventId = g.id;

	await db.insert(appointments).values({
		id,
		userId: opts.userId,
		organizationId: opts.organizationId,
		contactId: null,
		title: opts.title,
		description: 'Blocked via RocketBooks assistant — not available for booking.',
		startsAt: startIso,
		endsAt: endIso,
		location: null,
		source: BLOCK_SOURCE,
		googleEventId,
	});
	return { id, googleSynced: googleEventId != null };
}

export type BlockTimeResult = {
	ok: boolean;
	error?: string;
	mode?: 'full_day' | 'time_range';
	date?: string;
	timezone?: string;
	blocked?: { start: string; end: string };
	appointmentId?: string;
	googleSynced?: boolean;
	humanLabel?: string;
};

/**
 * Block availability on a date — whole day when no window is given, otherwise
 * the [startMinute, endMinute) range. Writes a booking override AND a visible
 * Busy appointment (see file header).
 */
export async function blockTime(opts: {
	userId: string;
	organizationId: string;
	seed: string;
	date: string; // YYYY-MM-DD (profile-local)
	startMinute?: number | null;
	endMinute?: number | null;
}): Promise<BlockTimeResult> {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) return { ok: false, error: 'date must be YYYY-MM-DD' };
	const bundle = await getOrCreateBookingProfile({
		userId: opts.userId,
		organizationId: opts.organizationId,
		seed: opts.seed,
	});
	const tz = bundle.profile.timezone;
	const [y, m, d] = opts.date.split('-').map(Number);
	const hasRange = opts.startMinute != null && opts.endMinute != null;

	if (hasRange && (opts.startMinute as number) >= (opts.endMinute as number)) {
		return { ok: false, error: 'end time must be after start time' };
	}

	// --- Whole-day block ---
	if (!hasRange) {
		await db
			.delete(bookingDateOverrides)
			.where(and(eq(bookingDateOverrides.bookingProfileId, bundle.profile.id), eq(bookingDateOverrides.date, opts.date)));
		await db.insert(bookingDateOverrides).values({
			id: randomUUID(),
			bookingProfileId: bundle.profile.id,
			date: opts.date,
			isBlocked: true,
			startMinute: null,
			endMinute: null,
		});
		const startUtc = zonedWallTimeToUtc(y, m, d, 0, tz);
		const endUtc = new Date(startUtc.getTime() + DAY_MS);
		const appt = await createBusyAppointment({
			userId: opts.userId,
			organizationId: opts.organizationId,
			title: 'Blocked (all day)',
			startUtc,
			endUtc,
		});
		return {
			ok: true,
			mode: 'full_day',
			date: opts.date,
			timezone: tz,
			appointmentId: appt.id,
			googleSynced: appt.googleSynced,
			humanLabel: `${formatInTimeZone(startUtc, tz)} — all day`,
		};
	}

	// --- Time-range block ---
	const bStart = opts.startMinute as number;
	const bEnd = opts.endMinute as number;
	const { blocked, windows } = windowsForDate(bundle, opts.date);
	const remaining = blocked ? [] : subtractWindow(windows, bStart, bEnd);

	// Rewrite this date's overrides to reflect availability after the block.
	await db
		.delete(bookingDateOverrides)
		.where(and(eq(bookingDateOverrides.bookingProfileId, bundle.profile.id), eq(bookingDateOverrides.date, opts.date)));
	if (remaining.length === 0) {
		await db.insert(bookingDateOverrides).values({
			id: randomUUID(),
			bookingProfileId: bundle.profile.id,
			date: opts.date,
			isBlocked: true,
			startMinute: null,
			endMinute: null,
		});
	} else {
		await db.insert(bookingDateOverrides).values(
			remaining.map((w) => ({
				id: randomUUID(),
				bookingProfileId: bundle.profile.id,
				date: opts.date,
				isBlocked: false,
				startMinute: w.startMinute,
				endMinute: w.endMinute,
			})),
		);
	}

	const startUtc = zonedWallTimeToUtc(y, m, d, bStart, tz);
	const endUtc = zonedWallTimeToUtc(y, m, d, bEnd, tz);
	const appt = await createBusyAppointment({
		userId: opts.userId,
		organizationId: opts.organizationId,
		title: 'Blocked',
		startUtc,
		endUtc,
	});

	return {
		ok: true,
		mode: 'time_range',
		date: opts.date,
		timezone: tz,
		blocked: { start: minutesToHHMM(bStart), end: minutesToHHMM(bEnd) },
		appointmentId: appt.id,
		googleSynced: appt.googleSynced,
		humanLabel: `${formatInTimeZone(startUtc, tz)} – ${formatInTimeZone(endUtc, tz)}`,
	};
}

/** Undo all assistant-created blocks for a date: remove the date's overrides
 * (reverting to the weekly rules) and delete the Busy appointments we created. */
export async function unblockDate(opts: {
	userId: string;
	organizationId: string;
	seed: string;
	date: string;
}): Promise<{ ok: boolean; error?: string; date?: string; removedOverrides: number; removedAppointments: number }> {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
		return { ok: false, error: 'date must be YYYY-MM-DD', removedOverrides: 0, removedAppointments: 0 };
	}
	const bundle = await getOrCreateBookingProfile({
		userId: opts.userId,
		organizationId: opts.organizationId,
		seed: opts.seed,
	});
	const tz = bundle.profile.timezone;
	const [y, m, d] = opts.date.split('-').map(Number);

	const removedOverrides = await db
		.delete(bookingDateOverrides)
		.where(and(eq(bookingDateOverrides.bookingProfileId, bundle.profile.id), eq(bookingDateOverrides.date, opts.date)))
		.returning({ id: bookingDateOverrides.id });

	const dayStart = zonedWallTimeToUtc(y, m, d, 0, tz);
	const dayEnd = new Date(dayStart.getTime() + DAY_MS);
	const blockAppts = await db
		.select({ id: appointments.id, googleEventId: appointments.googleEventId })
		.from(appointments)
		.where(
			and(
				eq(appointments.userId, opts.userId),
				eq(appointments.organizationId, opts.organizationId),
				eq(appointments.source, BLOCK_SOURCE),
				gte(appointments.startsAt, dayStart.toISOString()),
				lt(appointments.startsAt, dayEnd.toISOString()),
			),
		);
	for (const a of blockAppts) {
		if (a.googleEventId) await deleteGoogleEvent(opts.userId, a.googleEventId);
		await db.delete(appointments).where(eq(appointments.id, a.id));
	}

	return {
		ok: true,
		date: opts.date,
		removedOverrides: removedOverrides.length,
		removedAppointments: blockAppts.length,
	};
}

export type CheckAvailabilityResult = {
	ok: boolean;
	error?: string;
	available?: boolean;
	date?: string;
	weekday?: string;
	time?: string;
	durationMinutes?: number;
	timezone?: string;
	reason?: 'past' | 'too_soon' | 'too_far_out' | 'blocked' | 'outside_hours' | 'conflict';
	humanLabel?: string;
};

/** Is the user free for `durationMinutes` starting at `startMinute` local on `date`? */
export async function checkAvailability(opts: {
	userId: string;
	organizationId: string;
	seed: string;
	date: string;
	startMinute: number;
	durationMinutes?: number;
}): Promise<CheckAvailabilityResult> {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) return { ok: false, error: 'date must be YYYY-MM-DD' };
	const duration = opts.durationMinutes && opts.durationMinutes > 0 ? opts.durationMinutes : DEFAULT_CHECK_DURATION;
	const bundle = await getOrCreateBookingProfile({
		userId: opts.userId,
		organizationId: opts.organizationId,
		seed: opts.seed,
	});
	const profile = bundle.profile;
	const tz = profile.timezone;
	const [y, m, d] = opts.date.split('-').map(Number);
	const startMinute = opts.startMinute;
	const endMinute = startMinute + duration;

	const startUtc = zonedWallTimeToUtc(y, m, d, startMinute, tz);
	const endUtc = new Date(startUtc.getTime() + duration * 60000);
	const now = Date.now();

	const base = {
		ok: true,
		date: opts.date,
		weekday: weekdayName(opts.date),
		time: minutesToHHMM(startMinute),
		durationMinutes: duration,
		timezone: tz,
		humanLabel: formatInTimeZone(startUtc, tz),
	};

	if (startUtc.getTime() < now) return { ...base, available: false, reason: 'past' };
	if (startUtc.getTime() < now + profile.minNoticeMinutes * 60000) return { ...base, available: false, reason: 'too_soon' };
	if (startUtc.getTime() > now + profile.maxDaysOut * DAY_MS) return { ...base, available: false, reason: 'too_far_out' };

	const { blocked, windows } = windowsForDate(bundle, opts.date);
	if (blocked) return { ...base, available: false, reason: 'blocked' };
	const inWindow = windows.some((w) => startMinute >= w.startMinute && endMinute <= w.endMinute);
	if (!inWindow) return { ...base, available: false, reason: 'outside_hours' };

	const busy = await busyForDate(opts.userId, opts.organizationId, opts.date, tz);
	const buffer = profile.bufferMinutes;
	const conflict = busy.some(
		(b) => startUtc.getTime() - buffer * 60000 < b.end && endUtc.getTime() + buffer * 60000 > b.start,
	);
	if (conflict) return { ...base, available: false, reason: 'conflict' };

	return { ...base, available: true };
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Weekday name for a YYYY-MM-DD key (no timezone — the key IS the local date). */
function weekdayName(dateKey: string): string {
	const [y, m, d] = dateKey.split('-').map(Number);
	return WEEKDAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** Group open slots by local day and coalesce contiguous ones into "h:mm–h:mm" ranges. */
function rangesByDay(slots: OpenSlot[], tz: string): Map<string, string[]> {
	const byDay = new Map<string, OpenSlot[]>();
	for (const s of slots) {
		const key = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
			new Date(s.startUtc),
		);
		const list = byDay.get(key) ?? [];
		list.push(s);
		byDay.set(key, list);
	}
	const fmtTime = (iso: string) =>
		new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
	const out = new Map<string, string[]>();
	for (const [key, daySlots] of byDay) {
		daySlots.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
		const ranges: string[] = [];
		let runStart = daySlots[0].startUtc;
		let runEnd = daySlots[0].endUtc;
		for (let i = 1; i < daySlots.length; i++) {
			if (daySlots[i].startUtc === runEnd) {
				runEnd = daySlots[i].endUtc;
			} else {
				ranges.push(`${fmtTime(runStart)}–${fmtTime(runEnd)}`);
				runStart = daySlots[i].startUtc;
				runEnd = daySlots[i].endUtc;
			}
		}
		ranges.push(`${fmtTime(runStart)}–${fmtTime(runEnd)}`);
		out.set(key, ranges);
	}
	return out;
}

export type DayAvailability = {
	date: string;
	weekday: string;
	/** 'open' = has free ranges; 'fully_booked' = has hours but all taken; 'blocked' = day blocked; 'no_hours' = not a working day. */
	status: 'open' | 'fully_booked' | 'blocked' | 'no_hours';
	ranges: string[];
};

export type ListAvailabilityResult = {
	ok: boolean;
	error?: string;
	timezone?: string;
	durationMinutes?: number;
	from?: string;
	to?: string;
	days?: DayAvailability[];
	/** One ready-to-speak line per day. Relay this verbatim — do not recompute weekdays. */
	summary?: string;
};

/** Free time across a date range. Includes EVERY day in the range with an
 * explicit status, plus a human `summary` the assistant can read back directly. */
export async function listAvailability(opts: {
	userId: string;
	organizationId: string;
	seed: string;
	from: string;
	to?: string;
	durationMinutes?: number;
}): Promise<ListAvailabilityResult> {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.from)) return { ok: false, error: 'from must be YYYY-MM-DD' };
	const toDate = opts.to && /^\d{4}-\d{2}-\d{2}$/.test(opts.to) ? opts.to : opts.from;
	if (toDate < opts.from) return { ok: false, error: 'to must be on or after from' };
	const duration = opts.durationMinutes && opts.durationMinutes > 0 ? opts.durationMinutes : DEFAULT_CHECK_DURATION;

	const bundle = await getOrCreateBookingProfile({
		userId: opts.userId,
		organizationId: opts.organizationId,
		seed: opts.seed,
	});
	const tz = bundle.profile.timezone;
	const [fy, fm, fd] = opts.from.split('-').map(Number);
	const [ty, tm, td] = toDate.split('-').map(Number);
	// Cover the full local days [from 00:00, to+1 00:00).
	const fromUtc = zonedWallTimeToUtc(fy, fm, fd, 0, tz);
	const toUtc = new Date(zonedWallTimeToUtc(ty, tm, td, 0, tz).getTime() + DAY_MS);

	const slots = await getOpenSlots({ profile: bundle.profile, eventType: { durationMinutes: duration }, fromUtc, toUtc });
	const ranges = rangesByDay(slots, tz);

	// Enumerate EVERY day in [from, to] so a fully-booked / non-working day is
	// reported explicitly instead of silently missing (which the model would
	// otherwise be free to mislabel).
	const days: DayAvailability[] = [];
	for (let key = opts.from; key <= toDate; key = addDaysToDateKey(key, 1)) {
		const dayRanges = ranges.get(key) ?? [];
		const { blocked, windows } = windowsForDate(bundle, key);
		let status: DayAvailability['status'];
		if (dayRanges.length > 0) status = 'open';
		else if (blocked) status = 'blocked';
		else if (windows.length === 0) status = 'no_hours';
		else status = 'fully_booked';
		days.push({ date: key, weekday: weekdayName(key), status, ranges: dayRanges });
	}

	const summary = days
		.map((d) => {
			const label = `${d.weekday} ${d.date}`;
			if (d.status === 'open') return `${label}: ${d.ranges.join(', ')}`;
			if (d.status === 'fully_booked') return `${label}: fully booked`;
			if (d.status === 'blocked') return `${label}: blocked off`;
			return `${label}: no booking hours (not a working day)`;
		})
		.join('\n');

	return { ok: true, timezone: tz, durationMinutes: duration, from: opts.from, to: toDate, days, summary };
}
