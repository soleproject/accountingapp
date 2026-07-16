-- Hand-written: skips drizzle-kit generate because the meta journal has drifted
-- from the actual migrations on disk. Apply this directly via Supabase SQL editor.
-- The Drizzle TS schema for `aiUsageEvents` lives in db/schema/schema.ts.

CREATE TABLE "ai_usage_events" (
	"id" varchar PRIMARY KEY NOT NULL,
	"org_id" varchar,
	"user_id" varchar,
	"actor" varchar NOT NULL,
	"feature" varchar NOT NULL,
	"provider" varchar NOT NULL,
	"model" varchar NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cached_prompt_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"latency_ms" integer,
	"request_id" varchar,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ix_ai_usage_user_id" ON "ai_usage_events" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "ix_ai_usage_org_id" ON "ai_usage_events" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "ix_ai_usage_created_at" ON "ai_usage_events" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "ix_ai_usage_feature" ON "ai_usage_events" USING btree ("feature");
--> statement-breakpoint
CREATE INDEX "ix_ai_usage_model" ON "ai_usage_events" USING btree ("model");
