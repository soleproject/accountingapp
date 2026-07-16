import { pgTable, index, varchar, jsonb, timestamp, foreignKey, unique, date, json, doublePrecision, integer, boolean, text, numeric, uniqueIndex, uuid, serial, type AnyPgColumn, pgEnum } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const coaAiMatchStatus = pgEnum("coa_ai_match_status", ['PENDING', 'PROCESSING', 'COMPLETE', 'processing', 'complete', 'pending'])
export const jobstatus = pgEnum("jobstatus", ['PENDING', 'RUNNING', 'SUCCESS', 'ERROR'])
export const jobtype = pgEnum("jobtype", ['PLAID_SYNC', 'AI_ORCHESTRATOR'])
export const reconciliationmatchtype = pgEnum("reconciliationmatchtype", ['EXACT', 'FUZZY', 'SPLIT', 'TRANSFER'])
export const reconciliationperiodstatus = pgEnum("reconciliationperiodstatus", ['OPEN', 'RECONCILED', 'ARCHIVED'])
export const statementlinestatus = pgEnum("statementlinestatus", ['UNMATCHED', 'MATCHED', 'EXCLUDED'])
export const taskstatus = pgEnum("taskstatus", ['OPEN', 'DONE'])
export const orgEntityType = pgEnum("org_entity_type", ['llc', 'c_corp', 's_corp', 'partnership', 'sole_prop', 'beneficial_trust', 'business_trust', 'nonprofit', 'other'])


export const activityFeed = pgTable("activity_feed", {
	id: varchar().primaryKey().notNull(),
	orgId: varchar("org_id").notNull(),
	userId: varchar("user_id").notNull(),
	actor: varchar().notNull(),
	eventType: varchar("event_type").notNull(),
	eventMetadata: jsonb("event_metadata").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_activity_feed_actor").using("btree", table.actor.asc().nullsLast().op("text_ops")),
	index("idx_activity_feed_created_at").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_activity_feed_event_type").using("btree", table.eventType.asc().nullsLast().op("text_ops")),
	index("idx_activity_feed_org_id").using("btree", table.orgId.asc().nullsLast().op("text_ops")),
	index("idx_activity_feed_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
]);

export const aiAuditActions = pgTable("ai_audit_actions", {
	id: varchar().primaryKey().notNull(),
	orgId: varchar("org_id").notNull(),
	userId: varchar("user_id").notNull(),
	actor: varchar().notNull(),
	actionType: varchar("action_type").notNull(),
	beforeState: jsonb("before_state").notNull(),
	afterState: jsonb("after_state").notNull(),
	rollbackPayload: jsonb("rollback_payload").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	rolledBack: varchar("rolled_back"),
}, (table) => [
	index("ix_ai_audit_actions_action_type").using("btree", table.actionType.asc().nullsLast().op("text_ops")),
	index("ix_ai_audit_actions_actor").using("btree", table.actor.asc().nullsLast().op("text_ops")),
	index("ix_ai_audit_actions_created_at").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("ix_ai_audit_actions_id").using("btree", table.id.asc().nullsLast().op("text_ops")),
	index("ix_ai_audit_actions_org_id").using("btree", table.orgId.asc().nullsLast().op("text_ops")),
	index("ix_ai_audit_actions_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
]);

export const adminAuditLog = pgTable("admin_audit_log", {
	id: varchar().primaryKey().notNull(),
	adminUserId: varchar("admin_user_id").notNull(),
	action: varchar().notNull(),
	targetType: varchar("target_type").notNull(),
	targetId: varchar("target_id"),
	auditMetadata: jsonb("audit_metadata"),
	timestamp: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_admin_audit_log_action").using("btree", table.action.asc().nullsLast().op("text_ops")),
	index("ix_admin_audit_log_admin_user_id").using("btree", table.adminUserId.asc().nullsLast().op("text_ops")),
	index("ix_admin_audit_log_target_id").using("btree", table.targetId.asc().nullsLast().op("text_ops")),
	index("ix_admin_audit_log_target_type").using("btree", table.targetType.asc().nullsLast().op("text_ops")),
	index("ix_admin_audit_log_timestamp").using("btree", table.timestamp.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.adminUserId],
			foreignColumns: [users.id],
			name: "admin_audit_log_admin_user_id_fkey"
		}),
]);

export const emailAccounts = pgTable("email_accounts", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	emailAddress: text("email_address").notNull(),
	encryptedPassword: text("encrypted_password").notNull(),
	encryptionIv: text("encryption_iv").notNull(),
	encryptionAuthTag: text("encryption_auth_tag").notNull(),
	provider: text().notNull(),
	imapHost: text("imap_host").notNull(),
	imapPort: integer("imap_port").notNull(),
	imapSecure: boolean("imap_secure").default(true).notNull(),
	smtpHost: text("smtp_host").notNull(),
	smtpPort: integer("smtp_port").notNull(),
	smtpSecure: boolean("smtp_secure").default(true).notNull(),
	lastPolledAt: timestamp("last_polled_at", { withTimezone: true, mode: 'string' }),
	lastUidSeen: integer("last_uid_seen"),
	lastUidvalidity: integer("last_uidvalidity"),
	connectionStatus: text("connection_status").default('unknown').notNull(),
	lastError: text("last_error"),
	isActive: boolean("is_active").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_email_accounts_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
]);

export const adminCommunications = pgTable("admin_communications", {
	id: varchar().primaryKey().notNull(),
	sentByUserId: varchar("sent_by_user_id").notNull(),
	toEmail: text("to_email").notNull(),
	replyTo: text("reply_to"),
	subject: text().notNull(),
	bodyHtml: text("body_html"),
	bodyText: text("body_text"),
	status: text().notNull(),
	providerMessageId: text("provider_message_id"),
	error: text(),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_admin_communications_sent_at").using("btree", table.sentAt.desc().nullsLast().op("timestamptz_ops")),
	index("ix_admin_communications_sent_by").using("btree", table.sentByUserId.asc().nullsLast().op("text_ops")),
	index("ix_admin_communications_to_email").using("btree", table.toEmail.asc().nullsLast().op("text_ops")),
]);

export const adminSms = pgTable("admin_sms", {
	id: varchar().primaryKey().notNull(),
	sentByUserId: varchar("sent_by_user_id").notNull(),
	toPhone: text("to_phone").notNull(),
	fromPhone: text("from_phone"),
	body: text().notNull(),
	status: text().notNull(),
	providerMessageId: text("provider_message_id"),
	segments: integer(),
	error: text(),
	errorCode: integer("error_code"),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_admin_sms_sent_at").using("btree", table.sentAt.desc().nullsLast().op("timestamptz_ops")),
	index("ix_admin_sms_sent_by").using("btree", table.sentByUserId.asc().nullsLast().op("text_ops")),
	index("ix_admin_sms_to_phone").using("btree", table.toPhone.asc().nullsLast().op("text_ops")),
]);

export const aiPatterns = pgTable("ai_patterns", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	periodStart: date("period_start").notNull(),
	periodEnd: date("period_end").notNull(),
	data: json().notNull(),
	confidence: doublePrecision().notNull(),
	version: integer().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_ai_patterns_org_updated").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.updatedAt.asc().nullsLast().op("timestamptz_ops")),
	index("ix_ai_patterns_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	unique("uq_ai_patterns_org_period").on(table.organizationId, table.periodStart, table.periodEnd),
]);

export const alembicVersion = pgTable("alembic_version", {
	versionNum: varchar("version_num", { length: 255 }).primaryKey().notNull(),
});

export const alertEvents = pgTable("alert_events", {
	id: varchar().primaryKey().notNull(),
	orgId: varchar("org_id").notNull(),
	type: varchar().notNull(),
	severity: varchar().notNull(),
	title: varchar().notNull(),
	message: varchar().notNull(),
	alertMetadata: json("alert_metadata"),
	createdAt: timestamp("created_at", { mode: 'string' }).notNull(),
	readAt: timestamp("read_at", { mode: 'string' }),
}, (table) => [
	index("ix_alert_events_org_id").using("btree", table.orgId.asc().nullsLast().op("text_ops")),
]);

export const aiRecommendations = pgTable("ai_recommendations", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	transactionId: varchar("transaction_id"),
	contactId: varchar("contact_id"),
	recommendationType: varchar("recommendation_type").notNull(),
	currentContactId: varchar("current_contact_id"),
	suggestedContactId: varchar("suggested_contact_id"),
	currentCategoryAccountId: varchar("current_category_account_id"),
	suggestedCategoryAccountId: varchar("suggested_category_account_id"),
	currentCoaAccountId: varchar("current_coa_account_id"),
	suggestedCoaAccountId: varchar("suggested_coa_account_id"),
	anomalyFlag: boolean("anomaly_flag").default(false).notNull(),
	reasoning: text(),
	aiConfidence: doublePrecision("ai_confidence"),
	status: varchar().default('pending').notNull(),
	appliedAt: timestamp("applied_at", { withTimezone: true, mode: 'string' }),
	appliedByUserId: varchar("applied_by_user_id"),
	revertedAt: timestamp("reverted_at", { withTimezone: true, mode: 'string' }),
	revertedByUserId: varchar("reverted_by_user_id"),
	traceId: varchar("trace_id", { length: 64 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	payload: jsonb(),
}, (table) => [
	index("ix_ai_recommendations_contact_id").using("btree", table.contactId.asc().nullsLast().op("text_ops")),
	index("ix_ai_recommendations_id").using("btree", table.id.asc().nullsLast().op("text_ops")),
	index("ix_ai_recommendations_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_ai_recommendations_recommendation_type").using("btree", table.recommendationType.asc().nullsLast().op("text_ops")),
	index("ix_ai_recommendations_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("ix_ai_recommendations_trace_id").using("btree", table.traceId.asc().nullsLast().op("text_ops")),
	index("ix_ai_recommendations_transaction_id").using("btree", table.transactionId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.appliedByUserId],
			foreignColumns: [users.id],
			name: "ai_recommendations_applied_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "ai_recommendations_contact_id_fkey"
		}),
	foreignKey({
			columns: [table.currentCategoryAccountId],
			foreignColumns: [chartOfAccounts.id],
			name: "ai_recommendations_current_category_account_id_fkey"
		}),
	foreignKey({
			columns: [table.currentCoaAccountId],
			foreignColumns: [chartOfAccounts.id],
			name: "ai_recommendations_current_coa_account_id_fkey"
		}),
	foreignKey({
			columns: [table.currentContactId],
			foreignColumns: [contacts.id],
			name: "ai_recommendations_current_contact_id_fkey"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "ai_recommendations_organization_id_fkey"
		}),
	foreignKey({
			columns: [table.revertedByUserId],
			foreignColumns: [users.id],
			name: "ai_recommendations_reverted_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.suggestedCategoryAccountId],
			foreignColumns: [chartOfAccounts.id],
			name: "ai_recommendations_suggested_category_account_id_fkey"
		}),
	foreignKey({
			columns: [table.suggestedCoaAccountId],
			foreignColumns: [chartOfAccounts.id],
			name: "ai_recommendations_suggested_coa_account_id_fkey"
		}),
	foreignKey({
			columns: [table.suggestedContactId],
			foreignColumns: [contacts.id],
			name: "ai_recommendations_suggested_contact_id_fkey"
		}),
	foreignKey({
			columns: [table.transactionId],
			foreignColumns: [transactions.id],
			name: "ai_recommendations_transaction_id_fkey"
		}),
]);

export const autoCategorizationActions = pgTable("auto_categorization_actions", {
	id: varchar().primaryKey().notNull(),
	transactionId: varchar("transaction_id").notNull(),
	organizationId: varchar("organization_id").notNull(),
	suggestedCategoryId: varchar("suggested_category_id").notNull(),
	appliedCategoryId: varchar("applied_category_id").notNull(),
	confidence: doublePrecision().notNull(),
	reason: varchar().notNull(),
	userId: varchar("user_id"),
	approvedAt: varchar("approved_at").notNull(),
});

export const billLines = pgTable("bill_lines", {
	id: varchar().primaryKey().notNull(),
	billId: varchar("bill_id").notNull(),
	itemId: varchar("item_id"),
	description: text(),
	quantity: numeric({ precision: 12, scale:  2 }).notNull(),
	unitPrice: numeric("unit_price", { precision: 12, scale:  2 }).notNull(),
	amount: numeric({ precision: 12, scale:  2 }).notNull(),
});

export const billPaymentApplications = pgTable("bill_payment_applications", {
	id: varchar().primaryKey().notNull(),
	billPaymentId: varchar("bill_payment_id").notNull(),
	billId: varchar("bill_id").notNull(),
	amountApplied: numeric("amount_applied", { precision: 12, scale:  2 }).notNull(),
});

export const billPayments = pgTable("bill_payments", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	contactId: varchar("contact_id").notNull(),
	paymentDate: date("payment_date").notNull(),
	amount: numeric({ precision: 12, scale:  2 }).notNull(),
	memo: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const bills = pgTable("bills", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	contactId: varchar("contact_id").notNull(),
	billNumber: text("bill_number"),
	billDate: date("bill_date").notNull(),
	dueDate: date("due_date"),
	status: text().default('open').notNull(),
	memo: text(),
	taxAmount: numeric("tax_amount", { precision: 12, scale: 2 }).default('0').notNull(),
	discountAmount: numeric("discount_amount", { precision: 12, scale: 2 }).default('0').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const budgetCalendarV2Snapshots = pgTable("budget_calendar_v2_snapshots", {
	id: varchar().primaryKey().notNull(),
	orgId: varchar("org_id").notNull(),
	month: varchar().notNull(),
	data: json().notNull(),
	financialTruthSignature: varchar("financial_truth_signature").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_budget_calendar_v2_snapshots_month").using("btree", table.month.asc().nullsLast().op("text_ops")),
	index("ix_budget_calendar_v2_snapshots_org_id").using("btree", table.orgId.asc().nullsLast().op("text_ops")),
]);

export const budgetCalendarV2SummarySnapshots = pgTable("budget_calendar_v2_summary_snapshots", {
	id: varchar().primaryKey().notNull(),
	orgId: varchar("org_id").notNull(),
	month: varchar().notNull(),
	data: json().notNull(),
	financialTruthSignature: varchar("financial_truth_signature").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_budget_calendar_v2_summary_snapshots_month").using("btree", table.month.asc().nullsLast().op("text_ops")),
	index("ix_budget_calendar_v2_summary_snapshots_org_id").using("btree", table.orgId.asc().nullsLast().op("text_ops")),
]);

export const budgetPlans = pgTable("budget_plans", {
	id: varchar().primaryKey().notNull(),
	orgId: varchar("org_id").notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).notNull(),
	planJson: json("plan_json"),
	aiNarrative: text("ai_narrative"),
}, (table) => [
	index("ix_budget_plans_org_id").using("btree", table.orgId.asc().nullsLast().op("text_ops")),
]);

export const budgetSnapshots = pgTable("budget_snapshots", {
	id: varchar().primaryKey().notNull(),
	orgId: varchar("org_id").notNull(),
	month: varchar().notNull(),
	data: json().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	financialTruthSignature: varchar("financial_truth_signature").default('').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_budget_snapshots_month").using("btree", table.month.asc().nullsLast().op("text_ops")),
	index("ix_budget_snapshots_org_id").using("btree", table.orgId.asc().nullsLast().op("text_ops")),
]);

export const budgetSummarySnapshots = pgTable("budget_summary_snapshots", {
	id: varchar().primaryKey().notNull(),
	orgId: varchar("org_id").notNull(),
	data: json().notNull(),
	financialTruthSignature: varchar("financial_truth_signature").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_budget_summary_snapshots_org_id").using("btree", table.orgId.asc().nullsLast().op("text_ops")),
]);

export const bulkOperations = pgTable("bulk_operations", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	userId: varchar("user_id").notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).notNull(),
	operationType: varchar("operation_type").notNull(),
	transactionIds: json("transaction_ids"),
	filtersSnapshot: json("filters_snapshot"),
	fromCategoryId: varchar("from_category_id"),
	toCategoryId: varchar("to_category_id"),
	fromContactId: varchar("from_contact_id"),
	toContactId: varchar("to_contact_id"),
}, (table) => [
	index("ix_bulk_operations_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_bulk_operations_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
]);

export const calendarSnapshots = pgTable("calendar_snapshots", {
	id: varchar().primaryKey().notNull(),
	orgId: varchar("org_id").notNull(),
	month: varchar().notNull(),
	data: json().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_calendar_snapshots_month").using("btree", table.month.asc().nullsLast().op("text_ops")),
	index("ix_calendar_snapshots_org_id").using("btree", table.orgId.asc().nullsLast().op("text_ops")),
]);

export const categorizationFeedback = pgTable("categorization_feedback", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	transactionId: varchar("transaction_id").notNull(),
	wasCorrect: boolean("was_correct").notNull(),
	previousCategoryId: varchar("previous_category_id"),
	correctedCategoryId: varchar("corrected_category_id"),
	userId: varchar("user_id"),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
});

export const categorizationRules = pgTable("categorization_rules", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	ruleType: varchar("rule_type").notNull(),
	pattern: varchar().notNull(),
	categoryAccountId: varchar("category_account_id").notNull(),
	confidence: doublePrecision().notNull(),
	createdAt: varchar("created_at").notNull(),
	// 'deposit' | 'withdrawal' scopes the rule to one direction; NULL = any type
	// (migration 0138). A contact's deposits/withdrawals can map differently.
	transactionType: varchar("transaction_type"),
});

export const chartOfAccounts = pgTable("chart_of_accounts", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	accountNumber: varchar("account_number").notNull(),
	accountName: varchar("account_name").notNull(),
	gaapType: varchar("gaap_type").notNull(),
	accountType: varchar("account_type"),
	detailType: varchar("detail_type"),
	parentAccountId: varchar("parent_account_id"),
	normalBalance: varchar("normal_balance").notNull(),
	isActive: boolean("is_active"),
	isTemporary: boolean("is_temporary"),
	createdByAi: boolean("created_by_ai"),
	systemGenerated: boolean("system_generated"),
	needsReview: boolean("needs_review"),
	complianceNote: varchar("compliance_note"),
	startingBalance: numeric("starting_balance"),
	startingBalanceDate: date("starting_balance_date"),
	definition: varchar(),
	passedNameContactCheck: boolean("passed_name_contact_check").notNull(),
	suggestedMatchCoaId: varchar("suggested_match_coa_id"),
}, (table) => [
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "chart_of_accounts_organization_id_fkey"
		}),
	foreignKey({
			columns: [table.parentAccountId],
			foreignColumns: [table.id],
			name: "chart_of_accounts_parent_account_id_fkey"
		}),
	foreignKey({
			columns: [table.suggestedMatchCoaId],
			foreignColumns: [table.id],
			name: "chart_of_accounts_suggested_match_coa_id_fkey"
		}),
]);

export const coaHygieneSweepItems = pgTable("coa_hygiene_sweep_items", {
	id: varchar().primaryKey().notNull(),
	sweepId: varchar("sweep_id").notNull(),
	oldCoaId: varchar("old_coa_id").notNull(),
	oldCoaName: varchar("old_coa_name").notNull(),
	reason: varchar().notNull(),
	newCoaId: varchar("new_coa_id").notNull(),
	newCoaName: varchar("new_coa_name").notNull(),
	matchConfidence: doublePrecision("match_confidence").notNull(),
	isCanonical: boolean("is_canonical").notNull(),
	transactionsMovedCount: integer("transactions_moved_count").notNull(),
}, (table) => [
	index("ix_coa_hygiene_sweep_items_sweep_id").using("btree", table.sweepId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.sweepId],
			foreignColumns: [coaHygieneSweeps.id],
			name: "coa_hygiene_sweep_items_sweep_id_fkey"
		}),
]);

export const contactProfiles = pgTable("contact_profiles", {
	id: varchar().primaryKey().notNull(),
	contactId: varchar("contact_id").notNull(),
	contactType: text("contact_type"),
	expectedCategories: json("expected_categories"),
	exceptions: json(),
	notes: text(),
	aiConfidence: doublePrecision("ai_confidence"),
	lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	autoApplyRules: boolean("auto_apply_rules").default(true),
	strictEnforcement: boolean("strict_enforcement").default(false),
}, (table) => [
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "contact_profiles_contact_id_fkey"
		}),
	unique("contact_profiles_contact_id_key").on(table.contactId),
]);

export const dashboardSnapshots = pgTable("dashboard_snapshots", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: varchar("org_id").notNull(),
	totalRevenue: numeric("total_revenue", { precision: 24, scale:  4 }).notNull(),
	totalExpenses: numeric("total_expenses", { precision: 24, scale:  4 }).notNull(),
	netIncome: numeric("net_income", { precision: 24, scale:  4 }).notNull(),
	cashBalance: numeric("cash_balance", { precision: 24, scale:  4 }).notNull(),
	arTotal: numeric("ar_total", { precision: 24, scale:  4 }).notNull(),
	apTotal: numeric("ap_total", { precision: 24, scale:  4 }).notNull(),
	recentActivityJson: jsonb("recent_activity_json").default({}).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_dashboard_snapshots_org_id").using("btree", table.orgId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "dashboard_snapshots_org_id_fkey"
		}).onDelete("cascade"),
	unique("uq_dashboard_snapshots_org_id").on(table.orgId),
]);

export const coaHygieneSweeps = pgTable("coa_hygiene_sweeps", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	runAt: timestamp("run_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	runType: varchar("run_type").notNull(),
	status: varchar().notNull(),
	aiVersion: varchar("ai_version").notNull(),
	coasCorrectedCount: integer("coas_corrected_count").notNull(),
	transactionsUpdatedCount: integer("transactions_updated_count").notNull(),
}, (table) => [
	index("idx_coa_hygiene_sweep_org_run_at").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.runAt.asc().nullsLast().op("text_ops")),
	index("ix_coa_hygiene_sweeps_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
]);

export const documentRecords = pgTable("document_records", {
	id: uuid().primaryKey().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	resolutionType: text("resolution_type").notNull(),
	entityType: text("entity_type").notNull(),
	style: text().notNull(),
	templateId: text("template_id").notNull(),
	templateVersion: text("template_version").notNull(),
	variables: jsonb().default({}).notNull(),
	draft: text().default('').notNull(),
	pdfUrl: text("pdf_url"),
	signers: jsonb().default([]).notNull(),
	signatureRequestId: text("signature_request_id"),
	signatureStatus: text("signature_status"),
	status: text().default('draft').notNull(),
	workspaceId: uuid("workspace_id"),
	/** Org-scoping for the trust-documents area (Phase 1). workspaceId
	 *  stays around from the original schema but isn't used by the
	 *  trust pipeline. See migration 0043. */
	organizationId: varchar("organization_id"),
	/** Source linkage (migration 0045) — what real-world event spawned
	 *  this doc. Drives idempotency on auto-drafts and the cascade on
	 *  classification reversals.
	 *    'deposit_finding' → source_id = trust_review_findings.id
	 *    'fixed_asset'     → source_id = fixed_assets.id
	 *    'manual'          → source_id optional (free pointer to a
	 *                        transaction or asset for traceability) */
	sourceKind: varchar("source_kind"),
	sourceId: varchar("source_id"),
}, (table) => [
	uniqueIndex("ix_document_records_signature_request_id").using("btree", table.signatureRequestId.asc().nullsLast().op("text_ops")).where(sql`(signature_request_id IS NOT NULL)`),
	index("ix_document_records_workspace_id").using("btree", table.workspaceId.asc().nullsLast().op("uuid_ops")),
	index("ix_document_records_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_document_records_org_created").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsLast().op("timestamptz_ops")),
	index("ix_document_records_source").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.sourceKind.asc().nullsLast().op("text_ops"), table.sourceId.asc().nullsLast().op("text_ops")).where(sql`source_kind IS NOT NULL`),
	uniqueIndex("ix_document_records_auto_source_unique").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.sourceKind.asc().nullsLast().op("text_ops"), table.sourceId.asc().nullsLast().op("text_ops"), table.templateId.asc().nullsLast().op("text_ops")).where(sql`source_kind IS NOT NULL AND source_kind <> 'manual' AND status <> 'voided'`),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "document_records_organization_id_fkey"
		}),
]);

