// Timezone helpers for booking availability. No external deps — uses Intl so the
// host's IANA timezone (e.g. "America/New_York") is the source of truth for what
// "9:00 AM" means, independent of the server's or booker's clock.

/** Minutes to ADD to a UTC instant to get local wall-clock time in `timeZone`. */
export function tzOffsetMinutes(instant: Date, timeZone: string): number {
	const dtf = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hour12: false,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});
	const map: Record<string, string> = {};
	for (const p of dtf.formatToParts(instant)) map[p.type] = p.value;
	// Some runtimes emit hour "24" at midnight; normalize to 0.
	const hour = map.hour === '24' ? 0 : Number(map.hour);
	const asUtc = Date.UTC(
		Number(map.year),
		Number(map.month) - 1,
		Number(map.day),
		hour,
		Number(map.minute),
		Number(map.second),
	);
	return (asUtc - instant.getTime()) / 60000;
}

/** Convert a local wall-clock (date + minute-of-day) in `timeZone` to a UTC Date. */
export function zonedWallTimeToUtc(
	year: number,
	month: number, // 1-12
	day: number,
	minuteOfDay: number,
	timeZone: string,
): Date {
	const hour = Math.floor(minuteOfDay / 60);
	const minute = minuteOfDay % 60;
	const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
	const offset1 = tzOffsetMinutes(guess, timeZone);
	let utc = new Date(guess.getTime() - offset1 * 60000);
	// Refine once for DST transitions where the offset differs at the resolved instant.
	const offset2 = tzOffsetMinutes(utc, timeZone);
	if (offset2 !== offset1) {
		utc = new Date(guess.getTime() - offset2 * 60000);
	}
	return utc;
}

export type ZonedParts = {
	year: number;
	month: number; // 1-12
	day: number;
	weekday: number; // 0 = Sunday .. 6 = Saturday
	minuteOfDay: number;
	dateKey: string; // YYYY-MM-DD
};

/** Local calendar fields for an instant, in `timeZone`. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
	const dtf = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hour12: false,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	});
	const map: Record<string, string> = {};
	for (const p of dtf.formatToParts(instant)) map[p.type] = p.value;
	const year = Number(map.year);
	const month = Number(map.month);
	const day = Number(map.day);
	const hour = map.hour === '24' ? 0 : Number(map.hour);
	const minute = Number(map.minute);
	const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
	const dateKey = `${map.year}-${map.month}-${map.day}`;
	return { year, month, day, weekday, minuteOfDay: hour * 60 + minute, dateKey };
}

/** Add `n` calendar days to a YYYY-MM-DD key (no timezone involved). */
export function addDaysToDateKey(dateKey: string, n: number): string {
	const [y, m, d] = dateKey.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d + n));
	const yy = dt.getUTCFullYear();
	const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
	const dd = String(dt.getUTCDate()).padStart(2, '0');
	return `${yy}-${mm}-${dd}`;
}

/** Format a UTC instant as a human label in the given timezone (e.g. "Fri, Jun 6, 4:30 PM EDT"). */
export function formatInTimeZone(instant: Date, timeZone: string): string {
	return new Intl.DateTimeFormat('en-US', {
		timeZone,
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		timeZoneName: 'short',
	}).format(instant);
}

/** A reasonable list of IANA timezones to offer in the settings dropdown. */
export const COMMON_TIMEZONES = [
	'America/New_York',
	'America/Chicago',
	'America/Denver',
	'America/Phoenix',
	'America/Los_Angeles',
	'America/Anchorage',
	'Pacific/Honolulu',
	'America/Toronto',
	'America/Sao_Paulo',
	'Europe/London',
	'Europe/Paris',
	'Europe/Berlin',
	'Europe/Madrid',
	'Asia/Dubai',
	'Asia/Kolkata',
	'Asia/Singapore',
	'Asia/Tokyo',
	'Australia/Sydney',
	'UTC',
];
