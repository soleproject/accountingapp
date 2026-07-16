-- Rocket Suite DB performance sprint: candidate production indexes.
-- Generated 2026-06-21 from live pg_stat_statements + schema/index audit.
-- IMPORTANT:
--   * This file is committed for review; do not run blindly in peak traffic.
--   * Run with a migration path that does not wrap statements in a transaction.
--   * Validate hot-query plans with EXPLAIN (ANALYZE, BUFFERS) before production.
--   * Monitor pg_stat_progress_create_index, locks, DB CPU/IO, and app errors.

SET lock_timeout = '2s';
SET statement_timeout = '30min';

-- P0: highest cumulative live DB cost was repeated plaid_raw_transactions reads by account.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_plaid_raw_transactions_account_date
  ON plaid_raw_transactions (plaid_account_id, date);

-- P0: enterprise dashboard/client rollups and access checks.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_enterprise_clients_enterprise_created
  ON enterprise_clients (enterprise_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_enterprise_clients_client_user
  ON enterprise_clients (client_user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_enterprise_staff_enterprise_user
  ON enterprise_staff (enterprise_id, staff_user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_enterprise_staff_staff_enterprise
  ON enterprise_staff (staff_user_id, enterprise_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_organizations_owner_plan
  ON organizations (owner_user_id, plan_type);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_imported_transactions_org_auto_confirmed_created
  ON imported_transactions (organization_id, created_at DESC)
  WHERE auto_confirmed IS TRUE;
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_activity_feed_org_created
  ON activity_feed (org_id, created_at DESC);

-- P0/P1: accounting list screens, ledgers, joins, and badge counts.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_transactions_org_date_id_desc
  ON transactions (organization_id, date DESC, id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_transactions_org_review_date
  ON transactions (organization_id, reviewed, date DESC, id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_transactions_org_unposted_date
  ON transactions (organization_id, date DESC, id DESC)
  WHERE journal_entry_id IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_transactions_org_uncategorized_recent
  ON transactions (organization_id, created_at DESC)
  WHERE category_account_id IS NULL AND journal_entry_id IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_transactions_org_account_date
  ON transactions (organization_id, account_id, date DESC, id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_transactions_org_category_date
  ON transactions (organization_id, category_account_id, date DESC, id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_transactions_org_contact_date
  ON transactions (organization_id, contact_id, date DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_general_ledger_org_date_account
  ON general_ledger (organization_id, date, account_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_journal_entries_org_date_id
  ON journal_entries (organization_id, date, id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_journal_entries_org_posted_created
  ON journal_entries (organization_id, posted, created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_journal_entries_org_source
  ON journal_entries (organization_id, source_type, source_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_journal_entry_lines_je_id
  ON journal_entry_lines (journal_entry_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_journal_entry_lines_account_je
  ON journal_entry_lines (account_id, journal_entry_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_journal_entry_lines_contact_je
  ON journal_entry_lines (contact_id, journal_entry_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_journal_entry_lines_beneficiary_je
  ON journal_entry_lines (beneficiary_id, journal_entry_id)
  WHERE beneficiary_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_chart_of_accounts_org_active_number
  ON chart_of_accounts (organization_id, is_active, account_number);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_contacts_org_active_name
  ON contacts (organization_id, is_active, contact_name);

-- P1: invoices/bills/payments list totals and joins.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_invoices_org_date_created
  ON invoices (organization_id, invoice_date DESC, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_invoices_org_status_due
  ON invoices (organization_id, status, due_date);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_invoice_lines_invoice_id
  ON invoice_lines (invoice_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_invoice_payment_applications_invoice_id
  ON invoice_payment_applications (invoice_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_invoice_payment_applications_payment_id
  ON invoice_payment_applications (invoice_payment_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_invoice_payments_org_date
  ON invoice_payments (organization_id, payment_date DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_bills_org_date_created
  ON bills (organization_id, bill_date DESC, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_bills_org_status_due
  ON bills (organization_id, status, due_date);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_bill_lines_bill_id
  ON bill_lines (bill_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_bill_payment_applications_bill_id
  ON bill_payment_applications (bill_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_bill_payment_applications_payment_id
  ON bill_payment_applications (bill_payment_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_bill_payments_org_date
  ON bill_payments (organization_id, payment_date DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_payments_org_type_date
  ON payments (organization_id, type, payment_date);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_payments_org_invoice
  ON payments (organization_id, invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_payments_org_bill
  ON payments (organization_id, bill_id) WHERE bill_id IS NOT NULL;

-- P1: AI usage admin/reporting scale.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_ai_usage_created_feature
  ON ai_usage_events (created_at DESC, feature);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_ai_usage_created_model
  ON ai_usage_events (created_at DESC, model);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_ai_usage_created_user
  ON ai_usage_events (created_at DESC, user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_ai_usage_created_category
  ON ai_usage_events (created_at DESC, category);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_ai_usage_org_created
  ON ai_usage_events (org_id, created_at DESC);

-- P1/P2: background jobs and organizer screens.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_plaid_accounts_sync_due
  ON plaid_accounts (last_synced_at, id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_plaid_accounts_connection_item
  ON plaid_accounts (connection_status, plaid_item_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_imports_bank_statement_end_date
  ON imports (import_method, end_date, account_id, organization_id)
  WHERE import_method = 'bank_statement';
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_inbox_messages_org_source_received
  ON inbox_messages (organization_id, source, received_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_inbox_messages_ai_pending_received
  ON inbox_messages (ai_status, source, received_at)
  WHERE ai_status = 'pending';
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_tasks_org_status_due_created
  ON tasks (organization_id, status, due_date, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_tasks_org_entity
  ON tasks (organization_id, entity_type, entity_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_text_messages_org_undismissed_created
  ON text_messages (organization_id, created_at DESC)
  WHERE dashboard_dismissed_at IS NULL;

-- P2: text search support for existing ILIKE '%term%' paths.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_contacts_org_name_trgm
  ON contacts USING gin (contact_name gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_transactions_bank_desc_trgm
  ON transactions USING gin (bank_description gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_transactions_user_desc_trgm
  ON transactions USING gin (user_description gin_trgm_ops);
