// Knowledge-layer runner: resolve a form's "expertise" and (for the slice) fill it.
//
// `ensureSpec` is the shared knowledge-layer step — acquire the official blank PDF, archive
// it, and comprehend (or reuse) a FormSpec. It's global + idempotent: a form already
// acquired (same content hash) and comprehended (active spec) is reused, not re-fetched or
// re-learned — the "learn once, reuse for every client" payoff. The crawler (filing layer)
// and the slice scripts both build on it. Server-only.

import { randomUUID, createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/db/client";
import { taxFormCatalog, taxFormSources, taxFormSpecs } from "@/db/schema";
import {
	fillPdf,
	type FieldValue,
	type FormRef,
	type TaxFormProvider,
} from "./provider";
import type { FormSpec, SpecTrustStatus } from "./spec";
import { resolveFieldValues } from "./compute";
import { blankFormPath, downloadPdf, ensureTaxBucket, uploadPdf } from "./storage";

export interface EnsureCatalogOptions {
	title?: string;
	returnTypes?: string[];
	entityTypes?: string[];
}

/** Find (or create) the year-independent catalog row for a form. */
export async function ensureCatalog(
	ref: FormRef,
	opts: EnsureCatalogOptions = {},
	db: DB = defaultDb,
): Promise<string> {
	const existing = await db
		.select({ id: taxFormCatalog.id })
		.from(taxFormCatalog)
		.where(and(eq(taxFormCatalog.jurisdiction, ref.jurisdiction), eq(taxFormCatalog.formCode, ref.formCode)))
		.limit(1);
	if (existing[0]) return existing[0].id;

	const id = randomUUID();
	await db.insert(taxFormCatalog).values({
		id,
		jurisdiction: ref.jurisdiction,
		formCode: ref.formCode,
		title: opts.title ?? ref.formCode,
		returnTypes: opts.returnTypes ?? [],
		entityTypes: opts.entityTypes ?? [],
	});
	return id;
}

export interface EnsuredSpec {
	catalogId: string;
	sourceId: string;
	specId: string;
	spec: FormSpec;
	trustStatus: SpecTrustStatus;
	/** The blank form bytes (downloaded from the archive when reused, else freshly acquired). */
	blankBytes: Uint8Array;
	blankPath: string;
	reusedSource: boolean;
	reusedSpec: boolean;
}

/**
 * Acquire + archive + comprehend (or reuse) the FormSpec for one form/year. This is the
 * unit the crawler calls per node; it never touches client data. When an active spec
 * already exists, the blank PDF is pulled from Storage rather than re-downloaded.
 */
export async function ensureSpec(
	ref: FormRef,
	provider: TaxFormProvider,
	db: DB = defaultDb,
	model = "gpt-4o-mini",
): Promise<EnsuredSpec> {
	await ensureTaxBucket();
	const catalogId = await ensureCatalog(ref, {}, db);

	// Fast path: an active spec already exists → reuse it and fetch the blank from the archive.
	const activeSpec = (
		await db
			.select()
			.from(taxFormSpecs)
			.where(
				and(
					eq(taxFormSpecs.catalogId, catalogId),
					eq(taxFormSpecs.taxYear, ref.taxYear),
					eq(taxFormSpecs.isActive, true),
				),
			)
			.limit(1)
	)[0];

	if (activeSpec) {
		const src = (await db.select().from(taxFormSources).where(eq(taxFormSources.id, activeSpec.sourceId)).limit(1))[0];
		if (!src) throw new Error(`active spec ${activeSpec.id} references missing source ${activeSpec.sourceId}`);
		const blankBytes = await downloadPdf(src.formPdfPath);
		return {
			catalogId,
			sourceId: src.id,
			specId: activeSpec.id,
			spec: activeSpec.spec,
			trustStatus: activeSpec.trustStatus as SpecTrustStatus,
			blankBytes,
			blankPath: src.formPdfPath,
			reusedSource: true,
			reusedSpec: true,
		};
	}

	// Slow path: acquire the official blank, archive it (dedupe by hash), comprehend a spec.
	const acquired = await provider.acquire(ref);
	const blankPath = blankFormPath(ref.jurisdiction, ref.taxYear, ref.formCode, acquired.sha256);

	let sourceRow = (
		await db
			.select()
			.from(taxFormSources)
			.where(
				and(
					eq(taxFormSources.catalogId, catalogId),
					eq(taxFormSources.taxYear, ref.taxYear),
					eq(taxFormSources.sha256, acquired.sha256),
				),
			)
			.limit(1)
	)[0];
	const reusedSource = Boolean(sourceRow);
	if (!sourceRow) {
		await uploadPdf(blankPath, acquired.pdfBytes);
		const sourceId = randomUUID();
		await db.insert(taxFormSources).values({
			id: sourceId,
			catalogId,
			taxYear: ref.taxYear,
			sourceUrl: acquired.sourceUrl,
			sourceKind: acquired.sourceKind,
			formPdfPath: blankPath,
			sha256: acquired.sha256,
			pdfVersion: acquired.pdfVersion ?? null,
			fieldDump: acquired.fieldDump,
		});
		sourceRow = (await db.select().from(taxFormSources).where(eq(taxFormSources.id, sourceId)).limit(1))[0];
	}

	const spec = await provider.comprehend(acquired);
	spec.provenance.sourceId = sourceRow.id;
	const specId = randomUUID();
	const specHash = createHash("sha256").update(JSON.stringify(spec)).digest("hex");
	await db.insert(taxFormSpecs).values({
		id: specId,
		sourceId: sourceRow.id,
		catalogId,
		taxYear: ref.taxYear,
		specVersion: 1,
		spec,
		specHash,
		trustStatus: "learned",
		confidence: String(spec.confidence),
		model,
		isActive: true,
	});

	return {
		catalogId,
		sourceId: sourceRow.id,
		specId,
		spec,
		trustStatus: "learned",
		blankBytes: acquired.pdfBytes,
		blankPath,
		reusedSource,
		reusedSpec: false,
	};
}

export interface RunFormResult {
	catalogId: string;
	sourceId: string;
	specId: string;
	blankPath: string;
	spec: FormSpec;
	filledBytes: Uint8Array;
	unmappedKeys: string[];
	missingKeys: string[];
	deferredLines: string[];
	reusedSource: boolean;
	reusedSpec: boolean;
}

/**
 * Single-form convenience used by the slice scripts: ensure the spec, then compute + fill
 * from a plain inputs map (no filing-layer rows). The crawler uses ensureSpec directly.
 */
export async function acquireComprehendFill(args: {
	ref: FormRef;
	inputs: Record<string, FieldValue>;
	provider: TaxFormProvider;
	model?: string;
	/** Override the DB handle (e.g. a single-connection instance for standalone scripts). */
	database?: DB;
}): Promise<RunFormResult> {
	const { ref, inputs, provider } = args;
	const db = args.database ?? defaultDb;
	const ensured = await ensureSpec(ref, provider, db, args.model ?? "gpt-4o-mini");

	const { values, deferred } = resolveFieldValues(ensured.spec, inputs);
	const filled = await fillPdf(ensured.blankBytes, ensured.spec, values);

	return {
		catalogId: ensured.catalogId,
		sourceId: ensured.sourceId,
		specId: ensured.specId,
		blankPath: ensured.blankPath,
		spec: ensured.spec,
		filledBytes: filled.pdfBytes,
		unmappedKeys: filled.unmappedKeys,
		missingKeys: filled.missingKeys,
		deferredLines: deferred,
		reusedSource: ensured.reusedSource,
		reusedSpec: ensured.reusedSpec,
	};
}
