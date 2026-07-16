-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TYPE "public"."coa_ai_match_status" AS ENUM('PENDING', 'PROCESSING', 'COMPLETE', 'processing', 'complete', 'pending');--> statement-breakpoint
CREATE TYPE "public"."jobstatus" AS ENUM('PENDING', 'RUNNING', 'SUCCESS', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."jobtype" AS ENUM('PLAID_SYNC', 'AI_ORCHESTRATOR');--> statement-breakpoint
CREATE TYPE "public"."reconciliationmatchtype" AS ENUM('EXACT', 'FUZZY', 'SPLIT', 'TRANSFER');--> statement-breakpoint
CREATE TYPE "public"."reconciliationperiodstatus" AS ENUM('OPEN', 'RECONCILED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."statementlinestatus" AS ENUM('UNMATCHED', 'MATCHED', 'EXCLUDED');--> statement-breakpoint
CREATE TYPE "public"."taskstatus" AS ENUM('OPEN', 'DONE');--> statement-breakpoint
CREATE TABLE "activity_feed" (
	"id" varchar PRIMARY KEY NOT NULL,
	"org_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"actor" varchar NOT NULL,
	"event_type" varchar NOT NULL,
	"event_metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "ai_audit_actions" (
	"id" varchar PRIMARY KEY NOT NULL,
	"org_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"actor" varchar NOT NULL,
	"action_type" varchar NOT NULL,
	"before_state" jsonb NOT NULL,
	"after_state" jsonb NOT NULL,
	"rollback_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rolled_back" varchar
);
--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" varchar PRIMARY KEY NOT NULL,
	"admin_user_id" varchar NOT NULL,
	"action" varchar NOT NULL,
	"target_type" varchar NOT NULL,
	"target_id" varchar,
	"audit_metadata" jsonb,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_patterns" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"data" json NOT NULL,
	"confidence" double precision NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_ai_patterns_org_period" UNIQUE("organization_id","period_start","period_end")
);
--> statement-breakpoint
CREATE TABLE "alembic_version" (
	"version_num" varchar(255) PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_events" (
	"id" varchar PRIMARY KEY NOT NULL,
	"org_id" varchar NOT NULL,
	"type" varchar NOT NULL,
	"severity" varchar NOT NULL,
	"title" varchar NOT NULL,
	"message" varchar NOT NULL,
	"alert_metadata" json,
	"created_at" timestamp NOT NULL,
	"read_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "ai_recommendations" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"transaction_id" varchar,
	"contact_id" varchar,
	"recommendation_type" varchar NOT NULL,
	"current_contact_id" varchar,
	"suggested_contact_id" varchar,
	"current_category_account_id" varchar,
	"suggested_category_account_id" varchar,
	"current_coa_account_id" varchar,
	"suggested_coa_account_id" varchar,
	"anomaly_flag" boolean DEFAULT false NOT NULL,
	"reasoning" text,
	"ai_confidence" double precision,
	"status" varchar DEFAULT 'pending' NOT NULL,
	"applied_at" timestamp with time zone,
	"applied_by_user_id" varchar,
	"reverted_at" timestamp with time zone,
	"reverted_by_user_id" varchar,
	"trace_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "auto_categorization_actions" (
	"id" varchar PRIMARY KEY NOT NULL,
	"transaction_id" varchar NOT NULL,
	"organization_id" varchar NOT NULL,
	"suggested_category_id" varchar NOT NULL,
	"applied_category_id" varchar NOT NULL,
	"confidence" double precision NOT NULL,
	"reason" varchar NOT NULL,
	"user_id" varchar,
	"approved_at" varchar NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bill_lines" (
	"id" varchar PRIMARY KEY NOT NULL,
	"bill_id" varchar NOT NULL,
	"item_id" varchar,
	"description" text,
	"quantity" numeric(12, 2) NOT NULL,
	"unit_price" numeric(12, 2) NOT NULL,
	"amount" numeric(12, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bill_payment_applications" (
	"id" varchar PRIMARY KEY NOT NULL,
	"bill_payment_id" varchar NOT NULL,
	"bill_id" varchar NOT NULL,
	"amount_applied" numeric(12, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bill_payments" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"contact_id" varchar NOT NULL,
	"payment_date" date NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bills" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"contact_id" varchar NOT NULL,
	"bill_number" text,
	"bill_date" date NOT NULL,
	"due_date" date,
	"status" text DEFAULT 'open' NOT NULL,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_calendar_v2_snapshots" (
	"id" varchar PRIMARY KEY NOT NULL,
	"org_id" varchar NOT NULL,
	"month" varchar NOT NULL,
	"data" json NOT NULL,
	"financial_truth_signature" varchar NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_calendar_v2_summary_snapshots" (
	"id" varchar PRIMARY KEY NOT NULL,
	"org_id" varchar NOT NULL,
	"month" varchar NOT NULL,
	"data" json NOT NULL,
	"financial_truth_signature" varchar NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_plans" (
	"id" varchar PRIMARY KEY NOT NULL,
	"org_id" varchar NOT NULL,
	"created_at" timestamp NOT NULL,
	"plan_json" json,
	"ai_narrative" text
);
--> statement-breakpoint
CREATE TABLE "budget_snapshots" (
	"id" varchar PRIMARY KEY NOT NULL,
	"org_id" varchar NOT NULL,
	"month" varchar NOT NULL,
	"data" json NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"financial_truth_signature" varchar DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_summary_snapshots" (
	"id" varchar PRIMARY KEY NOT NULL,
	"org_id" varchar NOT NULL,
	"data" json NOT NULL,
	"financial_truth_signature" varchar NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bulk_operations" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"created_at" timestamp NOT NULL,
	"operation_type" varchar NOT NULL,
	"transaction_ids" json,
	"filters_snapshot" json,
	"from_category_id" varchar,
	"to_category_id" varchar,
	"from_contact_id" varchar,
	"to_contact_id" varchar
);
--> statement-breakpoint
CREATE TABLE "calendar_snapshots" (
	"id" varchar PRIMARY KEY NOT NULL,
	"org_id" varchar NOT NULL,
	"month" varchar NOT NULL,
	"data" json NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categorization_feedback" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"transaction_id" varchar NOT NULL,
	"was_correct" boolean NOT NULL,
	"previous_category_id" varchar,
	"corrected_category_id" varchar,
	"user_id" varchar,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "categorization_rules" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"rule_type" varchar NOT NULL,
	"pattern" varchar NOT NULL,
	"category_account_id" varchar NOT NULL,
	"confidence" double precision NOT NULL,
	"created_at" varchar NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chart_of_accounts" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"account_number" varchar NOT NULL,
	"account_name" varchar NOT NULL,
	"gaap_type" varchar NOT NULL,
	"account_type" varchar,
	"detail_type" varchar,
	"parent_account_id" varchar,
	"normal_balance" varchar NOT NULL,
	"is_active" boolean,
	"is_temporary" boolean,
	"created_by_ai" boolean,
	"system_generated" boolean,
	"needs_review" boolean,
	"compliance_note" varchar,
	"starting_balance" numeric,
	"starting_balance_date" date,
	"definition" varchar,
	"passed_name_contact_check" boolean NOT NULL,
	"suggested_match_coa_id" varchar,
	CONSTRAINT "chart_of_accounts_org_gaap_detail_unique" UNIQUE("organization_id","gaap_type","detail_type")
);
--> statement-breakpoint
CREATE TABLE "coa_hygiene_sweep_items" (
	"id" varchar PRIMARY KEY NOT NULL,
	"sweep_id" varchar NOT NULL,
	"old_coa_id" varchar NOT NULL,
	"old_coa_name" varchar NOT NULL,
	"reason" varchar NOT NULL,
	"new_coa_id" varchar NOT NULL,
	"new_coa_name" varchar NOT NULL,
	"match_confidence" double precision NOT NULL,
	"is_canonical" boolean NOT NULL,
	"transactions_moved_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_profiles" (
	"id" varchar PRIMARY KEY NOT NULL,
	"contact_id" varchar NOT NULL,
	"contact_type" text,
	"expected_categories" json,
	"exceptions" json,
	"notes" text,
	"ai_confidence" double precision,
	"last_reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"auto_apply_rules" boolean DEFAULT true,
	"strict_enforcement" boolean DEFAULT false,
	CONSTRAINT "contact_profiles_contact_id_key" UNIQUE("contact_id")
);
--> statement-breakpoint
CREATE TABLE "dashboard_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar NOT NULL,
	"total_revenue" numeric(24, 4) NOT NULL,
	"total_expenses" numeric(24, 4) NOT NULL,
	"net_income" numeric(24, 4) NOT NULL,
	"cash_balance" numeric(24, 4) NOT NULL,
	"ar_total" numeric(24, 4) NOT NULL,
	"ap_total" numeric(24, 4) NOT NULL,
	"recent_activity_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_dashboard_snapshots_org_id" UNIQUE("org_id")
);
--> statement-breakpoint
CREATE TABLE "coa_hygiene_sweeps" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_type" varchar NOT NULL,
	"status" varchar NOT NULL,
	"ai_version" varchar NOT NULL,
	"coas_corrected_count" integer NOT NULL,
	"transactions_updated_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolution_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"style" text NOT NULL,
	"template_id" text NOT NULL,
	"template_version" text NOT NULL,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"draft" text DEFAULT '' NOT NULL,
	"pdf_url" text,
	"signers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signature_request_id" text,
	"signature_status" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"workspace_id" uuid
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_record_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version_number" integer NOT NULL,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"draft" text DEFAULT '' NOT NULL,
	"pdf_url" text,
	"signers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"template_id" text NOT NULL,
	"template_version" text NOT NULL,
	"diff" jsonb,
	CONSTRAINT "uq_document_versions_record_version" UNIQUE("document_record_id","version_number")
);
--> statement-breakpoint
CREATE TABLE "enterprise_clients" (
	"id" varchar PRIMARY KEY NOT NULL,
	"enterprise_id" varchar NOT NULL,
	"client_user_id" varchar NOT NULL,
	"status" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enterprise_staff" (
	"id" varchar PRIMARY KEY NOT NULL,
	"enterprise_id" varchar NOT NULL,
	"staff_user_id" varchar NOT NULL,
	"role" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "export_jobs" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"format" varchar NOT NULL,
	"filters" jsonb,
	"sort_by" varchar,
	"sort_direction" varchar,
	"status" varchar NOT NULL,
	"transaction_count" integer,
	"file_size" integer,
	"file_path" varchar,
	"download_url" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"error_message" varchar,
	"columns" jsonb,
	"column_preset_id" varchar,
	"name" varchar
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"contact_name" text NOT NULL,
	"company_name" text,
	"individual_name" text,
	"email" text,
	"phone" text,
	"address" json,
	"type_tags" json DEFAULT '[]'::json NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_temporary" boolean,
	"created_by_ai" boolean,
	"system_generated" boolean,
	"needs_review" boolean,
	"logo_url" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed" boolean DEFAULT false,
	"is_widely_known" boolean DEFAULT false,
	"coa_ai_match" varchar,
	"coa_ai_match_status" "coa_ai_match_status" DEFAULT 'pending',
	"correct_widely_known_review" boolean
);
--> statement-breakpoint
CREATE TABLE "column_presets" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"name" varchar NOT NULL,
	"columns" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_record_id" uuid NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "imported_transactions" (
	"id" varchar PRIMARY KEY NOT NULL,
	"import_id" varchar,
	"organization_id" varchar,
	"source" varchar,
	"plaid_account_id" varchar,
	"plaid_transaction_id" varchar,
	"pending_transaction_id" varchar,
	"plaid_metadata" json,
	"account_id" varchar,
	"date" date,
	"description" varchar,
	"amount" numeric(12, 2),
	"debit" double precision,
	"credit" double precision,
	"balance" double precision,
	"currency_code" varchar,
	"check_number" varchar,
	"reference_number" varchar,
	"merchant_name" varchar,
	"raw_merchant_name" varchar,
	"merchant_address" varchar,
	"category" varchar,
	"type" varchar,
	"account_number" varchar,
	"routing_number" varchar,
	"memo" varchar,
	"contact_name" varchar,
	"raw_row" json NOT NULL,
	"status" varchar,
	"category_guess" varchar,
	"contact_guess" varchar,
	"confidence_score" double precision,
	"ai_predicted_category" varchar,
	"ai_predicted_contact" varchar,
	"ai_confidence" double precision,
	"auto_confirmed" boolean,
	"user_confirmed" boolean,
	"is_transfer" boolean,
	"transfer_group_id" varchar,
	"transfer_type" varchar,
	"is_recurring" boolean,
	"recurring_group_id" varchar,
	"recurring_interval" varchar,
	"recurring_amount" numeric,
	"is_anomaly" boolean,
	"anomaly_type" varchar,
	"anomaly_severity" varchar,
	"anomaly_message" varchar,
	"promotion_status" varchar,
	"promoted_transaction_id" varchar,
	"promotion_error" varchar,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"semantic_category" text,
	"semantic_contact" text,
	"semantic_reasoning" text,
	"semantic_confidence" double precision,
	"semantic_data" jsonb,
	"pfc_primary" varchar,
	"pfc_detailed" varchar,
	"pfc_confidence" varchar,
	"pfc_version" varchar,
	"business_finance_category_primary" text,
	"business_finance_category_detailed" text,
	"business_finance_category_confidence" text,
	"flag_type" varchar,
	"flag_reason" varchar,
	"is_promotable_cached" boolean,
	"promotability_reason_cached" text,
	CONSTRAINT "imported_transactions_plaid_transaction_id_key" UNIQUE("plaid_transaction_id")
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"account_id" varchar NOT NULL,
	"method" varchar NOT NULL,
	"import_method" varchar,
	"transaction_count" integer,
	"start_date" date,
	"end_date" date,
	"created_at" timestamp NOT NULL,
	"filename" varchar,
	"status" varchar NOT NULL,
	"hash" varchar,
	"saved_file_path" varchar,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"contact_id" varchar NOT NULL,
	"invoice_number" text,
	"invoice_date" date NOT NULL,
	"due_date" date,
	"status" text DEFAULT 'draft' NOT NULL,
	"memo" text,
	"posted" boolean NOT NULL,
	"posted_at" timestamp with time zone,
	"journal_entry_id" varchar,
	"ar_account_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "initial_review_state" (
	"id" varchar PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"current_step_id" varchar NOT NULL,
	"completed_steps" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" varchar NOT NULL,
	CONSTRAINT "uq_initial_review_state_user_id" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" varchar PRIMARY KEY NOT NULL,
	"invoice_id" varchar NOT NULL,
	"item_id" varchar,
	"description" text,
	"quantity" numeric(12, 2) NOT NULL,
	"unit_price" numeric(12, 2) NOT NULL,
	"amount" numeric(12, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_payment_applications" (
	"id" varchar PRIMARY KEY NOT NULL,
	"invoice_payment_id" varchar NOT NULL,
	"invoice_id" varchar NOT NULL,
	"amount_applied" numeric(12, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_payments" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"contact_id" varchar NOT NULL,
	"payment_date" date NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"unit_price" numeric(12, 2),
	"income_account_id" varchar,
	"expense_account_id" varchar,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" varchar PRIMARY KEY NOT NULL,
	"type" "jobtype" NOT NULL,
	"status" "jobstatus" NOT NULL,
	"organization_id" varchar,
	"account_id" varchar,
	"created_at" timestamp NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"error_message" varchar,
	"metadata" json
);
--> statement-breakpoint
CREATE TABLE "general_ledger" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar,
	"account_id" varchar,
	"journal_entry_id" varchar,
	"journal_entry_line_id" varchar,
	"contact_id" varchar,
	"date" timestamp,
	"memo" varchar,
	"debit" double precision,
	"credit" double precision,
	"balance" double precision,
	"created_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" varchar PRIMARY KEY NOT NULL,
	"org_id" varchar NOT NULL,
	"name" varchar NOT NULL,
	"target_amount" numeric(12, 2) NOT NULL,
	"current_amount" numeric(12, 2) NOT NULL,
	"target_date" date,
	"monthly_contribution" numeric(12, 2),
	"priority" varchar NOT NULL,
	"status" varchar NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opening_balance_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" varchar,
	"created_at" timestamp,
	"description" varchar
);
--> statement-breakpoint
CREATE TABLE "onboarding_audit_log" (
	"id" varchar PRIMARY KEY NOT NULL,
	"org_id" varchar NOT NULL,
	"user_id" varchar,
	"event_type" varchar NOT NULL,
	"step" varchar,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_state" (
	"org_id" varchar PRIMARY KEY NOT NULL,
	"phase" varchar NOT NULL,
	"step" varchar,
	"context" jsonb NOT NULL,
	"completed" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_sync_status" (
	"org_id" varchar PRIMARY KEY NOT NULL,
	"syncing" boolean DEFAULT false NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_support_users" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"support_user_id" varchar NOT NULL,
	"status" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_org_support_user" UNIQUE("organization_id","support_user_id")
);
--> statement-breakpoint
CREATE TABLE "organization_user_invites" (
	"id" varchar PRIMARY KEY NOT NULL,
	"org_id" varchar NOT NULL,
	"inviter_id" varchar NOT NULL,
	"email" varchar NOT NULL,
	"phone" varchar,
	"invited_for" varchar NOT NULL,
	"token" varchar NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"date" date NOT NULL,
	"memo" varchar,
	"posted" boolean NOT NULL,
	"created_at" timestamp NOT NULL,
	"posted_at" timestamp,
	"source_type" varchar,
	"source_id" varchar
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"payment_id" varchar(255) NOT NULL,
	"invoice_id" varchar(255),
	"bill_id" varchar(255),
	"amount" numeric(15, 2) NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"type" varchar NOT NULL,
	"customer_id" varchar,
	"vendor_id" varchar,
	"invoice_id" varchar,
	"bill_id" varchar,
	"payment_date" varchar NOT NULL,
	"amount" double precision NOT NULL,
	"ar_account_id" varchar,
	"ap_account_id" varchar,
	"bank_account_id" varchar,
	"journal_entry_id" varchar,
	"created_at" varchar DEFAULT 'CURRENT_TIMESTAMP'
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" varchar PRIMARY KEY NOT NULL,
	"name" varchar NOT NULL,
	"owner_user_id" varchar NOT NULL,
	"client_id" varchar,
	"plan_type" varchar DEFAULT 'pro' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accounting_method" varchar DEFAULT 'accrual' NOT NULL,
	"domain" varchar,
	"logo_url" varchar,
	"powered_by_text" varchar,
	"powered_by_enabled" boolean DEFAULT true,
	"primary_contact_id" uuid,
	"processing_mode" varchar DEFAULT 'batched' NOT NULL,
	"onboarding_mode" varchar DEFAULT 'simple' NOT NULL,
	"auto_apply_recommendations" boolean DEFAULT false NOT NULL,
	"auto_apply_types" json DEFAULT '[]'::json NOT NULL,
	"entity_type" varchar,
	"beneficiaries" json DEFAULT '[]'::json NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_entry_lines" (
	"id" varchar PRIMARY KEY NOT NULL,
	"journal_entry_id" varchar NOT NULL,
	"account_id" varchar NOT NULL,
	"debit" numeric NOT NULL,
	"credit" numeric NOT NULL,
	"memo" varchar,
	"created_at" timestamp NOT NULL,
	"contact_id" varchar
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" varchar PRIMARY KEY NOT NULL,
	"business_id" varchar NOT NULL,
	"pay_schedule_id" varchar,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"pay_date" date NOT NULL,
	"status" varchar DEFAULT 'draft' NOT NULL,
	"total_gross" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"total_net" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"total_taxes" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"total_benefits" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_contractors" (
	"id" varchar PRIMARY KEY NOT NULL,
	"business_id" varchar NOT NULL,
	"name" varchar NOT NULL,
	"email" varchar,
	"status" varchar DEFAULT 'active' NOT NULL,
	"pay_rate" numeric(10, 2) NOT NULL,
	"payment_method" varchar DEFAULT 'direct_deposit' NOT NULL,
	"bank_account_ref" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_employees" (
	"id" varchar PRIMARY KEY NOT NULL,
	"business_id" varchar NOT NULL,
	"first_name" varchar NOT NULL,
	"last_name" varchar NOT NULL,
	"email" varchar,
	"status" varchar DEFAULT 'active' NOT NULL,
	"hire_date" date,
	"termination_date" date,
	"pay_type" varchar NOT NULL,
	"pay_rate" numeric(10, 2) NOT NULL,
	"default_hours_per_period" numeric(5, 2),
	"tax_info_id" varchar,
	"benefits_enrollment_id" varchar,
	"payment_method" varchar DEFAULT 'direct_deposit' NOT NULL,
	"bank_account_ref" varchar,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_line_items" (
	"id" varchar PRIMARY KEY NOT NULL,
	"payroll_run_id" varchar NOT NULL,
	"employee_id" varchar,
	"contractor_id" varchar,
	"type" varchar NOT NULL,
	"gross_pay" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"net_pay" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"taxes_withheld" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"benefits_withheld" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"reimbursements" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"bonuses" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"commissions" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"hours_worked" numeric(5, 2),
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "payroll_schedules" (
	"id" varchar PRIMARY KEY NOT NULL,
	"business_id" varchar NOT NULL,
	"name" varchar NOT NULL,
	"frequency" varchar NOT NULL,
	"next_pay_date" date,
	"last_pay_date" date,
	"pay_period_start" date,
	"pay_period_end" date,
	"timezone" varchar DEFAULT 'UTC' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission_sets" (
	"id" varchar PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_accounts" (
	"id" varchar PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"balance" numeric(15, 2) NOT NULL,
	"institution" text,
	"plaid_account_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_budgets" (
	"id" varchar PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"category" text NOT NULL,
	"monthly_limit" numeric(15, 2) NOT NULL,
	"spent" numeric(15, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_tax_info" (
	"id" varchar PRIMARY KEY NOT NULL,
	"employee_id" varchar NOT NULL,
	"filing_status" varchar,
	"allowances" numeric(3, 0) DEFAULT '0',
	"additional_withholding" numeric(10, 2) DEFAULT '0.00',
	"state" varchar,
	"locality" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_tax_info_employee_id_key" UNIQUE("employee_id")
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" varchar PRIMARY KEY NOT NULL,
	"key" varchar(255) NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "personal_cashflow" (
	"id" varchar PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"month" date NOT NULL,
	"income" numeric(15, 2) NOT NULL,
	"expenses" numeric(15, 2) NOT NULL,
	"net" numeric(15, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_goals" (
	"id" varchar PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"name" text NOT NULL,
	"target_amount" numeric(15, 2) NOT NULL,
	"current_amount" numeric(15, 2) NOT NULL,
	"target_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_networth" (
	"id" varchar PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"date" date NOT NULL,
	"assets" numeric(15, 2) NOT NULL,
	"liabilities" numeric(15, 2) NOT NULL,
	"networth" numeric(15, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_transactions" (
	"id" varchar PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"account_id" varchar NOT NULL,
	"date" date NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"category" text,
	"description" text,
	"merchant" text,
	"plaid_transaction_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plaid_raw_transactions" (
	"id" varchar PRIMARY KEY NOT NULL,
	"plaid_account_id" varchar NOT NULL,
	"plaid_transaction_id" varchar NOT NULL,
	"date" date NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"description" varchar,
	"raw_json" json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plaid_sync_batches" (
	"id" varchar PRIMARY KEY NOT NULL,
	"plaid_account_id" varchar NOT NULL,
	"cursor" varchar,
	"added_count" integer NOT NULL,
	"modified_count" integer NOT NULL,
	"removed_count" integer NOT NULL,
	"raw_json" json,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qbo_account_staging" (
	"id" varchar PRIMARY KEY NOT NULL,
	"migration_job_id" varchar NOT NULL,
	"realm_id" varchar NOT NULL,
	"raw_qbo_id" varchar NOT NULL,
	"name" varchar NOT NULL,
	"type" varchar NOT NULL,
	"subtype" varchar,
	"fully_qualified_name" varchar,
	"is_active" boolean NOT NULL,
	"raw_json" json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_maintenance_state" (
	"id" varchar PRIMARY KEY NOT NULL,
	"maintenance_mode" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "predictive_cash_flow_snapshots" (
	"id" varchar PRIMARY KEY NOT NULL,
	"org_id" varchar NOT NULL,
	"range" integer NOT NULL,
	"data" json NOT NULL,
	"financial_truth_signature" varchar NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processing_modes" (
	"id" varchar PRIMARY KEY NOT NULL,
	"internal_name" varchar NOT NULL,
	"display_name" varchar NOT NULL,
	"source" varchar DEFAULT 'system' NOT NULL,
	"status" varchar DEFAULT 'stable' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plaid_accounts" (
	"id" varchar PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"institution_name" varchar NOT NULL,
	"institution_logo" varchar,
	"account_name" varchar NOT NULL,
	"last4" varchar,
	"account_type" varchar NOT NULL,
	"subtype" varchar,
	"balance" numeric(18, 2),
	"connection_status" varchar NOT NULL,
	"linked_organization_id" varchar,
	"linked_personal_id" varchar,
	"chart_of_account_id" varchar,
	"plaid_access_token" varchar NOT NULL,
	"plaid_item_id" varchar NOT NULL,
	"plaid_account_id" varchar,
	"plaid_cursor" varchar,
	"last_synced_at" timestamp with time zone,
	"sync_status" varchar NOT NULL,
	"sync_error_message" varchar,
	"last_sync_error_at" timestamp with time zone,
	"last_sync_started_at" timestamp with time zone,
	"last_sync_error" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"has_user_synced_once" boolean DEFAULT false NOT NULL,
	"sync_in_progress" boolean DEFAULT false NOT NULL,
	"promotion_requested" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qbo_customer_staging" (
	"id" varchar PRIMARY KEY NOT NULL,
	"migration_job_id" varchar NOT NULL,
	"realm_id" varchar NOT NULL,
	"raw_qbo_id" varchar NOT NULL,
	"display_name" varchar NOT NULL,
	"primary_email" varchar,
	"primary_phone" varchar,
	"raw_json" json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qbo_invoice_staging" (
	"id" varchar PRIMARY KEY NOT NULL,
	"migration_job_id" varchar NOT NULL,
	"realm_id" varchar NOT NULL,
	"raw_qbo_id" varchar NOT NULL,
	"customer_qbo_id" varchar,
	"txn_date" date,
	"due_date" date,
	"total_amount" numeric(18, 2) NOT NULL,
	"balance" numeric(18, 2) NOT NULL,
	"raw_json" json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qbo_mapping_overrides" (
	"id" varchar PRIMARY KEY NOT NULL,
	"migration_job_id" varchar NOT NULL,
	"entity_type" varchar NOT NULL,
	"staging_id" varchar NOT NULL,
	"field" varchar NOT NULL,
	"original_value" json,
	"override_value" json NOT NULL,
	"created_by_user_id" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qbo_mapping_results" (
	"id" varchar PRIMARY KEY NOT NULL,
	"migration_job_id" varchar NOT NULL,
	"result_json" json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qbo_migration_logs" (
	"id" varchar PRIMARY KEY NOT NULL,
	"job_id" varchar NOT NULL,
	"message" text,
	"level" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qbo_bill_staging" (
	"id" varchar PRIMARY KEY NOT NULL,
	"migration_job_id" varchar NOT NULL,
	"realm_id" varchar NOT NULL,
	"raw_qbo_id" varchar NOT NULL,
	"vendor_qbo_id" varchar,
	"txn_date" date,
	"due_date" date,
	"total_amount" numeric(18, 2) NOT NULL,
	"balance" numeric(18, 2) NOT NULL,
	"raw_json" json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qbo_migration_summaries" (
	"id" varchar PRIMARY KEY NOT NULL,
	"migration_job_id" varchar NOT NULL,
	"summary_json" json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qbo_mirroring_jobs" (
	"id" varchar PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"org_id" varchar,
	"realm_id" varchar NOT NULL,
	"status" varchar NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_successful_sync_at" timestamp with time zone,
	"qbo_change_token" varchar,
	"logs" json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qbo_oauth_states" (
	"id" varchar PRIMARY KEY NOT NULL,
	"state" varchar(255) NOT NULL,
	"user_id" varchar NOT NULL,
	"org_id" varchar,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"return_context" varchar(50)
);
--> statement-breakpoint
CREATE TABLE "qbo_payment_staging" (
	"id" varchar PRIMARY KEY NOT NULL,
	"migration_job_id" varchar NOT NULL,
	"realm_id" varchar NOT NULL,
	"raw_qbo_id" varchar NOT NULL,
	"customer_qbo_id" varchar,
	"total_amount" numeric(18, 2) NOT NULL,
	"txn_date" date,
	"raw_json" json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qbo_migration_jobs" (
	"id" varchar PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"org_id" varchar,
	"realm_id" varchar NOT NULL,
	"status" varchar NOT NULL,
	"error_message" text,
	"progress" integer,
	"migration_report" json,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "qbo_connections" (
	"id" varchar PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"org_id" varchar,
	"realm_id" varchar NOT NULL,
	"access_token" varchar NOT NULL,
	"refresh_token" varchar NOT NULL,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"refresh_token_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qbo_webhook_events" (
	"id" varchar PRIMARY KEY NOT NULL,
	"realm_id" varchar NOT NULL,
	"event_type" varchar NOT NULL,
	"raw_payload" json NOT NULL,
	"status" varchar NOT NULL,
	"attempts" integer NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quick_dashboard_snapshots" (
	"id" varchar PRIMARY KEY NOT NULL,
	"org_id" varchar NOT NULL,
	"scope" varchar NOT NULL,
	"data" json NOT NULL,
	"financial_truth_signature" varchar NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipt_lines" (
	"id" varchar PRIMARY KEY NOT NULL,
	"receipt_id" varchar NOT NULL,
	"description" varchar NOT NULL,
	"quantity" double precision DEFAULT '1' NOT NULL,
	"unit_price" double precision DEFAULT '0' NOT NULL,
	"amount" double precision NOT NULL,
	"expense_account_id" varchar,
	"category_guess" varchar,
	"item_name" varchar
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"contact_id" varchar,
	"receipt_date" varchar,
	"memo" varchar,
	"total_amount" double precision NOT NULL,
	"status" varchar DEFAULT 'draft' NOT NULL,
	"receipt_image_id" varchar,
	"journal_entry_id" varchar,
	"raw_text" text,
	"veryfi_document_id" varchar,
	"veryfi_raw_json" text,
	"posted" boolean DEFAULT false NOT NULL,
	"posted_at" varchar,
	"vendor_metadata" text
);
--> statement-breakpoint
CREATE TABLE "resolution_packet_exports" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"storage_filename" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resolution_packets" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"generated_at" varchar,
	"sections" jsonb NOT NULL,
	"signature" varchar NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_document_text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"id" varchar PRIMARY KEY NOT NULL,
	"role_id" varchar NOT NULL,
	"permission_id" varchar NOT NULL,
	CONSTRAINT "uq_role_permission" UNIQUE("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" varchar PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_exports" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"format" varchar NOT NULL,
	"column_preset_id" varchar,
	"columns" jsonb,
	"schedule" varchar NOT NULL,
	"schedule_type" varchar NOT NULL,
	"filters" jsonb,
	"sort_by" varchar,
	"sort_direction" varchar,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"is_active" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"user_id" varchar,
	"name" varchar NOT NULL,
	"filters_json" text NOT NULL,
	"sort_by" varchar,
	"sort_direction" varchar,
	"created_at" varchar NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qbo_vendor_staging" (
	"id" varchar PRIMARY KEY NOT NULL,
	"migration_job_id" varchar NOT NULL,
	"realm_id" varchar NOT NULL,
	"raw_qbo_id" varchar NOT NULL,
	"display_name" varchar NOT NULL,
	"primary_email" varchar,
	"primary_phone" varchar,
	"raw_json" json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_periods" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"account_id" varchar NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"statement_opening_balance" numeric(14, 2),
	"statement_closing_balance" numeric(14, 2),
	"ledger_opening_balance" numeric(14, 2),
	"ledger_closing_balance" numeric(14, 2),
	"status" "reconciliationperiodstatus" NOT NULL,
	"difference" numeric(14, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opening_statement_balance" numeric(19, 4),
	"closing_statement_balance" numeric(19, 4),
	"opening_ledger_balance" numeric(19, 4),
	"closing_ledger_balance" numeric(19, 4)
);
--> statement-breakpoint
CREATE TABLE "tag_categories" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag_items" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"tag_type" varchar NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"linked_entity_type" varchar,
	"linked_entity_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_processor_source_mappings" (
	"source" varchar PRIMARY KEY NOT NULL,
	"processing_mode" varchar NOT NULL,
	"updated_by_user_id" varchar,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "transaction_splits" (
	"id" varchar PRIMARY KEY NOT NULL,
	"transaction_id" varchar,
	"account_id" varchar,
	"debit" double precision,
	"credit" double precision,
	"memo" varchar,
	"created_at" timestamp,
	"amount" double precision,
	"category_type" varchar,
	"category_account_id" varchar,
	"contact_id" varchar,
	"notes" varchar
);
--> statement-breakpoint
CREATE TABLE "user_permission_overrides" (
	"id" varchar PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"permission_id" varchar NOT NULL,
	"allow" boolean NOT NULL,
	CONSTRAINT "uq_user_permission_override" UNIQUE("user_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "statement_lines" (
	"id" varchar PRIMARY KEY NOT NULL,
	"reconciliation_period_id" varchar NOT NULL,
	"organization_id" varchar NOT NULL,
	"account_id" varchar NOT NULL,
	"statement_date" date NOT NULL,
	"description_raw" text,
	"amount" numeric(14, 2) NOT NULL,
	"running_balance" numeric(14, 2),
	"external_id" varchar,
	"status" "statementlinestatus" NOT NULL,
	"matched_transaction_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_onboarding_state" (
	"id" varchar PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"current_step_id" varchar NOT NULL,
	"completed_steps" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_user_onboarding_state_user_id" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "user_permission_sets" (
	"id" varchar PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"permission_set_id" varchar NOT NULL,
	CONSTRAINT "uq_user_permission_set" UNIQUE("user_id","permission_set_id")
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"id" varchar PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"role_id" varchar NOT NULL,
	CONSTRAINT "uq_user_role" UNIQUE("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" varchar PRIMARY KEY NOT NULL,
	"preferences_json" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" varchar,
	"date" date NOT NULL,
	"description" varchar,
	"reference" varchar,
	"amount" double precision,
	"created_at" timestamp,
	"account_id" varchar,
	"contact_id" varchar,
	"type" varchar,
	"bank_description" varchar,
	"user_description" varchar,
	"tag_id" varchar,
	"category_type" varchar,
	"category_account_id" varchar,
	"payment_id" varchar,
	"journal_entry_id" varchar,
	"import_id" varchar,
	"reviewed" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" varchar PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"organization_id" varchar,
	"product" varchar NOT NULL,
	"page" varchar,
	"entity_id" varchar,
	"title" varchar NOT NULL,
	"description" text,
	"subject" varchar,
	"module" varchar,
	"category" varchar,
	"priority" varchar,
	"due_date" timestamp with time zone,
	"status" "taskstatus" NOT NULL,
	"source" varchar,
	"auto_created" boolean,
	"review_required" boolean,
	"assigned_to_users" json DEFAULT '[]'::json,
	"assigned_to_contacts" json DEFAULT '[]'::json,
	"entity_type" varchar,
	"subitems" json DEFAULT '[]'::json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"transaction_id" varchar
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY NOT NULL,
	"email" varchar NOT NULL,
	"password_hash" varchar NOT NULL,
	"full_name" varchar NOT NULL,
	"is_active" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	"role" varchar NOT NULL,
	"organization_id" varchar,
	"active_organization_id" varchar
);
--> statement-breakpoint
CREATE TABLE "goal_progress" (
	"id" varchar PRIMARY KEY NOT NULL,
	"goal_id" varchar NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"date" date NOT NULL,
	"source" varchar NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opening_balance_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"batch_id" integer,
	"account_id" integer,
	"amount" double precision,
	"created_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "payroll_benefit_enrollments" (
	"id" varchar PRIMARY KEY NOT NULL,
	"employee_id" varchar NOT NULL,
	"benefit_type" varchar NOT NULL,
	"contribution_amount" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"employer_contribution" numeric(10, 2) DEFAULT '0.00',
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission_set_permissions" (
	"id" varchar PRIMARY KEY NOT NULL,
	"permission_set_id" varchar NOT NULL,
	"permission_id" varchar NOT NULL,
	CONSTRAINT "uq_permission_set_permission" UNIQUE("permission_set_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "reconciliation_matches" (
	"id" varchar PRIMARY KEY NOT NULL,
	"reconciliation_period_id" varchar NOT NULL,
	"statement_line_id" varchar NOT NULL,
	"transaction_id" varchar NOT NULL,
	"match_type" "reconciliationmatchtype" NOT NULL,
	"score" double precision,
	"created_by" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_recommendations" ADD CONSTRAINT "ai_recommendations_applied_by_user_id_fkey" FOREIGN KEY ("applied_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_recommendations" ADD CONSTRAINT "ai_recommendations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_recommendations" ADD CONSTRAINT "ai_recommendations_current_category_account_id_fkey" FOREIGN KEY ("current_category_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_recommendations" ADD CONSTRAINT "ai_recommendations_current_coa_account_id_fkey" FOREIGN KEY ("current_coa_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_recommendations" ADD CONSTRAINT "ai_recommendations_current_contact_id_fkey" FOREIGN KEY ("current_contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_recommendations" ADD CONSTRAINT "ai_recommendations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_recommendations" ADD CONSTRAINT "ai_recommendations_reverted_by_user_id_fkey" FOREIGN KEY ("reverted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_recommendations" ADD CONSTRAINT "ai_recommendations_suggested_category_account_id_fkey" FOREIGN KEY ("suggested_category_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_recommendations" ADD CONSTRAINT "ai_recommendations_suggested_coa_account_id_fkey" FOREIGN KEY ("suggested_coa_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_recommendations" ADD CONSTRAINT "ai_recommendations_suggested_contact_id_fkey" FOREIGN KEY ("suggested_contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_recommendations" ADD CONSTRAINT "ai_recommendations_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_of_accounts" ADD CONSTRAINT "chart_of_accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_of_accounts" ADD CONSTRAINT "chart_of_accounts_parent_account_id_fkey" FOREIGN KEY ("parent_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_of_accounts" ADD CONSTRAINT "chart_of_accounts_suggested_match_coa_id_fkey" FOREIGN KEY ("suggested_match_coa_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coa_hygiene_sweep_items" ADD CONSTRAINT "coa_hygiene_sweep_items_sweep_id_fkey" FOREIGN KEY ("sweep_id") REFERENCES "public"."coa_hygiene_sweeps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_profiles" ADD CONSTRAINT "contact_profiles_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_snapshots" ADD CONSTRAINT "dashboard_snapshots_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_record_id_fkey" FOREIGN KEY ("document_record_id") REFERENCES "public"."document_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_clients" ADD CONSTRAINT "enterprise_clients_client_user_id_fkey" FOREIGN KEY ("client_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_clients" ADD CONSTRAINT "enterprise_clients_enterprise_id_fkey" FOREIGN KEY ("enterprise_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_staff" ADD CONSTRAINT "enterprise_staff_enterprise_id_fkey" FOREIGN KEY ("enterprise_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_staff" ADD CONSTRAINT "enterprise_staff_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "fk_export_jobs_column_preset" FOREIGN KEY ("column_preset_id") REFERENCES "public"."column_presets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "column_presets" ADD CONSTRAINT "column_presets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "column_presets" ADD CONSTRAINT "column_presets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_audit_events" ADD CONSTRAINT "document_audit_events_document_record_id_fkey" FOREIGN KEY ("document_record_id") REFERENCES "public"."document_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_transactions" ADD CONSTRAINT "imported_transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_transactions" ADD CONSTRAINT "imported_transactions_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_transactions" ADD CONSTRAINT "imported_transactions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_transactions" ADD CONSTRAINT "imported_transactions_plaid_account_id_fkey" FOREIGN KEY ("plaid_account_id") REFERENCES "public"."plaid_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_ar_account_id_fkey" FOREIGN KEY ("ar_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "general_ledger" ADD CONSTRAINT "general_ledger_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "general_ledger" ADD CONSTRAINT "general_ledger_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "general_ledger" ADD CONSTRAINT "general_ledger_journal_entry_line_id_fkey" FOREIGN KEY ("journal_entry_line_id") REFERENCES "public"."journal_entry_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_sync_status" ADD CONSTRAINT "org_sync_status_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_support_users" ADD CONSTRAINT "organization_support_users_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_support_users" ADD CONSTRAINT "organization_support_users_support_user_id_fkey" FOREIGN KEY ("support_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_user_invites" ADD CONSTRAINT "organization_user_invites_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_user_invites" ADD CONSTRAINT "organization_user_invites_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_pay_schedule_id_fkey" FOREIGN KEY ("pay_schedule_id") REFERENCES "public"."payroll_schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_employees" ADD CONSTRAINT "payroll_employees_benefits_enrollment_id_fkey" FOREIGN KEY ("benefits_enrollment_id") REFERENCES "public"."payroll_benefit_enrollments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_employees" ADD CONSTRAINT "payroll_employees_tax_info_id_fkey" FOREIGN KEY ("tax_info_id") REFERENCES "public"."payroll_tax_info"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_line_items" ADD CONSTRAINT "payroll_line_items_contractor_id_fkey" FOREIGN KEY ("contractor_id") REFERENCES "public"."payroll_contractors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_line_items" ADD CONSTRAINT "payroll_line_items_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."payroll_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_line_items" ADD CONSTRAINT "payroll_line_items_payroll_run_id_fkey" FOREIGN KEY ("payroll_run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_tax_info" ADD CONSTRAINT "payroll_tax_info_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."payroll_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plaid_raw_transactions" ADD CONSTRAINT "plaid_raw_transactions_plaid_account_id_fkey" FOREIGN KEY ("plaid_account_id") REFERENCES "public"."plaid_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plaid_sync_batches" ADD CONSTRAINT "plaid_sync_batches_plaid_account_id_fkey" FOREIGN KEY ("plaid_account_id") REFERENCES "public"."plaid_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_account_staging" ADD CONSTRAINT "qbo_account_staging_migration_job_id_fkey" FOREIGN KEY ("migration_job_id") REFERENCES "public"."qbo_migration_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plaid_accounts" ADD CONSTRAINT "plaid_accounts_chart_of_account_id_fkey" FOREIGN KEY ("chart_of_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plaid_accounts" ADD CONSTRAINT "plaid_accounts_linked_organization_id_fkey" FOREIGN KEY ("linked_organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plaid_accounts" ADD CONSTRAINT "plaid_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_customer_staging" ADD CONSTRAINT "qbo_customer_staging_migration_job_id_fkey" FOREIGN KEY ("migration_job_id") REFERENCES "public"."qbo_migration_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_invoice_staging" ADD CONSTRAINT "qbo_invoice_staging_migration_job_id_fkey" FOREIGN KEY ("migration_job_id") REFERENCES "public"."qbo_migration_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_mapping_overrides" ADD CONSTRAINT "qbo_mapping_overrides_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_mapping_overrides" ADD CONSTRAINT "qbo_mapping_overrides_migration_job_id_fkey" FOREIGN KEY ("migration_job_id") REFERENCES "public"."qbo_migration_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_mapping_results" ADD CONSTRAINT "qbo_mapping_results_migration_job_id_fkey" FOREIGN KEY ("migration_job_id") REFERENCES "public"."qbo_migration_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_migration_logs" ADD CONSTRAINT "qbo_migration_logs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."qbo_migration_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_bill_staging" ADD CONSTRAINT "qbo_bill_staging_migration_job_id_fkey" FOREIGN KEY ("migration_job_id") REFERENCES "public"."qbo_migration_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_migration_summaries" ADD CONSTRAINT "qbo_migration_summaries_migration_job_id_fkey" FOREIGN KEY ("migration_job_id") REFERENCES "public"."qbo_migration_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_mirroring_jobs" ADD CONSTRAINT "qbo_mirroring_jobs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_mirroring_jobs" ADD CONSTRAINT "qbo_mirroring_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_oauth_states" ADD CONSTRAINT "qbo_oauth_states_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_oauth_states" ADD CONSTRAINT "qbo_oauth_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_payment_staging" ADD CONSTRAINT "qbo_payment_staging_migration_job_id_fkey" FOREIGN KEY ("migration_job_id") REFERENCES "public"."qbo_migration_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_migration_jobs" ADD CONSTRAINT "qbo_migration_jobs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_migration_jobs" ADD CONSTRAINT "qbo_migration_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_connections" ADD CONSTRAINT "qbo_connections_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_connections" ADD CONSTRAINT "qbo_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolution_packet_exports" ADD CONSTRAINT "resolution_packet_exports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolution_packet_exports" ADD CONSTRAINT "resolution_packet_exports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolution_packets" ADD CONSTRAINT "resolution_packets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolution_packets" ADD CONSTRAINT "resolution_packets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_exports" ADD CONSTRAINT "scheduled_exports_column_preset_id_fkey" FOREIGN KEY ("column_preset_id") REFERENCES "public"."column_presets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_exports" ADD CONSTRAINT "scheduled_exports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_exports" ADD CONSTRAINT "scheduled_exports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qbo_vendor_staging" ADD CONSTRAINT "qbo_vendor_staging_migration_job_id_fkey" FOREIGN KEY ("migration_job_id") REFERENCES "public"."qbo_migration_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_processor_source_mappings" ADD CONSTRAINT "transaction_processor_source_mappings_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_matched_transaction_id_fkey" FOREIGN KEY ("matched_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_reconciliation_period_id_fkey" FOREIGN KEY ("reconciliation_period_id") REFERENCES "public"."reconciliation_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permission_sets" ADD CONSTRAINT "user_permission_sets_permission_set_id_fkey" FOREIGN KEY ("permission_set_id") REFERENCES "public"."permission_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permission_sets" ADD CONSTRAINT "user_permission_sets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_account_id_fkey" FOREIGN KEY ("category_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_progress" ADD CONSTRAINT "goal_progress_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_balance_lines" ADD CONSTRAINT "opening_balance_lines_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."opening_balance_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_benefit_enrollments" ADD CONSTRAINT "payroll_benefit_enrollments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."payroll_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_set_permissions" ADD CONSTRAINT "permission_set_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_set_permissions" ADD CONSTRAINT "permission_set_permissions_permission_set_id_fkey" FOREIGN KEY ("permission_set_id") REFERENCES "public"."permission_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "reconciliation_matches_reconciliation_period_id_fkey" FOREIGN KEY ("reconciliation_period_id") REFERENCES "public"."reconciliation_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "reconciliation_matches_statement_line_id_fkey" FOREIGN KEY ("statement_line_id") REFERENCES "public"."statement_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "reconciliation_matches_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_activity_feed_actor" ON "activity_feed" USING btree ("actor" text_ops);--> statement-breakpoint
CREATE INDEX "idx_activity_feed_created_at" ON "activity_feed" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_activity_feed_event_type" ON "activity_feed" USING btree ("event_type" text_ops);--> statement-breakpoint
CREATE INDEX "idx_activity_feed_org_id" ON "activity_feed" USING btree ("org_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_activity_feed_user_id" ON "activity_feed" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_ai_audit_actions_action_type" ON "ai_audit_actions" USING btree ("action_type" text_ops);--> statement-breakpoint
CREATE INDEX "ix_ai_audit_actions_actor" ON "ai_audit_actions" USING btree ("actor" text_ops);--> statement-breakpoint
CREATE INDEX "ix_ai_audit_actions_created_at" ON "ai_audit_actions" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "ix_ai_audit_actions_id" ON "ai_audit_actions" USING btree ("id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_ai_audit_actions_org_id" ON "ai_audit_actions" USING btree ("org_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_ai_audit_actions_user_id" ON "ai_audit_actions" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_admin_audit_log_action" ON "admin_audit_log" USING btree ("action" text_ops);--> statement-breakpoint
CREATE INDEX "ix_admin_audit_log_admin_user_id" ON "admin_audit_log" USING btree ("admin_user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_admin_audit_log_target_id" ON "admin_audit_log" USING btree ("target_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_admin_audit_log_target_type" ON "admin_audit_log" USING btree ("target_type" text_ops);--> statement-breakpoint
CREATE INDEX "ix_admin_audit_log_timestamp" ON "admin_audit_log" USING btree ("timestamp" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "ix_ai_patterns_org_updated" ON "ai_patterns" USING btree ("organization_id" text_ops,"updated_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "ix_ai_patterns_organization_id" ON "ai_patterns" USING btree ("organization_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_alert_events_org_id" ON "alert_events" USING btree ("org_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_ai_recommendations_contact_id" ON "ai_recommendations" USING btree ("contact_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_ai_recommendations_id" ON "ai_recommendations" USING btree ("id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_ai_recommendations_organization_id" ON "ai_recommendations" USING btree ("organization_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_ai_recommendations_recommendation_type" ON "ai_recommendations" USING btree ("recommendation_type" text_ops);--> statement-breakpoint
CREATE INDEX "ix_ai_recommendations_status" ON "ai_recommendations" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "ix_ai_recommendations_trace_id" ON "ai_recommendations" USING btree ("trace_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_ai_recommendations_transaction_id" ON "ai_recommendations" USING btree ("transaction_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_budget_calendar_v2_snapshots_month" ON "budget_calendar_v2_snapshots" USING btree ("month" text_ops);--> statement-breakpoint
CREATE INDEX "ix_budget_calendar_v2_snapshots_org_id" ON "budget_calendar_v2_snapshots" USING btree ("org_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_budget_calendar_v2_summary_snapshots_month" ON "budget_calendar_v2_summary_snapshots" USING btree ("month" text_ops);--> statement-breakpoint
CREATE INDEX "ix_budget_calendar_v2_summary_snapshots_org_id" ON "budget_calendar_v2_summary_snapshots" USING btree ("org_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_budget_plans_org_id" ON "budget_plans" USING btree ("org_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_budget_snapshots_month" ON "budget_snapshots" USING btree ("month" text_ops);--> statement-breakpoint
CREATE INDEX "ix_budget_snapshots_org_id" ON "budget_snapshots" USING btree ("org_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ix_budget_summary_snapshots_org_id" ON "budget_summary_snapshots" USING btree ("org_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_bulk_operations_organization_id" ON "bulk_operations" USING btree ("organization_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_bulk_operations_user_id" ON "bulk_operations" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_calendar_snapshots_month" ON "calendar_snapshots" USING btree ("month" text_ops);--> statement-breakpoint
CREATE INDEX "ix_calendar_snapshots_org_id" ON "calendar_snapshots" USING btree ("org_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_coa_hygiene_sweep_items_sweep_id" ON "coa_hygiene_sweep_items" USING btree ("sweep_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ix_dashboard_snapshots_org_id" ON "dashboard_snapshots" USING btree ("org_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_coa_hygiene_sweep_org_run_at" ON "coa_hygiene_sweeps" USING btree ("organization_id" text_ops,"run_at" text_ops);--> statement-breakpoint
CREATE INDEX "ix_coa_hygiene_sweeps_organization_id" ON "coa_hygiene_sweeps" USING btree ("organization_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ix_document_records_signature_request_id" ON "document_records" USING btree ("signature_request_id" text_ops) WHERE (signature_request_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "ix_document_records_workspace_id" ON "document_records" USING btree ("workspace_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "ix_document_versions_record_id" ON "document_versions" USING btree ("document_record_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "ix_export_jobs_created_at" ON "export_jobs" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "ix_export_jobs_expires_at" ON "export_jobs" USING btree ("expires_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "ix_export_jobs_organization_id" ON "export_jobs" USING btree ("organization_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_export_jobs_status" ON "export_jobs" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "ix_export_jobs_user_id" ON "export_jobs" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_column_presets_organization_id" ON "column_presets" USING btree ("organization_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_column_presets_user_id" ON "column_presets" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_document_audit_events_record_id" ON "document_audit_events" USING btree ("document_record_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "ix_imported_transactions_account_id" ON "imported_transactions" USING btree ("account_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_imported_transactions_import_id" ON "imported_transactions" USING btree ("import_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_imported_transactions_organization_id" ON "imported_transactions" USING btree ("organization_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_imported_transactions_plaid_account_id" ON "imported_transactions" USING btree ("plaid_account_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_imported_transactions_plaid_transaction_id" ON "imported_transactions" USING btree ("plaid_transaction_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_imports_account_id" ON "imports" USING btree ("account_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_imports_organization_id" ON "imports" USING btree ("organization_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_initial_review_state_organization_id" ON "initial_review_state" USING btree ("organization_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ix_initial_review_state_user_id" ON "initial_review_state" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_jobs_account_id" ON "jobs" USING btree ("account_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_jobs_organization_id" ON "jobs" USING btree ("organization_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_jobs_status" ON "jobs" USING btree ("status" enum_ops);--> statement-breakpoint
CREATE INDEX "ix_jobs_type" ON "jobs" USING btree ("type" enum_ops);--> statement-breakpoint
CREATE INDEX "ix_general_ledger_account_id" ON "general_ledger" USING btree ("account_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_general_ledger_id" ON "general_ledger" USING btree ("id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_general_ledger_organization_id" ON "general_ledger" USING btree ("organization_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_goals_org_id" ON "goals" USING btree ("org_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_opening_balance_batches_id" ON "opening_balance_batches" USING btree ("id" int4_ops);--> statement-breakpoint
CREATE INDEX "ix_opening_balance_batches_organization_id" ON "opening_balance_batches" USING btree ("organization_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_onboarding_audit_log_event_type" ON "onboarding_audit_log" USING btree ("event_type" text_ops);--> statement-breakpoint
CREATE INDEX "ix_onboarding_audit_log_org_id" ON "onboarding_audit_log" USING btree ("org_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_onboarding_audit_log_user_id" ON "onboarding_audit_log" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_onboarding_state_completed" ON "onboarding_state" USING btree ("completed" bool_ops);--> statement-breakpoint
CREATE INDEX "ix_onboarding_state_org_id" ON "onboarding_state" USING btree ("org_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_onboarding_state_phase" ON "onboarding_state" USING btree ("phase" text_ops);--> statement-breakpoint
CREATE INDEX "ix_organization_user_invites_token" ON "organization_user_invites" USING btree ("token" text_ops);--> statement-breakpoint
CREATE INDEX "ix_payroll_runs_business_id" ON "payroll_runs" USING btree ("business_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_payroll_contractors_business_id" ON "payroll_contractors" USING btree ("business_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_payroll_employees_business_id" ON "payroll_employees" USING btree ("business_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_payroll_line_items_payroll_run_id" ON "payroll_line_items" USING btree ("payroll_run_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_payroll_schedules_business_id" ON "payroll_schedules" USING btree ("business_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ix_permission_sets_name" ON "permission_sets" USING btree ("name" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ix_personal_accounts_plaid_account_id" ON "personal_accounts" USING btree ("plaid_account_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_personal_accounts_user_id" ON "personal_accounts" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_personal_budgets_category" ON "personal_budgets" USING btree ("category" text_ops);--> statement-breakpoint
CREATE INDEX "ix_personal_budgets_user_id" ON "personal_budgets" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ix_permissions_key" ON "permissions" USING btree ("key" text_ops);--> statement-breakpoint
CREATE INDEX "ix_personal_cashflow_month" ON "personal_cashflow" USING btree ("month" date_ops);--> statement-breakpoint
CREATE INDEX "ix_personal_cashflow_user_id" ON "personal_cashflow" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_personal_goals_user_id" ON "personal_goals" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_personal_networth_date" ON "personal_networth" USING btree ("date" date_ops);--> statement-breakpoint
CREATE INDEX "ix_personal_networth_user_id" ON "personal_networth" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_personal_transactions_account_id" ON "personal_transactions" USING btree ("account_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_personal_transactions_category" ON "personal_transactions" USING btree ("category" text_ops);--> statement-breakpoint
CREATE INDEX "ix_personal_transactions_date" ON "personal_transactions" USING btree ("date" date_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ix_personal_transactions_plaid_transaction_id" ON "personal_transactions" USING btree ("plaid_transaction_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_personal_transactions_user_id" ON "personal_transactions" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_plaid_raw_transactions_plaid_account_id" ON "plaid_raw_transactions" USING btree ("plaid_account_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_plaid_raw_transactions_plaid_transaction_id" ON "plaid_raw_transactions" USING btree ("plaid_transaction_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_plaid_sync_batches_plaid_account_id" ON "plaid_sync_batches" USING btree ("plaid_account_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_account_staging_migration_job_id" ON "qbo_account_staging" USING btree ("migration_job_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_account_staging_raw_qbo_id" ON "qbo_account_staging" USING btree ("raw_qbo_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_account_staging_realm_id" ON "qbo_account_staging" USING btree ("realm_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_predictive_cash_flow_snapshots_org_id" ON "predictive_cash_flow_snapshots" USING btree ("org_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_predictive_cash_flow_snapshots_range" ON "predictive_cash_flow_snapshots" USING btree ("range" int4_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ix_processing_modes_internal_name" ON "processing_modes" USING btree ("internal_name" text_ops);--> statement-breakpoint
CREATE INDEX "ix_plaid_accounts_linked_organization_id" ON "plaid_accounts" USING btree ("linked_organization_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_plaid_accounts_plaid_item_id" ON "plaid_accounts" USING btree ("plaid_item_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_plaid_accounts_user_id" ON "plaid_accounts" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_customer_staging_migration_job_id" ON "qbo_customer_staging" USING btree ("migration_job_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_customer_staging_raw_qbo_id" ON "qbo_customer_staging" USING btree ("raw_qbo_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_customer_staging_realm_id" ON "qbo_customer_staging" USING btree ("realm_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_invoice_staging_customer_qbo_id" ON "qbo_invoice_staging" USING btree ("customer_qbo_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_invoice_staging_migration_job_id" ON "qbo_invoice_staging" USING btree ("migration_job_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_invoice_staging_raw_qbo_id" ON "qbo_invoice_staging" USING btree ("raw_qbo_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_invoice_staging_realm_id" ON "qbo_invoice_staging" USING btree ("realm_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_mapping_overrides_created_by_user_id" ON "qbo_mapping_overrides" USING btree ("created_by_user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_mapping_overrides_entity_type" ON "qbo_mapping_overrides" USING btree ("entity_type" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_mapping_overrides_migration_job_id" ON "qbo_mapping_overrides" USING btree ("migration_job_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_mapping_overrides_staging_id" ON "qbo_mapping_overrides" USING btree ("staging_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ix_qbo_mapping_results_migration_job_id" ON "qbo_mapping_results" USING btree ("migration_job_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_migration_logs_job_id" ON "qbo_migration_logs" USING btree ("job_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_bill_staging_migration_job_id" ON "qbo_bill_staging" USING btree ("migration_job_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_bill_staging_raw_qbo_id" ON "qbo_bill_staging" USING btree ("raw_qbo_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_bill_staging_realm_id" ON "qbo_bill_staging" USING btree ("realm_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_bill_staging_vendor_qbo_id" ON "qbo_bill_staging" USING btree ("vendor_qbo_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ix_qbo_migration_summaries_migration_job_id" ON "qbo_migration_summaries" USING btree ("migration_job_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_mirroring_jobs_org_id" ON "qbo_mirroring_jobs" USING btree ("org_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_mirroring_jobs_qbo_change_token" ON "qbo_mirroring_jobs" USING btree ("qbo_change_token" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_mirroring_jobs_realm_id" ON "qbo_mirroring_jobs" USING btree ("realm_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_mirroring_jobs_status" ON "qbo_mirroring_jobs" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_mirroring_jobs_user_id" ON "qbo_mirroring_jobs" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ix_qbo_oauth_states_state" ON "qbo_oauth_states" USING btree ("state" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_payment_staging_customer_qbo_id" ON "qbo_payment_staging" USING btree ("customer_qbo_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_payment_staging_migration_job_id" ON "qbo_payment_staging" USING btree ("migration_job_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_payment_staging_raw_qbo_id" ON "qbo_payment_staging" USING btree ("raw_qbo_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_payment_staging_realm_id" ON "qbo_payment_staging" USING btree ("realm_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_migration_jobs_org_id" ON "qbo_migration_jobs" USING btree ("org_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_migration_jobs_realm_id" ON "qbo_migration_jobs" USING btree ("realm_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_migration_jobs_status" ON "qbo_migration_jobs" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_migration_jobs_user_id" ON "qbo_migration_jobs" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_connections_org_id" ON "qbo_connections" USING btree ("org_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_connections_realm_id" ON "qbo_connections" USING btree ("realm_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_connections_user_id" ON "qbo_connections" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_webhook_events_event_type" ON "qbo_webhook_events" USING btree ("event_type" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_webhook_events_realm_id" ON "qbo_webhook_events" USING btree ("realm_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_webhook_events_status" ON "qbo_webhook_events" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "ix_quick_dashboard_snapshots_org_id" ON "quick_dashboard_snapshots" USING btree ("org_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_quick_dashboard_snapshots_scope" ON "quick_dashboard_snapshots" USING btree ("scope" text_ops);--> statement-breakpoint
CREATE INDEX "ix_receipt_lines_receipt_id" ON "receipt_lines" USING btree ("receipt_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_receipts_contact_id" ON "receipts" USING btree ("contact_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_receipts_organization_id" ON "receipts" USING btree ("organization_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_receipts_receipt_date" ON "receipts" USING btree ("receipt_date" text_ops);--> statement-breakpoint
CREATE INDEX "ix_resolution_packet_exports_organization_id" ON "resolution_packet_exports" USING btree ("organization_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_resolution_packet_exports_user_id" ON "resolution_packet_exports" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_resolution_packets_organization_id" ON "resolution_packets" USING btree ("organization_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_resolution_packets_user_id" ON "resolution_packets" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_role_permissions_permission_id" ON "role_permissions" USING btree ("permission_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_role_permissions_role_id" ON "role_permissions" USING btree ("role_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ix_roles_name" ON "roles" USING btree ("name" text_ops);--> statement-breakpoint
CREATE INDEX "ix_scheduled_exports_next_run_at" ON "scheduled_exports" USING btree ("next_run_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "ix_scheduled_exports_organization_id" ON "scheduled_exports" USING btree ("organization_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_scheduled_exports_user_id" ON "scheduled_exports" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_vendor_staging_migration_job_id" ON "qbo_vendor_staging" USING btree ("migration_job_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_vendor_staging_raw_qbo_id" ON "qbo_vendor_staging" USING btree ("raw_qbo_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_qbo_vendor_staging_realm_id" ON "qbo_vendor_staging" USING btree ("realm_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_reconciliation_periods_account_status" ON "reconciliation_periods" USING btree ("account_id" enum_ops,"status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_reconciliation_periods_org_account" ON "reconciliation_periods" USING btree ("organization_id" text_ops,"account_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_reconciliation_periods_account_id" ON "reconciliation_periods" USING btree ("account_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_reconciliation_periods_organization_id" ON "reconciliation_periods" USING btree ("organization_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_transaction_splits_account_id" ON "transaction_splits" USING btree ("account_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_transaction_splits_category_account_id" ON "transaction_splits" USING btree ("category_account_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_transaction_splits_contact_id" ON "transaction_splits" USING btree ("contact_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_transaction_splits_id" ON "transaction_splits" USING btree ("id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_user_permission_overrides_permission_id" ON "user_permission_overrides" USING btree ("permission_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_user_permission_overrides_user_id" ON "user_permission_overrides" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_statement_lines_org_account" ON "statement_lines" USING btree ("organization_id" text_ops,"account_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_statement_lines_period_status" ON "statement_lines" USING btree ("reconciliation_period_id" text_ops,"status" enum_ops);--> statement-breakpoint
CREATE INDEX "ix_statement_lines_account_id" ON "statement_lines" USING btree ("account_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_statement_lines_organization_id" ON "statement_lines" USING btree ("organization_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_statement_lines_reconciliation_period_id" ON "statement_lines" USING btree ("reconciliation_period_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ix_user_onboarding_state_user_id" ON "user_onboarding_state" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_user_permission_sets_permission_set_id" ON "user_permission_sets" USING btree ("permission_set_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_user_permission_sets_user_id" ON "user_permission_sets" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_user_roles_role_id" ON "user_roles" USING btree ("role_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_user_roles_user_id" ON "user_roles" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_user_preferences_user_id" ON "user_preferences" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_transactions_account_id" ON "transactions" USING btree ("account_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_transactions_category_account_id" ON "transactions" USING btree ("category_account_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_transactions_contact_id" ON "transactions" USING btree ("contact_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_transactions_id" ON "transactions" USING btree ("id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_transactions_import_id" ON "transactions" USING btree ("import_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_transactions_journal_entry_id" ON "transactions" USING btree ("journal_entry_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_transactions_organization_id" ON "transactions" USING btree ("organization_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_transactions_payment_id" ON "transactions" USING btree ("payment_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_transactions_tag_id" ON "transactions" USING btree ("tag_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_tasks_organization_id" ON "tasks" USING btree ("organization_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_tasks_product" ON "tasks" USING btree ("product" text_ops);--> statement-breakpoint
CREATE INDEX "ix_tasks_status" ON "tasks" USING btree ("status" enum_ops);--> statement-breakpoint
CREATE INDEX "ix_tasks_user_id" ON "tasks" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ix_users_email" ON "users" USING btree ("email" text_ops);--> statement-breakpoint
CREATE INDEX "ix_goal_progress_goal_id" ON "goal_progress" USING btree ("goal_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_opening_balance_lines_account_id" ON "opening_balance_lines" USING btree ("account_id" int4_ops);--> statement-breakpoint
CREATE INDEX "ix_opening_balance_lines_id" ON "opening_balance_lines" USING btree ("id" int4_ops);--> statement-breakpoint
CREATE INDEX "ix_permission_set_permissions_permission_id" ON "permission_set_permissions" USING btree ("permission_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_permission_set_permissions_permission_set_id" ON "permission_set_permissions" USING btree ("permission_set_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_reconciliation_matches_statement_line_id" ON "reconciliation_matches" USING btree ("statement_line_id" text_ops);--> statement-breakpoint
CREATE INDEX "ix_reconciliation_matches_transaction_id" ON "reconciliation_matches" USING btree ("transaction_id" text_ops);
*/