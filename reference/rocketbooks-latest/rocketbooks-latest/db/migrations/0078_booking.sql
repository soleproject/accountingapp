-- Calendly-style availability + public booking links
-- Hand-written additive migration (idempotent). Booking is per-user.

-- One booking profile per user. Holds the public slug + global scheduling rules.
CREATE TABLE IF NOT EXISTS "booking_profiles" (
	"id" varchar PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"organization_id" varchar NOT NULL,
	"slug" varchar NOT NULL,
	"timezone" varchar DEFAULT 'America/New_York' NOT NULL,
	"min_notice_minutes" integer DEFAULT 240 NOT NULL,
	"max_days_out" integer DEFAULT 60 NOT NULL,
	"buffer_minutes" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
	ALTER TABLE "booking_profiles" ADD CONSTRAINT "booking_profiles_user_id_fkey"
		FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
	ALTER TABLE "booking_profiles" ADD CONSTRAINT "booking_profiles_organization_id_fkey"
		FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ux_booking_profiles_user" ON "booking_profiles" ("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "ux_booking_profiles_slug" ON "booking_profiles" ("slug");

-- Named, individually-linkable meeting types (e.g. "30-min intro").
CREATE TABLE IF NOT EXISTS "booking_event_types" (
	"id" varchar PRIMARY KEY NOT NULL,
	"booking_profile_id" varchar NOT NULL,
	"organization_id" varchar NOT NULL,
	"name" varchar NOT NULL,
	"slug" varchar NOT NULL,
	"duration_minutes" integer DEFAULT 30 NOT NULL,
	"description" text,
	"location" text,
	"color" varchar,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
	ALTER TABLE "booking_event_types" ADD CONSTRAINT "booking_event_types_profile_id_fkey"
		FOREIGN KEY ("booking_profile_id") REFERENCES "booking_profiles"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "ix_booking_event_types_profile" ON "booking_event_types" ("booking_profile_id");
CREATE UNIQUE INDEX IF NOT EXISTS "ux_booking_event_types_profile_slug" ON "booking_event_types" ("booking_profile_id", "slug");

-- Weekly recurring availability windows. Minutes are local to the profile timezone.
CREATE TABLE IF NOT EXISTS "booking_availability_rules" (
	"id" varchar PRIMARY KEY NOT NULL,
	"booking_profile_id" varchar NOT NULL,
	"weekday" integer NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
	ALTER TABLE "booking_availability_rules" ADD CONSTRAINT "booking_availability_rules_profile_id_fkey"
		FOREIGN KEY ("booking_profile_id") REFERENCES "booking_profiles"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "ix_booking_availability_rules_profile" ON "booking_availability_rules" ("booking_profile_id");

-- Per-date exceptions: block a day, or open one-off hours.
CREATE TABLE IF NOT EXISTS "booking_date_overrides" (
	"id" varchar PRIMARY KEY NOT NULL,
	"booking_profile_id" varchar NOT NULL,
	"date" date NOT NULL,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"start_minute" integer,
	"end_minute" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
	ALTER TABLE "booking_date_overrides" ADD CONSTRAINT "booking_date_overrides_profile_id_fkey"
		FOREIGN KEY ("booking_profile_id") REFERENCES "booking_profiles"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "ix_booking_date_overrides_profile" ON "booking_date_overrides" ("booking_profile_id", "date");

-- Booking records (audit, cancel link, delivery status).
CREATE TABLE IF NOT EXISTS "bookings" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"host_user_id" varchar NOT NULL,
	"booking_event_type_id" varchar,
	"appointment_id" varchar,
	"contact_id" varchar,
	"booker_name" varchar NOT NULL,
	"booker_email" varchar NOT NULL,
	"booker_phone" varchar,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" varchar DEFAULT 'confirmed' NOT NULL,
	"email_status" varchar,
	"sms_status" varchar,
	"google_event_id" text,
	"cancel_token" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
	ALTER TABLE "bookings" ADD CONSTRAINT "bookings_host_user_id_fkey"
		FOREIGN KEY ("host_user_id") REFERENCES "users"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
	ALTER TABLE "bookings" ADD CONSTRAINT "bookings_appointment_id_fkey"
		FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "ix_bookings_host_starts_at" ON "bookings" ("host_user_id", "starts_at");
CREATE UNIQUE INDEX IF NOT EXISTS "ux_bookings_cancel_token" ON "bookings" ("cancel_token");

-- Booked meetings flow into the existing appointments table (source = 'booking').
-- Denormalize booker info so the calendar detail panel can show it without a join.
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "booking_event_type_id" varchar;
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "booker_name" varchar;
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "booker_email" varchar;
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "booker_phone" varchar;
