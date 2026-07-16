// Tax form crawler / job-runner (FILING layer).
//
// Given a tax_returns row, the crawler seeds the root form node (the return's seed form),
// then drains tax_form_crawl_jobs: for each node it ensures the FormSpec (knowledge layer),
// decides whether the form is required (triggers), gathers the client's collected inputs,
// fills the PDF, stores it, and expands the form's dependencies into NEW child nodes —
// recursing until the dependency graph closes and the queue is empty.
//
// The dependency graph is the tax_return_forms.parent_form_id self-reference. "Done" = no
// queued jobs remain and every node is filled / verified / skipped / needs_input / failed.
//
// Phase 1 uses a single job kind 'process' (acquire+comprehend+fill+expand are bundled,
// since the knowledge layer already dedupes them). The acquire/comprehend/fill/verify split
// in the schema is reserved for when those steps become independently retryable/parallel.
//
// Condition policy (three-valued — see conditions.ts):
//   trigger:    required unless EVERY trigger is definitively false. Unknown ⇒ required
//               (conservative — surface a draft for review rather than silently drop a form).
//   dependency: added only when its condition is definitively true (or empty). Unknown ⇒
//               skipped + logged (avoid runaway crawls; a preparer can add it on review).
//
// Server-only.

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { db as defaultDb, type DB } from "@/db/client";
import { taxReturns, taxReturnForms, taxReturnInputs, taxFormCrawlJobs } from "@/db/schema";
import type { TaxFormProvider, FieldValue, FormRef } from "./provider";
import { fillPdf } from "./provider";
import { ensureSpec } from "./runner";
import { resolveFieldValues } from "./compute";
import { evalCondition, type CondContext } from "./conditions";
import { filledFormPath, uploadPdf } from "./storage";
import type { FormSpec } from "./spec";
import { logger } from "@/lib/logger";

type ReturnRow = typeof taxReturns.$inferSelect;
type FormNode = typeof taxReturnForms.$inferSelect;

const RETRY_BACKOFF_MS = 60_000;
const DEFAULT_MAX_JOBS = 500; // safety cap on a single drain pass

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Create the root form node for a return (its seed form) and enqueue it. Idempotent: a
 * second call won't duplicate the root or its job. Moves the return into 'crawling'.
 * Returns the root node id.
 */
export async function seedReturn(returnId: string, db: DB = defaultDb): Promise<string> {
	const ret = (await db.select().from(taxReturns).where(eq(taxReturns.id, returnId)).limit(1))[0];
	if (!ret) throw new Error(`tax_returns ${returnId} not found`);
	const jurisdiction = ret.jurisdictions[0] ?? "US";

	const id = randomUUID();
	const inserted = await db
		.insert(taxReturnForms)
		.values({
			id,
			returnId,
			organizationId: ret.organizationId,
			formCode: ret.seedFormCode,
			jurisdiction,
			copyIndex: 0,
			depth: 0,
			status: "pending",
		})
		.onConflictDoNothing({
			target: [taxReturnForms.returnId, taxReturnForms.formCode, taxReturnForms.jurisdiction, taxReturnForms.copyIndex],
		})
		.returning({ id: taxReturnForms.id });

	let rootId: string;
	if (inserted[0]) {
		rootId = inserted[0].id;
		await enqueueJob(rootId, ret.organizationId, db);
	} else {
		rootId = (
			await db
				.select({ id: taxReturnForms.id })
				.from(taxReturnForms)
				.where(and(eq(taxReturnForms.returnId, returnId), eq(taxReturnForms.formCode, ret.seedFormCode)))
				.limit(1)
		)[0].id;
	}

	await db.update(taxReturns).set({ status: "crawling", updatedAt: new Date().toISOString() }).where(eq(taxReturns.id, returnId));
	return rootId;
}

async function enqueueJob(returnFormId: string, organizationId: string, db: DB): Promise<void> {
	await db.insert(taxFormCrawlJobs).values({
		id: randomUUID(),
		returnFormId,
		organizationId,
		kind: "process",
		state: "queued",
	});
}

// ---------------------------------------------------------------------------
// Inputs + condition context
// ---------------------------------------------------------------------------

