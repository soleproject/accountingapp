// Shared defaults and helpers for the booking feature.

export const DEFAULT_TIMEZONE = 'America/New_York';
export const MIN_NOTICE_OPTIONS = [0, 60, 120, 240, 720, 1440]; // minutes
export const MAX_DAYS_OUT_OPTIONS = [7, 14, 30, 60, 90];
export const BUFFER_OPTIONS = [0, 5, 10, 15, 30];
export const DURATION_OPTIONS = [15, 30, 45, 60, 90, 120]; // minutes

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Slugify a name into a URL-safe token. Empty result falls back to the caller. */
export function slugify(input: string): string {
	return input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
}

/** minutes-from-midnight -> "HH:MM" 24h string for <input type="time">. */
export function minutesToHHMM(min: number): string {
	const h = Math.floor(min / 60);
	const m = min % 60;
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** "HH:MM" -> minutes from midnight. Returns null when invalid. */
export function hhmmToMinutes(value: string): number | null {
	const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
	if (!m) return null;
	const hours = Number(m[1]);
	const mins = Number(m[2]);
	if (hours < 0 || hours > 23 || mins < 0 || mins > 59) return null;
	return hours * 60 + mins;
}