export const documentVersions = pgTable("document_versions", {
	id: uuid().primaryKey().notNull(),
	documentRecordId: uuid("document_record_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	versionNumber: integer("version_number").notNull(),
	variables: jsonb().default({}).notNull(),
	draft: text().default('').notNull(),
	pdfUrl: text("pdf_url"),
	signers: jsonb().default([]).notNull(),
	templateId: text("template_id").notNull(),
	templateVersion: text("template_version").notNull(),
	diff: jsonb(),
}, (table) => [
	index("ix_document_versions_record_id").using("btree", table.documentRecordId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.documentRecordId],
			foreignColumns: [documentRecords.id],
			name: "document_versions_document_record_id_fkey"
		}).onDelete("cascade"),
	unique("uq_document_versions_record_version").on(table.documentRecordId, table.versionNumber),
]);

export const enterpriseClients = pgTable("enterprise_clients", {
	id: varchar().primaryKey().notNull(),
	enterpriseId: varchar("enterprise_id").notNull(),
	clientUserId: varchar("client_user_id").notNull(),
	status: varchar().notNull(),
	// How this client got attached to the enterprise. 'invite_link' for
	// self-serve /signup (host- or ?ref=-resolved); 'manual' for admin
	// creation via super-admin or enterprise /clients/new. NULL for
	// legacy rows pre-migration 0052 (surfaced as Unknown).
	acquisitionSource: varchar("acquisition_source"),
	// Per-client billing override for "varies" enterprises (migration 0110).
	// NULL = inherit the firm's clientBillingMode/clientPriceMode.
	clientBillingMode: varchar("client_billing_mode"),
	clientPriceMode: varchar("client_price_mode"),
	// 'new' (default) | 'switching' — which welcome email this client got (0111).
	clientType: varchar("client_type"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.clientUserId],
			foreignColumns: [users.id],
			name: "enterprise_clients_client_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.enterpriseId],
			foreignColumns: [organizations.id],
			name: "enterprise_clients_enterprise_id_fkey"
		}).onDelete("cascade"),
]);

export const enterpriseStaff = pgTable("enterprise_staff", {
	id: varchar().primaryKey().notNull(),
	enterpriseId: varchar("enterprise_id").notNull(),
	staffUserId: varchar("staff_user_id").notNull(),
	role: varchar().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	archivedAt: timestamp("archived_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	foreignKey({
			columns: [table.enterpriseId],
			foreignColumns: [organizations.id],
			name: "enterprise_staff_enterprise_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.staffUserId],
			foreignColumns: [users.id],
			name: "enterprise_staff_staff_user_id_fkey"
		}).onDelete("cascade"),
]);

export const exportJobs = pgTable("export_jobs", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	userId: varchar("user_id").notNull(),
	format: varchar().notNull(),
	filters: jsonb(),
	sortBy: varchar("sort_by"),
	sortDirection: varchar("sort_direction"),
	status: varchar().notNull(),
	transactionCount: integer("transaction_count"),
	fileSize: integer("file_size"),
	filePath: varchar("file_path"),
	downloadUrl: varchar("download_url"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	errorMessage: varchar("error_message"),
	columns: jsonb(),
	columnPresetId: varchar("column_preset_id"),
	name: varchar(),
}, (table) => [
	index("ix_export_jobs_created_at").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("ix_export_jobs_expires_at").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	index("ix_export_jobs_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_export_jobs_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("ix_export_jobs_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "export_jobs_organization_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "export_jobs_user_id_fkey"
		}),
	foreignKey({
			columns: [table.columnPresetId],
			foreignColumns: [columnPresets.id],
			name: "fk_export_jobs_column_preset"
		}),
]);

export const contacts = pgTable("contacts", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	contactName: text("contact_name").notNull(),
	companyName: text("company_name"),
	individualName: text("individual_name"),
	email: text(),
	phone: text(),
	address: json(),
	typeTags: json("type_tags").default([]).notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	isTemporary: boolean("is_temporary"),
	createdByAi: boolean("created_by_ai"),
	systemGenerated: boolean("system_generated"),
	needsReview: boolean("needs_review"),
	logoUrl: varchar("logo_url"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	reviewed: boolean().default(false),
	isWidelyKnown: boolean("is_widely_known").default(false),
	coaAiMatch: varchar("coa_ai_match"),
	coaAiMatchStatus: coaAiMatchStatus("coa_ai_match_status").default('pending'),
	correctWidelyKnownReview: boolean("correct_widely_known_review"),
	// Trustee fields (Phase 0 of the trustee-resolutions module).
	// NULL on non-trustee contacts. trustee_removed_at lets the queue
	// distinguish currently-acting trustees (signers for new
	// resolutions) from former trustees kept around for audit.
	trusteeRole: varchar("trustee_role"),
	trusteeEffectiveDate: date("trustee_effective_date"),
	trusteeRemovedAt: timestamp("trustee_removed_at", { withTimezone: true, mode: 'string' }),
	// 1099 prep (migration 0125): a vendor/contractor's TIN, W-9 status
	// ('not_requested' | 'requested' | 'on_file'), and whether they're 1099-eligible.
	taxId: varchar("tax_id"),
	w9Status: varchar("w9_status").default('not_requested').notNull(),
	is1099Eligible: boolean("is_1099_eligible").default(false).notNull(),
	// AI-suggested 1099 eligibility (migration 0126). Suggestion only — the
	// accountant confirms (Accept flips is_1099_eligible). NULL = not evaluated.
	ai1099Suggestion: boolean("ai_1099_suggestion"),
	ai1099Reason: text("ai_1099_reason"),
	ai1099SuggestedAt: timestamp("ai_1099_suggested_at", { withTimezone: true, mode: 'string' }),
});

export const columnPresets = pgTable("column_presets", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	userId: varchar("user_id").notNull(),
	name: varchar().notNull(),
	columns: jsonb().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_column_presets_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_column_presets_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "column_presets_organization_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "column_presets_user_id_fkey"
		}),
]);

export const documentAuditEvents = pgTable("document_audit_events", {
	id: uuid().primaryKey().notNull(),
	documentRecordId: uuid("document_record_id").notNull(),
	timestamp: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	type: text().notNull(),
	metadata: jsonb(),
}, (table) => [
	index("ix_document_audit_events_record_id").using("btree", table.documentRecordId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.documentRecordId],
			foreignColumns: [documentRecords.id],
			name: "document_audit_events_document_record_id_fkey"
		}).onDelete("cascade"),
]);

export const importedTransactions = pgTable("imported_transactions", {
	id: varchar().primaryKey().notNull(),
	importId: varchar("import_id"),
	organizationId: varchar("organization_id"),
	source: varchar(),
	plaidAccountId: varchar("plaid_account_id"),
	plaidTransactionId: varchar("plaid_transaction_id"),
	pendingTransactionId: varchar("pending_transaction_id"),
	plaidMetadata: json("plaid_metadata"),
	accountId: varchar("account_id"),
	date: date(),
	description: varchar(),
	amount: numeric({ precision: 12, scale:  2 }),
	debit: doublePrecision(),
	credit: doublePrecision(),
	balance: doublePrecision(),
	currencyCode: varchar("currency_code"),
	checkNumber: varchar("check_number"),
	referenceNumber: varchar("reference_number"),
	merchantName: varchar("merchant_name"),
	rawMerchantName: varchar("raw_merchant_name"),
	merchantAddress: varchar("merchant_address"),
	category: varchar(),
	type: varchar(),
	accountNumber: varchar("account_number"),
	routingNumber: varchar("routing_number"),
	memo: varchar(),
	contactName: varchar("contact_name"),
	rawRow: json("raw_row").notNull(),
	status: varchar(),
	categoryGuess: varchar("category_guess"),
	contactGuess: varchar("contact_guess"),
	confidenceScore: doublePrecision("confidence_score"),
	aiPredictedCategory: varchar("ai_predicted_category"),
	aiPredictedContact: varchar("ai_predicted_contact"),
	aiConfidence: doublePrecision("ai_confidence"),
	autoConfirmed: boolean("auto_confirmed"),
	userConfirmed: boolean("user_confirmed"),
	isTransfer: boolean("is_transfer"),
	transferGroupId: varchar("transfer_group_id"),
	transferType: varchar("transfer_type"),
	isRecurring: boolean("is_recurring"),
	recurringGroupId: varchar("recurring_group_id"),
	recurringInterval: varchar("recurring_interval"),
	recurringAmount: numeric("recurring_amount"),
	isAnomaly: boolean("is_anomaly"),
	anomalyType: varchar("anomaly_type"),
	anomalySeverity: varchar("anomaly_severity"),
	anomalyMessage: varchar("anomaly_message"),
	promotionStatus: varchar("promotion_status"),
	promotedTransactionId: varchar("promoted_transaction_id"),
	promotionError: varchar("promotion_error"),
	createdAt: timestamp("created_at", { mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).notNull(),
	semanticCategory: text("semantic_category"),
	semanticContact: text("semantic_contact"),
	semanticReasoning: text("semantic_reasoning"),
	semanticConfidence: doublePrecision("semantic_confidence"),
	semanticData: jsonb("semantic_data"),
	pfcPrimary: varchar("pfc_primary"),
	pfcDetailed: varchar("pfc_detailed"),
	pfcConfidence: varchar("pfc_confidence"),
	pfcVersion: varchar("pfc_version"),
	businessFinanceCategoryPrimary: text("business_finance_category_primary"),
	businessFinanceCategoryDetailed: text("business_finance_category_detailed"),
	businessFinanceCategoryConfidence: text("business_finance_category_confidence"),
	flagType: varchar("flag_type"),
	flagReason: varchar("flag_reason"),
	isPromotableCached: boolean("is_promotable_cached"),
	promotabilityReasonCached: text("promotability_reason_cached"),
}, (table) => [
	index("ix_imported_transactions_account_id").using("btree", table.accountId.asc().nullsLast().op("text_ops")),
	index("ix_imported_transactions_import_id").using("btree", table.importId.asc().nullsLast().op("text_ops")),
	index("ix_imported_transactions_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_imported_transactions_plaid_account_id").using("btree", table.plaidAccountId.asc().nullsLast().op("text_ops")),
	index("ix_imported_transactions_plaid_transaction_id").using("btree", table.plaidTransactionId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [chartOfAccounts.id],
			name: "imported_transactions_account_id_fkey"
		}),
	foreignKey({
			columns: [table.importId],
			foreignColumns: [imports.id],
			name: "imported_transactions_import_id_fkey"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "imported_transactions_organization_id_fkey"
		}),
	foreignKey({
			columns: [table.plaidAccountId],
			foreignColumns: [plaidAccounts.id],
			name: "imported_transactions_plaid_account_id_fkey"
		}),
	unique("imported_transactions_plaid_transaction_id_key").on(table.plaidTransactionId),
]);

export const imports = pgTable("imports", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	accountId: varchar("account_id").notNull(),
	method: varchar().notNull(),
	importMethod: varchar("import_method"),
	transactionCount: integer("transaction_count"),
	startDate: date("start_date"),
	endDate: date("end_date"),
	createdAt: timestamp("created_at", { mode: 'string' }).notNull(),
	filename: varchar(),
	status: varchar().notNull(),
	hash: varchar(),
	savedFilePath: varchar("saved_file_path"),
	errorMessage: text("error_message"),
	veryfiDocumentId: varchar("veryfi_document_id"),
	veryfiRawJson: text("veryfi_raw_json"),
}, (table) => [
	index("ix_imports_account_id").using("btree", table.accountId.asc().nullsLast().op("text_ops")),
	index("ix_imports_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [chartOfAccounts.id],
			name: "imports_account_id_fkey"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "imports_organization_id_fkey"
		}),
]);

export const invoices = pgTable("invoices", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	contactId: varchar("contact_id").notNull(),
	invoiceNumber: text("invoice_number"),
	invoiceDate: date("invoice_date").notNull(),
	dueDate: date("due_date"),
	status: text().default('draft').notNull(),
	memo: text(),
	posted: boolean().notNull(),
	postedAt: timestamp("posted_at", { withTimezone: true, mode: 'string' }),
	journalEntryId: varchar("journal_entry_id"),
	arAccountId: varchar("ar_account_id"),
	taxAmount: numeric("tax_amount", { precision: 12, scale: 2 }).default('0').notNull(),
	discountAmount: numeric("discount_amount", { precision: 12, scale: 2 }).default('0').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.arAccountId],
			foreignColumns: [chartOfAccounts.id],
			name: "invoices_ar_account_id_fkey"
		}),
	foreignKey({
			columns: [table.journalEntryId],
			foreignColumns: [journalEntries.id],
			name: "invoices_journal_entry_id_fkey"
		}),
]);

export const initialReviewState = pgTable("initial_review_state", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	currentStepId: varchar("current_step_id").notNull(),
	completedSteps: jsonb("completed_steps").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	organizationId: varchar("organization_id").notNull(),
}, (table) => [
	index("ix_initial_review_state_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	uniqueIndex("ix_initial_review_state_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	unique("uq_initial_review_state_user_id").on(table.userId),
]);

export const invoiceLines = pgTable("invoice_lines", {
	id: varchar().primaryKey().notNull(),
	invoiceId: varchar("invoice_id").notNull(),
	itemId: varchar("item_id"),
	description: text(),
	quantity: numeric({ precision: 12, scale:  2 }).notNull(),
	unitPrice: numeric("unit_price", { precision: 12, scale:  2 }).notNull(),
	amount: numeric({ precision: 12, scale:  2 }).notNull(),
});

export const invoicePaymentApplications = pgTable("invoice_payment_applications", {
	id: varchar().primaryKey().notNull(),
	invoicePaymentId: varchar("invoice_payment_id").notNull(),
	invoiceId: varchar("invoice_id").notNull(),
	amountApplied: numeric("amount_applied", { precision: 12, scale:  2 }).notNull(),
});

export const invoicePayments = pgTable("invoice_payments", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	contactId: varchar("contact_id").notNull(),
	paymentDate: date("payment_date").notNull(),
	amount: numeric({ precision: 12, scale:  2 }).notNull(),
	memo: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const items = pgTable("items", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	name: text().notNull(),
	description: text(),
	unitPrice: numeric("unit_price", { precision: 12, scale:  2 }),
	incomeAccountId: varchar("income_account_id"),
	expenseAccountId: varchar("expense_account_id"),
	isActive: boolean("is_active").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const jobs = pgTable("jobs", {
	id: varchar().primaryKey().notNull(),
	type: jobtype().notNull(),
	status: jobstatus().notNull(),
	organizationId: varchar("organization_id"),
	accountId: varchar("account_id"),
	createdAt: timestamp("created_at", { mode: 'string' }).notNull(),
	startedAt: timestamp("started_at", { mode: 'string' }),
	finishedAt: timestamp("finished_at", { mode: 'string' }),
	errorMessage: varchar("error_message"),
	metadata: json(),
}, (table) => [
	index("ix_jobs_account_id").using("btree", table.accountId.asc().nullsLast().op("text_ops")),
	index("ix_jobs_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_jobs_status").using("btree", table.status.asc().nullsLast().op("enum_ops")),
	index("ix_jobs_type").using("btree", table.type.asc().nullsLast().op("enum_ops")),
]);

export const generalLedger = pgTable("general_ledger", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id"),
	accountId: varchar("account_id"),
	journalEntryId: varchar("journal_entry_id"),
	journalEntryLineId: varchar("journal_entry_line_id"),
	contactId: varchar("contact_id"),
	date: timestamp({ mode: 'string' }),
	memo: varchar(),
	debit: doublePrecision(),
	credit: doublePrecision(),
	balance: doublePrecision(),
	createdAt: timestamp("created_at", { mode: 'string' }),
}, (table) => [
	index("ix_general_ledger_account_id").using("btree", table.accountId.asc().nullsLast().op("text_ops")),
	index("ix_general_ledger_id").using("btree", table.id.asc().nullsLast().op("text_ops")),
	index("ix_general_ledger_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "general_ledger_contact_id_fkey"
		}),
	foreignKey({
			columns: [table.journalEntryId],
			foreignColumns: [journalEntries.id],
			name: "general_ledger_journal_entry_id_fkey"
		}),
	foreignKey({
			columns: [table.journalEntryLineId],
			foreignColumns: [journalEntryLines.id],
			name: "general_ledger_journal_entry_line_id_fkey"
		}),
]);

export const goals = pgTable("goals", {
	id: varchar().primaryKey().notNull(),
	orgId: varchar("org_id").notNull(),
	name: varchar().notNull(),
	targetAmount: numeric("target_amount", { precision: 12, scale:  2 }).notNull(),
	currentAmount: numeric("current_amount", { precision: 12, scale:  2 }).notNull(),
	targetDate: date("target_date"),
	monthlyContribution: numeric("monthly_contribution", { precision: 12, scale:  2 }),
	priority: varchar().notNull(),
	status: varchar().notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).notNull(),
}, (table) => [
	index("ix_goals_org_id").using("btree", table.orgId.asc().nullsLast().op("text_ops")),
]);

export const openingBalanceBatches = pgTable("opening_balance_batches", {
	id: serial().primaryKey().notNull(),
	organizationId: varchar("organization_id"),
	createdAt: timestamp("created_at", { mode: 'string' }),
	description: varchar(),
}, (table) => [
	index("ix_opening_balance_batches_id").using("btree", table.id.asc().nullsLast().op("int4_ops")),
	index("ix_opening_balance_batches_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
]);

export const onboardingAuditLog = pgTable("onboarding_audit_log", {
	id: varchar().primaryKey().notNull(),
	orgId: varchar("org_id").notNull(),
	userId: varchar("user_id"),
	eventType: varchar("event_type").notNull(),
	step: varchar(),
	metadata: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_onboarding_audit_log_event_type").using("btree", table.eventType.asc().nullsLast().op("text_ops")),
	index("ix_onboarding_audit_log_org_id").using("btree", table.orgId.asc().nullsLast().op("text_ops")),
	index("ix_onboarding_audit_log_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
]);

export const onboardingState = pgTable("onboarding_state", {
	orgId: varchar("org_id").primaryKey().notNull(),
	phase: varchar().notNull(),
	step: varchar(),
	context: jsonb().notNull(),
	completed: boolean().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_onboarding_state_completed").using("btree", table.completed.asc().nullsLast().op("bool_ops")),
	index("ix_onboarding_state_org_id").using("btree", table.orgId.asc().nullsLast().op("text_ops")),
	index("ix_onboarding_state_phase").using("btree", table.phase.asc().nullsLast().op("text_ops")),
]);

export const orgSyncStatus = pgTable("org_sync_status", {
	orgId: varchar("org_id").primaryKey().notNull(),
	syncing: boolean().default(false).notNull(),
	progress: integer().default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "org_sync_status_org_id_fkey"
		}).onDelete("cascade"),
]);

export const organizationSupportUsers = pgTable("organization_support_users", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	supportUserId: varchar("support_user_id").notNull(),
	status: varchar().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "organization_support_users_organization_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.supportUserId],
			foreignColumns: [users.id],
			name: "organization_support_users_support_user_id_fkey"
		}).onDelete("cascade"),
	unique("uq_org_support_user").on(table.organizationId, table.supportUserId),
]);

export const organizationUserInvites = pgTable("organization_user_invites", {
	id: varchar().primaryKey().notNull(),
	orgId: varchar("org_id").notNull(),
	inviterId: varchar("inviter_id").notNull(),
	email: varchar().notNull(),
	phone: varchar(),
	invitedFor: varchar("invited_for").notNull(),
	token: varchar().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_organization_user_invites_token").using("btree", table.token.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.inviterId],
			foreignColumns: [users.id],
			name: "organization_user_invites_inviter_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "organization_user_invites_org_id_fkey"
		}).onDelete("cascade"),
]);

export const journalEntries = pgTable("journal_entries", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	date: date().notNull(),
	memo: varchar(),
	posted: boolean().notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).notNull(),
	postedAt: timestamp("posted_at", { mode: 'string' }),
	sourceType: varchar("source_type"),
	sourceId: varchar("source_id"),
	reversalOfId: varchar("reversal_of_id"),
	// Adjusting entry flag (migration 0120). Distinguishes accountant year-end
	// adjustments from operational entries so the trial balance can show
	// unadjusted → adjustments → adjusted columns. Default false.
	isAdjusting: boolean("is_adjusting").default(false),
}, (table) => [
	index("ix_journal_entries_reversal_of_id")
		.using("btree", table.reversalOfId.asc().nullsLast().op("text_ops"))
		.where(sql`(reversal_of_id IS NOT NULL)`),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "journal_entries_organization_id_fkey"
		}),
	foreignKey({
			columns: [table.reversalOfId],
			foreignColumns: [table.id],
			name: "journal_entries_reversal_of_id_fkey"
		}),
]);

export const paymentAllocations = pgTable("payment_allocations", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	paymentId: varchar("payment_id", { length: 255 }).notNull(),
	invoiceId: varchar("invoice_id", { length: 255 }),
	billId: varchar("bill_id", { length: 255 }),
	amount: numeric({ precision: 15, scale:  2 }).notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
});

export const payments = pgTable("payments", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	type: varchar().notNull(),
	customerId: varchar("customer_id"),
	vendorId: varchar("vendor_id"),
	invoiceId: varchar("invoice_id"),
	billId: varchar("bill_id"),
	paymentDate: varchar("payment_date").notNull(),
	amount: doublePrecision().notNull(),
	arAccountId: varchar("ar_account_id"),
	apAccountId: varchar("ap_account_id"),
	bankAccountId: varchar("bank_account_id"),
	journalEntryId: varchar("journal_entry_id"),
	transactionId: varchar("transaction_id"),
	transactionSplitId: varchar("transaction_split_id"),
	createdAt: varchar("created_at").default('CURRENT_TIMESTAMP'),
});

