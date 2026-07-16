// Conversational tax-intake onboarding — the stateful sequencer that turns the intake
// TOOLS (classify/extract/record/run) into a guided, resumable flow. Modeled on the
// accounting onboarding state machine: a phase per step, a status reader the assistant
// calls each turn to orient, and a turn-gated advance so the AI can't skip steps.
//
// Phases:
//   classify   — implicit: the return row already exists (type/year/entity chosen)
//   documents  — "upload your W-2s/1099s" → extract_tax_document fills facts
//   interview  — fallback Q&A for anything not on a document (filing status, deductions…)
//   review     — confirm the collected facts (esp. unconfirmed/extracted ones)
//   run        — run_tax_return: determine + fill forms, loop on needs_input
//   complete   — drafts ready for preparer review
//
// `intake_phase` on tax_returns tracks where the CONVERSATION is; `status` tracks the
// forms. They move independently. Server-only.

import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { taxReturns, taxReturnInputs, taxReturnForms } from "@/db/schema";

export const INTAKE_PHASES = ["classify", "documents", "interview", "review", "run", "complete"] as const;
export type IntakePhase = (typeof INTAKE_PHASES)[number];

/** Linear order for "next"; the assistant may also jump to a named phase. */
const PHASE_ORDER: IntakePhase[] = ["classify", "documents", "interview", "review", "run", "complete"];

export function nextPhase(p: IntakePhase): IntakePhase {
	const i = PHASE_ORDER.indexOf(p);
	return i < 0 || i === PHASE_ORDER.length - 1 ? "complete" : PHASE_ORDER[i + 1];
}

/** One-line guidance the assistant uses to know what this phase is for. */
export const PHASE_GUIDANCE: Record<IntakePhase, string> = {
	classify: "Confirm the return type, tax year, and (business) entity type. The return already exists once you're past here.",
	documents: "Ask the client to upload their W-2s, 1099s, K-1s, and prior-year return. Each upload auto-extracts box values. When they have no more documents, move to interview.",
	interview: "Collect what the documents don't cover by asking: filing status, dependents, state(s), itemize-vs-standard, and any income/expenses not on an uploaded form. Record each answer.",
	review: "Walk the client through the collected facts — especially AI-extracted ones marked unconfirmed — and have them confirm or correct before running.",
	run: "Run the return. If any form comes back needs_input, ask the client for exactly those missing values, record them, and run again.",
	complete: "The draft forms are ready. Remind the client they are DRAFTS for preparer review, not filed returns.",
};

export interface IntakeStatus {
	returnId: string;
	phase: IntakePhase;
	guidance: string;
	returnType: string;
	taxYear: number;
	entityType: string | null;
	/** Signals that help the assistant decide whether to advance. */
	signals: {
		factCount: number;
		unconfirmedFactCount: number;
		documentEntityCount: number; // distinct entity_keys = roughly # of docs processed
		formCount: number;
		needsInputFormCount: number;
		filledFormCount: number;
	};
}

/** Read the full intake state for the assistant to orient at the top of a turn. Org-scoped. */
export async function getIntakeStatus(orgId: string, returnId: string): Promise<IntakeStatus | null> {
	const ret = (
		await db.select().from(taxReturns).where(eq(taxReturns.id, returnId)).limit(1)
	)[0];
	if (!ret || ret.organizationId !== orgId) return null;

	const inputs = await db.select().from(taxReturnInputs).where(eq(taxReturnInputs.returnId, returnId));
	const forms = await db.select().from(taxReturnForms).where(eq(taxReturnForms.returnId, returnId));
	const entities = new Set(inputs.map((i) => i.entityKey).filter((k): k is string => Boolean(k)));

	const phase = (ret.intakePhase as IntakePhase) ?? "documents";
	return {
		returnId,
		phase,
		guidance: PHASE_GUIDANCE[phase] ?? "",
		returnType: ret.returnType,
		taxYear: ret.taxYear,
		entityType: ret.entityType ?? null,
		signals: {
			factCount: inputs.length,
			unconfirmedFactCount: inputs.filter((i) => !i.confirmedByUser).length,
			documentEntityCount: entities.size,
			formCount: forms.length,
			needsInputFormCount: forms.filter((f) => f.status === "needs_input").length,
			filledFormCount: forms.filter((f) => f.status === "filled" || f.status === "verified").length,
		},
	};
}

export interface AdvanceResult {
	ok: boolean;
	error?: string;
	phase?: IntakePhase;
}

/**
 * Move the intake phase. `to` is either "next" or a specific phase. Turn-gated: a given
 * turnId may advance a return at most once, so the assistant can't fast-forward the whole
 * interview in a single breath (mirrors the accounting onboarding gate). Org-scoped.
 */
const advancedThisTurn = new Map<string, Set<string>>(); // turnId → returnIds advanced

export async function advanceIntake(
	orgId: string,
	returnId: string,
	to: "next" | IntakePhase,
	turnId?: string,
): Promise<AdvanceResult> {
	const ret = (await db.select().from(taxReturns).where(eq(taxReturns.id, returnId)).limit(1))[0];
	if (!ret || ret.organizationId !== orgId) return { ok: false, error: "return not found" };

	if (turnId) {
		const set = advancedThisTurn.get(turnId) ?? new Set<string>();
		if (set.has(returnId)) {
			return { ok: false, error: "already advanced this return this turn — let the user respond before advancing again." };
		}
		set.add(returnId);
		advancedThisTurn.set(turnId, set);
	}

	const current = (ret.intakePhase as IntakePhase) ?? "documents";
	const target: IntakePhase = to === "next" ? nextPhase(current) : to;
	if (!INTAKE_PHASES.includes(target)) return { ok: false, error: `unknown phase '${to}'` };

	await db.update(taxReturns).set({ intakePhase: target, updatedAt: new Date().toISOString() }).where(eq(taxReturns.id, returnId));
	return { ok: true, phase: target };
}
