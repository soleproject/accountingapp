import {
	pgTable,
	varchar,
	text,
	integer,
	numeric,
	boolean,
	jsonb,
	timestamp,
	index,
	uniqueIndex,
	foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users, organizations, contacts, organizerDocuments } from "./schema";
import type { FormSpec } from "@/lib/tax/spec";

// Tax return completion — self-extending form system. See db/migrations/0097_tax_returns.sql.
//
// KNOWLEDGE layer (global, no organization_id): the archived official forms and the
// AI-derived FormSpec "expertise" for filling them — learned once, reused for every client.
// FILING layer (organization-scoped): one client's return, the crawler nodes, the collected
// facts, and the work queue. All client-specific data lives in the filing layer only.

const ts = { withTimezone: true, mode: "string" } as const;

// --- KNOWLEDGE LAYER (global) ---------------------------------------------

// Form identity, independent of tax year.
export const taxFormCatalog = pgTable("tax_form_catalog", {
	id: varchar().primaryKey().notNull(),
	jurisdiction: varchar().notNull(),            // 'US' or state code 'CA','NY',...
	formCode: varchar("form_code").notNull(),     // '1040','SCH_C','4562','CA_540'
	title: text().notNull().default(""),
	returnTypes: text("return_types").array().notNull().default(sql`'{}'`),  // 'personal'|'business'
	entityTypes: text("entity_types").array().notNull().default(sql`'{}'`),  // mirrors org_entity_type
	createdAt: timestamp("created_at", ts).defaultNow().notNull(),
}, (t) => [
	uniqueIndex("ux_tax_form_catalog_jur_code").on(t.jurisdiction, t.formCode),
]);

// The archive: provenance + the archived blank PDFs for a given year.
export const taxFormSources = pgTable("tax_form_sources", {
	id: varchar().primaryKey().notNull(),
	catalogId: varchar("catalog_id").notNull(),
	taxYear: integer("tax_year").notNull(),
	sourceUrl: text("source_url").notNull(),
	sourceKind: varchar("source_kind").notNull().default("official"), // official|provider|manual_upload
	formPdfPath: text("form_pdf_path").notNull(),
	instructionsPath: text("instructions_path"),
	sha256: varchar().notNull(),
	pdfVersion: varchar("pdf_version"),
	fieldDump: jsonb("field_dump"),
	retrievedAt: timestamp("retrieved_at", ts).defaultNow().notNull(),
}, (t) => [
	uniqueIndex("ux_tax_form_sources_catalog_year_hash").on(t.catalogId, t.taxYear, t.sha256),
	index("ix_tax_form_sources_catalog_year").on(t.catalogId, t.taxYear),
	foreignKey({ columns: [t.catalogId], foreignColumns: [taxFormCatalog.id], name: "tax_form_sources_catalog_id_fkey" }).onDelete("cascade"),
]);