export const organizations = pgTable("organizations", {
	id: varchar().primaryKey().notNull(),
	name: varchar().notNull(),
	ownerUserId: varchar("owner_user_id").notNull(),
	clientId: varchar("client_id"),
	planType: varchar("plan_type").default('pro').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	accountingMethod: varchar("accounting_method").default('accrual').notNull(),
	domain: varchar(),
	logoUrl: varchar("logo_url"),
	// Logo variants (migration 0083): dark-mode wordmark + collapsed icon (light/dark).
	logoUrlDark: text("logo_url_dark"),
	logoIconUrl: text("logo_icon_url"),
	logoIconDarkUrl: text("logo_icon_dark_url"),
	poweredByText: varchar("powered_by_text"),
	poweredByEnabled: boolean("powered_by_enabled").default(true),
	primaryContactId: uuid("primary_contact_id"),
	processingMode: varchar("processing_mode").default('batched').notNull(),
	onboardingMode: varchar("onboarding_mode").default('simple').notNull(),
	autoApplyRecommendations: boolean("auto_apply_recommendations").default(false).notNull(),
	autoApplyTypes: json("auto_apply_types").default([]).notNull(),
	// Per-org AI categorization automation (migration 0119). enabled=false →
	// the AI categorizes but never auto-confirms (everything queues for review);
	// threshold = confidence cutoff to auto-post. NULL threshold → env/0.85.
	// See lib/accounting/automation-settings.ts + automation-levels.ts.
	aiAutoPostEnabled: boolean("ai_auto_post_enabled").default(true).notNull(),
	aiAutoPostThreshold: doublePrecision("ai_auto_post_threshold"),
	// AI assistant "client profile" memory (migration 0129): how this client
	// likes to work (communication style, small-amount threshold, standing
	// instructions) + durable learnings the assistant saves over time. Read into
	// the AI context every turn; edited in Settings; appended by remember_about_client.
	aiClientProfile: jsonb("ai_client_profile"),
	// Monthly statement report email (migration 0121). Opt-in; recipients is an
	// optional comma/newline list of extra emails (owner always included).
	monthlyReportEnabled: boolean("monthly_report_enabled").default(false).notNull(),
	monthlyReportRecipients: text("monthly_report_recipients"),
	// Automatic weekly review reminders to the client (migration 0122). Opt-in.
	reviewAutoOutreachEnabled: boolean("review_auto_outreach_enabled").default(false).notNull(),
	// "What's this?" contact-inquiry email loop (migration 0123). Opt-in.
	contactInquiryEnabled: boolean("contact_inquiry_enabled").default(false).notNull(),
	// IRS substantiation documentation requests (migration 0124). Opt-in.
	substantiationEnabled: boolean("substantiation_enabled").default(false).notNull(),
	entityType: orgEntityType("entity_type"),
	entityTypeOnboardingEnabled: boolean("entity_type_onboarding_enabled").default(false).notNull(),
	// Enterprise onboarding answers (migration 0103). Captured by the AI-guided
	// firm onboarding wizard; some are applied later (color theming, email domain).
	aiAssistantName: varchar("ai_assistant_name"),
	brandColorHex: varchar("brand_color_hex"),
	sendingFromEmail: varchar("sending_from_email"),
	clientBillingMode: varchar("client_billing_mode"),
	clientPriceMode: varchar("client_price_mode"),
	clientOnboardingHandoff: varchar("client_onboarding_handoff"),
	clientBackendLoginEnabled: boolean("client_backend_login_enabled"),
	themeConfig: jsonb("theme_config"),
	// Custom client welcome-email copy { subject, body, cta } edited in the
	// onboarding wizard (migration 0107). Null = use the handoff-derived default.
	welcomeEmailConfig: jsonb("welcome_email_config"),
	// Welcome-email override for clients SWITCHING from another system (0111).
	// welcomeEmailConfig above is the new-client variant; null = handoff default.
	welcomeEmailConfigSwitching: jsonb("welcome_email_config_switching"),
	// Booking/scheduling link used as the welcome-email CTA when new clients book
	// a setup meeting (migration 0109). External (Calendly) or the firm's own
	// /book/<slug> page. Null = CTA falls back to the sign-in link.
	clientBookingUrl: varchar("client_booking_url"),
	// Per-firm toggles for the automatic client-facing emails, set in the
	// "Client Interaction" onboarding step (migration 0132). Null = all enabled.
	clientInteractionPrefs: jsonb("client_interaction_prefs"),
	beneficiaries: json().default([]).notNull(),
	businessDescription: text("business_description"),
	address: jsonb(),
	website: varchar(),
	phone: varchar(),
	fax: varchar(),
	email: varchar(),
	// Payer TIN/EIN for 1099-NEC generation (migration 0127).
	payerTin: varchar("payer_tin"),
	// Cached AI "month in review" dashboard narrative (migration 0129).
	aiDashboardSummary: text("ai_dashboard_summary"),
	aiDashboardSummaryAt: timestamp("ai_dashboard_summary_at", { withTimezone: true, mode: 'string' }),
	// Cached AI command-center headline + the posture it was generated for (0130).
	aiDashboardHeadline: text("ai_dashboard_headline"),
	aiDashboardPosture: varchar("ai_dashboard_posture"),
	// Shared proactive-opener cache (0131): one greeting for both /ai-chat + the
	// sidecar, keyed by a signature of the books-state it was generated from.
	aiOpenerGreeting: text("ai_opener_greeting"),
	aiOpenerSig: varchar("ai_opener_sig"),
	aiOpenerAt: timestamp("ai_opener_at", { withTimezone: true, mode: 'string' }),
	payingPartyUserId: varchar("paying_party_user_id"),
	// Enterprise tier (private-label / certified partner). NULL for client
	// orgs and for legacy enterprises that pre-date the tier rollout.
	// Allowed values come from lib/enterprise/tiers.ts (pl_495, pl_995, cp1).
	enterpriseTier: varchar("enterprise_tier"),
	// Self-serve accounting plan for CLIENT orgs (planType='pro'). Allowed
	// values come from lib/accounting/tiers.ts (starter, plus, pro). NULL =
	// grandfathered flat $89 client (legacy base_seat) — NULL means "legacy
	// plan", never "no plan". Validated in app, not by a DB CHECK (matches the
	// enterprise_tier precedent above). Added in migration 0114.
	accountingTier: varchar("accounting_tier"),
	// Per-company "who does the books": 'firm' (firm-managed) | 'client' (client
	// self-serve, firm oversees). Set by the Add a Company wizard. Migration 0133.
	booksManagedBy: varchar("books_managed_by"),
	// Per-org recurring-task → responsible party ('pro' | 'client') map, set by
	// the firm on the business-edit Responsibilities matrix. Keys are the catalog
	// keys in lib/enterprise/task-catalog.ts. Null = smart defaults. Migration 0134.
	taskResponsibilities: jsonb("task_responsibilities"),
	// Firm-wide DEFAULT responsibility matrix, set on the ENTERPRISE org via
	// Enterprise → Settings. Resolution: client override → this → smart default.
	// Migration 0136.
	enterpriseDefaultResponsibilities: jsonb("enterprise_default_responsibilities"),
	// Firm-wide DEFAULT for "who does the books", set on the ENTERPRISE org via
	// Enterprise → Settings. 'firm' | 'client' | 'both'. NULL reads as 'both' (a
	// mix). New client businesses inherit 'firm'/'client'; 'both' = no forced
	// default (the pro chooses per business). Migration 0139.
	enterpriseDefaultBooksManagedBy: varchar("enterprise_default_books_managed_by"),
	// Business registration state (2-letter) + its annual-report due date (MM-DD),
	// set by the firm on the business-edit page. annual_report_due drives the
	// state-filing reminder card. Migration 0135.
	formationState: varchar("formation_state"),
	annualReportDue: varchar("annual_report_due"),
	// When true the org's logo/branding (logoUrl, poweredByText) replaces
	// the default RocketSuite chrome for its enterprise's clients. Set true
	// automatically when an enterprise tier is assigned.
	privateLabelEnabled: boolean("private_label_enabled").default(false).notNull(),
	// 8-char URL-safe token (non-confusable alphabet) handed out by partners
	// as /signup?ref=<invite_slug>. NULL for client orgs and pre-tier
	// enterprises; only populated by ensureInviteSlug() in
	// lib/enterprise/invite-slug.ts. Partial unique index in migration 0051.
	inviteSlug: varchar("invite_slug"),
	// Which user referred this org's owner (migration 0099). Set once at signup
	// via a ?ref=<user referral_slug> link; NULL for organic/host/enterprise-org
	// signups. Credits the individual referrer, independent of invite_slug.
	referredByUserId: varchar("referred_by_user_id"),
	// White-label sign-in subdomain label, e.g. 'acme' → acme.accountingapp.ai
	// (migration 0106). Unique when set; validated by lib/enterprise/subdomain.ts.
	subdomain: varchar("subdomain"),
	// Letterhead settings for generated documents (Task/Create workspace).
	letterheadSignatoryName: varchar("letterhead_signatory_name"),
	letterheadSignatoryTitle: varchar("letterhead_signatory_title"),
	letterheadEnabled: boolean("letterhead_enabled").default(true).notNull(),
	// Meeting follow-up lifecycle (migration 0076). Off by default — opt-in per org.
	meetingFollowupsEnabled: boolean("meeting_followups_enabled").default(false).notNull(),
	meetingFollowupsGraceMinutes: integer("meeting_followups_grace_minutes").default(30).notNull(),
	// Organizer Video auto-transcription (migration 0088). Off by default — paid add-on.
	videoTranscriptionEnabled: boolean("video_transcription_enabled").default(false).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.clientId],
			foreignColumns: [users.id],
			name: "organizations_client_id_fkey"
		}),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "organizations_owner_user_id_fkey"
		}),
	foreignKey({
			columns: [table.payingPartyUserId],
			foreignColumns: [users.id],
			name: "organizations_paying_party_user_id_fkey"
		}),
]);

export const journalEntryLines = pgTable("journal_entry_lines", {
	id: varchar().primaryKey().notNull(),
	journalEntryId: varchar("journal_entry_id").notNull(),
	accountId: varchar("account_id").notNull(),
	debit: numeric().notNull(),
	credit: numeric().notNull(),
	memo: varchar(),
	createdAt: timestamp("created_at", { mode: 'string' }).notNull(),
	contactId: varchar("contact_id"),
	/** @deprecated — tags moved to polymorphic journal_entry_line_tags.
	 *  Column kept for one release as a safety net (backfilled into the
	 *  new table by migration 0047); reads and writes go through the
	 *  polymorphic store now. A future migration will drop it. */
	rentalPropertyId: varchar("rental_property_id"),
	/** @deprecated — see rentalPropertyId. Tags now live in
	 *  journal_entry_line_tags with entity_type='fixed_asset'. */
	fixedAssetId: varchar("fixed_asset_id"),
	beneficiaryId: varchar("beneficiary_id"),
}, (table) => [
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [chartOfAccounts.id],
			name: "journal_entry_lines_account_id_fkey"
		}),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "journal_entry_lines_contact_id_fkey"
		}),
	foreignKey({
			columns: [table.journalEntryId],
			foreignColumns: [journalEntries.id],
			name: "journal_entry_lines_journal_entry_id_fkey"
		}),
]);

export const payrollRuns = pgTable("payroll_runs", {
	id: varchar().primaryKey().notNull(),
	businessId: varchar("business_id").notNull(),
	payScheduleId: varchar("pay_schedule_id"),
	periodStart: date("period_start").notNull(),
	periodEnd: date("period_end").notNull(),
	payDate: date("pay_date").notNull(),
	status: varchar().default('draft').notNull(),
	totalGross: numeric("total_gross", { precision: 12, scale:  2 }).default('0.00').notNull(),
	totalNet: numeric("total_net", { precision: 12, scale:  2 }).default('0.00').notNull(),
	totalTaxes: numeric("total_taxes", { precision: 12, scale:  2 }).default('0.00').notNull(),
	totalBenefits: numeric("total_benefits", { precision: 12, scale:  2 }).default('0.00').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_payroll_runs_business_id").using("btree", table.businessId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.payScheduleId],
			foreignColumns: [payrollSchedules.id],
			name: "payroll_runs_pay_schedule_id_fkey"
		}),
]);

export const payrollContractors = pgTable("payroll_contractors", {
	id: varchar().primaryKey().notNull(),
	businessId: varchar("business_id").notNull(),
	name: varchar().notNull(),
	email: varchar(),
	status: varchar().default('active').notNull(),
	payRate: numeric("pay_rate", { precision: 10, scale:  2 }).notNull(),
	paymentMethod: varchar("payment_method").default('direct_deposit').notNull(),
	bankAccountRef: varchar("bank_account_ref"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_payroll_contractors_business_id").using("btree", table.businessId.asc().nullsLast().op("text_ops")),
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const payrollEmployees: any = pgTable("payroll_employees", {
	id: varchar().primaryKey().notNull(),
	businessId: varchar("business_id").notNull(),
	firstName: varchar("first_name").notNull(),
	lastName: varchar("last_name").notNull(),
	email: varchar(),
	status: varchar().default('active').notNull(),
	hireDate: date("hire_date"),
	terminationDate: date("termination_date"),
	payType: varchar("pay_type").notNull(),
	payRate: numeric("pay_rate", { precision: 10, scale:  2 }).notNull(),
	defaultHoursPerPeriod: numeric("default_hours_per_period", { precision: 5, scale:  2 }),
	taxInfoId: varchar("tax_info_id"),
	benefitsEnrollmentId: varchar("benefits_enrollment_id"),
	paymentMethod: varchar("payment_method").default('direct_deposit').notNull(),
	bankAccountRef: varchar("bank_account_ref"),
	notes: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_payroll_employees_business_id").using("btree", table.businessId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.benefitsEnrollmentId],
			foreignColumns: [payrollBenefitEnrollments.id],
			name: "payroll_employees_benefits_enrollment_id_fkey"
		}),
	foreignKey({
			columns: [table.taxInfoId],
			foreignColumns: [payrollTaxInfo.id],
			name: "payroll_employees_tax_info_id_fkey"
		}),
]);

export const payrollLineItems = pgTable("payroll_line_items", {
	id: varchar().primaryKey().notNull(),
	payrollRunId: varchar("payroll_run_id").notNull(),
	employeeId: varchar("employee_id"),
	contractorId: varchar("contractor_id"),
	type: varchar().notNull(),
	grossPay: numeric("gross_pay", { precision: 12, scale:  2 }).default('0.00').notNull(),
	netPay: numeric("net_pay", { precision: 12, scale:  2 }).default('0.00').notNull(),
	taxesWithheld: numeric("taxes_withheld", { precision: 12, scale:  2 }).default('0.00').notNull(),
	benefitsWithheld: numeric("benefits_withheld", { precision: 12, scale:  2 }).default('0.00').notNull(),
	reimbursements: numeric({ precision: 12, scale:  2 }).default('0.00').notNull(),
	bonuses: numeric({ precision: 12, scale:  2 }).default('0.00').notNull(),
	commissions: numeric({ precision: 12, scale:  2 }).default('0.00').notNull(),
	hoursWorked: numeric("hours_worked", { precision: 5, scale:  2 }),
	notes: text(),
}, (table) => [
	index("ix_payroll_line_items_payroll_run_id").using("btree", table.payrollRunId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.contractorId],
			foreignColumns: [payrollContractors.id],
			name: "payroll_line_items_contractor_id_fkey"
		}),
	foreignKey({
			columns: [table.employeeId],
			foreignColumns: [payrollEmployees.id],
			name: "payroll_line_items_employee_id_fkey"
		}),
	foreignKey({
			columns: [table.payrollRunId],
			foreignColumns: [payrollRuns.id],
			name: "payroll_line_items_payroll_run_id_fkey"
		}),
]);

export const payrollSchedules = pgTable("payroll_schedules", {
	id: varchar().primaryKey().notNull(),
	businessId: varchar("business_id").notNull(),
	name: varchar().notNull(),
	frequency: varchar().notNull(),
	nextPayDate: date("next_pay_date"),
	lastPayDate: date("last_pay_date"),
	payPeriodStart: date("pay_period_start"),
	payPeriodEnd: date("pay_period_end"),
	timezone: varchar().default('UTC').notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_payroll_schedules_business_id").using("btree", table.businessId.asc().nullsLast().op("text_ops")),
]);

export const permissionSets = pgTable("permission_sets", {
	id: varchar().primaryKey().notNull(),
	name: varchar({ length: 255 }).notNull(),
	description: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_permission_sets_name").using("btree", table.name.asc().nullsLast().op("text_ops")),
]);

export const personalAccounts = pgTable("personal_accounts", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	name: text().notNull(),
	type: text().notNull(),
	balance: numeric({ precision: 15, scale:  2 }).notNull(),
	institution: text(),
	plaidAccountId: varchar("plaid_account_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_personal_accounts_plaid_account_id").using("btree", table.plaidAccountId.asc().nullsLast().op("text_ops")),
	index("ix_personal_accounts_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
]);

export const personalBudgets = pgTable("personal_budgets", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	category: text().notNull(),
	monthlyLimit: numeric("monthly_limit", { precision: 15, scale:  2 }).notNull(),
	spent: numeric({ precision: 15, scale:  2 }).notNull(),
	rollover: boolean().default(false).notNull(),
	aiVerdict: text("ai_verdict"),
	aiProbability: integer("ai_probability"),
	aiNote: text("ai_note"),
	aiReviewedAt: timestamp("ai_reviewed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_personal_budgets_category").using("btree", table.category.asc().nullsLast().op("text_ops")),
	index("ix_personal_budgets_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
]);

export const personalCategories = pgTable("personal_categories", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	name: text().notNull(),
	groupName: text("group_name").default('Other').notNull(),
	icon: text(),
	color: text(),
	rollover: boolean().default(false).notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
	archived: boolean().default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_personal_categories_user_name").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.name.asc().nullsLast().op("text_ops")),
	index("ix_personal_categories_user").using("btree", table.userId.asc().nullsLast().op("text_ops")),
]);

export const personalRecurring = pgTable("personal_recurring", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	merchantKey: text("merchant_key").notNull(),
	displayMerchant: text("display_merchant").notNull(),
	type: text().default('expense').notNull(),
	cadence: text().notNull(),
	intervalDays: integer("interval_days").notNull(),
	avgAmount: numeric("avg_amount", { precision: 15, scale:  2 }).notNull(),
	lastAmount: numeric("last_amount", { precision: 15, scale:  2 }).notNull(),
	lastDate: date("last_date").notNull(),
	nextDate: date("next_date").notNull(),
	occurrences: integer().notNull(),
	category: text(),
	status: text().default('active').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_personal_recurring_user_merchant").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.merchantKey.asc().nullsLast().op("text_ops")),
	index("ix_personal_recurring_user").using("btree", table.userId.asc().nullsLast().op("text_ops")),
]);

export const personalTransactionRules = pgTable("personal_transaction_rules", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	matchField: text("match_field").default('merchant').notNull(),
	matchOp: text("match_op").default('contains').notNull(),
	matchValue: text("match_value").notNull(),
	categoryName: text("category_name").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_personal_transaction_rules_user").using("btree", table.userId.asc().nullsLast().op("text_ops")),
]);

export const payrollTaxInfo = pgTable("payroll_tax_info", {
	id: varchar().primaryKey().notNull(),
	employeeId: varchar("employee_id").notNull(),
	filingStatus: varchar("filing_status"),
	allowances: numeric({ precision: 3, scale:  0 }).default('0'),
	additionalWithholding: numeric("additional_withholding", { precision: 10, scale:  2 }).default('0.00'),
	state: varchar(),
	locality: varchar(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.employeeId],
			foreignColumns: [payrollEmployees.id],
			name: "payroll_tax_info_employee_id_fkey"
		}),
	unique("payroll_tax_info_employee_id_key").on(table.employeeId),
]);

export const permissions = pgTable("permissions", {
	id: varchar().primaryKey().notNull(),
	key: varchar({ length: 255 }).notNull(),
	description: text(),
}, (table) => [
	uniqueIndex("ix_permissions_key").using("btree", table.key.asc().nullsLast().op("text_ops")),
]);

export const personalCashflow = pgTable("personal_cashflow", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	month: date().notNull(),
	income: numeric({ precision: 15, scale:  2 }).notNull(),
	expenses: numeric({ precision: 15, scale:  2 }).notNull(),
	net: numeric({ precision: 15, scale:  2 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_personal_cashflow_month").using("btree", table.month.asc().nullsLast().op("date_ops")),
	index("ix_personal_cashflow_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
]);

export const personalGoals = pgTable("personal_goals", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	name: text().notNull(),
	targetAmount: numeric("target_amount", { precision: 15, scale:  2 }).notNull(),
	currentAmount: numeric("current_amount", { precision: 15, scale:  2 }).notNull(),
	targetDate: date("target_date"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_personal_goals_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
]);

export const personalNetworth = pgTable("personal_networth", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	date: date().notNull(),
	assets: numeric({ precision: 15, scale:  2 }).notNull(),
	liabilities: numeric({ precision: 15, scale:  2 }).notNull(),
	networth: numeric({ precision: 15, scale:  2 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_personal_networth_date").using("btree", table.date.asc().nullsLast().op("date_ops")),
	index("ix_personal_networth_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
]);

export const personalTransactions = pgTable("personal_transactions", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	accountId: varchar("account_id").notNull(),
	date: date().notNull(),
	amount: numeric({ precision: 15, scale:  2 }).notNull(),
	category: text(),
	description: text(),
	merchant: text(),
	plaidTransactionId: varchar("plaid_transaction_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_personal_transactions_account_id").using("btree", table.accountId.asc().nullsLast().op("text_ops")),
	index("ix_personal_transactions_category").using("btree", table.category.asc().nullsLast().op("text_ops")),
	index("ix_personal_transactions_date").using("btree", table.date.asc().nullsLast().op("date_ops")),
	uniqueIndex("ix_personal_transactions_plaid_transaction_id").using("btree", table.plaidTransactionId.asc().nullsLast().op("text_ops")),
	index("ix_personal_transactions_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
]);

export const plaidRawTransactions = pgTable("plaid_raw_transactions", {
	id: varchar().primaryKey().notNull(),
	plaidAccountId: varchar("plaid_account_id").notNull(),
	plaidTransactionId: varchar("plaid_transaction_id").notNull(),
	date: date().notNull(),
	amount: numeric({ precision: 18, scale:  2 }).notNull(),
	description: varchar(),
	rawJson: json("raw_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_plaid_raw_transactions_plaid_account_id").using("btree", table.plaidAccountId.asc().nullsLast().op("text_ops")),
	index("ix_plaid_raw_transactions_plaid_transaction_id").using("btree", table.plaidTransactionId.asc().nullsLast().op("text_ops")),
	uniqueIndex("ix_plaid_raw_transactions_uniq").using("btree", table.plaidAccountId.asc().nullsLast().op("text_ops"), table.plaidTransactionId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.plaidAccountId],
			foreignColumns: [plaidAccounts.id],
			name: "plaid_raw_transactions_plaid_account_id_fkey"
		}),
]);

// Point-in-time snapshots of the bank-reported balance (captured FREE from the
// /transactions/sync accounts[] response — no metered /accounts/balance/get). One
// row per account per day. Gives reconciliation an INDEPENDENT per-period anchor
// (the bank's actual balance at that time) instead of rolling the single live
// balance back through the same Plaid feed that built the ledger.
export const plaidBalanceSnapshots = pgTable("plaid_balance_snapshots", {
	id: varchar().primaryKey().notNull(),
	plaidAccountId: varchar("plaid_account_id").notNull(),
	organizationId: varchar("organization_id"),
	snapshotDate: date("snapshot_date").notNull(),
	balance: numeric({ precision: 19, scale: 4 }).notNull(),
	currency: varchar(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("uq_plaid_balance_snapshots_acct_date").on(table.plaidAccountId, table.snapshotDate),
	index("ix_plaid_balance_snapshots_acct").on(table.plaidAccountId),
]);

export const plaidSyncBatches = pgTable("plaid_sync_batches", {
	id: varchar().primaryKey().notNull(),
	plaidAccountId: varchar("plaid_account_id").notNull(),
	cursor: varchar(),
	addedCount: integer("added_count").notNull(),
	modifiedCount: integer("modified_count").notNull(),
	removedCount: integer("removed_count").notNull(),
	rawJson: json("raw_json"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_plaid_sync_batches_plaid_account_id").using("btree", table.plaidAccountId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.plaidAccountId],
			foreignColumns: [plaidAccounts.id],
			name: "plaid_sync_batches_plaid_account_id_fkey"
		}),
]);

export const qboAccountStaging = pgTable("qbo_account_staging", {
	id: varchar().primaryKey().notNull(),
	migrationJobId: varchar("migration_job_id").notNull(),
	realmId: varchar("realm_id").notNull(),
	rawQboId: varchar("raw_qbo_id").notNull(),
	name: varchar().notNull(),
	type: varchar().notNull(),
	subtype: varchar(),
	fullyQualifiedName: varchar("fully_qualified_name"),
	isActive: boolean("is_active").notNull(),
	rawJson: json("raw_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_qbo_account_staging_migration_job_id").using("btree", table.migrationJobId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_account_staging_raw_qbo_id").using("btree", table.rawQboId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_account_staging_realm_id").using("btree", table.realmId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.migrationJobId],
			foreignColumns: [qboMigrationJobs.id],
			name: "qbo_account_staging_migration_job_id_fkey"
		}),
]);

