/**
 * recordings.source values produced by a notetaker bot joining a meeting
 * (Recall.ai → Zoom / Teams / Meet). Kept in sync with SOURCE_BY_PLATFORM in
 * app/api/recorder/bot/route.ts. The Notetaker page lists these; the Recorder
 * page (mic recordings) excludes them.
 */
export const BOT_SOURCES = ['zoom_bot', 'teams_bot', 'meet_bot'] as const;

export type BotSource = (typeof BOT_SOURCES)[number];
