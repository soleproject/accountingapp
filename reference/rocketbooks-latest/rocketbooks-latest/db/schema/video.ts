import { pgTable, varchar, text, timestamp, index, uniqueIndex, foreignKey } from "drizzle-orm/pg-core";
import { users } from "./schema";

// Organizer Video — one row per call started via POST /api/video/rooms, plus a
// participant row per join (the "complete session record" foundation, Phase A).
// See db/migrations/0082_video_sessions.sql and 0084_video_participants.sql.

export const videoSessions = pgTable("video_sessions", {
	id: varchar().primaryKey().notNull(),
	hostUserId: varchar("host_user_id").notNull(),
	roomName: varchar("room_name").notNull(),
	roomUrl: text("room_url").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
	transcriptEmailedAt: timestamp("transcript_emailed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("ix_video_sessions_host_created").using("btree", table.hostUserId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsLast().op("timestamptz_ops")),
	uniqueIndex("ux_video_sessions_room_name").using("btree", table.roomName.asc().nullsLast().op("text_ops")),
	foreignKey({ columns: [table.hostUserId], foreignColumns: [users.id], name: "video_sessions_host_user_id_fkey" }).onDelete("cascade"),
]);

// One row per participant-join. daily_session_id is the attribution key that
// future transcript/chat rows map back to a person with.
export const videoParticipants = pgTable("video_participants", {
	id: varchar().primaryKey().notNull(),
	sessionId: varchar("session_id").notNull(),
	userId: varchar("user_id"),
	displayName: varchar("display_name").notNull(),
	dailySessionId: varchar("daily_session_id").notNull(),
	role: varchar().notNull(), // 'host' | 'guest'
	joinedAt: timestamp("joined_at", { withTimezone: true, mode: 'string' }).notNull(),
	leftAt: timestamp("left_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ux_video_participants_session_daily").using("btree", table.sessionId.asc().nullsLast().op("text_ops"), table.dailySessionId.asc().nullsLast().op("text_ops")),
	index("ix_video_participants_session").using("btree", table.sessionId.asc().nullsLast().op("text_ops"), table.joinedAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({ columns: [table.sessionId], foreignColumns: [videoSessions.id], name: "video_participants_session_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.userId], foreignColumns: [users.id], name: "video_participants_user_id_fkey" }).onDelete("set null"),
]);

// One row per chat message (Phase B). Persisted host-side; participant_id is
// resolved from daily_session_id for speaker attribution (nullable on miss).
export const videoChatMessages = pgTable("video_chat_messages", {
	id: varchar().primaryKey().notNull(),
	sessionId: varchar("session_id").notNull(),
	participantId: varchar("participant_id"),
	senderName: varchar("sender_name").notNull(),
	text: text().notNull(),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_video_chat_messages_session").using("btree", table.sessionId.asc().nullsLast().op("text_ops"), table.sentAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({ columns: [table.sessionId], foreignColumns: [videoSessions.id], name: "video_chat_messages_session_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.participantId], foreignColumns: [videoParticipants.id], name: "video_chat_messages_participant_id_fkey" }).onDelete("set null"),
]);

// One row per transcription-message (Phase C, Daily live transcription).
// Persisted host-side; participant_id is the resolved speaker (nullable on miss).
export const videoTranscriptLines = pgTable("video_transcript_lines", {
	id: varchar().primaryKey().notNull(),
	sessionId: varchar("session_id").notNull(),
	participantId: varchar("participant_id"),
	speakerName: varchar("speaker_name").notNull(),
	text: text().notNull(),
	saidAt: timestamp("said_at", { withTimezone: true, mode: 'string' }).notNull(),
	source: varchar().default('daily_live').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_video_transcript_lines_session").using("btree", table.sessionId.asc().nullsLast().op("text_ops"), table.saidAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({ columns: [table.sessionId], foreignColumns: [videoSessions.id], name: "video_transcript_lines_session_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.participantId], foreignColumns: [videoParticipants.id], name: "video_transcript_lines_participant_id_fkey" }).onDelete("set null"),
]);