export const platformMaintenanceState = pgTable("platform_maintenance_state", {
	id: varchar().primaryKey().notNull(),
	maintenanceMode: boolean("maintenance_mode").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

export const predictiveCashFlowSnapshots = pgTable("predictive_cash_flow_snapshots", {
	id: varchar().primaryKey().notNull(),
	orgId: varchar("org_id").notNull(),
	range: integer().notNull(),
	data: json().notNull(),
	financialTruthSignature: varchar("financial_truth_signature").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_predictive_cash_flow_snapshots_org_id").using("btree", table.orgId.asc().nullsLast().op("text_ops")),
	index("ix_predictive_cash_flow_snapshots_range").using("btree", table.range.asc().nullsLast().op("int4_ops")),
]);

export const processingModes = pgTable("processing_modes", {
	id: varchar().primaryKey().notNull(),
	internalName: varchar("internal_name").notNull(),
	displayName: varchar("display_name").notNull(),
	source: varchar().default('system').notNull(),
	status: varchar().default('stable').notNull(),
	enabled: boolean().default(true).notNull(),
	notes: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_processing_modes_internal_name").using("btree", table.internalName.asc().nullsLast().op("text_ops")),
]);

export const plaidAccounts = pgTable("plaid_accounts", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	institutionName: varchar("institution_name").notNull(),
	institutionLogo: varchar("institution_logo"),
	accountName: varchar("account_name").notNull(),
	last4: varchar(),
	accountType: varchar("account_type").notNull(),
	subtype: varchar(),
	balance: numeric({ precision: 18, scale:  2 }),
	connectionStatus: varchar("connection_status").notNull(),
	linkedOrganizationId: varchar("linked_organization_id"),
	linkedPersonalId: varchar("linked_personal_id"),
	chartOfAccountId: varchar("chart_of_account_id"),
	plaidAccessToken: varchar("plaid_access_token").notNull(),
	plaidItemId: varchar("plaid_item_id").notNull(),
	plaidAccountId: varchar("plaid_account_id"),
	plaidCursor: varchar("plaid_cursor"),
	lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: 'string' }),
	syncStatus: varchar("sync_status").notNull(),
	syncErrorMessage: varchar("sync_error_message"),
	lastSyncErrorAt: timestamp("last_sync_error_at", { withTimezone: true, mode: 'string' }),
	lastSyncStartedAt: timestamp("last_sync_started_at", { withTimezone: true, mode: 'string' }),
	lastSyncError: varchar("last_sync_error"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	hasUserSyncedOnce: boolean("has_user_synced_once").default(false).notNull(),
	syncInProgress: boolean("sync_in_progress").default(false).notNull(),
	promotionRequested: boolean("promotion_requested").default(false).notNull(),
	inScope: boolean("in_scope").default(false).notNull(),
	promotedAt: timestamp("promoted_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("ix_plaid_accounts_linked_organization_id").using("btree", table.linkedOrganizationId.asc().nullsLast().op("text_ops")),
	index("ix_plaid_accounts_plaid_item_id").using("btree", table.plaidItemId.asc().nullsLast().op("text_ops")),
	index("ix_plaid_accounts_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.chartOfAccountId],
			foreignColumns: [chartOfAccounts.id],
			name: "plaid_accounts_chart_of_account_id_fkey"
		}),
	foreignKey({
			columns: [table.linkedOrganizationId],
			foreignColumns: [organizations.id],
			name: "plaid_accounts_linked_organization_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "plaid_accounts_user_id_fkey"
		}),
]);

// GoHighLevel (GHL) integration — Phase 1 (additive, ingestion-only).
// See db/migrations/0113_ghl_integration.sql. Tokens are stored as
// AES-256-GCM payloads (iv:tag:enc); never query/log them in plaintext.
export const ghlConnections = pgTable("ghl_connections", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	organizationId: varchar("organization_id").notNull(),
	locationId: varchar("location_id").notNull(),
	accessToken: varchar("access_token").notNull(),
	refreshToken: varchar("refresh_token").notNull(),
	accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true, mode: 'string' }),
	connectionStatus: varchar("connection_status").default('connected').notNull(),
	syncCursor: varchar("sync_cursor"),
	lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: 'string' }),
	lastSyncError: varchar("last_sync_error"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_ghl_connections_org_location_uniq").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.locationId.asc().nullsLast().op("text_ops")),
	index("ix_ghl_connections_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_ghl_connections_location_id").using("btree", table.locationId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "ghl_connections_organization_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "ghl_connections_user_id_fkey"
		}),
]);

export const ghlRawPayments = pgTable("ghl_raw_payments", {
	id: varchar().primaryKey().notNull(),
	ghlConnectionId: varchar("ghl_connection_id").notNull(),
	ghlPaymentId: varchar("ghl_payment_id").notNull(),
	date: date().notNull(),
	amount: numeric({ precision: 18, scale:  2 }).notNull(),
	contactName: varchar("contact_name"),
	description: varchar(),
	rawJson: json("raw_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_ghl_raw_payments_uniq").using("btree", table.ghlConnectionId.asc().nullsLast().op("text_ops"), table.ghlPaymentId.asc().nullsLast().op("text_ops")),
	index("ix_ghl_raw_payments_ghl_connection_id").using("btree", table.ghlConnectionId.asc().nullsLast().op("text_ops")),
	index("ix_ghl_raw_payments_ghl_payment_id").using("btree", table.ghlPaymentId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.ghlConnectionId],
			foreignColumns: [ghlConnections.id],
			name: "ghl_raw_payments_ghl_connection_id_fkey"
		}),
]);

export const ghlOauthStates = pgTable("ghl_oauth_states", {
	id: varchar().primaryKey().notNull(),
	state: varchar({ length: 255 }).notNull(),
	userId: varchar("user_id").notNull(),
	orgId: varchar("org_id"),
	returnContext: varchar("return_context", { length: 50 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	uniqueIndex("ix_ghl_oauth_states_state").using("btree", table.state.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "ghl_oauth_states_org_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "ghl_oauth_states_user_id_fkey"
		}),
]);

export const qboCustomerStaging = pgTable("qbo_customer_staging", {
	id: varchar().primaryKey().notNull(),
	migrationJobId: varchar("migration_job_id").notNull(),
	realmId: varchar("realm_id").notNull(),
	rawQboId: varchar("raw_qbo_id").notNull(),
	displayName: varchar("display_name").notNull(),
	primaryEmail: varchar("primary_email"),
	primaryPhone: varchar("primary_phone"),
	rawJson: json("raw_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_qbo_customer_staging_migration_job_id").using("btree", table.migrationJobId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_customer_staging_raw_qbo_id").using("btree", table.rawQboId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_customer_staging_realm_id").using("btree", table.realmId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.migrationJobId],
			foreignColumns: [qboMigrationJobs.id],
			name: "qbo_customer_staging_migration_job_id_fkey"
		}),
]);

export const qboInvoiceStaging = pgTable("qbo_invoice_staging", {
	id: varchar().primaryKey().notNull(),
	migrationJobId: varchar("migration_job_id").notNull(),
	realmId: varchar("realm_id").notNull(),
	rawQboId: varchar("raw_qbo_id").notNull(),
	customerQboId: varchar("customer_qbo_id"),
	txnDate: date("txn_date"),
	dueDate: date("due_date"),
	totalAmount: numeric("total_amount", { precision: 18, scale:  2 }).notNull(),
	balance: numeric({ precision: 18, scale:  2 }).notNull(),
	rawJson: json("raw_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_qbo_invoice_staging_customer_qbo_id").using("btree", table.customerQboId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_invoice_staging_migration_job_id").using("btree", table.migrationJobId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_invoice_staging_raw_qbo_id").using("btree", table.rawQboId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_invoice_staging_realm_id").using("btree", table.realmId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.migrationJobId],
			foreignColumns: [qboMigrationJobs.id],
			name: "qbo_invoice_staging_migration_job_id_fkey"
		}),
]);

export const qboMappingOverrides = pgTable("qbo_mapping_overrides", {
	id: varchar().primaryKey().notNull(),
	migrationJobId: varchar("migration_job_id").notNull(),
	entityType: varchar("entity_type").notNull(),
	stagingId: varchar("staging_id").notNull(),
	field: varchar().notNull(),
	originalValue: json("original_value"),
	overrideValue: json("override_value").notNull(),
	createdByUserId: varchar("created_by_user_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_qbo_mapping_overrides_created_by_user_id").using("btree", table.createdByUserId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_mapping_overrides_entity_type").using("btree", table.entityType.asc().nullsLast().op("text_ops")),
	index("ix_qbo_mapping_overrides_migration_job_id").using("btree", table.migrationJobId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_mapping_overrides_staging_id").using("btree", table.stagingId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "qbo_mapping_overrides_created_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.migrationJobId],
			foreignColumns: [qboMigrationJobs.id],
			name: "qbo_mapping_overrides_migration_job_id_fkey"
		}),
]);

export const qboMappingResults = pgTable("qbo_mapping_results", {
	id: varchar().primaryKey().notNull(),
	migrationJobId: varchar("migration_job_id").notNull(),
	resultJson: json("result_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_qbo_mapping_results_migration_job_id").using("btree", table.migrationJobId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.migrationJobId],
			foreignColumns: [qboMigrationJobs.id],
			name: "qbo_mapping_results_migration_job_id_fkey"
		}),
]);

export const qboMigrationLogs = pgTable("qbo_migration_logs", {
	id: varchar().primaryKey().notNull(),
	jobId: varchar("job_id").notNull(),
	message: text(),
	level: varchar(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_qbo_migration_logs_job_id").using("btree", table.jobId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.jobId],
			foreignColumns: [qboMigrationJobs.id],
			name: "qbo_migration_logs_job_id_fkey"
		}),
]);

export const qboBillStaging = pgTable("qbo_bill_staging", {
	id: varchar().primaryKey().notNull(),
	migrationJobId: varchar("migration_job_id").notNull(),
	realmId: varchar("realm_id").notNull(),
	rawQboId: varchar("raw_qbo_id").notNull(),
	vendorQboId: varchar("vendor_qbo_id"),
	txnDate: date("txn_date"),
	dueDate: date("due_date"),
	totalAmount: numeric("total_amount", { precision: 18, scale:  2 }).notNull(),
	balance: numeric({ precision: 18, scale:  2 }).notNull(),
	rawJson: json("raw_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_qbo_bill_staging_migration_job_id").using("btree", table.migrationJobId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_bill_staging_raw_qbo_id").using("btree", table.rawQboId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_bill_staging_realm_id").using("btree", table.realmId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_bill_staging_vendor_qbo_id").using("btree", table.vendorQboId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.migrationJobId],
			foreignColumns: [qboMigrationJobs.id],
			name: "qbo_bill_staging_migration_job_id_fkey"
		}),
]);

export const qboMigrationSummaries = pgTable("qbo_migration_summaries", {
	id: varchar().primaryKey().notNull(),
	migrationJobId: varchar("migration_job_id").notNull(),
	summaryJson: json("summary_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_qbo_migration_summaries_migration_job_id").using("btree", table.migrationJobId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.migrationJobId],
			foreignColumns: [qboMigrationJobs.id],
			name: "qbo_migration_summaries_migration_job_id_fkey"
		}),
]);

export const qboMirroringJobs = pgTable("qbo_mirroring_jobs", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	orgId: varchar("org_id"),
	realmId: varchar("realm_id").notNull(),
	status: varchar().notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	lastSuccessfulSyncAt: timestamp("last_successful_sync_at", { withTimezone: true, mode: 'string' }),
	qboChangeToken: varchar("qbo_change_token"),
	logs: json().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_qbo_mirroring_jobs_org_id").using("btree", table.orgId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_mirroring_jobs_qbo_change_token").using("btree", table.qboChangeToken.asc().nullsLast().op("text_ops")),
	index("ix_qbo_mirroring_jobs_realm_id").using("btree", table.realmId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_mirroring_jobs_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("ix_qbo_mirroring_jobs_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "qbo_mirroring_jobs_org_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "qbo_mirroring_jobs_user_id_fkey"
		}),
]);

export const qboOauthStates = pgTable("qbo_oauth_states", {
	id: varchar().primaryKey().notNull(),
	state: varchar({ length: 255 }).notNull(),
	userId: varchar("user_id").notNull(),
	orgId: varchar("org_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	returnContext: varchar("return_context", { length: 50 }),
}, (table) => [
	uniqueIndex("ix_qbo_oauth_states_state").using("btree", table.state.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "qbo_oauth_states_org_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "qbo_oauth_states_user_id_fkey"
		}),
]);

export const qboPaymentStaging = pgTable("qbo_payment_staging", {
	id: varchar().primaryKey().notNull(),
	migrationJobId: varchar("migration_job_id").notNull(),
	realmId: varchar("realm_id").notNull(),
	rawQboId: varchar("raw_qbo_id").notNull(),
	customerQboId: varchar("customer_qbo_id"),
	totalAmount: numeric("total_amount", { precision: 18, scale:  2 }).notNull(),
	txnDate: date("txn_date"),
	rawJson: json("raw_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_qbo_payment_staging_customer_qbo_id").using("btree", table.customerQboId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_payment_staging_migration_job_id").using("btree", table.migrationJobId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_payment_staging_raw_qbo_id").using("btree", table.rawQboId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_payment_staging_realm_id").using("btree", table.realmId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.migrationJobId],
			foreignColumns: [qboMigrationJobs.id],
			name: "qbo_payment_staging_migration_job_id_fkey"
		}),
]);

export const qboMigrationJobs = pgTable("qbo_migration_jobs", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	orgId: varchar("org_id"),
	realmId: varchar("realm_id").notNull(),
	status: varchar().notNull(),
	errorMessage: text("error_message"),
	progress: integer(),
	migrationReport: json("migration_report"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("ix_qbo_migration_jobs_org_id").using("btree", table.orgId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_migration_jobs_realm_id").using("btree", table.realmId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_migration_jobs_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("ix_qbo_migration_jobs_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "qbo_migration_jobs_org_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "qbo_migration_jobs_user_id_fkey"
		}),
]);

export const qboConnections = pgTable("qbo_connections", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	orgId: varchar("org_id"),
	realmId: varchar("realm_id").notNull(),
	accessToken: varchar("access_token").notNull(),
	refreshToken: varchar("refresh_token").notNull(),
	accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_qbo_connections_org_id").using("btree", table.orgId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_connections_realm_id").using("btree", table.realmId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_connections_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.orgId],
			foreignColumns: [organizations.id],
			name: "qbo_connections_org_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "qbo_connections_user_id_fkey"
		}),
]);

export const qboWebhookEvents = pgTable("qbo_webhook_events", {
	id: varchar().primaryKey().notNull(),
	realmId: varchar("realm_id").notNull(),
	eventType: varchar("event_type").notNull(),
	rawPayload: json("raw_payload").notNull(),
	status: varchar().notNull(),
	attempts: integer().notNull(),
	lastError: text("last_error"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_qbo_webhook_events_event_type").using("btree", table.eventType.asc().nullsLast().op("text_ops")),
	index("ix_qbo_webhook_events_realm_id").using("btree", table.realmId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_webhook_events_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
]);

// Bidirectional mapping between a QBO record and its local counterpart. One
// row per (realm, entityType, qboId) and per (realm, entityType, localId).
// qboSyncToken is QBO's optimistic-lock version; it MUST be sent on every
// outbound update or QBO rejects with 5010 (Stale Object Error).
export const qboEntityMap = pgTable("qbo_entity_map", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	realmId: varchar("realm_id").notNull(),
	entityType: varchar("entity_type", { length: 32 }).notNull(),
	qboId: varchar("qbo_id", { length: 64 }).notNull(),
	localId: varchar("local_id").notNull(),
	qboSyncToken: varchar("qbo_sync_token", { length: 32 }),
	lastQboUpdatedAt: timestamp("last_qbo_updated_at", { withTimezone: true, mode: 'string' }),
	lastLocalUpdatedAt: timestamp("last_local_updated_at", { withTimezone: true, mode: 'string' }),
	lastSyncAt: timestamp("last_sync_at", { withTimezone: true, mode: 'string' }),
	syncStatus: varchar("sync_status", { length: 16 }).default('pending').notNull(),
	lastError: text("last_error"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_qbo_entity_map_org_realm_type_qbo").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.realmId.asc().nullsLast().op("text_ops"), table.entityType.asc().nullsLast().op("text_ops"), table.qboId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_entity_map_org_realm_type_local").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.realmId.asc().nullsLast().op("text_ops"), table.entityType.asc().nullsLast().op("text_ops"), table.localId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_entity_map_org_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_entity_map_sync_status").using("btree", table.syncStatus.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "qbo_entity_map_org_id_fkey"
		}),
]);

// Local→QBO push queue. Local writers enqueue here transactionally, then the
// qbo-outbound-drain Inngest worker calls QBO. Decouples user-facing writes
// from QBO's rate-limited API and lets failed pushes retry without rolling
// back the user's local change.
export const qboOutboundQueue = pgTable("qbo_outbound_queue", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	realmId: varchar("realm_id").notNull(),
	entityType: varchar("entity_type", { length: 32 }).notNull(),
	localId: varchar("local_id").notNull(),
	qboId: varchar("qbo_id", { length: 64 }),
	operation: varchar({ length: 16 }).notNull(),
	payload: json().notNull(),
	status: varchar({ length: 16 }).default('pending').notNull(),
	attempts: integer().default(0).notNull(),
	lastError: text("last_error"),
	scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_qbo_outbound_queue_org_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_outbound_queue_realm_id").using("btree", table.realmId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_outbound_queue_status_scheduled").using("btree", table.status.asc().nullsLast().op("text_ops"), table.scheduledAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "qbo_outbound_queue_org_id_fkey"
		}),
]);

// Per-(org, realm) mirror configuration: which entity types sync, and a
// fallback chart-of-accounts row for QBO accounts that don't auto-map by
// name. Account/category mapping overrides live in qboEntityMap (entityType
// = 'account') — these JSON columns are reserved for non-entity overrides
// (e.g. QBO Class → local category overrides) so the mapping UI has one
// place to read.
export const qboMirrorSettings = pgTable("qbo_mirror_settings", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	realmId: varchar("realm_id").notNull(),
	mirrorAccounts: boolean("mirror_accounts").default(true).notNull(),
	mirrorCustomers: boolean("mirror_customers").default(true).notNull(),
	mirrorVendors: boolean("mirror_vendors").default(true).notNull(),
	mirrorInvoices: boolean("mirror_invoices").default(true).notNull(),
	mirrorBills: boolean("mirror_bills").default(true).notNull(),
	mirrorPayments: boolean("mirror_payments").default(true).notNull(),
	mirrorBillPayments: boolean("mirror_bill_payments").default(true).notNull(),
	mirrorItems: boolean("mirror_items").default(true).notNull(),
	defaultAccountId: varchar("default_account_id"),
	categoryMappingOverrides: json("category_mapping_overrides"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_qbo_mirror_settings_org_realm").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.realmId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "qbo_mirror_settings_org_id_fkey"
		}),
	foreignKey({
			columns: [table.defaultAccountId],
			foreignColumns: [chartOfAccounts.id],
			name: "qbo_mirror_settings_default_account_id_fkey"
		}),
]);

// One row per detected conflict (both sides changed the same record between
// syncs). Resolution=null until a user picks "use_qbo" or "use_ours" in the
// conflict log UI, at which point the chosen side is pushed and resolvedAt
// is set.
export const qboConflicts = pgTable("qbo_conflicts", {
	id: varchar().primaryKey().notNull(),
	entityMapId: varchar("entity_map_id").notNull(),
	organizationId: varchar("organization_id").notNull(),
	detectedAt: timestamp("detected_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	qboSnapshot: json("qbo_snapshot").notNull(),
	localSnapshot: json("local_snapshot").notNull(),
	resolution: varchar({ length: 16 }),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	resolvedByUserId: varchar("resolved_by_user_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_qbo_conflicts_entity_map_id").using("btree", table.entityMapId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_conflicts_org_unresolved").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.resolvedAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.entityMapId],
			foreignColumns: [qboEntityMap.id],
			name: "qbo_conflicts_entity_map_id_fkey"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "qbo_conflicts_org_id_fkey"
		}),
	foreignKey({
			columns: [table.resolvedByUserId],
			foreignColumns: [users.id],
			name: "qbo_conflicts_resolved_by_user_id_fkey"
		}),
]);

export const quickDashboardSnapshots = pgTable("quick_dashboard_snapshots", {
	id: varchar().primaryKey().notNull(),
	orgId: varchar("org_id").notNull(),
	scope: varchar().notNull(),
	data: json().notNull(),
	financialTruthSignature: varchar("financial_truth_signature").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_quick_dashboard_snapshots_org_id").using("btree", table.orgId.asc().nullsLast().op("text_ops")),
	index("ix_quick_dashboard_snapshots_scope").using("btree", table.scope.asc().nullsLast().op("text_ops")),
]);

export const receiptLines = pgTable("receipt_lines", {
	id: varchar().primaryKey().notNull(),
	receiptId: varchar("receipt_id").notNull(),
	description: varchar().notNull(),
	quantity: doublePrecision().default(sql`'1'`).notNull(),
	unitPrice: doublePrecision("unit_price").default(sql`'0'`).notNull(),
	amount: doublePrecision().notNull(),
	expenseAccountId: varchar("expense_account_id"),
	suggestedAccountId: varchar("suggested_account_id"),
	categoryGuess: varchar("category_guess"),
	itemName: varchar("item_name"),
}, (table) => [
	index("ix_receipt_lines_receipt_id").using("btree", table.receiptId.asc().nullsLast().op("text_ops")),
]);

export const receipts = pgTable("receipts", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	contactId: varchar("contact_id"),
	receiptDate: varchar("receipt_date"),
	memo: varchar(),
	totalAmount: doublePrecision("total_amount").notNull(),
	status: varchar().default('draft').notNull(),
	receiptImageId: varchar("receipt_image_id"),
	journalEntryId: varchar("journal_entry_id"),
	rawText: text("raw_text"),
	veryfiDocumentId: varchar("veryfi_document_id"),
	veryfiRawJson: text("veryfi_raw_json"),
	posted: boolean().default(false).notNull(),
	postedAt: varchar("posted_at"),
	vendorMetadata: text("vendor_metadata"),
	vendorLogoUrl: varchar("vendor_logo_url"),
	sourceAccountId: varchar("source_account_id"),
}, (table) => [
	index("ix_receipts_contact_id").using("btree", table.contactId.asc().nullsLast().op("text_ops")),
	index("ix_receipts_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_receipts_receipt_date").using("btree", table.receiptDate.asc().nullsLast().op("text_ops")),
]);

// Phase 3 snapshot table. When the upload pipeline auto-applies a
// high-confidence match, this row holds the pre-state so undo can
// restore it cleanly. reversed_at non-null = the application has been
// undone.
export const receiptMatchApplications = pgTable("receipt_match_applications", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	suggestionId: varchar("suggestion_id").notNull(),
	receiptId: varchar("receipt_id").notNull(),
	transactionId: varchar("transaction_id").notNull(),
	newJournalEntryId: varchar("new_journal_entry_id").notNull(),
	preState: jsonb("pre_state").notNull(),
	appliedAt: timestamp("applied_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	reversedAt: timestamp("reversed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("ix_receipt_match_applications_suggestion").using("btree", table.suggestionId.asc().nullsLast().op("text_ops")),
	index("ix_receipt_match_applications_receipt").using("btree", table.receiptId.asc().nullsLast().op("text_ops")),
	index("ix_receipt_match_applications_transaction").using("btree", table.transactionId.asc().nullsLast().op("text_ops")),
]);

