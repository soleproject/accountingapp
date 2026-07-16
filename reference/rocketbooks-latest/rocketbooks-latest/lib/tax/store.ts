// Read/query helpers for the tax-returns UI. Org-scoped; server-only.
//
// The intake tools (lib/tax/intake-tools.ts) write the filing-layer rows; these read them
// back for the /taxes pages. Kept separate from intake-tools so the page
// can render without importing the AI/provider machinery.

import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { taxReturns, taxReturnForms, taxReturnInputs, taxFormCatalog, taxFormSpecs } from "@/db/schema";

export interface TaxReturnRow {
	id: string;
	taxYear: number;
	returnType: string;
	entityType: string | null;
	jurisdictions: string[];
	seedFormCode: string;
	status: string;
	createdAt: string;
	updatedAt: string;
	formCount: number;
}

export interface TaxFormRow {
	id: string;
	formCode: string;
	jurisdiction: string;
	copyIndex: number;
	instanceLabel: string | null;
	parentFormId: string | null;
	relationship: string | null;
	depth: number;
	status: string;
	isDraft: boolean;
	filledPdfPath: string | null;
	/** The knowledge-layer spec used to fill this form (links to its review page). */
	specId: string | null;
	/**
	 * Whether RocketBooks already has a learned/verified spec for this form+year — i.e. the
	 * form is "in the system" and ready, vs. needing a download+map. Computed from the
	 * knowledge layer (active spec for the form's jurisdiction/code/year), independent of
	 * whether THIS return has filled it yet.
	 */
	inSystem: boolean;
	/** Trust status of the in-system spec, when one exists (learned|verified|locked). */
	specTrust: string | null;
	/** On needs_input nodes, the "missing required inputs: …" message. */
	error: string | null;
}

export interface TaxInputRow {
	ref: string;
	entityKey: string | null;
	value: unknown;
	confirmedByUser: boolean;
	/** 0..1 from extraction; null for hand-entered. Low + unconfirmed ⇒ needs review. */
	confidence: number | null;
}

/** All returns for an org, newest first, with a form count. */
export async function listTaxReturns(orgId: string): Promise<TaxReturnRow[]> {
	const rows = await db
		.select()
		.from(taxReturns)
		.where(eq(taxReturns.organizationId, orgId))
		.orderBy(desc(taxReturns.updatedAt));

	const out: TaxReturnRow[] = [];
	for (const r of rows) {
		const forms = await db
			.select({ id: taxReturnForms.id })
			.from(taxReturnForms)
			.where(eq(taxReturnForms.returnId, r.id));
		out.push({
			id: r.id,
			taxYear: r.taxYear,
			returnType: r.returnType,
			entityType: r.entityType ?? null,
			jurisdictions: r.jurisdictions ?? [],
			seedFormCode: r.seedFormCode,
			status: r.status,
			createdAt: r.createdAt,
			updatedAt: r.updatedAt,
			formCount: forms.length,
		});
	}
	return out;
}

export interface TaxReturnDetail {
	return: TaxReturnRow;
	forms: TaxFormRow[];
	inputs: TaxInputRow[];
}