interface ReturnInputs {
	/** Flat ref→value for inputs with no entity key (shared facts). */
	shared: Record<string, FieldValue>;
	/** Per-entity ref→value, keyed by entityKey. */
	byEntity: Map<string, Record<string, FieldValue>>;
	/** Distinct non-null entity keys present on the return. */
	entityKeys: string[];
}

async function loadInputs(returnId: string, db: DB): Promise<ReturnInputs> {
	const rows = await db.select().from(taxReturnInputs).where(eq(taxReturnInputs.returnId, returnId));
	const shared: Record<string, FieldValue> = {};
	const byEntity = new Map<string, Record<string, FieldValue>>();
	for (const r of rows) {
		const v = r.value as FieldValue;
		if (r.entityKey == null) {
			shared[r.ref] = v;
		} else {
			const m = byEntity.get(r.entityKey) ?? {};
			m[r.ref] = v;
			byEntity.set(r.entityKey, m);
		}
	}
	return { shared, byEntity, entityKeys: [...byEntity.keys()] };
}

/** The ref→value map a specific node sees: shared facts + this node's entity (if any). */
function inputsForNode(node: FormNode, inputs: ReturnInputs): Record<string, FieldValue> {
	const entity = node.instanceLabel ? inputs.byEntity.get(node.instanceLabel) : undefined;
	return { ...inputs.shared, ...(entity ?? {}) };
}

function makeContext(values: Record<string, FieldValue>, computed: Record<string, number> = {}): CondContext {
	return {
		resolve(token) {
			if (Object.prototype.hasOwnProperty.call(values, token)) {
				const v = values[token];
				return v == null ? undefined : v;
			}
			if (Object.prototype.hasOwnProperty.call(computed, token)) return computed[token];
			return undefined;
		},
		has(ref) {
			return Object.prototype.hasOwnProperty.call(values, ref) && values[ref] != null;
		},
	};
}

/** A form is required unless EVERY trigger is definitively false. */
function isRequired(spec: FormSpec, ctx: CondContext): boolean {
	if (!spec.triggers || spec.triggers.length === 0) return true;
	let anyFalseSeen = false;
	for (const t of spec.triggers) {
		const r = evalCondition(t.condition, ctx);
		if (r === true) return true;     // a satisfied trigger ⇒ required
		if (r === null) return true;     // unknown ⇒ conservatively required
		anyFalseSeen = true;
	}
	return anyFalseSeen ? false : true;
}

// ---------------------------------------------------------------------------
// Node processing
// ---------------------------------------------------------------------------

export interface ProcessResult {
	status: FormNode["status"];
	childIdsCreated: string[];
	missingInputs?: string[];
}

/**
 * Process one form node end to end: ensure spec → triggers → inputs → fill → store, then
 * expand dependencies into child nodes. Enqueues a job for each newly-created child.
 */
