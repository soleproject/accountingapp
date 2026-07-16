import { pgTable, varchar, text, timestamp, integer, boolean, date, index, uniqueIndex, foreignKey } from "drizzle-orm/pg-core";
import { users, organizations, appointments } from "./schema";

// Calendly-style booking. One profile per user; each profile exposes a public
// slug and one or more linkable event types. See db/migrations/0078_booking.sql.

export const bookingProfiles = pgTable("booking_profiles", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	organizationId: varchar("organization_id").notNull(),
	slug: varchar().notNull(),
	timezone: varchar().default('America/New_York').notNull(),
	minNoticeMinutes: integer("min_notice_minutes").default(240).notNull(),
	maxDaysOut: integer("max_days_out").default(60).notNull(),
	bufferMinutes: integer("buffer_minutes").default(0).notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ux_booking_profiles_user").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	uniqueIndex("ux_booking_profiles_slug").using("btree", table.slug.asc().nullsLast().op("text_ops")),
	foreignKey({ columns: [table.userId], foreignColumns: [users.id], name: "booking_profiles_user_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.organizationId], foreignColumns: [organizations.id], name: "booking_profiles_organization_id_fkey" }).onDelete("cascade"),
]);

export const bookingEventTypes = pgTable("booking_event_types", {
	id: varchar().primaryKey().notNull(),
	bookingProfileId: varchar("booking_profile_id").notNull(),
	organizationId: varchar("organization_id").notNull(),
	name: varchar().notNull(),
	slug: varchar().notNull(),
	durationMinutes: integer("duration_minutes").default(30).notNull(),
	description: text(),
	location: text(),
	color: varchar(),
	isActive: boolean("is_active").default(true).notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_booking_event_types_profile").using("btree", table.bookingProfileId.asc().nullsLast().op("text_ops")),
	uniqueIndex("ux_booking_event_types_profile_slug").using("btree", table.bookingProfileId.asc().nullsLast().op("text_ops"), table.slug.asc().nullsLast().op("text_ops")),
	foreignKey({ columns: [table.bookingProfileId], foreignColumns: [bookingProfiles.id], name: "booking_event_types_profile_id_fkey" }).onDelete("cascade"),
]);

export const bookingAvailabilityRules = pgTable("booking_availability_rules", {
	id: varchar().primaryKey().notNull(),
	bookingProfileId: varchar("booking_profile_id").notNull(),
	weekday: integer().notNull(), // 0 = Sunday .. 6 = Saturday
	startMinute: integer("start_minute").notNull(), // minutes from midnight, profile-local
	endMinute: integer("end_minute").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_booking_availability_rules_profile").using("btree", table.bookingProfileId.asc().nullsLast().op("text_ops")),
	foreignKey({ columns: [table.bookingProfileId], foreignColumns: [bookingProfiles.id], name: "booking_availability_rules_profile_id_fkey" }).onDelete("cascade"),
]);

export const bookingDateOverrides = pgTable("booking_date_overrides", {
	id: varchar().primaryKey().notNull(),
	bookingProfileId: varchar("booking_profile_id").notNull(),
	date: date().notNull(),
	isBlocked: boolean("is_blocked").default(false).notNull(),
	startMinute: integer("start_minute"),
	endMinute: integer("end_minute"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_booking_date_overrides_profile").using("btree", table.bookingProfileId.asc().nullsLast().op("text_ops"), table.date.asc().nullsLast()),
	foreignKey({ columns: [table.bookingProfileId], foreignColumns: [bookingProfiles.id], name: "booking_date_overrides_profile_id_fkey" }).onDelete("cascade"),
]);

export const bookings = pgTable("bookings", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	hostUserId: varchar("host_user_id").notNull(),
	bookingEventTypeId: varchar("booking_event_type_id"),
	appointmentId: varchar("appointment_id"),
	contactId: varchar("contact_id"),
	bookerName: varchar("booker_name").notNull(),
	bookerEmail: varchar("booker_email").notNull(),
	bookerPhone: varchar("booker_phone"),
	startsAt: timestamp("starts_at", { withTimezone: true, mode: 'string' }).notNull(),
	endsAt: timestamp("ends_at", { withTimezone: true, mode: 'string' }).notNull(),
	status: varchar().default('confirmed').notNull(),
	emailStatus: varchar("email_status"),
	smsStatus: varchar("sms_status"),
	googleEventId: text("google_event_id"),
	cancelToken: varchar("cancel_token").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_bookings_host_starts_at").using("btree", table.hostUserId.asc().nullsLast().op("text_ops"), table.startsAt.asc().nullsLast().op("timestamptz_ops")),
	uniqueIndex("ux_bookings_cancel_token").using("btree", table.cancelToken.asc().nullsLast().op("text_ops")),
	foreignKey({ columns: [table.hostUserId], foreignColumns: [users.id], name: "bookings_host_user_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.appointmentId], foreignColumns: [appointments.id], name: "bookings_appointment_id_fkey" }).onDelete("set null"),
]);