/** One return with its form tree + recorded inputs — org-scoped (null if not owned). */
export async function getTaxReturnDetail(orgId: string, returnId: string): Promise<TaxReturnDetail | null> {
	const r = (
		await db
			.select()
			.from(taxReturns)
			.where(and(eq(taxReturns.id, returnId), eq(taxReturns.organizationId, orgId)))
			.limit(1)
	)[0];
	if (!r) return null;

	const formRows = await db
		.select()
		.from(taxReturnForms)
		.where(eq(taxReturnForms.returnId, returnId))
		.orderBy(taxReturnForms.depth, taxReturnForms.formCode);

	const inputRows = await db
		.select()
		.from(taxReturnInputs)
		.where(eq(taxReturnInputs.returnId, returnId))
		.orderBy(taxReturnInputs.ref);

	// Knowledge-layer readiness: which (jurisdiction, formCode) have an ACTIVE spec for this
	// return's tax year → "in system". One query for the whole tree.
	const activeSpecs = await db
		.select({
			jurisdiction: taxFormCatalog.jurisdiction,
			formCode: taxFormCatalog.formCode,
			trustStatus: taxFormSpecs.trustStatus,
		})
		.from(taxFormSpecs)
		.innerJoin(taxFormCatalog, eq(taxFormSpecs.catalogId, taxFormCatalog.id))
		.where(and(eq(taxFormSpecs.taxYear, r.taxYear), eq(taxFormSpecs.isActive, true)));
	const specByKey = new Map(activeSpecs.map((s) => [`${s.jurisdiction}|${s.formCode}`, s.trustStatus] as const));

	return {
		return: {
			id: r.id,
			taxYear: r.taxYear,
			returnType: r.returnType,
			entityType: r.entityType ?? null,
			jurisdictions: r.jurisdictions ?? [],
			seedFormCode: r.seedFormCode,
			status: r.status,
			createdAt: r.createdAt,
			updatedAt: r.updatedAt,
			formCount: formRows.length,
		},
		forms: formRows.map((f) => ({
			id: f.id,
			formCode: f.formCode,
			jurisdiction: f.jurisdiction,
			copyIndex: f.copyIndex,
			instanceLabel: f.instanceLabel ?? null,
			parentFormId: f.parentFormId ?? null,
			relationship: f.relationship ?? null,
			depth: f.depth,
			status: f.status,
			isDraft: f.isDraft,
			filledPdfPath: f.filledPdfPath ?? null,
			specId: f.specId ?? null,
			inSystem: specByKey.has(`${f.jurisdiction}|${f.formCode}`),
			specTrust: specByKey.get(`${f.jurisdiction}|${f.formCode}`) ?? null,
			error: f.error ?? null,
		})),
		inputs: inputRows.map((i) => ({
			ref: i.ref,
			entityKey: i.entityKey ?? null,
			value: i.value,
			confirmedByUser: i.confirmedByUser,
			confidence: i.confidence === null || i.confidence === undefined ? null : Number(i.confidence),
		})),
	};
}

/**
 * Delete one recorded fact, scoped to the org (so a stray/cross-org id is a no-op rather
 * than a leak). entityKey null targets the shared-fact row; a string targets that entity's.
 * Returns true if a row was removed.
 */
export async function deleteTaxInput(orgId: string, returnId: string, ref: string, entityKey: string | null): Promise<boolean> {
	// Confirm the return belongs to this org first.
	const owned = (
		await db.select({ id: taxReturns.id }).from(taxReturns).where(and(eq(taxReturns.id, returnId), eq(taxReturns.organizationId, orgId))).limit(1)
	)[0];
	if (!owned) return false;

	const deleted = await db
		.delete(taxReturnInputs)
		.where(
			and(
				eq(taxReturnInputs.returnId, returnId),
				eq(taxReturnInputs.ref, ref),
				entityKey === null ? sql`${taxReturnInputs.entityKey} is null` : eq(taxReturnInputs.entityKey, entityKey),
			),
		)
		.returning({ id: taxReturnInputs.id });
	return deleted.length > 0;
}

/**
 * Mark one recorded fact confirmed-by-user (the preparer reviewed an extracted value and
 * accepts it). Org-scoped; entity-aware. Returns true if a row was updated.
 */
export async function confirmTaxInput(orgId: string, returnId: string, ref: string, entityKey: string | null): Promise<boolean> {
	const owned = (
		await db.select({ id: taxReturns.id }).from(taxReturns).where(and(eq(taxReturns.id, returnId), eq(taxReturns.organizationId, orgId))).limit(1)
	)[0];
	if (!owned) return false;

	const updated = await db
		.update(taxReturnInputs)
		.set({ confirmedByUser: true })
		.where(
			and(
				eq(taxReturnInputs.returnId, returnId),
				eq(taxReturnInputs.ref, ref),
				entityKey === null ? sql`${taxReturnInputs.entityKey} is null` : eq(taxReturnInputs.entityKey, entityKey),
			),
		)
		.returning({ id: taxReturnInputs.id });
	return updated.length > 0;
}
