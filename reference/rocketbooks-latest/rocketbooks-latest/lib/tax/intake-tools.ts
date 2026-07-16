// Tax intake — the conversational front door to the tax engine.
//
// These tools hang off the existing AI chat (app/api/ai/chat → lib/ai/tools.ts default
// case) and are the missing connective tissue between a human and the crawler: they
// CREATE a return, RECORD the collected facts into tax_return_inputs (the controlled
// vocab the crawler consumes), RUN the crawl, and report what's still NEEDED.
//
// The intended chat flow mirrors the user's original spec:
//   1. classify_tax_return  — personal vs business → seed form (1040 / 1065 / 1120 / 1120S / 1041)
//   2. list_tax_facts       — what facts to collect (controlled vocabulary, by relevance)
//   3. record_tax_facts     — write interview answers / extracted doc values to the return
//   4. run_tax_return       — crawl: determine forms, fill them, surface the form tree
//   5. (loop) needs_input nodes tell the assistant exactly which refs are still missing
//
// Server-only. Org-scoped: every row is written under ctx.organizationId.

import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { taxReturns, taxReturnForms, taxReturnInputs } from "@/db/schema";
import { getEffectiveUserId } from "@/lib/auth/impersonate";
import { TAX_INPUT_REFS, isKnownInputRef } from "./input-refs";
import { PdfFillProvider } from "./provider";
import { openAiComprehender } from "./comprehend";
import { crawlReturn, tickReturn } from "./crawler";
import { extractTaxDocument, extractPriorReturn, EXTRACTABLE_DOC_TYPES, type ExtractableDocType } from "./extract";
import { downloadPdf } from "./storage";
import { getIntakeStatus, advanceIntake, INTAKE_PHASES, type IntakePhase } from "./onboarding";

export interface TaxIntakeContext {
	organizationId: string;
	/**
	 * Acting user id. In the chat request this is omitted and resolved from the session
	 * via getEffectiveUserId(); standalone callers (scripts/tests) with no request scope
	 * pass it explicitly.
	 */
	userId?: string;
	/** Per-turn id; gates advance_tax_intake to one phase-advance per return per turn. */
	turnId?: string;
}

// Entity type → the federal seed form the crawl starts from.
const ENTITY_SEED_FORM: Record<string, string> = {
	sole_prop: "1040",
	llc: "1040", // single-member default; multi-member would be 1065 (asked at classify time)
	partnership: "1065",
	s_corp: "1120S",
	c_corp: "1120",
	beneficial_trust: "1041",
	business_trust: "1041",
	nonprofit: "990",
	other: "1040",
};