export async function processReturnForm(
	node: FormNode,
	args: { provider: TaxFormProvider; taxYear: number; returnInputs: ReturnInputs; db?: DB; model?: string },
): Promise<ProcessResult> {
	const db = args.db ?? defaultDb;
	const ref: FormRef = { jurisdiction: node.jurisdiction, formCode: node.formCode, taxYear: args.taxYear };
	const now = () => new Date().toISOString();

	await db.update(taxReturnForms).set({ status: "acquiring", updatedAt: now() }).where(eq(taxReturnForms.id, node.id));

	const ensured = await ensureSpec(ref, args.provider, db, args.model ?? "gpt-4o-mini");
	const spec = ensured.spec;
	await db
		.update(taxReturnForms)
		.set({ specId: ensured.specId, catalogId: ensured.catalogId, status: "ready", updatedAt: now() })
		.where(eq(taxReturnForms.id, node.id));

	const values = inputsForNode(node, args.returnInputs);
	const ctx = makeContext(values);

	// Triggers — is this form actually required?
	if (!isRequired(spec, ctx)) {
		await db
			.update(taxReturnForms)
			.set({ status: "skipped", triggerReason: "all triggers evaluated false", updatedAt: now() })
			.where(eq(taxReturnForms.id, node.id));
		return { status: "skipped", childIdsCreated: [] };
	}

	// Required inputs present?
	const missing = spec.inputs.filter((i) => i.required && !(Object.prototype.hasOwnProperty.call(values, i.ref) && values[i.ref] != null)).map((i) => i.ref);
	if (missing.length > 0) {
		await db
			.update(taxReturnForms)
			.set({ status: "needs_input", error: `missing required inputs: ${missing.join(", ")}`, updatedAt: now() })
			.where(eq(taxReturnForms.id, node.id));
		return { status: "needs_input", childIdsCreated: [], missingInputs: missing };
	}

	// Fill + store.
	const { values: fieldValues } = resolveFieldValues(spec, values);
	const filled = await fillPdf(ensured.blankBytes, spec, fieldValues);
	const path = filledFormPath(node.returnId, node.id);
	await uploadPdf(path, filled.pdfBytes);
	const isDraft = ensured.trustStatus !== "verified" && ensured.trustStatus !== "locked";
	await db
		.update(taxReturnForms)
		.set({
			status: "filled",
			filledPdfPath: path,
			fieldValues,
			isDraft,
			error: null,
			updatedAt: now(),
		})
		.where(eq(taxReturnForms.id, node.id));

	// Expand dependencies → child nodes.
	const childIdsCreated = await expandDependencies(node, spec, ctx, args.returnInputs, db);
	return { status: "filled", childIdsCreated };
}

async function expandDependencies(
	parent: FormNode,
	spec: FormSpec,
	ctx: CondContext,
	inputs: ReturnInputs,
	db: DB,
): Promise<string[]> {
	const created: string[] = [];
	for (const dep of spec.dependencies ?? []) {
		// Candidate instances. A 'per_entity' dep is evaluated ONCE PER ENTITY in that
		// entity's own context (shared facts + that entity's facts), since its gating
		// condition usually references per-entity data, e.g. has(business.name). A 'one'
		// dep is evaluated against the parent node's context.
		const candidates: Array<{ entityKey: string | null; ctx: CondContext }> =
			dep.multiplicity === "per_entity" && inputs.entityKeys.length > 0
				? inputs.entityKeys.map((k) => ({
						entityKey: k,
						ctx: makeContext({ ...inputs.shared, ...(inputs.byEntity.get(k) ?? {}) }),
					}))
				: [{ entityKey: null, ctx }];

		for (const cand of candidates) {
			const decision = evalCondition(dep.condition, cand.ctx);
			if (decision !== true) {
				if (decision === null) {
					logger.warn(
						{ parent: parent.formCode, dep: dep.formCode, condition: dep.condition, entity: cand.entityKey },
						"tax crawler: dependency condition unresolved — skipped (add on review)",
					);
				}
				continue;
			}
			const childId = await upsertChildNode(parent, dep, cand.entityKey, db);
			if (childId) {
				await enqueueJob(childId, parent.organizationId, db);
				created.push(childId);
			}
		}
	}
	return created;
}

/**
 * Create a dependency child node, deduped on its real identity: (returnId, formCode,
 * jurisdiction, entityKey). This is what makes the dependency graph a DAG rather than a
 * tree — the same form reached via two paths (a "diamond") resolves to one node, and a
 * per-entity form reached twice for the same entity isn't duplicated. copyIndex is a
 * derived display ordinal (count of existing instances of this form), not an identity.
 * Returns the new node id, or null if an instance already existed.
 *
 * Safe without a transaction because drainReturn processes one job at a time per return,
 * so there are never concurrent inserts for the same return.
 */