// Phase 1 of receipt ↔ transaction matching. Detection-only: the
// matcher writes one row per candidate. Phase 2 (UI on /ai-chat) reads
// where status='pending'. Phase 3 auto-applies high-confidence ones at
// upload time (status='auto_applied') with a snapshot in
// receipt_match_applications; the user can verify (dismiss) or undo.
export const receiptMatchSuggestions = pgTable("receipt_match_suggestions", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	receiptId: varchar("receipt_id").notNull(),
	transactionId: varchar("transaction_id").notNull(),
	confidence: numeric({ precision: 4, scale: 3 }).notNull(),
	amountDiff: numeric("amount_diff", { precision: 12, scale: 2 }).notNull(),
	dateDiffDays: integer("date_diff_days").notNull(),
	vendorMatch: boolean("vendor_match").default(false).notNull(),
	status: varchar().default('pending').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_receipt_match_suggestions_receipt_txn").using("btree", table.receiptId.asc().nullsLast().op("text_ops"), table.transactionId.asc().nullsLast().op("text_ops")),
	index("ix_receipt_match_suggestions_org_status").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("ix_receipt_match_suggestions_receipt").using("btree", table.receiptId.asc().nullsLast().op("text_ops")),
	index("ix_receipt_match_suggestions_transaction").using("btree", table.transactionId.asc().nullsLast().op("text_ops")),
]);

export const resolutionPacketExports = pgTable("resolution_packet_exports", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	userId: varchar("user_id").notNull(),
	storageFilename: varchar("storage_filename").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_resolution_packet_exports_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_resolution_packet_exports_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "resolution_packet_exports_organization_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "resolution_packet_exports_user_id_fkey"
		}),
]);

export const resolutionPackets = pgTable("resolution_packets", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	userId: varchar("user_id").notNull(),
	generatedAt: varchar("generated_at"),
	sections: jsonb().notNull(),
	signature: varchar().notNull(),
	signedAt: timestamp("signed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	signedDocumentText: text("signed_document_text").notNull(),
}, (table) => [
	index("ix_resolution_packets_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_resolution_packets_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "resolution_packets_organization_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "resolution_packets_user_id_fkey"
		}),
]);

export const rolePermissions = pgTable("role_permissions", {
	id: varchar().primaryKey().notNull(),
	roleId: varchar("role_id").notNull(),
	permissionId: varchar("permission_id").notNull(),
}, (table) => [
	index("ix_role_permissions_permission_id").using("btree", table.permissionId.asc().nullsLast().op("text_ops")),
	index("ix_role_permissions_role_id").using("btree", table.roleId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.permissionId],
			foreignColumns: [permissions.id],
			name: "role_permissions_permission_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.roleId],
			foreignColumns: [roles.id],
			name: "role_permissions_role_id_fkey"
		}).onDelete("cascade"),
	unique("uq_role_permission").on(table.roleId, table.permissionId),
]);

export const roles = pgTable("roles", {
	id: varchar().primaryKey().notNull(),
	name: varchar({ length: 255 }).notNull(),
}, (table) => [
	uniqueIndex("ix_roles_name").using("btree", table.name.asc().nullsLast().op("text_ops")),
]);

export const scheduledExports = pgTable("scheduled_exports", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	userId: varchar("user_id").notNull(),
	format: varchar().notNull(),
	columnPresetId: varchar("column_preset_id"),
	columns: jsonb(),
	schedule: varchar().notNull(),
	scheduleType: varchar("schedule_type").notNull(),
	filters: jsonb(),
	sortBy: varchar("sort_by"),
	sortDirection: varchar("sort_direction"),
	lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: 'string' }),
	nextRunAt: timestamp("next_run_at", { withTimezone: true, mode: 'string' }),
	isActive: varchar("is_active").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_scheduled_exports_next_run_at").using("btree", table.nextRunAt.asc().nullsLast().op("timestamptz_ops")),
	index("ix_scheduled_exports_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_scheduled_exports_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.columnPresetId],
			foreignColumns: [columnPresets.id],
			name: "scheduled_exports_column_preset_id_fkey"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "scheduled_exports_organization_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "scheduled_exports_user_id_fkey"
		}),
]);

export const savedViews = pgTable("saved_views", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	userId: varchar("user_id"),
	name: varchar().notNull(),
	filtersJson: text("filters_json").notNull(),
	sortBy: varchar("sort_by"),
	sortDirection: varchar("sort_direction"),
	createdAt: varchar("created_at").notNull(),
});

export const qboPurchaseStaging = pgTable("qbo_purchase_staging", {
	id: varchar().primaryKey().notNull(),
	migrationJobId: varchar("migration_job_id").notNull(),
	realmId: varchar("realm_id").notNull(),
	rawQboId: varchar("raw_qbo_id").notNull(),
	accountQboId: varchar("account_qbo_id"),
	vendorQboId: varchar("vendor_qbo_id"),
	totalAmount: numeric("total_amount", { precision: 18, scale:  2 }).notNull(),
	txnDate: date("txn_date"),
	rawJson: json("raw_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_qbo_purchase_staging_migration_job_id").using("btree", table.migrationJobId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_purchase_staging_raw_qbo_id").using("btree", table.rawQboId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_purchase_staging_realm_id").using("btree", table.realmId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.migrationJobId],
			foreignColumns: [qboMigrationJobs.id],
			name: "qbo_purchase_staging_migration_job_id_fkey"
		}),
]);

export const qboDepositStaging = pgTable("qbo_deposit_staging", {
	id: varchar().primaryKey().notNull(),
	migrationJobId: varchar("migration_job_id").notNull(),
	realmId: varchar("realm_id").notNull(),
	rawQboId: varchar("raw_qbo_id").notNull(),
	depositToAccountQboId: varchar("deposit_to_account_qbo_id"),
	totalAmount: numeric("total_amount", { precision: 18, scale:  2 }).notNull(),
	txnDate: date("txn_date"),
	rawJson: json("raw_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_qbo_deposit_staging_migration_job_id").using("btree", table.migrationJobId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_deposit_staging_raw_qbo_id").using("btree", table.rawQboId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_deposit_staging_realm_id").using("btree", table.realmId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.migrationJobId],
			foreignColumns: [qboMigrationJobs.id],
			name: "qbo_deposit_staging_migration_job_id_fkey"
		}),
]);

export const qboTransferStaging = pgTable("qbo_transfer_staging", {
	id: varchar().primaryKey().notNull(),
	migrationJobId: varchar("migration_job_id").notNull(),
	realmId: varchar("realm_id").notNull(),
	rawQboId: varchar("raw_qbo_id").notNull(),
	fromAccountQboId: varchar("from_account_qbo_id"),
	toAccountQboId: varchar("to_account_qbo_id"),
	amount: numeric("amount", { precision: 18, scale:  2 }).notNull(),
	txnDate: date("txn_date"),
	rawJson: json("raw_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_qbo_transfer_staging_migration_job_id").using("btree", table.migrationJobId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_transfer_staging_raw_qbo_id").using("btree", table.rawQboId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_transfer_staging_realm_id").using("btree", table.realmId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.migrationJobId],
			foreignColumns: [qboMigrationJobs.id],
			name: "qbo_transfer_staging_migration_job_id_fkey"
		}),
]);

export const qboJournalEntryStaging = pgTable("qbo_journal_entry_staging", {
	id: varchar().primaryKey().notNull(),
	migrationJobId: varchar("migration_job_id").notNull(),
	realmId: varchar("realm_id").notNull(),
	rawQboId: varchar("raw_qbo_id").notNull(),
	docNumber: varchar("doc_number"),
	totalAmount: numeric("total_amount", { precision: 18, scale:  2 }).notNull(),
	txnDate: date("txn_date"),
	rawJson: json("raw_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_qbo_journal_entry_staging_migration_job_id").using("btree", table.migrationJobId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_journal_entry_staging_raw_qbo_id").using("btree", table.rawQboId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_journal_entry_staging_realm_id").using("btree", table.realmId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.migrationJobId],
			foreignColumns: [qboMigrationJobs.id],
			name: "qbo_journal_entry_staging_migration_job_id_fkey"
		}),
]);

export const qboBillPaymentStaging = pgTable("qbo_bill_payment_staging", {
	id: varchar().primaryKey().notNull(),
	migrationJobId: varchar("migration_job_id").notNull(),
	realmId: varchar("realm_id").notNull(),
	rawQboId: varchar("raw_qbo_id").notNull(),
	vendorQboId: varchar("vendor_qbo_id"),
	totalAmount: numeric("total_amount", { precision: 18, scale:  2 }).notNull(),
	txnDate: date("txn_date"),
	rawJson: json("raw_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_qbo_bill_payment_staging_migration_job_id").using("btree", table.migrationJobId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_bill_payment_staging_raw_qbo_id").using("btree", table.rawQboId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_bill_payment_staging_realm_id").using("btree", table.realmId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_bill_payment_staging_vendor_qbo_id").using("btree", table.vendorQboId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.migrationJobId],
			foreignColumns: [qboMigrationJobs.id],
			name: "qbo_bill_payment_staging_migration_job_id_fkey"
		}),
]);

export const qboVendorStaging = pgTable("qbo_vendor_staging", {
	id: varchar().primaryKey().notNull(),
	migrationJobId: varchar("migration_job_id").notNull(),
	realmId: varchar("realm_id").notNull(),
	rawQboId: varchar("raw_qbo_id").notNull(),
	displayName: varchar("display_name").notNull(),
	primaryEmail: varchar("primary_email"),
	primaryPhone: varchar("primary_phone"),
	rawJson: json("raw_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_qbo_vendor_staging_migration_job_id").using("btree", table.migrationJobId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_vendor_staging_raw_qbo_id").using("btree", table.rawQboId.asc().nullsLast().op("text_ops")),
	index("ix_qbo_vendor_staging_realm_id").using("btree", table.realmId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.migrationJobId],
			foreignColumns: [qboMigrationJobs.id],
			name: "qbo_vendor_staging_migration_job_id_fkey"
		}),
]);

export const reconciliationPeriods = pgTable("reconciliation_periods", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	accountId: varchar("account_id").notNull(),
	startDate: date("start_date").notNull(),
	endDate: date("end_date").notNull(),
	statementOpeningBalance: numeric("statement_opening_balance", { precision: 14, scale:  2 }),
	statementClosingBalance: numeric("statement_closing_balance", { precision: 14, scale:  2 }),
	ledgerOpeningBalance: numeric("ledger_opening_balance", { precision: 14, scale:  2 }),
	ledgerClosingBalance: numeric("ledger_closing_balance", { precision: 14, scale:  2 }),
	status: reconciliationperiodstatus().notNull(),
	difference: numeric({ precision: 14, scale:  2 }),
	// Plain-language explanation of the reconciliation result (migration 0102).
	aiExplanation: text("ai_explanation"),
	// User force-reconciled this period; engine re-runs keep RECONCILED (0103).
	manuallyReconciled: boolean("manually_reconciled").default(false).notNull(),
	// Hand-started reconciliation (clear-the-transactions model); engine skips it (0104).
	isManual: boolean("is_manual").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	openingStatementBalance: numeric("opening_statement_balance", { precision: 19, scale:  4 }),
	closingStatementBalance: numeric("closing_statement_balance", { precision: 19, scale:  4 }),
	openingLedgerBalance: numeric("opening_ledger_balance", { precision: 19, scale:  4 }),
	closingLedgerBalance: numeric("closing_ledger_balance", { precision: 19, scale:  4 }),
}, (table) => [
	index("idx_reconciliation_periods_account_status").using("btree", table.accountId.asc().nullsLast().op("enum_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("idx_reconciliation_periods_org_account").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.accountId.asc().nullsLast().op("text_ops")),
	index("ix_reconciliation_periods_account_id").using("btree", table.accountId.asc().nullsLast().op("text_ops")),
	index("ix_reconciliation_periods_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	uniqueIndex("uq_reconciliation_periods_org_acct_period").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.accountId.asc().nullsLast().op("text_ops"), table.startDate.asc().nullsLast().op("date_ops"), table.endDate.asc().nullsLast().op("date_ops")),
]);

export const tagCategories = pgTable("tag_categories", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	name: text().notNull(),
	description: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const tagItems = pgTable("tag_items", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	tagType: varchar("tag_type").notNull(),
	name: text().notNull(),
	description: text(),
	linkedEntityType: varchar("linked_entity_type"),
	linkedEntityId: varchar("linked_entity_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const transactionProcessorSourceMappings = pgTable("transaction_processor_source_mappings", {
	source: varchar().primaryKey().notNull(),
	processingMode: varchar("processing_mode").notNull(),
	updatedByUserId: varchar("updated_by_user_id"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	foreignKey({
			columns: [table.updatedByUserId],
			foreignColumns: [users.id],
			name: "transaction_processor_source_mappings_updated_by_user_id_fkey"
		}),
]);

export const userPermissionOverrides = pgTable("user_permission_overrides", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	permissionId: varchar("permission_id").notNull(),
	allow: boolean().notNull(),
}, (table) => [
	index("ix_user_permission_overrides_permission_id").using("btree", table.permissionId.asc().nullsLast().op("text_ops")),
	index("ix_user_permission_overrides_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.permissionId],
			foreignColumns: [permissions.id],
			name: "user_permission_overrides_permission_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "user_permission_overrides_user_id_fkey"
		}).onDelete("cascade"),
	unique("uq_user_permission_override").on(table.userId, table.permissionId),
]);

export const statementLines = pgTable("statement_lines", {
	id: varchar().primaryKey().notNull(),
	reconciliationPeriodId: varchar("reconciliation_period_id").notNull(),
	organizationId: varchar("organization_id").notNull(),
	accountId: varchar("account_id").notNull(),
	statementDate: date("statement_date").notNull(),
	descriptionRaw: text("description_raw"),
	amount: numeric({ precision: 14, scale:  2 }).notNull(),
	runningBalance: numeric("running_balance", { precision: 14, scale:  2 }),
	externalId: varchar("external_id"),
	status: statementlinestatus().notNull(),
	matchedTransactionId: varchar("matched_transaction_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_statement_lines_org_account").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.accountId.asc().nullsLast().op("text_ops")),
	index("idx_statement_lines_period_status").using("btree", table.reconciliationPeriodId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("enum_ops")),
	index("ix_statement_lines_account_id").using("btree", table.accountId.asc().nullsLast().op("text_ops")),
	index("ix_statement_lines_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_statement_lines_reconciliation_period_id").using("btree", table.reconciliationPeriodId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.matchedTransactionId],
			foreignColumns: [transactions.id],
			name: "statement_lines_matched_transaction_id_fkey"
		}),
	foreignKey({
			columns: [table.reconciliationPeriodId],
			foreignColumns: [reconciliationPeriods.id],
			name: "statement_lines_reconciliation_period_id_fkey"
		}),
]);

export const userOnboardingState = pgTable("user_onboarding_state", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	currentStepId: varchar("current_step_id").notNull(),
	completedSteps: jsonb("completed_steps").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_user_onboarding_state_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	unique("uq_user_onboarding_state_user_id").on(table.userId),
]);

export const userPermissionSets = pgTable("user_permission_sets", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	permissionSetId: varchar("permission_set_id").notNull(),
}, (table) => [
	index("ix_user_permission_sets_permission_set_id").using("btree", table.permissionSetId.asc().nullsLast().op("text_ops")),
	index("ix_user_permission_sets_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.permissionSetId],
			foreignColumns: [permissionSets.id],
			name: "user_permission_sets_permission_set_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "user_permission_sets_user_id_fkey"
		}).onDelete("cascade"),
	unique("uq_user_permission_set").on(table.userId, table.permissionSetId),
]);

export const userRoles = pgTable("user_roles", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	roleId: varchar("role_id").notNull(),
}, (table) => [
	index("ix_user_roles_role_id").using("btree", table.roleId.asc().nullsLast().op("text_ops")),
	index("ix_user_roles_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.roleId],
			foreignColumns: [roles.id],
			name: "user_roles_role_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "user_roles_user_id_fkey"
		}).onDelete("cascade"),
	unique("uq_user_role").on(table.userId, table.roleId),
]);

export const userPreferences = pgTable("user_preferences", {
	userId: varchar("user_id").primaryKey().notNull(),
	preferencesJson: text("preferences_json").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_user_preferences_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
]);

export const transactions = pgTable("transactions", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id"),
	date: date().notNull(),
	description: varchar(),
	reference: varchar(),
	amount: doublePrecision(),
	createdAt: timestamp("created_at", { mode: 'string' }),
	accountId: varchar("account_id"),
	contactId: varchar("contact_id"),
	type: varchar(),
	bankDescription: varchar("bank_description"),
	userDescription: varchar("user_description"),
	tagId: varchar("tag_id"),
	categoryType: varchar("category_type"),
	categoryAccountId: varchar("category_account_id"),
	paymentId: varchar("payment_id"),
	journalEntryId: varchar("journal_entry_id"),
	importId: varchar("import_id"),
	reviewed: boolean().default(false),
	// Human-review flag (migration 0137) — true ONLY when a person clicks the
	// reviewed toggle; distinct from `reviewed` (AI auto-confirm + learning signal).
	verified: boolean().notNull().default(false),
	// AI categorization provenance — persisted by server/jobs/auto-categorize.ts
	// so the accountant review queue can show how the category was chosen and
	// how confident the model was, without re-running the model per row.
	// Nullable: rows the categorizer hasn't touched have no provenance.
	aiConfidence: doublePrecision("ai_confidence"),
	aiReason: text("ai_reason"),
	aiSource: varchar("ai_source"),
	aiCategorizedAt: timestamp("ai_categorized_at", { mode: 'string' }),
	// Cross-source de-duplication (migration 0139). 'active' | 'duplicate' | 'kept_both'.
	// A 'duplicate' row has its JE reversed (zero GL) and is hidden from the ledger +
	// reconciliation, surfaced only in the "Removed duplicates" bucket.
	dedupeState: varchar("dedupe_state").notNull().default('active'),
	duplicateOfId: varchar("duplicate_of_id"),
}, (table) => [
	index("ix_transactions_dedupe_state").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.dedupeState.asc().nullsLast().op("text_ops")),
	index("ix_transactions_account_id").using("btree", table.accountId.asc().nullsLast().op("text_ops")),
	index("ix_transactions_category_account_id").using("btree", table.categoryAccountId.asc().nullsLast().op("text_ops")),
	index("ix_transactions_contact_id").using("btree", table.contactId.asc().nullsLast().op("text_ops")),
	index("ix_transactions_id").using("btree", table.id.asc().nullsLast().op("text_ops")),
	index("ix_transactions_import_id").using("btree", table.importId.asc().nullsLast().op("text_ops")),
	index("ix_transactions_journal_entry_id").using("btree", table.journalEntryId.asc().nullsLast().op("text_ops")),
	index("ix_transactions_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_transactions_payment_id").using("btree", table.paymentId.asc().nullsLast().op("text_ops")),
	index("ix_transactions_tag_id").using("btree", table.tagId.asc().nullsLast().op("text_ops")),
	uniqueIndex("ix_transactions_org_reference_uniq")
		.using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.reference.asc().nullsLast().op("text_ops"))
		.where(sql`(reference IS NOT NULL)`),
	foreignKey({
			columns: [table.categoryAccountId],
			foreignColumns: [chartOfAccounts.id],
			name: "transactions_category_account_id_fkey"
		}),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "transactions_contact_id_fkey"
		}),
	foreignKey({
			columns: [table.importId],
			foreignColumns: [imports.id],
			name: "transactions_import_id_fkey"
		}),
]);

export const transactionSubstantiation = pgTable("transaction_substantiation", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	transactionId: varchar("transaction_id").notNull(),
	docType: varchar("doc_type").notNull(),
	status: varchar().default('needed').notNull(),
	fields: jsonb(),
	requestedAt: timestamp("requested_at", { withTimezone: true, mode: 'string' }),
	providedAt: timestamp("provided_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ux_txn_subst_org_txn").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.transactionId.asc().nullsLast().op("text_ops")),
	index("ix_txn_subst_org_status").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
]);

export const transactionSplits = pgTable("transaction_splits", {
	id: varchar().primaryKey().notNull(),
	transactionId: varchar("transaction_id").notNull(),
	organizationId: varchar("organization_id").notNull(),
	categoryAccountId: varchar("category_account_id").notNull(),
	amount: numeric({ precision: 14, scale: 2 }).notNull(),
	memo: text(),
	contactId: varchar("contact_id"),
	intent: varchar(),
	intentTargetId: varchar("intent_target_id"),
	position: integer().default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_transaction_splits_transaction_id").using("btree", table.transactionId.asc().nullsLast().op("text_ops")),
	index("ix_transaction_splits_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_transaction_splits_category_account_id").using("btree", table.categoryAccountId.asc().nullsLast().op("text_ops")),
]);

export const tasks = pgTable("tasks", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	organizationId: varchar("organization_id"),
	product: varchar().notNull(),
	page: varchar(),
	entityId: varchar("entity_id"),
	title: varchar().notNull(),
	description: text(),
	subject: varchar(),
	module: varchar(),
	category: varchar(),
	priority: varchar(),
	dueDate: timestamp("due_date", { withTimezone: true, mode: 'string' }),
	status: taskstatus().notNull(),
	source: varchar(),
	autoCreated: boolean("auto_created"),
	reviewRequired: boolean("review_required"),
	assignedToUsers: json("assigned_to_users").default([]),
	assignedToContacts: json("assigned_to_contacts").default([]),
	entityType: varchar("entity_type"),
	subitems: json().default([]).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	transactionId: varchar("transaction_id"),
}, (table) => [
	index("ix_tasks_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_tasks_product").using("btree", table.product.asc().nullsLast().op("text_ops")),
	index("ix_tasks_status").using("btree", table.status.asc().nullsLast().op("enum_ops")),
	index("ix_tasks_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "tasks_organization_id_fkey"
		}),
]);

export const users = pgTable("users", {
	id: varchar().primaryKey().notNull(),
	email: varchar().notNull(),
	passwordHash: varchar("password_hash").notNull(),
	fullName: varchar("full_name").notNull(),
	isActive: boolean("is_active").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: 'string' }),
	role: varchar().notNull(),
	organizationId: varchar("organization_id"),
	activeOrganizationId: varchar("active_organization_id"),
	welcomeDismissedAt: timestamp("welcome_dismissed_at", { withTimezone: true, mode: 'string' }),
	phone: varchar(),
	smsOptInAt: timestamp("sms_opt_in_at", { withTimezone: true, mode: 'string' }),
	smsOptOutAt: timestamp("sms_opt_out_at", { withTimezone: true, mode: 'string' }),
	// Proactive weekly digest opt-in (migration 0116). NULL = off; set when the
	// user enables it in Settings, cleared on unsubscribe. Owner-only, opt-in.
	weeklyDigestOptInAt: timestamp("weekly_digest_opt_in_at", { withTimezone: true, mode: 'string' }),
	aiThreadContextWindow: integer("ai_thread_context_window"),
	aiVoiceDoc: text("ai_voice_doc"),
	// Signature block appended to outgoing email replies (migration 0080).
	emailSignature: text("email_signature"),
	recorderEnabledAt: timestamp("recorder_enabled_at", { withTimezone: true, mode: 'string' }),
	textsEnabledAt: timestamp("texts_enabled_at", { withTimezone: true, mode: 'string' }),
	// Per-user referral slug (migration 0099). 8-char non-confusable token
	// handed out as <marketing>/?ref=<referral_slug>; minted lazily on first
	// /share. The referral link follows the person across every workspace.
	referralSlug: varchar("referral_slug"),
	// Per-user dashboard layout prefs (migration 0131). jsonb keyed by
	// dashboard name → { order: string[], hidden: string[] }. NULL = the
	// default built-in layout. Private to each user.
	dashboardPrefs: jsonb("dashboard_prefs"),
}, (table) => [
	uniqueIndex("ix_users_email").using("btree", table.email.asc().nullsLast().op("text_ops")),
	uniqueIndex("ix_users_referral_slug")
		.using("btree", table.referralSlug.asc().nullsLast().op("text_ops"))
		.where(sql`${table.referralSlug} IS NOT NULL`),
]);

