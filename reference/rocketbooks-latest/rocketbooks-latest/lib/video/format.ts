// Pure display helpers for the video session record. No Daily / no server-only —
// safe to import from any server or client component.

/** Human date+time, e.g. "May 30, 2026, 6:12 PM". */
export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Call length as "Xm SSs". Falls back to `now` when the call hasn't ended.
 * Returns "—" if we never recorded a start (no one joined).
 */
export function formatDuration(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt) return '—';
  const endMs = endedAt ? new Date(endedAt).getTime() : Date.now();
  const secs = Math.max(0, Math.round((endMs - new Date(startedAt).getTime()) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}