async function upsertChildNode(
	parent: FormNode,
	dep: FormSpec["dependencies"][number],
	entityKey: string | null,
	db: DB,
): Promise<string | null> {
	const siblings = await db
		.select({ id: taxReturnForms.id, label: taxReturnForms.instanceLabel })
		.from(taxReturnForms)
		.where(
			and(
				eq(taxReturnForms.returnId, parent.returnId),
				eq(taxReturnForms.formCode, dep.formCode),
				eq(taxReturnForms.jurisdiction, dep.jurisdiction),
			),
		);

	// Already present for this entity? (null label === the single 'one' instance.)
	if (siblings.some((s) => (s.label ?? null) === entityKey)) return null;

	const id = randomUUID();
	await db.insert(taxReturnForms).values({
		id,
		returnId: parent.returnId,
		organizationId: parent.organizationId,
		formCode: dep.formCode,
		jurisdiction: dep.jurisdiction,
		copyIndex: siblings.length, // derived ordinal among instances of this form
		instanceLabel: entityKey ?? undefined,
		parentFormId: parent.id,
		relationship: dep.relationship,
		triggerReason: dep.condition || "(always)",
		depth: parent.depth + 1,
		status: "pending",
	});
	return id;
}

// ---------------------------------------------------------------------------
// Queue draining
// ---------------------------------------------------------------------------

async function pickNextJob(returnId: string, db: DB): Promise<typeof taxFormCrawlJobs.$inferSelect | undefined> {
	const nodeIds = (await db.select({ id: taxReturnForms.id }).from(taxReturnForms).where(eq(taxReturnForms.returnId, returnId))).map((r) => r.id);
	if (nodeIds.length === 0) return undefined;
	const rows = await db
		.select()
		.from(taxFormCrawlJobs)
		.where(
			and(
				inArray(taxFormCrawlJobs.returnFormId, nodeIds),
				eq(taxFormCrawlJobs.state, "queued"),
				lte(taxFormCrawlJobs.runAfter, new Date().toISOString()),
			),
		)
		.orderBy(asc(taxFormCrawlJobs.runAfter), asc(taxFormCrawlJobs.createdAt))
		.limit(1);
	return rows[0];
}

async function runJob(
	job: typeof taxFormCrawlJobs.$inferSelect,
	args: { provider: TaxFormProvider; taxYear: number; returnInputs: ReturnInputs; db: DB; model?: string },
): Promise<void> {
	const { db } = args;
	const now = () => new Date().toISOString();
	const attempts = job.attempts + 1;
	await db.update(taxFormCrawlJobs).set({ state: "running", attempts, startedAt: now() }).where(eq(taxFormCrawlJobs.id, job.id));

	const node = (await db.select().from(taxReturnForms).where(eq(taxReturnForms.id, job.returnFormId)).limit(1))[0];
	if (!node) {
		await db.update(taxFormCrawlJobs).set({ state: "failed", error: "node not found", finishedAt: now() }).where(eq(taxFormCrawlJobs.id, job.id));
		return;
	}

	try {
		const result = await processReturnForm(node, { provider: args.provider, taxYear: args.taxYear, returnInputs: args.returnInputs, db, model: args.model });
		await db
			.update(taxFormCrawlJobs)
			.set({ state: "succeeded", finishedAt: now(), result: { status: result.status, children: result.childIdsCreated.length, missing: result.missingInputs ?? [] } })
			.where(eq(taxFormCrawlJobs.id, job.id));
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (attempts < job.maxAttempts) {
			const runAfter = new Date(Date.now() + RETRY_BACKOFF_MS).toISOString();
			await db.update(taxFormCrawlJobs).set({ state: "queued", error: msg, runAfter }).where(eq(taxFormCrawlJobs.id, job.id));
		} else {
			await db.update(taxFormCrawlJobs).set({ state: "failed", error: msg, finishedAt: now() }).where(eq(taxFormCrawlJobs.id, job.id));
			await db.update(taxReturnForms).set({ status: "failed", error: msg, updatedAt: now() }).where(eq(taxReturnForms.id, node.id));
		}
	}
}

export interface DrainSummary {
	jobsRun: number;
	/** Queued jobs still on the return (runnable now or waiting on backoff). When >0 the
	 *  caller should tick again — this is what lets a long crawl run in bounded batches
	 *  across several requests instead of one synchronous drain that blows the time limit. */
	jobsRemaining: number;
	nodes: Array<{ formCode: string; jurisdiction: string; copyIndex: number; status: string; depth: number; parentFormId: string | null }>;
	returnStatus: string;
}

