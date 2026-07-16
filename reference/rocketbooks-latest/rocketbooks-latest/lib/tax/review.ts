// Preparer review of FormSpecs — the trust ladder's promotion mechanism.
//
// Specs are GLOBAL knowledge (no org_id): a spec is learned once and reused for every
// org, so verifying one benefits everyone. A spec ships as `learned` (AI-derived, draft);
// a preparer reviews its field mappings + dependencies against the real form and promotes
// it. Every transition writes a tax_form_spec_reviews audit row.
//
// Trust ladder: learned → verified → locked, with send-back/unlock/reject edges.
// When a spec reaches verified/locked, forms filled with it stop being drafts (the crawler
// reads trustStatus at fill time; see crawler.ts). Already-filled draft forms don't flip
// retroactively — they re-fill non-draft on the next run.
//
// Server-only.

import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { taxFormSpecs, taxFormCatalog, taxFormSources, taxFormSpecReviews, users } from "@/db/schema";
import type { FormSpec, SpecTrustStatus } from "./spec";

/** Allowed trust-ladder transitions and the action label for each. */
export const SPEC_TRANSITIONS: Record<SpecTrustStatus, Array<{ to: SpecTrustStatus; label: string; tone: "approve" | "neutral" | "reject" }>> = {
	learned: [
		{ to: "verified", label: "Approve (verify)", tone: "approve" },
		{ to: "deprecated", label: "Reject (deprecate)", tone: "reject" },
	],
	verified: [
		{ to: "locked", label: "Lock", tone: "approve" },
		{ to: "learned", label: "Send back to draft", tone: "neutral" },
		{ to: "deprecated", label: "Reject (deprecate)", tone: "reject" },
	],
	locked: [
		{ to: "verified", label: "Unlock", tone: "neutral" },
	],
	deprecated: [
		{ to: "learned", label: "Reopen as draft", tone: "neutral" },
	],
};

export function isAllowedTransition(from: SpecTrustStatus, to: SpecTrustStatus): boolean {
	return (SPEC_TRANSITIONS[from] ?? []).some((t) => t.to === to);
}

export interface SpecReviewData {
	specId: string;
	formCode: string;
	jurisdiction: string;
	taxYear: number;
	title: string;
	trustStatus: SpecTrustStatus;
	confidence: number | null;
	model: string | null;
	createdAt: string;
	sourceUrl: string;
	spec: FormSpec;
	history: Array<{
		id: string;
		fromStatus: string;
		toStatus: string;
		reviewerEmail: string | null;
		notes: string | null;
		createdAt: string;
	}>;
	allowedTransitions: Array<{ to: SpecTrustStatus; label: string; tone: string }>;
}

/** Load one spec for the review page (specs are global, so no org scoping). */
export async function getSpecReviewData(specId: string): Promise<SpecReviewData | null> {
	const row = (
		await db
			.select({
				id: taxFormSpecs.id,
				taxYear: taxFormSpecs.taxYear,
				spec: taxFormSpecs.spec,
				trustStatus: taxFormSpecs.trustStatus,
				confidence: taxFormSpecs.confidence,
				model: taxFormSpecs.model,
				createdAt: taxFormSpecs.createdAt,
				formCode: taxFormCatalog.formCode,
				jurisdiction: taxFormCatalog.jurisdiction,
				title: taxFormCatalog.title,
				sourceUrl: taxFormSources.sourceUrl,
			})
			.from(taxFormSpecs)
			.innerJoin(taxFormCatalog, eq(taxFormSpecs.catalogId, taxFormCatalog.id))
			.innerJoin(taxFormSources, eq(taxFormSpecs.sourceId, taxFormSources.id))
			.where(eq(taxFormSpecs.id, specId))
			.limit(1)
	)[0];
	if (!row) return null;

	const historyRows = await db
		.select({
			id: taxFormSpecReviews.id,
			fromStatus: taxFormSpecReviews.fromStatus,
			toStatus: taxFormSpecReviews.toStatus,
			notes: taxFormSpecReviews.notes,
			createdAt: taxFormSpecReviews.createdAt,
			reviewerEmail: users.email,
		})
		.from(taxFormSpecReviews)
		.leftJoin(users, eq(taxFormSpecReviews.reviewerUserId, users.id))
		.where(eq(taxFormSpecReviews.specId, specId))
		.orderBy(desc(taxFormSpecReviews.createdAt));

	const trust = row.trustStatus as SpecTrustStatus;
	return {
		specId: row.id,
		formCode: row.formCode,
		jurisdiction: row.jurisdiction,
		taxYear: row.taxYear,
		title: row.title,
		trustStatus: trust,
		confidence: row.confidence === null ? null : Number(row.confidence),
		model: row.model,
		createdAt: row.createdAt,
		sourceUrl: row.sourceUrl,
		spec: row.spec,
		history: historyRows.map((h) => ({
			id: h.id,
			fromStatus: h.fromStatus,
			toStatus: h.toStatus,
			reviewerEmail: h.reviewerEmail ?? null,
			notes: h.notes ?? null,
			createdAt: h.createdAt,
		})),
		allowedTransitions: (SPEC_TRANSITIONS[trust] ?? []).map((t) => ({ to: t.to, label: t.label, tone: t.tone })),
	};
}

export interface ReviewResult {
	ok: boolean;
	error?: string;
	newStatus?: SpecTrustStatus;
}

/**
 * Record a trust-ladder transition: validate it's allowed from the current status, update
 * the spec, and append an audit row. Idempotent-ish — re-recording the same status is a
 * no-op error rather than a duplicate audit entry.
 */
export async function recordSpecReview(
	specId: string,
	reviewerUserId: string,
	toStatus: SpecTrustStatus,
	notes: string | null,
): Promise<ReviewResult> {
	const cur = (await db.select({ trustStatus: taxFormSpecs.trustStatus }).from(taxFormSpecs).where(eq(taxFormSpecs.id, specId)).limit(1))[0];
	if (!cur) return { ok: false, error: "Spec not found." };
	const from = cur.trustStatus as SpecTrustStatus;
	if (from === toStatus) return { ok: false, error: `Spec is already ${toStatus}.` };
	if (!isAllowedTransition(from, toStatus)) return { ok: false, error: `Can't move a ${from} spec to ${toStatus}.` };

	await db.update(taxFormSpecs).set({ trustStatus: toStatus }).where(eq(taxFormSpecs.id, specId));
	await db.insert(taxFormSpecReviews).values({
		id: randomUUID(),
		specId,
		reviewerUserId,
		fromStatus: from,
		toStatus,
		notes: notes && notes.trim() ? notes.trim() : null,
	});
	return { ok: true, newStatus: toStatus };
}