export const oauthConnections = pgTable("oauth_connections", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	provider: varchar().notNull(),
	accountEmail: text("account_email").notNull(),
	scope: text().notNull(),
	encryptedAccessToken: text("encrypted_access_token").notNull(),
	accessIv: text("access_iv").notNull(),
	accessAuthTag: text("access_auth_tag").notNull(),
	encryptedRefreshToken: text("encrypted_refresh_token"),
	refreshIv: text("refresh_iv"),
	refreshAuthTag: text("refresh_auth_tag"),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	connectionStatus: varchar("connection_status").default('unknown').notNull(),
	connectionError: text("connection_error"),
	lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: 'string' }),
	calendarSyncToken: text("calendar_sync_token"),
	calendarSyncTokenUpdatedAt: timestamp("calendar_sync_token_updated_at", { withTimezone: true, mode: 'string' }),
	connectedAt: timestamp("connected_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ux_oauth_connections_user_provider_account").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.provider.asc().nullsLast().op("text_ops"), table.accountEmail.asc().nullsLast().op("text_ops")),
	index("ix_oauth_connections_user_provider").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.provider.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "oauth_connections_user_id_fkey"
		}).onDelete("cascade"),
]);

export const appointments = pgTable("appointments", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	organizationId: varchar("organization_id").notNull(),
	contactId: varchar("contact_id"),
	title: varchar().notNull(),
	description: text(),
	startsAt: timestamp("starts_at", { withTimezone: true, mode: 'string' }).notNull(),
	endsAt: timestamp("ends_at", { withTimezone: true, mode: 'string' }),
	location: text(),
	source: varchar().default('manual').notNull(),
	googleEventId: text("google_event_id"),
	bookingEventTypeId: varchar("booking_event_type_id"),
	bookerName: varchar("booker_name"),
	bookerEmail: varchar("booker_email"),
	bookerPhone: varchar("booker_phone"),
	videoEnabled: boolean("video_enabled"),
	guestEmails: text("guest_emails"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_appointments_user_id_starts_at").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.startsAt.asc().nullsLast().op("timestamptz_ops")),
	index("ix_appointments_organization_id_starts_at").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.startsAt.asc().nullsLast().op("timestamptz_ops")),
	index("ix_appointments_contact_id_starts_at").using("btree", table.contactId.asc().nullsLast().op("text_ops"), table.startsAt.asc().nullsLast().op("timestamptz_ops")),
	uniqueIndex("ux_appointments_user_google_event").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.googleEventId.asc().nullsLast().op("text_ops")).where(sql`${table.googleEventId} IS NOT NULL`),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "appointments_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "appointments_organization_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "appointments_contact_id_fkey"
		}).onDelete("set null"),
]);

export const inboxMessages = pgTable("inbox_messages", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	organizationId: varchar("organization_id").notNull(),
	contactId: varchar("contact_id"),
	emailAccountId: varchar("email_account_id"),
	source: varchar().notNull(),
	fromAddress: text("from_address").notNull(),
	fromName: text("from_name"),
	subject: text(),
	body: text().notNull(),
	bodyHtml: text("body_html"),
	receivedAt: timestamp("received_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	status: varchar().default('open').notNull(),
	triagedAt: timestamp("triaged_at", { withTimezone: true, mode: 'string' }),
	externalId: text("external_id"),
	threadId: text("thread_id"),
	aiStatus: text("ai_status"),
	aiDraftSubject: text("ai_draft_subject"),
	aiDraftHtml: text("ai_draft_html"),
	aiDraftText: text("ai_draft_text"),
	aiModel: text("ai_model"),
	aiDraftedAt: timestamp("ai_drafted_at", { withTimezone: true, mode: 'string' }),
	aiSkipReason: text("ai_skip_reason"),
	sentMessageId: text("sent_message_id"),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ux_inbox_messages_user_external").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.externalId.asc().nullsLast().op("text_ops")).where(sql`${table.externalId} IS NOT NULL`),
	index("ix_inbox_messages_user_status_received").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops"), table.receivedAt.desc().nullsLast().op("timestamptz_ops")),
	index("ix_inbox_messages_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_inbox_messages_contact_id_received").using("btree", table.contactId.asc().nullsLast().op("text_ops"), table.receivedAt.desc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "inbox_messages_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "inbox_messages_organization_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "inbox_messages_contact_id_fkey"
		}).onDelete("set null"),
]);

export const notes = pgTable("notes", {
	id: varchar().primaryKey().notNull(),
	userId: varchar("user_id").notNull(),
	organizationId: varchar("organization_id").notNull(),
	contactId: varchar("contact_id"),
	appointmentId: varchar("appointment_id"),
	body: text().notNull(),
	source: varchar().default('manual').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_notes_user_id_created_at").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsLast().op("timestamptz_ops")),
	index("ix_notes_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_notes_contact_id_created_at").using("btree", table.contactId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "notes_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "notes_organization_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "notes_contact_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.appointmentId],
			foreignColumns: [appointments.id],
			name: "notes_appointment_id_fkey"
		}).onDelete("set null"),
	index("ix_notes_appointment_id").using("btree", table.appointmentId.asc().nullsLast().op("text_ops")).where(sql`appointment_id IS NOT NULL`),
]);

export const goalProgress = pgTable("goal_progress", {
	id: varchar().primaryKey().notNull(),
	goalId: varchar("goal_id").notNull(),
	amount: numeric({ precision: 12, scale:  2 }).notNull(),
	date: date().notNull(),
	source: varchar().notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).notNull(),
}, (table) => [
	index("ix_goal_progress_goal_id").using("btree", table.goalId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.goalId],
			foreignColumns: [goals.id],
			name: "goal_progress_goal_id_fkey"
		}),
]);

export const openingBalanceLines = pgTable("opening_balance_lines", {
	id: serial().primaryKey().notNull(),
	batchId: integer("batch_id"),
	accountId: integer("account_id"),
	amount: doublePrecision(),
	createdAt: timestamp("created_at", { mode: 'string' }),
}, (table) => [
	index("ix_opening_balance_lines_account_id").using("btree", table.accountId.asc().nullsLast().op("int4_ops")),
	index("ix_opening_balance_lines_id").using("btree", table.id.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.batchId],
			foreignColumns: [openingBalanceBatches.id],
			name: "opening_balance_lines_batch_id_fkey"
		}),
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const payrollBenefitEnrollments: any = pgTable("payroll_benefit_enrollments", {
	id: varchar().primaryKey().notNull(),
	employeeId: varchar("employee_id").notNull(),
	benefitType: varchar("benefit_type").notNull(),
	contributionAmount: numeric("contribution_amount", { precision: 10, scale:  2 }).default('0.00').notNull(),
	employerContribution: numeric("employer_contribution", { precision: 10, scale:  2 }).default('0.00'),
	notes: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.employeeId],
			foreignColumns: [payrollEmployees.id],
			name: "payroll_benefit_enrollments_employee_id_fkey"
		}),
]);

export const permissionSetPermissions = pgTable("permission_set_permissions", {
	id: varchar().primaryKey().notNull(),
	permissionSetId: varchar("permission_set_id").notNull(),
	permissionId: varchar("permission_id").notNull(),
}, (table) => [
	index("ix_permission_set_permissions_permission_id").using("btree", table.permissionId.asc().nullsLast().op("text_ops")),
	index("ix_permission_set_permissions_permission_set_id").using("btree", table.permissionSetId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.permissionId],
			foreignColumns: [permissions.id],
			name: "permission_set_permissions_permission_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.permissionSetId],
			foreignColumns: [permissionSets.id],
			name: "permission_set_permissions_permission_set_id_fkey"
		}).onDelete("cascade"),
	unique("uq_permission_set_permission").on(table.permissionSetId, table.permissionId),
]);

export const reconciliationMatches = pgTable("reconciliation_matches", {
	id: varchar().primaryKey().notNull(),
	reconciliationPeriodId: varchar("reconciliation_period_id").notNull(),
	statementLineId: varchar("statement_line_id").notNull(),
	transactionId: varchar("transaction_id").notNull(),
	matchType: reconciliationmatchtype("match_type").notNull(),
	score: doublePrecision(),
	createdBy: varchar("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_reconciliation_matches_statement_line_id").using("btree", table.statementLineId.asc().nullsLast().op("text_ops")),
	index("ix_reconciliation_matches_transaction_id").using("btree", table.transactionId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.reconciliationPeriodId],
			foreignColumns: [reconciliationPeriods.id],
			name: "reconciliation_matches_reconciliation_period_id_fkey"
		}),
	foreignKey({
			columns: [table.statementLineId],
			foreignColumns: [statementLines.id],
			name: "reconciliation_matches_statement_line_id_fkey"
		}),
	foreignKey({
			columns: [table.transactionId],
			foreignColumns: [transactions.id],
			name: "reconciliation_matches_transaction_id_fkey"
		}),
]);

// Platform-subscription billing catalog. Super-admin defines a row per
// purchasable thing (base seat, current-year unlock, prior-year unlocks).
// The Stripe Price ID is the source of truth for price; this table maps it
// to the feature key that gates access in code. Unique on (feature_key,
// period_year) so you can't create two "Prior Year 2024" rows.
export const billingProducts = pgTable("billing_products", {
	id: varchar().primaryKey().notNull(),
	name: varchar({ length: 255 }).notNull(),
	description: text(),
	kind: varchar().notNull(),
	featureKey: varchar("feature_key").notNull(),
	periodYear: integer("period_year"),
	stripeProductId: varchar("stripe_product_id"),
	stripePriceId: varchar("stripe_price_id"),
	unitAmountCents: integer("unit_amount_cents").notNull(),
	currency: varchar({ length: 3 }).default('usd').notNull(),
	active: boolean().default(true).notNull(),
	createdByUserId: varchar("created_by_user_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_billing_products_feature_year").using("btree", table.featureKey.asc().nullsLast().op("text_ops"), sql`coalesce(${table.periodYear}, 0)`),
	index("ix_billing_products_stripe_price_id").using("btree", table.stripePriceId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "billing_products_created_by_user_id_fkey"
		}),
]);

// Append-only Stripe webhook audit log. Dedupe via stripe_event_id unique
// index — Stripe retries the same event multiple times and the handler must
// be idempotent. PR-1 just records; later PRs read back to drive state.
export const billingEvents = pgTable("billing_events", {
	id: varchar().primaryKey().notNull(),
	stripeEventId: varchar("stripe_event_id").notNull(),
	type: varchar().notNull(),
	payload: jsonb().notNull(),
	receivedAt: timestamp("received_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	processedAt: timestamp("processed_at", { withTimezone: true, mode: 'string' }),
	error: text(),
}, (table) => [
	uniqueIndex("ix_billing_events_stripe_event_id").using("btree", table.stripeEventId.asc().nullsLast().op("text_ops")),
	index("ix_billing_events_type").using("btree", table.type.asc().nullsLast().op("text_ops")),
]);

// Per-org Stripe customer + aggregate billing state. One row per org that
// has ever opened the billing flow. status is the read-once value used by
// the lockout helper (added in PR-2 Phase B). When an org has no row, it's
// treated as inactive — no enforcement until they opt in.
export const organizationBilling = pgTable("organization_billing", {
	organizationId: varchar("organization_id").primaryKey().notNull(),
	payingPartyUserId: varchar("paying_party_user_id"),
	stripeCustomerId: varchar("stripe_customer_id"),
	status: varchar().default('inactive').notNull(),
	currentPeriodEnd: timestamp("current_period_end", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_organization_billing_stripe_customer_id").using("btree", table.stripeCustomerId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "organization_billing_organization_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.payingPartyUserId],
			foreignColumns: [users.id],
			name: "organization_billing_paying_party_user_id_fkey"
		}),
]);

// One row per Stripe subscription on an org. PR-2 only creates the base
// $89/mo subscription per org, but the table is plural so add-ons land
// here without a schema change.
export const organizationSubscriptions = pgTable("organization_subscriptions", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	billingProductId: varchar("billing_product_id").notNull(),
	stripeSubscriptionId: varchar("stripe_subscription_id").notNull(),
	status: varchar().notNull(),
	currentPeriodStart: timestamp("current_period_start", { withTimezone: true, mode: 'string' }),
	currentPeriodEnd: timestamp("current_period_end", { withTimezone: true, mode: 'string' }),
	cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_organization_subscriptions_stripe_subscription_id").using("btree", table.stripeSubscriptionId.asc().nullsLast().op("text_ops")),
	index("ix_organization_subscriptions_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "organization_subscriptions_organization_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.billingProductId],
			foreignColumns: [billingProducts.id],
			name: "organization_subscriptions_billing_product_id_fkey"
		}),
]);

// Firm arrears billing ledger: one row per (enterprise, month) the firm-pays cron
// has invoiced. The UNIQUE(enterprise, year, month) is the idempotency key so a
// re-run never double-bills. Written by lib/stripe/firm-arrears.ts.
export const firmArrearsInvoices = pgTable("firm_arrears_invoices", {
	id: varchar().primaryKey().notNull(),
	enterpriseId: varchar("enterprise_id").notNull(),
	periodYear: integer("period_year").notNull(),
	periodMonth: integer("period_month").notNull(),
	stripeInvoiceId: varchar("stripe_invoice_id"),
	clientCount: integer("client_count").default(0).notNull(),
	amountCents: integer("amount_cents").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("uq_firm_arrears_invoices_period").on(table.enterpriseId, table.periodYear, table.periodMonth),
]);

// Per-call AI usage log. One row per provider request (chat/completion or
// realtime session). Written fire-and-forget from the AI wrappers so the
// request path is not delayed by the insert.
export const aiUsageEvents = pgTable("ai_usage_events", {
	id: varchar().primaryKey().notNull(),
	orgId: varchar("org_id"),
	userId: varchar("user_id"),
	actor: varchar().notNull(),
	feature: varchar().notNull(),
	provider: varchar().notNull(),
	model: varchar().notNull(),
	promptTokens: integer("prompt_tokens").notNull().default(0),
	completionTokens: integer("completion_tokens").notNull().default(0),
	cachedPromptTokens: integer("cached_prompt_tokens").notNull().default(0),
	totalTokens: integer("total_tokens").notNull().default(0),
	costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
	latencyMs: integer("latency_ms"),
	requestId: varchar("request_id"),
	metadata: jsonb(),
	// Generalizing columns (migration 0100): this table is now the unified
	// per-use cost ledger, not just LLM tokens. `category`/`unit` describe the
	// billable unit; `quantity` holds the unit count (tokens mirrored here for
	// LLM rows so a single column sums across services).
	category: varchar(),
	quantity: numeric("quantity", { precision: 14, scale: 4 }),
	unit: varchar(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_ai_usage_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	index("ix_ai_usage_org_id").using("btree", table.orgId.asc().nullsLast().op("text_ops")),
	index("ix_ai_usage_created_at").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("ix_ai_usage_feature").using("btree", table.feature.asc().nullsLast().op("text_ops")),
	index("ix_ai_usage_model").using("btree", table.model.asc().nullsLast().op("text_ops")),
	index("ix_ai_usage_category").using("btree", table.category.asc().nullsLast().op("text_ops")),
	index("ix_ai_usage_provider").using("btree", table.provider.asc().nullsLast().op("text_ops")),
]);

// Editable per-unit rate card for non-token paid services (migration 0100).
// recordServiceUsage() looks up a rate by `key` and computes
// cost = quantity * rateUsd. LLM token pricing lives in lib/ai/usage.ts.
export const usageRates = pgTable("usage_rates", {
	key: varchar().primaryKey().notNull(),
	provider: varchar().notNull(),
	label: varchar().notNull(),
	unit: varchar().notNull(),
	rateUsd: numeric("rate_usd", { precision: 14, scale: 8 }).notNull().default('0'),
	notes: varchar(),
	updatedBy: varchar("updated_by"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

// Per-enterprise allowlist of gated (custom-SKU) billing products visible to
// that enterprise's client orgs on /billing (migration 0101). One row per
// (enterprise, product). Built-in products keep their global visibility and are
// never listed here.
export const enterpriseClientProducts = pgTable("enterprise_client_products", {
	id: varchar().primaryKey().notNull(),
	enterpriseId: varchar("enterprise_id").notNull(),
	billingProductId: varchar("billing_product_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_ent_client_products_unique").using("btree", table.enterpriseId.asc().nullsLast().op("text_ops"), table.billingProductId.asc().nullsLast().op("text_ops")),
	index("ix_ent_client_products_enterprise").using("btree", table.enterpriseId.asc().nullsLast().op("text_ops")),
]);

// Per-org historical period unlocks (PR-3). One row per (org, year). The
// SKU sold is captured for analytics but the lookup that gates writes only
// looks at period_year — current_year_unlock and prior_year purchases
// produce equivalent entitlements once paid for.
export const organizationEntitlements = pgTable("organization_entitlements", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	periodYear: integer("period_year").notNull(),
	billingProductId: varchar("billing_product_id").notNull(),
	stripePaymentIntentId: varchar("stripe_payment_intent_id"),
	stripeCheckoutSessionId: varchar("stripe_checkout_session_id"),
	unitAmountCents: integer("unit_amount_cents").notNull(),
	currency: varchar({ length: 3 }).default('usd').notNull(),
	grantedAt: timestamp("granted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_organization_entitlements_organization_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "organization_entitlements_organization_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.billingProductId],
			foreignColumns: [billingProducts.id],
			name: "organization_entitlements_billing_product_id_fkey"
		}),
]);

// Per-billing-period revenue share owed to an enterprise partner for one
// of its client companies. One row per (client_organization, billing
// period). The is_within_cap flag captures whether the client was inside
// the tier's included-companies cap at the time the row was written —
// pre-cap rows record the full partner share ($50); post-cap rows record
// the split share ($25). The platform's share is implicit:
// client_price_cents - partner_share_cents.
//
// Payouts (Stripe Connect transfers, manual ACH, etc.) are NOT wired up;
// this table is the ledger that a future payout job will read.
export const enterpriseClientRevenueShare = pgTable("enterprise_client_revenue_share", {
	id: varchar().primaryKey().notNull(),
	enterpriseId: varchar("enterprise_id").notNull(),
	clientOrganizationId: varchar("client_organization_id").notNull(),
	clientSubscriptionId: varchar("client_subscription_id"),
	enterpriseTier: varchar("enterprise_tier").notNull(),
	billingPeriodStart: timestamp("billing_period_start", { withTimezone: true, mode: 'string' }).notNull(),
	billingPeriodEnd: timestamp("billing_period_end", { withTimezone: true, mode: 'string' }).notNull(),
	clientPriceCents: integer("client_price_cents").notNull(),
	partnerShareCents: integer("partner_share_cents").notNull(),
	isWithinCap: boolean("is_within_cap").notNull(),
	clientIndexAtWrite: integer("client_index_at_write").notNull(),
	currency: varchar({ length: 3 }).default('usd').notNull(),
	paidOutAt: timestamp("paid_out_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_enterprise_client_rev_share_client_period")
		.using("btree", table.clientOrganizationId.asc().nullsLast().op("text_ops"), table.billingPeriodStart.asc().nullsLast().op("timestamptz_ops")),
	index("ix_enterprise_client_rev_share_enterprise_id")
		.using("btree", table.enterpriseId.asc().nullsLast().op("text_ops")),
	index("ix_enterprise_client_rev_share_unpaid")
		.using("btree", table.enterpriseId.asc().nullsLast().op("text_ops"))
		.where(sql`${table.paidOutAt} IS NULL`),
	foreignKey({
			columns: [table.enterpriseId],
			foreignColumns: [organizations.id],
			name: "enterprise_client_rev_share_enterprise_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.clientOrganizationId],
			foreignColumns: [organizations.id],
			name: "enterprise_client_rev_share_client_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.clientSubscriptionId],
			foreignColumns: [organizationSubscriptions.id],
			name: "enterprise_client_rev_share_subscription_id_fkey"
		}).onDelete("set null"),
]);

// Per-user referral earnings ledger (migration 0099). One row per referred
// client org per billing period; flat referrer_share_cents (no cap). Mirrors
// enterprise_client_revenue_share but keyed on the referring user. The unique
// index on (referred_organization_id, billing_period_start) makes retried
// Stripe webhooks idempotent.
export const userReferralRevenueShare = pgTable("user_referral_revenue_share", {
	id: varchar().primaryKey().notNull(),
	referrerUserId: varchar("referrer_user_id").notNull(),
	referredOrganizationId: varchar("referred_organization_id").notNull(),
	referredSubscriptionId: varchar("referred_subscription_id"),
	billingPeriodStart: timestamp("billing_period_start", { withTimezone: true, mode: 'string' }).notNull(),
	billingPeriodEnd: timestamp("billing_period_end", { withTimezone: true, mode: 'string' }).notNull(),
	clientPriceCents: integer("client_price_cents").notNull(),
	referrerShareCents: integer("referrer_share_cents").notNull(),
	currency: varchar({ length: 3 }).default('usd').notNull(),
	paidOutAt: timestamp("paid_out_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_user_referral_rev_share_org_period")
		.using("btree", table.referredOrganizationId.asc().nullsLast().op("text_ops"), table.billingPeriodStart.asc().nullsLast().op("timestamptz_ops")),
	index("ix_user_referral_rev_share_referrer")
		.using("btree", table.referrerUserId.asc().nullsLast().op("text_ops")),
	index("ix_user_referral_rev_share_unpaid")
		.using("btree", table.referrerUserId.asc().nullsLast().op("text_ops"))
		.where(sql`${table.paidOutAt} IS NULL`),
	foreignKey({
			columns: [table.referrerUserId],
			foreignColumns: [users.id],
			name: "user_referral_rev_share_referrer_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.referredOrganizationId],
			foreignColumns: [organizations.id],
			name: "user_referral_rev_share_referred_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.referredSubscriptionId],
			foreignColumns: [organizationSubscriptions.id],
			name: "user_referral_rev_share_subscription_id_fkey"
		}).onDelete("set null"),
]);

// Per-org PFC→CoA override. Written by aiMapPfcToCoa after a QB sync to
// pin each Plaid Personal Finance Category to a specific QB-imported
// (or un-hidden seed) row, replacing the static slot lookup in
// pfc-coa-mapping.ts for orgs that have customized their CoA via QB.
// resolve-pfc-coa.ts checks this table first; falls back to the slot
// lookup for orgs without overrides.
export const pfcOrgOverrides = pgTable("pfc_org_overrides", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	pfcDetailed: varchar("pfc_detailed").notNull(),
	categoryAccountId: varchar("category_account_id").notNull(),
	source: varchar().notNull(),
	confidence: numeric({ precision: 3, scale: 2 }),
	reasoning: text(),
	aiModel: varchar("ai_model"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_pfc_org_overrides_org_pfc").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.pfcDetailed.asc().nullsLast().op("text_ops")),
	index("ix_pfc_org_overrides_coa").using("btree", table.categoryAccountId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "pfc_org_overrides_org_fkey"
		}),
	foreignKey({
			columns: [table.categoryAccountId],
			foreignColumns: [chartOfAccounts.id],
			name: "pfc_org_overrides_coa_fkey"
		}),
]);