/** Count of queued (not-yet-run) jobs for a return — runnable now OR scheduled (backoff). */
async function countQueuedJobs(returnId: string, db: DB): Promise<number> {
	const nodeIds = (await db.select({ id: taxReturnForms.id }).from(taxReturnForms).where(eq(taxReturnForms.returnId, returnId))).map((r) => r.id);
	if (nodeIds.length === 0) return 0;
	const rows = await db
		.select({ id: taxFormCrawlJobs.id })
		.from(taxFormCrawlJobs)
		.where(and(inArray(taxFormCrawlJobs.returnFormId, nodeIds), eq(taxFormCrawlJobs.state, "queued")));
	return rows.length;
}

/**
 * Drain the queue for one return until no runnable job remains (or the safety cap is hit),
 * then finalize the return's status. Jobs scheduled in the future (backoff) are left for a
 * later pass — drain returns rather than busy-waiting on them.
 */
export async function drainReturn(
	returnId: string,
	args: { provider: TaxFormProvider; db?: DB; model?: string; maxJobs?: number },
): Promise<DrainSummary> {
	const db = args.db ?? defaultDb;
	const ret = (await db.select().from(taxReturns).where(eq(taxReturns.id, returnId)).limit(1))[0];
	if (!ret) throw new Error(`tax_returns ${returnId} not found`);
	const cap = args.maxJobs ?? DEFAULT_MAX_JOBS;

	let jobsRun = 0;
	while (jobsRun < cap) {
		// Inputs are reloaded each iteration so a needs_input node retried after the client
		// supplies data picks up the new facts.
		const returnInputs = await loadInputs(returnId, db);
		const job = await pickNextJob(returnId, db);
		if (!job) break;
		await runJob(job, { provider: args.provider, taxYear: ret.taxYear, returnInputs, db, model: args.model });
		jobsRun++;
	}

	const returnStatus = await finalizeReturnStatus(returnId, db);
	const jobsRemaining = await countQueuedJobs(returnId, db);
	const nodes = (await db.select().from(taxReturnForms).where(eq(taxReturnForms.returnId, returnId)).orderBy(asc(taxReturnForms.depth)))
		.map((n) => ({ formCode: n.formCode, jurisdiction: n.jurisdiction, copyIndex: n.copyIndex, status: n.status, depth: n.depth, parentFormId: n.parentFormId }));

	return { jobsRun, jobsRemaining, nodes, returnStatus };
}

/**
 * Advance a return's crawl by a BOUNDED batch (default 2 forms' worth of work) and return
 * — for the async/polling run path so no single request exceeds the serverless time limit.
 * Seeds the root on first call (idempotent). The caller keeps ticking while jobsRemaining>0.
 */
export async function tickReturn(
	returnId: string,
	args: { provider: TaxFormProvider; db?: DB; model?: string; maxJobs?: number },
): Promise<DrainSummary> {
	const db = args.db ?? defaultDb;
	await seedReturn(returnId, db); // idempotent — no-op once the root + its job exist
	return drainReturn(returnId, { ...args, maxJobs: args.maxJobs ?? 2 });
}

async function finalizeReturnStatus(returnId: string, db: DB): Promise<string> {
	const nodes = await db.select({ status: taxReturnForms.status }).from(taxReturnForms).where(eq(taxReturnForms.returnId, returnId));
	const statuses = new Set(nodes.map((n) => n.status));
	let status: string;
	if (statuses.has("needs_input")) status = "collecting";        // waiting on the client
	else if (statuses.has("failed")) status = "review";            // a node errored — needs a look
	else if ([...statuses].every((s) => s === "verified" || s === "skipped")) status = "complete";
	else status = "review";                                        // filled drafts await preparer sign-off
	await db.update(taxReturns).set({ status, updatedAt: new Date().toISOString() }).where(eq(taxReturns.id, returnId));
	return status;
}

/** Convenience: seed the root node then drain. */
export async function crawlReturn(
	returnId: string,
	args: { provider: TaxFormProvider; db?: DB; model?: string; maxJobs?: number },
): Promise<DrainSummary> {
	const db = args.db ?? defaultDb;
	await seedReturn(returnId, db);
	return drainReturn(returnId, args);
}
