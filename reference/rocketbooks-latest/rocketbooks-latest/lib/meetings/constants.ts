// Client-safe constants for the meeting follow-up feature. Kept out of
// settings.ts (which is `server-only` because it touches the db) so the
// settings card and the server action can share one source of truth.

export const DEFAULT_GRACE_MINUTES = 30;

/** Allowed grace-period choices (minutes) surfaced in the settings card. */
export const GRACE_OPTIONS = [0, 15, 30, 60, 120, 240] as const;