// Beneficial-trust accounting foundation (see migration 0034).
//
// organizationAccountingFeatures: per-(org, feature_pack) toggle row.
// Tall-schema sibling of qboMirrorSettings — new packs (business_trust,
// nonprofit, …) ship as new rows, not new columns.
export const organizationAccountingFeatures = pgTable("organization_accounting_features", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	featurePack: varchar("feature_pack", { length: 64 }).notNull(),
	enabled: boolean().default(false).notNull(),
	config: jsonb(),
	enabledAt: timestamp("enabled_at", { withTimezone: true, mode: 'string' }),
	enabledByUserId: varchar("enabled_by_user_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_org_acct_features_org_pack").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.featurePack.asc().nullsLast().op("text_ops")),
	index("ix_org_acct_features_enabled").using("btree", table.featurePack.asc().nullsLast().op("text_ops")).where(sql`enabled = true`),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "organization_accounting_features_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.enabledByUserId],
			foreignColumns: [users.id],
			name: "organization_accounting_features_user_id_fkey"
		}),
]);

// trustBeneficiaries: roster for any trust-type org. dateOfBirth +
// isIncapacitated are read by the Phase 4 posting rules to enforce 815/820
// (Food/Clothing) eligibility — those accounts can only post if the
// recipient beneficiary is under 21 OR incapacitated.
export const trustBeneficiaries = pgTable("trust_beneficiaries", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	fullName: varchar("full_name").notNull(),
	dateOfBirth: date("date_of_birth"),
	isIncapacitated: boolean("is_incapacitated").default(false).notNull(),
	/** Date the is_incapacitated flag was most recently set TRUE. Null when
	 *  there is no incapacitation history on record. The 815/820 qualifying
	 *  check uses this against the JE date so historical posts stay valid. */
	incapacitatedSince: date("incapacitated_since"),
	/** Date the is_incapacitated flag was most recently set FALSE after
	 *  having been TRUE. Null while still incapacitated (or never been). */
	notIncapacitatedSince: date("not_incapacitated_since"),
	relationship: varchar(),
	legalGuardianContactId: varchar("legal_guardian_contact_id"),
	notes: text(),
	demandNoteAccountId: varchar("demand_note_account_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_trust_beneficiaries_org_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "trust_beneficiaries_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.demandNoteAccountId],
			foreignColumns: [chartOfAccounts.id],
			name: "trust_beneficiaries_demand_note_account_id_fkey"
		}),
	foreignKey({
			columns: [table.legalGuardianContactId],
			foreignColumns: [contacts.id],
			name: "trust_beneficiaries_legal_guardian_contact_id_fkey"
		}),
]);

/**
 * One-to-one with `organizations` when the beneficial-trust feature
 * pack is enabled. Stores the metadata the resolution-generation
 * pipeline needs to populate templates (trust name, effective date,
 * governing state, grantor, default signing authority, etc.).
 *
 * Created lazily — the first time the UI hits a state-sensitive doc
 * or the user opens /trust-documents. See migration
 * 0042_trust_documentation_foundations.sql.
 */
export const trustMetadata = pgTable("trust_metadata", {
	organizationId: varchar("organization_id").primaryKey().notNull(),
	trustName: varchar("trust_name"),
	effectiveDate: date("effective_date"),
	governingState: varchar("governing_state"),
	situsState: varchar("situs_state"),
	ein: varchar(),
	/** 'MM-DD' string — '12-31' for the common calendar-year case. */
	fiscalYearEnd: varchar("fiscal_year_end"),
	grantorName: varchar("grantor_name"),
	grantorContactId: varchar("grantor_contact_id"),
	/** Trust-wide rule for action approval. Per-trustee overrides could
	 *  be added later if the instrument carves out specific roles.
	 *    sole       — any single trustee may act
	 *    majority   — majority of trustees must consent
	 *    unanimous  — all trustees must consent */
	defaultSigningAuthority: varchar("default_signing_authority"),
	/** Pointer to the uploaded trust-instrument doc once we have the
	 *  document_records integration in Phase 1. */
	trustAgreementDocId: varchar("trust_agreement_doc_id"),
	notes: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "trust_metadata_org_id_fkey"
		}),
	foreignKey({
			columns: [table.grantorContactId],
			foreignColumns: [contacts.id],
			name: "trust_metadata_grantor_contact_id_fkey"
		}),
]);

// fixed_assets system: register + per-book depreciation + run audit.
// See db/migrations/0038_fixed_assets.sql for the architectural rationale.
export const assetCategories = pgTable("asset_categories", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	name: varchar().notNull(),
	assetAccountId: varchar("asset_account_id").notNull(),
	accumulatedDepAccountId: varchar("accumulated_dep_account_id").notNull(),
	depExpenseAccountId: varchar("dep_expense_account_id").notNull(),
	defaultMethod: varchar("default_method").default('straight_line').notNull(),
	defaultUsefulLifeMonths: integer("default_useful_life_months").default(60).notNull(),
	defaultSalvagePct: numeric("default_salvage_pct", { precision: 5, scale: 2 }).default('0').notNull(),
	defaultAutoDepreciate: boolean("default_auto_depreciate").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const fixedAssets = pgTable("fixed_assets", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	categoryId: varchar("category_id").notNull(),
	name: varchar().notNull(),
	assetNumber: varchar("asset_number"),
	serialNumber: varchar("serial_number"),
	location: varchar(),
	notes: text(),
	/** draft | active | disposed */
	status: varchar().default('draft').notNull(),
	/** purchased | inherited | exchanged_1031 | contributed */
	acquisitionType: varchar("acquisition_type").default('purchased').notNull(),
	inServiceDate: date("in_service_date").notNull(),
	costBasis: numeric("cost_basis", { precision: 15, scale: 2 }).notNull(),
	fmvAtDod: numeric("fmv_at_dod", { precision: 15, scale: 2 }),
	alternateValuationDate: date("alternate_valuation_date"),
	replacedAssetId: varchar("replaced_asset_id"),
	carryoverBasis: numeric("carryover_basis", { precision: 15, scale: 2 }),
	excessBasis: numeric("excess_basis", { precision: 15, scale: 2 }),
	parentAssetId: varchar("parent_asset_id"),
	salvageValue: numeric("salvage_value", { precision: 15, scale: 2 }).default('0').notNull(),
	autoDepreciate: boolean("auto_depreciate").default(false).notNull(),
	sourceTransactionId: varchar("source_transaction_id"),
	disposedAt: date("disposed_at"),
	disposalProceeds: numeric("disposal_proceeds", { precision: 15, scale: 2 }),
	disposalFees: numeric("disposal_fees", { precision: 15, scale: 2 }),
	disposalJournalEntryId: varchar("disposal_journal_entry_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const assetBooks = pgTable("asset_books", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	assetId: varchar("asset_id").notNull(),
	/** 'fiduciary' | 'tax' */
	bookType: varchar("book_type").notNull(),
	method: varchar().notNull(),
	usefulLifeMonths: integer("useful_life_months").notNull(),
	convention: varchar().default('half_year').notNull(),
	accumulatedDepreciation: numeric("accumulated_depreciation", { precision: 15, scale: 2 }).default('0').notNull(),
	accumulatedThroughDate: date("accumulated_through_date"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const assetDepreciationRuns = pgTable("asset_depreciation_runs", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	bookType: varchar("book_type").notNull(),
	periodStartDate: date("period_start_date").notNull(),
	periodEndDate: date("period_end_date").notNull(),
	journalEntryId: varchar("journal_entry_id").notNull(),
	/** manual | cron */
	triggeredBy: varchar("triggered_by").notNull(),
	triggeredByUserId: varchar("triggered_by_user_id"),
	assetsIncluded: integer("assets_included").default(0).notNull(),
	totalExpense: numeric("total_expense", { precision: 15, scale: 2 }).default('0').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const assetSettings = pgTable("asset_settings", {
	organizationId: varchar("organization_id").primaryKey().notNull(),
	defaultAutoDepreciate: boolean("default_auto_depreciate").default(false).notNull(),
	cronEnabled: boolean("cron_enabled").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

// loans: header for every note payable held by the trust. Each loan
// points at a 250.x liability sub-account in the chart_of_accounts (251
// Mortgage, 252 Auto, etc.). The amortization schedule rows below drive
// the principal/interest split on each payment.
export const loans = pgTable("loans", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	liabilityAccountId: varchar("liability_account_id").notNull(),
	interestExpenseAccountId: varchar("interest_expense_account_id"),
	lenderContactId: varchar("lender_contact_id"),
	displayName: varchar("display_name").notNull(),
	originalPrincipal: numeric("original_principal", { precision: 14, scale: 2 }).notNull(),
	currentPrincipal: numeric("current_principal", { precision: 14, scale: 2 }).notNull(),
	annualInterestRate: numeric("annual_interest_rate", { precision: 8, scale: 5 }).notNull(),
	termMonths: integer("term_months").notNull(),
	paymentAmount: numeric("payment_amount", { precision: 14, scale: 2 }),
	firstPaymentDate: date("first_payment_date"),
	startDate: date("start_date").notNull(),
	status: varchar({ length: 16 }).default('active').notNull(),
	noteDocumentUrl: varchar("note_document_url"),
	/** Optional FK to fixed_assets.id — populated for purchase-money loans
	 *  (mortgage on a building, auto loan on a vehicle). ON DELETE SET
	 *  NULL so disposing the asset leaves the loan record intact. */
	collateralAssetId: varchar("collateral_asset_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_loans_org_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_loans_liability_account_id").using("btree", table.liabilityAccountId.asc().nullsLast().op("text_ops")),
	index("ix_loans_org_active").using("btree", table.organizationId.asc().nullsLast().op("text_ops")).where(sql`status = 'active'`),
	index("ix_loans_collateral_asset_id").using("btree", table.collateralAssetId.asc().nullsLast().op("text_ops")).where(sql`collateral_asset_id IS NOT NULL`),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "loans_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.liabilityAccountId],
			foreignColumns: [chartOfAccounts.id],
			name: "loans_liability_account_id_fkey"
		}),
	foreignKey({
			columns: [table.interestExpenseAccountId],
			foreignColumns: [chartOfAccounts.id],
			name: "loans_interest_expense_account_id_fkey"
		}),
	foreignKey({
			columns: [table.lenderContactId],
			foreignColumns: [contacts.id],
			name: "loans_lender_contact_id_fkey"
		}),
]);

// loanAmortizationSchedules: one row per scheduled payment. postedJournalEntryId
// is set when the payment posts, allowing the rules engine to consume the next
// open schedule row and detect missed/duplicated payments.
export const loanAmortizationSchedules = pgTable("loan_amortization_schedules", {
	id: varchar().primaryKey().notNull(),
	loanId: varchar("loan_id").notNull(),
	paymentNumber: integer("payment_number").notNull(),
	dueDate: date("due_date").notNull(),
	principalAmount: numeric("principal_amount", { precision: 14, scale: 2 }).notNull(),
	interestAmount: numeric("interest_amount", { precision: 14, scale: 2 }).notNull(),
	remainingBalance: numeric("remaining_balance", { precision: 14, scale: 2 }).notNull(),
	postedJournalEntryId: varchar("posted_journal_entry_id"),
	postedAt: timestamp("posted_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ix_loan_amort_loan_payment_num").using("btree", table.loanId.asc().nullsLast().op("text_ops"), table.paymentNumber.asc().nullsLast().op("int4_ops")),
	index("ix_loan_amort_due_date").using("btree", table.dueDate.asc().nullsLast().op("date_ops")).where(sql`posted_journal_entry_id IS NULL`),
	foreignKey({
			columns: [table.loanId],
			foreignColumns: [loans.id],
			name: "loan_amortization_schedules_loan_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.postedJournalEntryId],
			foreignColumns: [journalEntries.id],
			name: "loan_amortization_schedules_posted_je_id_fkey"
		}),
]);

// rentalProperties: per-property sub-ledger header. assetAccountId points
// at the property's 125/126 sub-account in chart_of_accounts. The per-line
// property tag lives on journal_entry_lines.rentalPropertyId — net rental
// income for each property = sum of income lines − sum of expense lines
// scoped to that property_id, posted to 430.
/**
 * User-defined tag dimensions. Slug is the entity_type stored on
 * journal_entry_line_tags (alongside the hardcoded system slugs like
 * 'rental_property'). Each dimension has its own value list — see
 * tagDimensionValues below.
 */
export const tagDimensions = pgTable("tag_dimensions", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	/** Stored as entity_type on journal_entry_line_tags. Lowercased,
	 *  url-safe (a-z 0-9 _-). Org-unique. */
	slug: varchar().notNull(),
	label: varchar().notNull(),
	emoji: varchar({ length: 8 }),
	sortOrder: integer("sort_order").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_tag_dimensions_org_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	foreignKey({
		columns: [table.organizationId],
		foreignColumns: [organizations.id],
		name: "tag_dimensions_org_id_fkey",
	}).onDelete("cascade"),
	unique("tag_dimensions_org_slug_unique").on(table.organizationId, table.slug),
]);

export const tagDimensionValues = pgTable("tag_dimension_values", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	dimensionId: varchar("dimension_id").notNull(),
	label: varchar().notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
	/** Soft-archived values hide from new pickers but keep historical
	 *  tags intact. */
	archivedAt: timestamp("archived_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_tag_dimension_values_org_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_tag_dimension_values_dim_id").using("btree", table.dimensionId.asc().nullsLast().op("text_ops")),
	foreignKey({
		columns: [table.organizationId],
		foreignColumns: [organizations.id],
		name: "tag_dimension_values_org_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.dimensionId],
		foreignColumns: [tagDimensions.id],
		name: "tag_dimension_values_dim_id_fkey",
	}).onDelete("cascade"),
	unique("tag_dimension_values_dim_label_unique").on(table.dimensionId, table.label),
]);

/**
 * Polymorphic per-line tag store. Replaces the typed
 * journal_entry_lines.rental_property_id and fixed_asset_id columns
 * with one (entity_type, entity_id) shape so any tag dimension
 * (rental property, fixed asset, loan, future class/location) can
 * attach without a schema change per dimension.
 *
 * UNIQUE (line_id, entity_type) — a line can carry at most one tag
 * per dimension.
 */
export const journalEntryLineTags = pgTable("journal_entry_line_tags", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	journalEntryLineId: varchar("journal_entry_line_id").notNull(),
	/** Discriminator. Values: 'rental_property' | 'fixed_asset' | 'loan'
	 *  | future user-defined dimensions. Validated in the action layer. */
	entityType: varchar("entity_type").notNull(),
	entityId: varchar("entity_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_jel_tags_org_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_jel_tags_entity").using("btree", table.entityType.asc().nullsLast(), table.entityId.asc().nullsLast()),
	index("ix_jel_tags_line_id").using("btree", table.journalEntryLineId.asc().nullsLast().op("text_ops")),
	foreignKey({
		columns: [table.journalEntryLineId],
		foreignColumns: [journalEntryLines.id],
		name: "journal_entry_line_tags_line_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.organizationId],
		foreignColumns: [organizations.id],
		name: "journal_entry_line_tags_org_id_fkey",
	}).onDelete("cascade"),
	unique("journal_entry_line_tags_unique_dim").on(table.journalEntryLineId, table.entityType),
]);

/**
 * Polymorphic task → entity links. Relates an organizer task to notes,
 * appointments, inbox messages, and text messages via one (entity_type,
 * entity_id) row per link. Contacts are NOT stored here — they live on
 * tasks.assigned_to_contacts (already wired into the AI tools, the contact
 * drill-in, and the dashboard company filter). A task may have many links
 * of the same type, so uniqueness is on the full (task, type, entity) triple.
 */
export const taskLinks = pgTable("task_links", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	taskId: varchar("task_id").notNull(),
	/** Discriminator: 'note' | 'appointment' | 'inbox_message' | 'text_message'.
	 *  Validated in the action layer (lib/task-links). */
	entityType: varchar("entity_type").notNull(),
	entityId: varchar("entity_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_task_links_task").using("btree", table.taskId.asc().nullsLast().op("text_ops")),
	index("ix_task_links_entity").using("btree", table.organizationId.asc().nullsLast(), table.entityType.asc().nullsLast(), table.entityId.asc().nullsLast()),
	foreignKey({
		columns: [table.taskId],
		foreignColumns: [tasks.id],
		name: "task_links_task_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.organizationId],
		foreignColumns: [organizations.id],
		name: "task_links_organization_id_fkey",
	}).onDelete("cascade"),
	unique("task_links_unique_link").on(table.taskId, table.entityType, table.entityId),
]);

export const taskArtifacts = pgTable("task_artifacts", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	taskId: varchar("task_id").notNull(),
	userId: varchar("user_id"),
	/** 'letter' | 'email' | 'text' | 'resolution'. Validated in the action layer. */
	kind: varchar().notNull(),
	title: text().default('').notNull(),
	body: text().default('').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_task_artifacts_task").using("btree", table.taskId.asc().nullsLast().op("text_ops")),
	foreignKey({
		columns: [table.taskId],
		foreignColumns: [tasks.id],
		name: "task_artifacts_task_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.organizationId],
		foreignColumns: [organizations.id],
		name: "task_artifacts_organization_id_fkey",
	}).onDelete("cascade"),
	unique("task_artifacts_unique_task").on(table.taskId),
]);

export const organizerDocuments = pgTable("organizer_documents", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	userId: varchar("user_id"),
	/** Created docs: 'letter' | 'email' | 'text' | 'resolution' | 'deck'. Uploaded docs: 'upload'. Validated in the action layer. */
	kind: varchar().notNull(),
	title: text().default('').notNull(),
	body: text().default('').notNull(),
	contactId: varchar("contact_id"),
	/** 'created' (drafted in the Create workspace) | 'uploaded' (a user file). */
	source: varchar().default('created').notNull(),
	/** Uploaded docs only: object path inside the organizer-documents bucket. */
	storagePath: text("storage_path"),
	mimeType: varchar("mime_type"),
	fileSize: integer("file_size"),
	originalFilename: text("original_filename"),
	/** Cached AI breakdown shown on the view page, with the content hash it was
	 *  generated against (stale when the live content hashes differently). */
	aiBreakdown: jsonb("ai_breakdown"),
	aiBreakdownHash: text("ai_breakdown_hash"),
	aiBreakdownAt: timestamp("ai_breakdown_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_organizer_documents_org_user_updated").using("btree", table.organizationId.asc().nullsLast(), table.userId.asc().nullsLast(), table.updatedAt.desc().nullsLast()),
	foreignKey({
		columns: [table.organizationId],
		foreignColumns: [organizations.id],
		name: "organizer_documents_organization_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.contactId],
		foreignColumns: [contacts.id],
		name: "organizer_documents_contact_id_fkey",
	}).onDelete("set null"),
]);

// --- Signatures (DocuSign-style e-signing) --------------------------------

export const signatureRequests = pgTable("signature_requests", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	userId: varchar("user_id"),
	title: text().default('').notNull(),
	message: text().default('').notNull(),
	/** draft | sent | completed | declined | voided. Validated in the action layer. */
	status: varchar().default('draft').notNull(),
	sourceDocumentId: varchar("source_document_id"),
	sourcePdfPath: text("source_pdf_path"),
	completedPdfPath: text("completed_pdf_path"),
	/** When true, signers are invited one at a time in signing_order. */
	sequential: boolean().default(false).notNull(),
	/** CSV of delivery channels chosen at send (email,sms,link) — reused by
	 *  reminders and sequential auto-advance. */
	deliveryChannels: text("delivery_channels"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("ix_signature_requests_org_created").using("btree", table.organizationId.asc().nullsLast(), table.createdAt.desc().nullsLast()),
	foreignKey({
		columns: [table.organizationId],
		foreignColumns: [organizations.id],
		name: "signature_requests_organization_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.sourceDocumentId],
		foreignColumns: [organizerDocuments.id],
		name: "signature_requests_source_document_id_fkey",
	}).onDelete("set null"),
]);

export const signatureRecipients = pgTable("signature_recipients", {
	id: varchar().primaryKey().notNull(),
	requestId: varchar("request_id").notNull(),
	name: text().default('').notNull(),
	email: text().default('').notNull(),
	phone: text(),
	signingOrder: integer("signing_order").default(0).notNull(),
	/** pending | viewed | signed | declined. */
	status: varchar().default('pending').notNull(),
	token: varchar().notNull(),
	invitedAt: timestamp("invited_at", { withTimezone: true, mode: 'string' }),
	viewedAt: timestamp("viewed_at", { withTimezone: true, mode: 'string' }),
	signedAt: timestamp("signed_at", { withTimezone: true, mode: 'string' }),
	declineReason: text("decline_reason"),
	signedIp: varchar("signed_ip"),
	signedUserAgent: text("signed_user_agent"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ux_signature_recipients_token").using("btree", table.token.asc().nullsLast()),
	index("ix_signature_recipients_request").using("btree", table.requestId.asc().nullsLast()),
	foreignKey({
		columns: [table.requestId],
		foreignColumns: [signatureRequests.id],
		name: "signature_recipients_request_id_fkey",
	}).onDelete("cascade"),
]);

export const signatureFields = pgTable("signature_fields", {
	id: varchar().primaryKey().notNull(),
	requestId: varchar("request_id").notNull(),
	recipientId: varchar("recipient_id").notNull(),
	/** 0-based page index. */
	page: integer().default(0).notNull(),
	/** Normalized 0..1 coordinates (top-left origin) + size. */
	x: numeric().notNull(),
	y: numeric().notNull(),
	w: numeric().notNull(),
	h: numeric().notNull(),
	/** signature | initials | date | text | name | checkbox. */
	type: varchar().notNull(),
	required: boolean().default(true).notNull(),
	value: text(),
	signatureImagePath: text("signature_image_path"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_signature_fields_request").using("btree", table.requestId.asc().nullsLast()),
	foreignKey({
		columns: [table.requestId],
		foreignColumns: [signatureRequests.id],
		name: "signature_fields_request_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.recipientId],
		foreignColumns: [signatureRecipients.id],
		name: "signature_fields_recipient_id_fkey",
	}).onDelete("cascade"),
]);

export const signatureEvents = pgTable("signature_events", {
	id: varchar().primaryKey().notNull(),
	requestId: varchar("request_id").notNull(),
	recipientId: varchar("recipient_id"),
	/** created|sent|viewed|signed|completed|declined|reminded|voided|consented. */
	type: varchar().notNull(),
	at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	ip: varchar(),
	userAgent: text("user_agent"),
	meta: jsonb(),
}, (table) => [
	index("ix_signature_events_request").using("btree", table.requestId.asc().nullsLast(), table.at.asc().nullsLast()),
	foreignKey({
		columns: [table.requestId],
		foreignColumns: [signatureRequests.id],
		name: "signature_events_request_id_fkey",
	}).onDelete("cascade"),
]);

export const rentalProperties = pgTable("rental_properties", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	displayName: varchar("display_name").notNull(),
	address: jsonb(),
	assetAccountId: varchar("asset_account_id"),
	/** 1:1 link to the underlying fixed_assets row (the building). Wired
	 *  when the property is created via /rental-properties/new — the form
	 *  spins up the asset in the same transaction. Older properties may
	 *  have null; the list page tolerates it. */
	fixedAssetId: varchar("fixed_asset_id"),
	status: varchar({ length: 16 }).default('active').notNull(),
	acquiredOn: date("acquired_on"),
	disposedOn: date("disposed_on"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_rental_properties_org_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "rental_properties_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.assetAccountId],
			foreignColumns: [chartOfAccounts.id],
			name: "rental_properties_asset_account_id_fkey"
		}),
]);