export const TAX_INTAKE_TOOL_DEFINITIONS = [
	{
		type: "function" as const,
		function: {
			name: "classify_tax_return",
			description:
				"Start a tax return by classifying it. Call this once you know whether it's a PERSONAL or BUSINESS return and (for business) the entity type. Creates the return and picks the federal seed form (personal→1040; business: partnership→1065, s_corp→1120S, c_corp→1120, trust→1041, sole_prop/single-member LLC→1040). Returns the returnId to use in later tax tools. If a return for this client+year already exists, it is reused.",
			parameters: {
				type: "object",
				properties: {
					return_type: { type: "string", enum: ["personal", "business"] },
					tax_year: { type: "number", description: "e.g. 2023" },
					entity_type: {
						type: "string",
						enum: ["sole_prop", "llc", "partnership", "s_corp", "c_corp", "beneficial_trust", "business_trust", "nonprofit", "other"],
						description: "Required when return_type=business.",
					},
					jurisdictions: {
						type: "array",
						items: { type: "string" },
						description: "Federal + state codes, e.g. ['US','CA']. Defaults to ['US'].",
					},
				},
				required: ["return_type", "tax_year"],
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "get_tax_intake_status",
			description:
				"Get the guided-intake state of a return: which phase the conversation is in (classify → documents → interview → review → run → complete), one-line guidance for that phase, and signals (fact count, unconfirmed facts, # documents processed, form/needs-input counts). CALL THIS at the start of a turn about an in-progress return to know what to do next. The phase is the source of truth for where you are.",
			parameters: {
				type: "object",
				properties: { return_id: { type: "string" } },
				required: ["return_id"],
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "advance_tax_intake",
			description:
				"Move the intake conversation to the next phase (or a specific one). Phases: documents (collect uploads), interview (ask for what docs don't cover), review (confirm facts), run (fill forms), complete. Use 'next' to advance one step. Only advance when the current phase is genuinely done (e.g. leave 'documents' when the client has no more to upload; leave 'interview' when required facts are collected). Turn-gated: at most one advance per return per turn — let the user respond before advancing again. Do NOT advance on a user question or hesitation; stay on the phase and answer.",
			parameters: {
				type: "object",
				properties: {
					return_id: { type: "string" },
					to: { type: "string", enum: ["next", "classify", "documents", "interview", "review", "run", "complete"] },
				},
				required: ["return_id", "to"],
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "list_tax_facts",
			description:
				"List the collectable tax facts (the controlled vocabulary) the system understands, with their refs, labels, value types, and which source document each typically comes from. Use this to know what to ask the client for, or to map a value from an uploaded W-2/1099 to the right ref before calling record_tax_facts. Returns refs grouped by topic.",
			parameters: {
				type: "object",
				properties: {
					group: { type: "string", description: "Optional ref prefix filter, e.g. 'w2', 'business', 'taxpayer'." },
				},
				required: [],
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "record_tax_facts",
			description:
				"Save collected facts onto a tax return. Each fact's `ref` MUST be from the controlled vocabulary (call list_tax_facts). Facts feed the engine that decides which forms are required and fills them. For per-entity facts (one business's numbers, one W-2), pass entity_key to group them (e.g. the business name or employer name); omit for shared facts (taxpayer name, filing status). Re-recording the same ref+entity_key updates it. Returns how many were saved and any rejected refs.",
			parameters: {
				type: "object",
				properties: {
					return_id: { type: "string" },
					facts: {
						type: "array",
						items: {
							type: "object",
							properties: {
								ref: { type: "string", description: "Controlled-vocab ref, e.g. 'w2.box1'." },
								value: { description: "string | number | boolean" },
								entity_key: { type: "string", description: "Groups per-entity facts (business/employer name). Omit for shared facts." },
							},
							required: ["ref", "value"],
						},
					},
				},
				required: ["return_id", "facts"],
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "extract_tax_document",
			description:
				"Read an UPLOADED tax document (W-2, 1099-NEC/MISC/INT/DIV, K-1) and auto-record its box values as facts on the return — so the client doesn't type them. Pass the storage_path of the uploaded PDF (from the upload step). Detects the doc type if you don't pass it. Extracted values are recorded UNCONFIRMED for the user to review/correct (extraction can misread). All values from one document are grouped under that employer/payer as the entity. After calling, tell the user what was read and ask them to confirm.",
			parameters: {
				type: "object",
				properties: {
					return_id: { type: "string" },
					storage_path: { type: "string", description: "Path of the uploaded PDF in the tax-forms bucket." },
					doc_type: { type: "string", enum: ["W-2", "1099-NEC", "1099-MISC", "1099-INT", "1099-DIV", "K-1"], description: "Optional — declare the type to skip auto-detection." },
				},
				required: ["return_id", "storage_path"],
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "import_prior_return",
			description:
				"Read the client's UPLOADED prior-year tax return (a full filed 1040/1065/1120/1120S/1041 PDF) to jump-start this year. Pass the storage_path. Reads (1) carry-forward identity (name/SSN/address/filing status/EIN — recorded UNCONFIRMED to confirm), and (2) the list of forms that were FILED last year — which it pre-populates as this year's expected forms (shown in the UI), so you don't have to interview from scratch. Use this on the wizard's 'do you have last year's return?' = yes path. After it runs, tell the client which forms carried over and that you'll verify each is in the system.",
			parameters: {
				type: "object",
				properties: {
					return_id: { type: "string" },
					storage_path: { type: "string", description: "Path of the uploaded prior-return PDF in the tax-forms bucket." },
				},
				required: ["return_id", "storage_path"],
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "run_tax_return",
			description:
				"Start filling the return: determine which federal/state forms are required from the recorded facts and begin acquiring + filling them (drafts), recursing into dependent schedules. Returns the current form tree, the return status, and `stillWorking`/`jobsRemaining` — when stillWorking is true the crawl continues in the background and the form list updates live (tell the user it's working, don't claim it's done). Call after recording facts; re-callable to pick up newly recorded facts. The UI renders the form tree as a card.",
			parameters: {
				type: "object",
				properties: {
					return_id: { type: "string" },
				},
				required: ["return_id"],
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "tick_tax_return",
			description:
				"Advance an in-progress return's form-filling by one batch and report jobsRemaining. Normally driven by the workspace UI's background poller, not by you — only call it if the user explicitly asks you to keep going / check progress on a return still working.",
			parameters: { type: "object", properties: { return_id: { type: "string" } }, required: ["return_id"] },
		},
	},
	{
		type: "function" as const,
		function: {
			name: "get_tax_return_status",
			description:
				"Read the current state of a tax return without running anything: the form tree, each form's status and whether it's a draft, and which facts are still missing on any needs_input form. Use this to tell the client what's left to do.",
			parameters: {
				type: "object",
				properties: {
					return_id: { type: "string" },
				},
				required: ["return_id"],
			},
		},
	},
];

const INTAKE_TOOL_NAMES = new Set(TAX_INTAKE_TOOL_DEFINITIONS.map((t) => t.function.name));
export function isTaxIntakeToolName(name: string): boolean {
	return INTAKE_TOOL_NAMES.has(name);
}

/** A lazily-built provider — real IRS acquisition + OpenAI comprehension. */
function buildProvider() {
	return new PdfFillProvider({ comprehender: openAiComprehender({ model: "gpt-4o-mini" }) });
}

/** Confirm a return belongs to this org before any read/write. */
async function loadOwnedReturn(orgId: string, returnId: string) {
	const row = (
		await db.select().from(taxReturns).where(and(eq(taxReturns.id, returnId), eq(taxReturns.organizationId, orgId))).limit(1)
	)[0];
	return row ?? null;
}

/**
 * Upsert one fact onto a return, keyed on (return, ref, entity_key) via the 0097 partial-
 * unique indexes. `confirmed` is true for hand-entered facts and FALSE for AI-extracted
 * ones (they're a draft of a fact, pending review). On update, only raise confirmed →
 * never silently demote a user-confirmed fact back to unconfirmed via a re-extraction.
 */
async function upsertFact(
	orgId: string,
	returnId: string,
	ref: string,
	value: string | number | boolean,
	entityKey: string | null,
	confirmed: boolean,
	confidence?: number,
): Promise<void> {
	const conf = confidence === undefined ? null : String(confidence);
	const existing = (
		await db
			.select({ id: taxReturnInputs.id, confirmedByUser: taxReturnInputs.confirmedByUser })
			.from(taxReturnInputs)
			.where(
				and(
					eq(taxReturnInputs.returnId, returnId),
					eq(taxReturnInputs.ref, ref),
					entityKey === null ? isNullEntity() : eq(taxReturnInputs.entityKey, entityKey),
				),
			)
			.limit(1)
	)[0];
	if (existing) {
		await db
			.update(taxReturnInputs)
			.set({ value, confirmedByUser: confirmed || existing.confirmedByUser, confidence: conf })
			.where(eq(taxReturnInputs.id, existing.id));
	} else {
		await db.insert(taxReturnInputs).values({
			id: randomUUID(),
			returnId,
			organizationId: orgId,
			ref,
			entityKey: entityKey ?? undefined,
			value,
			confirmedByUser: confirmed,
			confidence: conf,
		});
	}
}

export async function executeTaxIntakeTool(
	ctx: TaxIntakeContext,
	name: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	switch (name) {
		case "classify_tax_return": {
			const returnType = String(args.return_type ?? "");
			if (returnType !== "personal" && returnType !== "business") return { error: "return_type must be 'personal' or 'business'" };
			const taxYear = Number(args.tax_year);
			if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2100) return { error: "tax_year must be a valid year" };

			const entityType = returnType === "business" ? String(args.entity_type ?? "") : null;
			if (returnType === "business" && !entityType) return { error: "entity_type is required for a business return" };

			const seedFormCode = returnType === "personal" ? "1040" : (ENTITY_SEED_FORM[entityType!] ?? "1040");
			const jurisdictions = Array.isArray(args.jurisdictions) && args.jurisdictions.length
				? (args.jurisdictions as unknown[]).map(String)
				: ["US"];

			// Reuse an existing return for this org+year+type rather than spawning duplicates.
			const existing = (
				await db
					.select()
					.from(taxReturns)
					.where(and(eq(taxReturns.organizationId, ctx.organizationId), eq(taxReturns.taxYear, taxYear), eq(taxReturns.returnType, returnType)))
					.limit(1)
			)[0];
			if (existing) {
				return { ok: true, returnId: existing.id, reused: true, seedFormCode: existing.seedFormCode, taxYear, returnType, status: existing.status };
			}

			const userId = ctx.userId ?? (await getEffectiveUserId());
			const id = randomUUID();
			await db.insert(taxReturns).values({
				id,
				organizationId: ctx.organizationId,
				taxYear,
				returnType,
				entityType: entityType ?? undefined,
				jurisdictions,
				seedFormCode,
				status: "collecting",
				createdByUserId: userId,
			});
			return { ok: true, returnId: id, reused: false, seedFormCode, taxYear, returnType, jurisdictions };
		}

		case "get_tax_intake_status": {
			const returnId = String(args.return_id ?? "");
			const status = await getIntakeStatus(ctx.organizationId, returnId);
			if (!status) return { error: "return not found" };
			return status;
		}

		case "advance_tax_intake": {
			const returnId = String(args.return_id ?? "");
			const toRaw = String(args.to ?? "next");
			const to = toRaw === "next" || (INTAKE_PHASES as readonly string[]).includes(toRaw) ? (toRaw as "next" | IntakePhase) : null;
			if (!to) return { error: `invalid phase '${toRaw}'` };
			const result = await advanceIntake(ctx.organizationId, returnId, to, ctx.turnId);
			if (!result.ok) return { error: result.error };
			// Return the fresh status so the assistant immediately knows the new phase + guidance.
			const status = await getIntakeStatus(ctx.organizationId, returnId);
			return { ok: true, phase: result.phase, status };
		}

		case "list_tax_facts": {
			const group = typeof args.group === "string" ? args.group.trim().toLowerCase() : "";
			const refs = TAX_INPUT_REFS.filter((r) => !group || r.ref.toLowerCase().startsWith(group)).map((r) => ({
				ref: r.ref,
				label: r.label,
				valueType: r.valueType,
				perEntity: Boolean(r.perEntity),
				fromDocuments: r.docTypes ?? [],
			}));
			return { count: refs.length, refs };
		}

		case "record_tax_facts": {
			const returnId = String(args.return_id ?? "");
			const ret = await loadOwnedReturn(ctx.organizationId, returnId);
			if (!ret) return { error: "return not found" };
			const facts = Array.isArray(args.facts) ? (args.facts as Array<Record<string, unknown>>) : [];
			if (!facts.length) return { error: "facts array is empty" };

			const saved: Array<{ ref: string; entity_key: string | null }> = [];
			const rejected: Array<{ ref: string; reason: string }> = [];
			for (const f of facts) {
				const ref = String(f.ref ?? "");
				if (!isKnownInputRef(ref)) {
					rejected.push({ ref, reason: "not in controlled vocabulary (call list_tax_facts)" });
					continue;
				}
				if (f.value === undefined || f.value === null || f.value === "") {
					rejected.push({ ref, reason: "empty value" });
					continue;
				}
				const entityKey = typeof f.entity_key === "string" && f.entity_key.trim() ? f.entity_key.trim() : null;
				const value = f.value as string | number | boolean;
				// Hand-entered via this tool → confirmed.
				await upsertFact(ctx.organizationId, returnId, ref, value, entityKey, true);
				saved.push({ ref, entity_key: entityKey });
			}
			return { ok: true, savedCount: saved.length, saved, rejected };
		}

		case "extract_tax_document": {
			const returnId = String(args.return_id ?? "");
			const ret = await loadOwnedReturn(ctx.organizationId, returnId);
			if (!ret) return { error: "return not found" };
			const storagePath = String(args.storage_path ?? "");
			if (!storagePath) return { error: "storage_path required (the uploaded PDF's tax-forms bucket path)" };
			const declared = typeof args.doc_type === "string" && (EXTRACTABLE_DOC_TYPES as readonly string[]).includes(args.doc_type)
				? (args.doc_type as ExtractableDocType)
				: undefined;

			let pdfBytes: Uint8Array;
			try {
				pdfBytes = await downloadPdf(storagePath);
			} catch (e) {
				return { error: `could not read uploaded document: ${e instanceof Error ? e.message : String(e)}` };
			}

			const result = await extractTaxDocument(pdfBytes, {
				docType: declared,
				usage: { userId: ctx.userId ?? null, orgId: ctx.organizationId, actor: "tax-intake", feature: "tax-extract-doc" },
			});
			if (result.docType === "unknown") {
				return { ok: true, docType: "unknown", extracted: 0, message: "Could not identify the document type. Ask the user what it is, or enter the values manually." };
			}

			// Record every extracted fact UNCONFIRMED — they surface in the editor for review.
			// All facts from one document share the entity (employer/payer) as entity_key.
			// Per-field confidence is persisted (lowered for boxes the verify pass / cross-
			// checks flagged) so the editor can highlight what to double-check.
			const entityKey = result.entityLabel;
			const recorded: Array<{ ref: string; value: unknown; confidence: number; needsReview: boolean; reviewReason?: string }> = [];
			for (const f of result.facts) {
				await upsertFact(ctx.organizationId, returnId, f.ref, f.value, entityKey, false, f.confidence);
				recorded.push({ ref: f.ref, value: f.value, confidence: f.confidence, needsReview: Boolean(f.needsReview), reviewReason: f.reviewReason });
			}
			const flagged = recorded.filter((r) => r.needsReview);
			return {
				ok: true,
				docType: result.docType,
				entityLabel: entityKey,
				extracted: recorded.length,
				facts: recorded,
				checks: result.checks,
				flaggedForReview: flagged.length,
				note:
					flagged.length > 0
						? `Extracted ${recorded.length} values; ${flagged.length} need a closer look (the two AI reads disagreed or a math check failed). Read those back to the user to confirm. All values are UNCONFIRMED until reviewed.`
						: "Extracted facts are UNCONFIRMED — read them back to the user to confirm before running the return.",
			};
		}

		case "import_prior_return": {
			const returnId = String(args.return_id ?? "");
			const ret = await loadOwnedReturn(ctx.organizationId, returnId);
			if (!ret) return { error: "return not found" };
			const storagePath = String(args.storage_path ?? "");
			if (!storagePath) return { error: "storage_path required (the uploaded prior-return PDF)" };

			let priorBytes: Uint8Array;
			try {
				priorBytes = await downloadPdf(storagePath);
			} catch (e) {
				return { error: `could not read prior return: ${e instanceof Error ? e.message : String(e)}` };
			}

			const reading = await extractPriorReturn(priorBytes, {
				usage: { userId: ctx.userId ?? null, orgId: ctx.organizationId, actor: "tax-intake", feature: "tax-extract-prior-return" },
			});

			// Carry-forward identity facts → UNCONFIRMED (a starting point to confirm).
			for (const f of reading.facts) {
				await upsertFact(ctx.organizationId, returnId, f.ref, f.value, null, false, f.confidence);
			}

			// Pre-seed the forms filed last year as PENDING nodes so they show in the UI now
			// ("you filed these last year"). A later run_tax_return picks them up;
			// onConflictDoNothing keeps it idempotent. Only seed forms not already present.
			const priorJurisdiction = ret.jurisdictions?.[0] ?? "US";
			const seeded: string[] = [];
			for (const formCode of reading.filedForms) {
				const inserted = await db
					.insert(taxReturnForms)
					.values({
						id: randomUUID(),
						returnId,
						organizationId: ctx.organizationId,
						formCode,
						jurisdiction: priorJurisdiction,
						copyIndex: 0,
						depth: 0,
						status: "pending",
						triggerReason: "carried forward from prior-year return",
					})
					.onConflictDoNothing({
						target: [taxReturnForms.returnId, taxReturnForms.formCode, taxReturnForms.jurisdiction, taxReturnForms.copyIndex],
					})
					.returning({ id: taxReturnForms.id });
				if (inserted[0]) seeded.push(formCode);
			}

			return {
				ok: true,
				returnType: reading.returnType,
				priorTaxYear: reading.priorTaxYear,
				carriedForwardFacts: reading.facts.length,
				filedForms: reading.filedForms,
				seededForms: seeded,
				unsupportedForms: reading.unsupportedForms,
				note:
					`Read the prior ${reading.returnType} return${reading.priorTaxYear ? ` (${reading.priorTaxYear})` : ""}. ` +
					`Carried forward ${reading.facts.length} identity fields (UNCONFIRMED — confirm them) and pre-listed ${seeded.length} form(s) likely needed again` +
					(reading.unsupportedForms.length ? `. Note: ${reading.unsupportedForms.join(", ")} were on the prior return but aren't in the system yet.` : ".") +
					" Next: confirm the carry-forward facts, collect this year's documents, then run the return.",
			};
		}

		case "run_tax_return": {
			const returnId = String(args.return_id ?? "");
			const ret = await loadOwnedReturn(ctx.organizationId, returnId);
			if (!ret) return { error: "return not found" };
			// Bounded batch so a fan-out of 6-8 forms (each a download + AI passes) can't blow
			// the request time limit. Kicks the crawl; the workspace polls tick_tax_return to
			// finish. The assistant just reports that it started and how much remains.
			const summary = await tickReturn(returnId, { provider: buildProvider() });
			return {
				ok: true,
				returnId,
				returnStatus: summary.returnStatus,
				jobsRun: summary.jobsRun,
				jobsRemaining: summary.jobsRemaining,
				stillWorking: summary.jobsRemaining > 0,
				forms: summary.nodes.map((n) => ({
					formCode: n.formCode,
					jurisdiction: n.jurisdiction,
					copyIndex: n.copyIndex,
					depth: n.depth,
					status: n.status,
				})),
				note:
					summary.jobsRemaining > 0
						? "Started filling the forms — RocketBooks is downloading and mapping them in the background. The form list updates live; this can take a minute."
						: "All forms processed (drafts for review).",
			};
		}

		case "tick_tax_return": {
			// Advance the crawl one bounded batch — called by the workspace poller, not the
			// assistant. Returns jobsRemaining so the poller knows whether to keep going.
			const returnId = String(args.return_id ?? "");
			const ret = await loadOwnedReturn(ctx.organizationId, returnId);
			if (!ret) return { error: "return not found" };
			const summary = await tickReturn(returnId, { provider: buildProvider() });
			return {
				ok: true,
				returnId,
				returnStatus: summary.returnStatus,
				jobsRun: summary.jobsRun,
				jobsRemaining: summary.jobsRemaining,
				stillWorking: summary.jobsRemaining > 0,
			};
		}

		case "get_tax_return_status": {
			const returnId = String(args.return_id ?? "");
			const ret = await loadOwnedReturn(ctx.organizationId, returnId);
			if (!ret) return { error: "return not found" };
			const nodes = await db.select().from(taxReturnForms).where(eq(taxReturnForms.returnId, returnId));
			return {
				returnId,
				taxYear: ret.taxYear,
				returnType: ret.returnType,
				status: ret.status,
				forms: nodes.map((n) => ({
					formCode: n.formCode,
					jurisdiction: n.jurisdiction,
					copyIndex: n.copyIndex,
					status: n.status,
					isDraft: n.isDraft,
					// error carries the "missing required inputs: …" message on needs_input nodes.
					needs: n.status === "needs_input" ? n.error : undefined,
				})),
			};
		}

		default:
			return { error: `Unknown tax intake tool: ${name}` };
	}
}

// drizzle helper: WHERE entity_key IS NULL (matches the partial-unique index path).
function isNullEntity() {
	return sql`${taxReturnInputs.entityKey} is null`;
}