// The expertise: a structured FormSpec derived from a source. Versioned + trust-laddered.
export const taxFormSpecs = pgTable("tax_form_specs", {
	id: varchar().primaryKey().notNull(),
	sourceId: varchar("source_id").notNull(),
	catalogId: varchar("catalog_id").notNull(),
	taxYear: integer("tax_year").notNull(),
	specVersion: integer("spec_version").notNull().default(1),
	spec: jsonb().$type<FormSpec>().notNull(),
	specHash: varchar("spec_hash").notNull(),
	trustStatus: varchar("trust_status").notNull().default("learned"), // learned|verified|locked|deprecated
	confidence: numeric(),
	model: varchar(),
	isActive: boolean("is_active").notNull().default(true),
	createdAt: timestamp("created_at", ts).defaultNow().notNull(),
}, (t) => [
	uniqueIndex("ux_tax_form_specs_source_version").on(t.sourceId, t.specVersion),
	uniqueIndex("ux_tax_form_specs_one_active").on(t.catalogId, t.taxYear).where(sql`is_active`),
	foreignKey({ columns: [t.sourceId], foreignColumns: [taxFormSources.id], name: "tax_form_specs_source_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [t.catalogId], foreignColumns: [taxFormCatalog.id], name: "tax_form_specs_catalog_id_fkey" }).onDelete("cascade"),
]);

// Audit of promotions up the trust ladder (e.g. learned -> verified by a preparer).
export const taxFormSpecReviews = pgTable("tax_form_spec_reviews", {
	id: varchar().primaryKey().notNull(),
	specId: varchar("spec_id").notNull(),
	reviewerUserId: varchar("reviewer_user_id").notNull(),
	fromStatus: varchar("from_status").notNull(),
	toStatus: varchar("to_status").notNull(),
	fixturesPassed: integer("fixtures_passed").notNull().default(0),
	notes: text(),
	createdAt: timestamp("created_at", ts).defaultNow().notNull(),
}, (t) => [
	index("ix_tax_form_spec_reviews_spec").on(t.specId),
	foreignKey({ columns: [t.specId], foreignColumns: [taxFormSpecs.id], name: "tax_form_spec_reviews_spec_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [t.reviewerUserId], foreignColumns: [users.id], name: "tax_form_spec_reviews_reviewer_user_id_fkey" }).onDelete("cascade"),
]);

// --- FILING LAYER (organization-scoped) -----------------------------------

// Top-level filing; the root of the crawl.
export const taxReturns = pgTable("tax_returns", {
	id: varchar().primaryKey().notNull(),
	organizationId: varchar("organization_id").notNull(),
	clientContactId: varchar("client_contact_id"),  // null = the org itself
	taxYear: integer("tax_year").notNull(),
	returnType: varchar("return_type").notNull(),   // 'personal' | 'business'
	entityType: varchar("entity_type"),             // mirrors org_entity_type
	jurisdictions: text().array().notNull().default(sql`'{}'`),
	seedFormCode: varchar("seed_form_code").notNull(),
	status: varchar().notNull().default("collecting"), // collecting|crawling|review|complete|archived
	// Guided-conversation phase (distinct from `status`, which tracks the forms):
	// classify|documents|interview|review|run|complete. See lib/tax/onboarding.ts.
	intakePhase: varchar("intake_phase").notNull().default("documents"),
	createdByUserId: varchar("created_by_user_id").notNull(),
	createdAt: timestamp("created_at", ts).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", ts).defaultNow().notNull(),
}, (t) => [
	index("ix_tax_returns_org_year").on(t.organizationId, t.taxYear),
	foreignKey({ columns: [t.organizationId], foreignColumns: [organizations.id], name: "tax_returns_organization_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [t.clientContactId], foreignColumns: [contacts.id], name: "tax_returns_client_contact_id_fkey" }).onDelete("set null"),
	foreignKey({ columns: [t.createdByUserId], foreignColumns: [users.id], name: "tax_returns_created_by_user_id_fkey" }).onDelete("cascade"),
]);

// The crawler nodes: one row per form instance. The dependency graph is the
// parentFormId self-reference.
export const taxReturnForms = pgTable("tax_return_forms", {
	id: varchar().primaryKey().notNull(),
	returnId: varchar("return_id").notNull(),
	organizationId: varchar("organization_id").notNull(),
	catalogId: varchar("catalog_id"),
	specId: varchar("spec_id"),
	formCode: varchar("form_code").notNull(),
	jurisdiction: varchar().notNull(),
	copyIndex: integer("copy_index").notNull().default(0),  // per_entity multiplicity
	instanceLabel: text("instance_label"),
	parentFormId: varchar("parent_form_id"),               // the graph edge
	relationship: varchar(),                               // attaches|carries_to|supports|state_of
	triggerReason: text("trigger_reason"),
	depth: integer().notNull().default(0),
	// pending|acquiring|comprehending|needs_input|ready|filling|filled|verifying|verified|failed|skipped
	status: varchar().notNull().default("pending"),
	fieldValues: jsonb("field_values"),
	computedValues: jsonb("computed_values"),
	filledPdfPath: text("filled_pdf_path"),
	isDraft: boolean("is_draft").notNull().default(true),
	error: text(),
	createdAt: timestamp("created_at", ts).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", ts).defaultNow().notNull(),
}, (t) => [
	uniqueIndex("ux_tax_return_forms_instance").on(t.returnId, t.formCode, t.jurisdiction, t.copyIndex),
	index("ix_tax_return_forms_return_status").on(t.returnId, t.status),
	index("ix_tax_return_forms_org").on(t.organizationId),
	index("ix_tax_return_forms_parent").on(t.parentFormId),
	foreignKey({ columns: [t.returnId], foreignColumns: [taxReturns.id], name: "tax_return_forms_return_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [t.organizationId], foreignColumns: [organizations.id], name: "tax_return_forms_organization_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [t.catalogId], foreignColumns: [taxFormCatalog.id], name: "tax_return_forms_catalog_id_fkey" }).onDelete("set null"),
	foreignKey({ columns: [t.specId], foreignColumns: [taxFormSpecs.id], name: "tax_return_forms_spec_id_fkey" }).onDelete("set null"),
	foreignKey({ columns: [t.parentFormId], foreignColumns: [t.id], name: "tax_return_forms_parent_form_id_fkey" }).onDelete("cascade"),
]);

// The work queue that drives the recursive crawl.
export const taxFormCrawlJobs = pgTable("tax_form_crawl_jobs", {
	id: varchar().primaryKey().notNull(),
	returnFormId: varchar("return_form_id").notNull(),
	organizationId: varchar("organization_id").notNull(),
	kind: varchar().notNull(),                       // acquire|comprehend|fill|verify
	state: varchar().notNull().default("queued"),    // queued|running|succeeded|failed|canceled
	attempts: integer().notNull().default(0),
	maxAttempts: integer("max_attempts").notNull().default(3),
	payload: jsonb(),
	result: jsonb(),
	error: text(),
	runAfter: timestamp("run_after", ts).defaultNow().notNull(),
	startedAt: timestamp("started_at", ts),
	finishedAt: timestamp("finished_at", ts),
	createdAt: timestamp("created_at", ts).defaultNow().notNull(),
}, (t) => [
	index("ix_tax_form_crawl_jobs_state_runafter").on(t.state, t.runAfter),
	index("ix_tax_form_crawl_jobs_return_form").on(t.returnFormId),
	foreignKey({ columns: [t.returnFormId], foreignColumns: [taxReturnForms.id], name: "tax_form_crawl_jobs_return_form_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [t.organizationId], foreignColumns: [organizations.id], name: "tax_form_crawl_jobs_organization_id_fkey" }).onDelete("cascade"),
]);

// Normalized collected facts that feed FormSpec.inputs (ref vocabulary in lib/tax/input-refs.ts).
export const taxReturnInputs = pgTable("tax_return_inputs", {
	id: varchar().primaryKey().notNull(),
	returnId: varchar("return_id").notNull(),
	organizationId: varchar("organization_id").notNull(),
	ref: varchar().notNull(),                        // 'w2.box1' (controlled vocabulary)
	entityKey: varchar("entity_key"),                // ties a value to a per_entity instance
	value: jsonb().notNull(),
	sourceDocumentId: varchar("source_document_id"),
	confidence: numeric(),
	confirmedByUser: boolean("confirmed_by_user").notNull().default(false),
	createdAt: timestamp("created_at", ts).defaultNow().notNull(),
}, (t) => [
	uniqueIndex("ux_tax_return_inputs_ref_entity").on(t.returnId, t.ref, t.entityKey).where(sql`entity_key IS NOT NULL`),
	uniqueIndex("ux_tax_return_inputs_ref_noentity").on(t.returnId, t.ref).where(sql`entity_key IS NULL`),
	index("ix_tax_return_inputs_return").on(t.returnId),
	foreignKey({ columns: [t.returnId], foreignColumns: [taxReturns.id], name: "tax_return_inputs_return_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [t.organizationId], foreignColumns: [organizations.id], name: "tax_return_inputs_organization_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [t.sourceDocumentId], foreignColumns: [organizerDocuments.id], name: "tax_return_inputs_source_document_id_fkey" }).onDelete("set null"),
]);