// personalUseLeaseAgreements: documents that a specific user (trustee or
// beneficiary) leases a specific trust-owned asset for personal use.
// Drives 440 lease-income auto-detection in Phase 4.
export const personalUseLeaseAgreements = pgTable("personal_use_lease_agreements", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	lesseeUserId: varchar("lessee_user_id").notNull(),
	lesseeRole: varchar("lessee_role", { length: 32 }).notNull(),
	assetAccountId: varchar("asset_account_id").notNull(),
	monthlyAmount: numeric("monthly_amount", { precision: 14, scale: 2 }).notNull(),
	startDate: date("start_date").notNull(),
	endDate: date("end_date"),
	agreementDocumentUrl: varchar("agreement_document_url"),
	status: varchar({ length: 16 }).default('active').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_personal_use_lease_org_id").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_personal_use_lease_org_active").using("btree", table.organizationId.asc().nullsLast().op("text_ops")).where(sql`status = 'active'`),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "personal_use_lease_agreements_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.lesseeUserId],
			foreignColumns: [users.id],
			name: "personal_use_lease_agreements_lessee_user_id_fkey"
		}),
	foreignKey({
			columns: [table.assetAccountId],
			foreignColumns: [chartOfAccounts.id],
			name: "personal_use_lease_agreements_asset_account_id_fkey"
		}),
]);

// trustReviewFindings: persistent record of every "warn"-severity finding
// the beneficial-trust rules engine produced for a posted JE. Surfaces in
// the Trust Review queue UI. dismissed_at IS NULL = open for review.
export const trustReviewFindings = pgTable("trust_review_findings", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	journalEntryId: varchar("journal_entry_id").notNull(),
	code: varchar({ length: 64 }).notNull(),
	severity: varchar({ length: 16 }).notNull(),
	message: text().notNull(),
	metadata: jsonb(),
	dismissedAt: timestamp("dismissed_at", { withTimezone: true, mode: 'string' }),
	dismissedByUserId: varchar("dismissed_by_user_id"),
	dismissedNote: text("dismissed_note"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_trust_review_findings_org_open").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsLast().op("timestamptz_ops")).where(sql`dismissed_at IS NULL`),
	index("ix_trust_review_findings_je").using("btree", table.journalEntryId.asc().nullsLast().op("text_ops")),
	index("ix_trust_review_findings_code").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.code.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "trust_review_findings_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.journalEntryId],
			foreignColumns: [journalEntries.id],
			name: "trust_review_findings_je_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.dismissedByUserId],
			foreignColumns: [users.id],
			name: "trust_review_findings_dismissed_by_user_id_fkey"
		}),
]);

// Book review findings — the general bookkeeping-correctness counterpart to
// trust_review_findings. Written by the audit layer (lib/audit/*): duplicate
// detection (real-time at import + nightly) and integrity sweeps (nightly).
// Flag-only — nothing here blocks the autonomous pipeline.
//
// subject_key is the idempotency key: the audit layer recomputes findings on
// every run, so a unique partial index over (org, code, subject_key) WHERE
// status='open' collapses repeats to one open row. It exists because some
// findings have no transaction_id (e.g. an org-level unbalanced trial balance)
// and duplicate pairs are symmetric — subject_key canonicalizes both
// (e.g. 'dup:<minTxnId>:<maxTxnId>', 'je:<id>', 'txn:<id>', 'org').
/** Year-end close checklist — manual item check-offs per org + year (0128).
 * Auto items derive status live; only manual items are persisted here. */
export const yearEndCloseItems = pgTable("year_end_close_items", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	year: integer().notNull(),
	itemKey: varchar("item_key").notNull(),
	done: boolean().default(false).notNull(),
	doneAt: timestamp("done_at", { withTimezone: true, mode: 'string' }),
	doneByUserId: varchar("done_by_user_id"),
	note: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ux_yec_org_year_item").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.year.asc().nullsLast(), table.itemKey.asc().nullsLast().op("text_ops")),
]);

export const bookReviewFindings = pgTable("book_review_findings", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	kind: varchar({ length: 16 }).notNull(),
	code: varchar({ length: 64 }).notNull(),
	severity: varchar({ length: 16 }).notNull(),
	subjectKey: varchar("subject_key", { length: 128 }).notNull(),
	message: text().notNull(),
	transactionId: varchar("transaction_id"),
	journalEntryId: varchar("journal_entry_id"),
	relatedTransactionId: varchar("related_transaction_id"),
	metadata: jsonb(),
	status: varchar({ length: 16 }).default('open').notNull(),
	resolution: varchar({ length: 16 }),
	dismissedAt: timestamp("dismissed_at", { withTimezone: true, mode: 'string' }),
	dismissedByUserId: varchar("dismissed_by_user_id"),
	dismissedNote: text("dismissed_note"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_book_review_findings_org_status").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsLast().op("timestamptz_ops")).where(sql`status = 'open'`),
	index("ix_book_review_findings_txn").using("btree", table.transactionId.asc().nullsLast().op("text_ops")),
	uniqueIndex("ux_book_review_findings_open_subject").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.code.asc().nullsLast().op("text_ops"), table.subjectKey.asc().nullsLast().op("text_ops")).where(sql`status = 'open'`),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "book_review_findings_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.transactionId],
			foreignColumns: [transactions.id],
			name: "book_review_findings_txn_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.journalEntryId],
			foreignColumns: [journalEntries.id],
			name: "book_review_findings_je_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.relatedTransactionId],
			foreignColumns: [transactions.id],
			name: "book_review_findings_related_txn_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.dismissedByUserId],
			foreignColumns: [users.id],
			name: "book_review_findings_dismissed_by_user_id_fkey"
		}),
]);

// Month-end close ladder. One row per org-month that has been advanced past
// 'open'; an ABSENT row means the month is open (default). Status flows
// open → reviewed → closed; 'closed' hard-blocks posting/edits dated in that
// month (enforced by assertPeriodOpen in lib/accounting/posting.ts). Reopen
// (→ open) clears the close stamps. status is varchar (not pgEnum) per the
// project's schema-drift convention.
export const accountingPeriods = pgTable("accounting_periods", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	year: integer().notNull(),
	month: integer().notNull(),
	status: varchar({ length: 16 }).default('open').notNull(),
	reviewedByUserId: varchar("reviewed_by_user_id"),
	reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: 'string' }),
	closedByUserId: varchar("closed_by_user_id"),
	closedAt: timestamp("closed_at", { withTimezone: true, mode: 'string' }),
	note: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("ux_accounting_periods_org_year_month").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.year.asc().nullsLast().op("int4_ops"), table.month.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "accounting_periods_org_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.reviewedByUserId],
			foreignColumns: [users.id],
			name: "accounting_periods_reviewed_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.closedByUserId],
			foreignColumns: [users.id],
			name: "accounting_periods_closed_by_user_id_fkey"
		}),
]);

export const trustDobCorrectionJobs = pgTable("trust_dob_correction_jobs", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	userId: varchar("user_id").notNull(),
	beneficiaryId: varchar("beneficiary_id").notNull(),
	oldDob: date("old_dob"),
	newDob: date("new_dob").notNull(),
	items: json().notNull(),
	totalCount: integer("total_count").notNull(),
	status: varchar().notNull(),
	progress: integer().notNull().default(0),
	repostedCount: integer("reposted_count").notNull().default(0),
	failedCount: integer("failed_count").notNull().default(0),
	failedItems: json("failed_items"),
	errorMessage: text("error_message"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("ix_trust_dob_correction_jobs_bene_status").using("btree", table.beneficiaryId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("ix_trust_dob_correction_jobs_org_created").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "trust_dob_correction_jobs_org_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "trust_dob_correction_jobs_user_id_fkey"
		}),
	foreignKey({
			columns: [table.beneficiaryId],
			foreignColumns: [trustBeneficiaries.id],
			name: "trust_dob_correction_jobs_beneficiary_id_fkey"
		}),
]);

// Organizer Recorder, Phase 1 (migration 0067).
//
// recordings — one session. status walks uploading → transcribing → ready
// (or failed). storage_path is the supabase 'recordings' bucket key.
export const recordings = pgTable('recordings', {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar('organization_id').notNull(),
	userId: varchar('user_id').notNull(),
	contactId: varchar('contact_id'),
	appointmentId: varchar('appointment_id'),
	title: varchar(),
	source: varchar().notNull(),
	status: varchar().notNull(),
	durationS: integer('duration_s'),
	storagePath: varchar('storage_path'),
	failureReason: text('failure_reason'),
	startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index('ix_recordings_org_created_at').using('btree', table.organizationId.asc().nullsLast().op('text_ops'), table.createdAt.desc().nullsLast().op('timestamptz_ops')),
	index('ix_recordings_user_created_at').using('btree', table.userId.asc().nullsLast().op('text_ops'), table.createdAt.desc().nullsLast().op('timestamptz_ops')),
	index('ix_recordings_status').using('btree', table.status.asc().nullsLast().op('text_ops')).where(sql`status IN ('uploading', 'transcribing')`),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: 'recordings_organization_id_fkey'
		}).onDelete('cascade'),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: 'recordings_user_id_fkey'
		}).onDelete('cascade'),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: 'recordings_contact_id_fkey'
		}).onDelete('set null'),
	foreignKey({
			columns: [table.appointmentId],
			foreignColumns: [appointments.id],
			name: 'recordings_appointment_id_fkey'
		}).onDelete('set null'),
	index('ix_recordings_appointment_id').using('btree', table.appointmentId.asc().nullsLast().op('text_ops')).where(sql`appointment_id IS NOT NULL`),
]);

// recording_segments — diarized utterances from Deepgram. speaker_label is
// the raw label ('S1', 'S2', …); the *_user_id / *_contact_id columns are
// filled when the user maps a speaker to a person on the review screen.
export const recordingSegments = pgTable('recording_segments', {
	id: varchar().primaryKey().notNull(),
	recordingId: varchar('recording_id').notNull(),
	speakerLabel: varchar('speaker_label').notNull(),
	speakerUserId: varchar('speaker_user_id'),
	speakerContactId: varchar('speaker_contact_id'),
	startMs: integer('start_ms').notNull(),
	endMs: integer('end_ms').notNull(),
	text: text().notNull(),
	channel: varchar(),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index('ix_recording_segments_recording_start').using('btree', table.recordingId.asc().nullsLast().op('text_ops'), table.startMs.asc().nullsLast().op('int4_ops')),
	foreignKey({
			columns: [table.recordingId],
			foreignColumns: [recordings.id],
			name: 'recording_segments_recording_id_fkey'
		}).onDelete('cascade'),
	foreignKey({
			columns: [table.speakerUserId],
			foreignColumns: [users.id],
			name: 'recording_segments_speaker_user_id_fkey'
		}).onDelete('set null'),
	foreignKey({
			columns: [table.speakerContactId],
			foreignColumns: [contacts.id],
			name: 'recording_segments_speaker_contact_id_fkey'
		}).onDelete('set null'),
]);

// recording_outputs — AI-drafted summary + action items. One row per
// recording; separate table so regenerating doesn't touch the source-of-
// truth status row in .
export const recordingOutputs = pgTable('recording_outputs', {
	id: varchar().primaryKey().notNull(),
	recordingId: varchar('recording_id').notNull().unique(),
	summaryMd: text('summary_md'),
	actionItems: jsonb('action_items').default([]).notNull(),
	decisions: jsonb().default([]).notNull(),
	approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'string' }),
	approvedBy: varchar('approved_by'),
	generatedAt: timestamp('generated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.recordingId],
			foreignColumns: [recordings.id],
			name: 'recording_outputs_recording_id_fkey'
		}).onDelete('cascade'),
	foreignKey({
			columns: [table.approvedBy],
			foreignColumns: [users.id],
			name: 'recording_outputs_approved_by_fkey'
		}).onDelete('set null'),
]);

// recording_bot_sessions — Phase 2a (migration 0074). 1:1 sidecar on
// recordings for the meeting-bot (Recall.ai) capture source. Holds the
// bot-specific fields; everything downstream (segments, outputs, approve)
// is shared with the device recorder. calendar_event_id is reserved for
// Phase 2b auto-join. recall_bot_id is the webhook lookup key.
export const recordingBotSessions = pgTable('recording_bot_sessions', {
	id: varchar().primaryKey().notNull(),
	recordingId: varchar('recording_id').notNull().unique(),
	recallBotId: varchar('recall_bot_id'),
	platform: varchar().notNull(),
	meetingUrl: text('meeting_url').notNull(),
	botStatus: varchar('bot_status').notNull(),
	mediaUrl: text('media_url'),
	consentAck: boolean('consent_ack').default(false).notNull(),
	consentBy: varchar('consent_by'),
	calendarEventId: varchar('calendar_event_id'),
	lastEvent: jsonb('last_event'),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex('ux_recording_bot_sessions_recall_bot_id').using('btree', table.recallBotId.asc().nullsLast().op('text_ops')).where(sql`recall_bot_id IS NOT NULL`),
	foreignKey({
			columns: [table.recordingId],
			foreignColumns: [recordings.id],
			name: 'recording_bot_sessions_recording_id_fkey'
		}).onDelete('cascade'),
	foreignKey({
			columns: [table.consentBy],
			foreignColumns: [users.id],
			name: 'recording_bot_sessions_consent_by_fkey'
		}).onDelete('set null'),
]);

// Meeting follow-up lifecycle, Phase 1 (migration 0075).
//
// One row per past meeting (an appointment WITH a contact). The orchestrator
// cron (/api/cron/meeting-followups) walks `state`:
//   awaiting_notes → chasing_notes → notes_received → debrief_pending → completed
// See db/migrations/0075_meeting_followups.sql for the full state contract.
export const meetingFollowups = pgTable('meeting_followups', {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar('organization_id').notNull(),
	userId: varchar('user_id').notNull(),
	appointmentId: varchar('appointment_id').notNull().unique(),
	state: varchar().default('awaiting_notes').notNull(),
	notesSource: varchar('notes_source'),
	recordingId: varchar('recording_id'),
	chaseTaskId: varchar('chase_task_id'),
	debriefTaskId: varchar('debrief_task_id'),
	meetingEndedAt: timestamp('meeting_ended_at', { withTimezone: true, mode: 'string' }).notNull(),
	notesReceivedAt: timestamp('notes_received_at', { withTimezone: true, mode: 'string' }),
	debriefedAt: timestamp('debriefed_at', { withTimezone: true, mode: 'string' }),
	completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index('ix_meeting_followups_state').using('btree', table.state.asc().nullsLast().op('text_ops'), table.meetingEndedAt.asc().nullsLast().op('timestamptz_ops')),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: 'meeting_followups_organization_id_fkey'
		}).onDelete('cascade'),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: 'meeting_followups_user_id_fkey'
		}).onDelete('cascade'),
	foreignKey({
			columns: [table.appointmentId],
			foreignColumns: [appointments.id],
			name: 'meeting_followups_appointment_id_fkey'
		}).onDelete('cascade'),
	foreignKey({
			columns: [table.recordingId],
			foreignColumns: [recordings.id],
			name: 'meeting_followups_recording_id_fkey'
		}).onDelete('set null'),
]);

// meeting_action_items — the ledger of follow-ups the AI proposed and what it
// did with them. owner_type='contact' means a diarized speaker mapped to a
// contact (the "anyone on the call" case). Phase 1 execution is internal-only:
// proposed_action is always {kind:'create_task'}; on debrief approval the AI
// creates a tracking task and records result_task_id / status='executed'.
export const meetingActionItems = pgTable('meeting_action_items', {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar('organization_id').notNull(),
	followupId: varchar('followup_id').notNull(),
	appointmentId: varchar('appointment_id').notNull(),
	description: text().notNull(),
	ownerType: varchar('owner_type').default('user').notNull(),
	ownerContactId: varchar('owner_contact_id'),
	dueHint: text('due_hint'),
	executableByAi: boolean('executable_by_ai').default(true).notNull(),
	bucket: varchar().default('user').notNull(),
	proposedAction: jsonb('proposed_action').default({}).notNull(),
	status: varchar().default('proposed').notNull(),
	resultTaskId: varchar('result_task_id'),
	resultDocId: varchar('result_doc_id'),
	result: jsonb(),
	executedAt: timestamp('executed_at', { withTimezone: true, mode: 'string' }),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index('ix_meeting_action_items_followup').using('btree', table.followupId.asc().nullsLast().op('text_ops')),
	foreignKey({
			columns: [table.followupId],
			foreignColumns: [meetingFollowups.id],
			name: 'meeting_action_items_followup_id_fkey'
		}).onDelete('cascade'),
]);

// Organizer Texts (migration 0069). One row per SMS in either direction.
// contact_id is nullable for inbound from unknown numbers. Threads are
// scoped to (organization_id, contact_id) — org-shared, not per-user.
export const textMessages = pgTable('text_messages', {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar('organization_id').notNull(),
	contactId: varchar('contact_id'),
	direction: varchar().notNull(),
	// Channel: 'sms' (Twilio; default for existing rows) | 'telegram'.
	channel: varchar().default('sms').notNull(),
	fromPhone: text('from_phone').notNull(),
	toPhone: text('to_phone').notNull(),
	body: text().notNull(),
	status: varchar(),
	providerMessageId: text('provider_message_id'),
	segments: integer(),
	error: text(),
	sentByUserId: varchar('sent_by_user_id'),
	readAt: timestamp('read_at', { withTimezone: true, mode: 'string' }),
	// Manual "mark reviewed" for the dashboard Texts card (migration 0081).
	dashboardDismissedAt: timestamp('dashboard_dismissed_at', { withTimezone: true, mode: 'string' }),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index('ix_text_messages_org_created').using('btree', table.organizationId.asc().nullsLast().op('text_ops'), table.createdAt.desc().nullsLast().op('timestamptz_ops')),
	index('ix_text_messages_contact_created').using('btree', table.contactId.asc().nullsLast().op('text_ops'), table.createdAt.desc().nullsLast().op('timestamptz_ops')),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: 'text_messages_organization_id_fkey'
		}).onDelete('cascade'),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: 'text_messages_contact_id_fkey'
		}).onDelete('set null'),
	foreignKey({
			columns: [table.sentByUserId],
			foreignColumns: [users.id],
			name: 'text_messages_sent_by_user_id_fkey'
		}).onDelete('set null'),
]);

// Per-org connection to the shared Rocketbooks Telegram bot (migration 0140).
// `inviteToken` is embedded in the t.me/<bot>?start=<token> deep link the org
// shares with contacts/groups; starting the bot via it links that chat here.
export const telegramConnections = pgTable('telegram_connections', {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar('organization_id').notNull(),
	inviteToken: varchar('invite_token').notNull(),
	botUsername: varchar('bot_username'),
	createdByUserId: varchar('created_by_user_id'),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex('ux_telegram_connections_org').using('btree', table.organizationId.asc().nullsLast().op('text_ops')),
	uniqueIndex('ux_telegram_connections_token').using('btree', table.inviteToken.asc().nullsLast().op('text_ops')),
	foreignKey({ columns: [table.organizationId], foreignColumns: [organizations.id], name: 'telegram_connections_org_fkey' }).onDelete('cascade'),
	foreignKey({ columns: [table.createdByUserId], foreignColumns: [users.id], name: 'telegram_connections_user_fkey' }).onDelete('set null'),
]);

// A Telegram chat (private DM or group) linked to an org, and the contact its
// messages route to. Inbound lands in text_messages via this mapping (migration 0140).
export const telegramChats = pgTable('telegram_chats', {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar('organization_id').notNull(),
	chatId: varchar('chat_id').notNull(),
	chatType: varchar('chat_type'),
	title: varchar(),
	contactId: varchar('contact_id'),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex('ux_telegram_chats_org_chat').using('btree', table.organizationId.asc().nullsLast().op('text_ops'), table.chatId.asc().nullsLast().op('text_ops')),
	index('ix_telegram_chats_chat').using('btree', table.chatId.asc().nullsLast().op('text_ops')),
	foreignKey({ columns: [table.organizationId], foreignColumns: [organizations.id], name: 'telegram_chats_org_fkey' }).onDelete('cascade'),
	foreignKey({ columns: [table.contactId], foreignColumns: [contacts.id], name: 'telegram_chats_contact_fkey' }).onDelete('set null'),
]);

// AI client outreach log — see migration 0102_ai_client_outreach.sql.
// One row per (client org, issue type) tracking the AI's proactive contact.
export const aiClientOutreach = pgTable("ai_client_outreach", {
	id: varchar().primaryKey().notNull(),
	enterpriseId: varchar("enterprise_id"),
	organizationId: varchar("organization_id").notNull(),
	issueType: varchar("issue_type").notNull(),
	channel: varchar(),
	status: varchar().default('drafted').notNull(),
	targetType: varchar("target_type").default('client_owner').notNull(),
	lastMessageSubject: varchar("last_message_subject"),
	lastMessageBody: text("last_message_body"),
	lastContactAt: timestamp("last_contact_at", { withTimezone: true, mode: 'string' }),
	attempts: integer().default(0).notNull(),
	createdByUserId: varchar("created_by_user_id"),
	// AR collections two-step (0112): the client-approval link token + when they
	// clicked it. Only set for overdue_invoices outreach.
	approveToken: varchar("approve_token"),
	approvedAt: timestamp("approved_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	// contact_inquiry: which transactions this outreach asked about (migration 0123),
	// so an inbound reply can be applied to exactly those. { transactionIds: [...] }.
	context: jsonb(),
}, (table) => [
	index("ix_ai_client_outreach_org_issue").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.issueType.asc().nullsLast().op("text_ops")),
	index("ix_ai_client_outreach_enterprise").using("btree", table.enterpriseId.asc().nullsLast().op("text_ops")),
	index("ix_ai_client_outreach_approve_token").using("btree", table.approveToken.asc().nullsLast().op("text_ops")),
]);

/** Inbound client email replies (0108). The /api/email/inbound webhook stores the
 * decoded reply here, linked back to the originating outreach via outreach_id. */
export const emailInbound = pgTable("email_inbound", {
	id: varchar().primaryKey().notNull(),
	outreachId: varchar("outreach_id"),
	enterpriseId: varchar("enterprise_id"),
	organizationId: varchar("organization_id"),
	fromEmail: varchar("from_email"),
	toEmail: varchar("to_email"),
	subject: varchar(),
	body: text(),
	raw: jsonb(),
	receivedAt: timestamp("received_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_email_inbound_outreach").using("btree", table.outreachId.asc().nullsLast().op("text_ops")),
	index("ix_email_inbound_org").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("ix_email_inbound_enterprise").using("btree", table.enterpriseId.asc().nullsLast().op("text_ops")),
]);

/** Log of customer-facing AR reminders sent on a client's behalf (0112) — audit + 7-day dedup. */
export const arCollectionReminders = pgTable("ar_collection_reminders", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	enterpriseId: varchar("enterprise_id"),
	outreachId: varchar("outreach_id"),
	contactId: varchar("contact_id").notNull(),
	customerEmail: varchar("customer_email"),
	invoiceCount: integer("invoice_count").default(0).notNull(),
	totalCents: integer("total_cents").default(0).notNull(),
	status: varchar().notNull(), // 'sent' | 'skipped' | 'failed'
	error: text(),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_ar_reminders_org_contact").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.contactId.asc().nullsLast().op("text_ops"), table.sentAt.asc().nullsLast()),
	index("ix_ar_reminders_outreach").using("btree", table.outreachId.asc().nullsLast().op("text_ops")),
]);

// AI-guided enterprise onboarding state — see migration 0103_enterprise_onboarding.sql.
export const enterpriseOnboardingState = pgTable("enterprise_onboarding_state", {
	enterpriseId: varchar("enterprise_id").primaryKey().notNull(),
	phase: varchar().default('private_label').notNull(),
	context: jsonb().default({}).notNull(),
	completed: boolean().default(false).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("ix_enterprise_onboarding_completed").using("btree", table.completed.asc().nullsLast().op("bool_ops")),
]);
