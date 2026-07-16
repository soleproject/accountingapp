'use server';

import { randomUUID } from 'crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
	contacts,
	documentRecords,
	documentAuditEvents,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { safeSend } from '@/lib/inngest';
import { getTemplate } from '@/lib/resolutions/registry';
import { loadTrustHeader } from '@/lib/resolutions/trust-header';
import { renderAndStoreResolution } from '@/lib/resolutions/render-and-store';
import type { Signer } from '@/lib/resolutions/types';
import { logger } from '@/lib/logger';

export interface DraftResolutionResult {
	ok: boolean;
	documentRecordId?: string;
	needsTrustState?: boolean;
	error?: string;
}

/**
 * Create a `document_records` row for a new resolution draft and
 * hand the actual PDF rendering off to the Inngest worker. Returns
 * the new document id immediately so the UI can navigate to its
 * detail page; the PDF lands shortly after (worker writes `pdf_url`
 * + a `rendered` audit event, the detail page polls or refreshes).
 *
 * If the template `requiresState` and the trust hasn't told us its
 * governing state yet, returns `needsTrustState: true` so the UI can
 * lazy-prompt before re-submitting. The draft is NOT created in that
 * case — we don't want orphaned half-data records for an info-gather
 * round trip.
 */
export async function draftResolution(args: {
	templateId: string;
	variables: Record<string, unknown>;
	/** Source linkage when this draft comes from an auto-trigger
	 *  (corpus classification, contributed-asset insert, etc.). When
	 *  non-manual, the (org, sourceKind, sourceId) tuple is idempotent
	 *  — a second draftResolution call with the same source returns
	 *  the existing draft id instead of creating a duplicate. */
	source?: {
		kind: 'deposit_finding' | 'fixed_asset' | 'rental_property' | 'manual';
		id: string;
	};
}): Promise<DraftResolutionResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const userId = await getEffectiveUserId();
	if (!userId) return { ok: false, error: 'No session user' };

	const template = getTemplate(args.templateId);
	if (!template) return { ok: false, error: `Unknown template: ${args.templateId}` };

	// Idempotency check for auto-triggered drafts. Keyed on
	// (org, source_kind, source_id, template_id) so distinct
	// templates can each have their own non-voided doc against the
	// same source — e.g., a purchased real-property asset carries a
	// Real Estate Purchase Resolution AND an Insurance Authorization,
	// both with sourceKind='fixed_asset' + sourceId=assetId but
	// different templateIds. Mirrors the partial unique index
	// ix_document_records_auto_source_unique (migration 0049).
	// 'manual' kind is exempt — users can intentionally create
	// multiple manual docs against the same asset / txn.
	if (args.source && args.source.kind !== 'manual') {
		const [existing] = await db
			.select({ id: documentRecords.id })
			.from(documentRecords)
			.where(
				and(
					eq(documentRecords.organizationId, orgId),
					eq(documentRecords.sourceKind, args.source.kind),
					eq(documentRecords.sourceId, args.source.id),
					eq(documentRecords.templateId, args.templateId),
					ne(documentRecords.status, 'voided'),
				),
			)
			.limit(1);
		if (existing) {
			return { ok: true, documentRecordId: existing.id };
		}
	}

	// Validate variables up front so we never persist a draft that
	// can't render. The Inngest worker re-validates as a defense in
	// depth, but failing here gives the user a synchronous error.
	const parsed = template.variablesSchema.safeParse(args.variables);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		return {
			ok: false,
			error: `${first?.path.join('.') ?? '(root)'} — ${first?.message ?? 'invalid'}`,
		};
	}

	const trust = await loadTrustHeader(orgId);
	if (template.requiresState && !trust.governingState) {
		return { ok: false, needsTrustState: true };
	}

	// Materialize signers from the template's required roles. For
	// 'Trustee' roles, pre-fill expectedName with the first active
	// trustee contact (the user can override at sign time). Other
	// roles are left null and the user fills them in.
	let activeTrusteeName: string | null = null;
	const trusteeNeeded = template.requiredSignerRoles.some((r) => r.role.toLowerCase().includes('trustee'));
	if (trusteeNeeded) {
		const [t] = await db
			.select({ contactName: contacts.contactName })
			.from(contacts)
			.where(
				sql`${contacts.organizationId} = ${orgId} AND ${contacts.trusteeRole} IS NOT NULL AND ${contacts.trusteeRemovedAt} IS NULL`,
			)
			.limit(1);
		activeTrusteeName = t?.contactName ?? null;
	}

	const signers: Signer[] = template.requiredSignerRoles.map((seed) => ({
		id: randomUUID(),
		role: seed.role,
		expectedName: seed.role.toLowerCase().includes('trustee') ? activeTrusteeName : null,
		signedName: null,
		signedAt: null,
		signedIp: null,
	}));

	const docId = randomUUID();
	const now = new Date().toISOString();

	await db.insert(documentRecords).values({
		id: docId,
		organizationId: orgId,
		resolutionType: template.id,
		entityType: 'beneficial_trust',
		style: 'pdf',
		templateId: template.id,
		templateVersion: template.version,
		variables: parsed.data as object,
		draft: '',
		signers: signers as unknown as object,
		status: 'rendering',
		sourceKind: args.source?.kind ?? null,
		sourceId: args.source?.id ?? null,
		createdAt: now,
		updatedAt: now,
	});

	await db.insert(documentAuditEvents).values({
		id: randomUUID(),
		documentRecordId: docId,
		type: 'drafted',
		metadata: {
			userId,
			templateId: template.id,
			templateVersion: template.version,
			source: args.source ?? null,
		},
		timestamp: now,
	});

	const sent = await safeSend({
		name: 'trust/resolution.requested',
		data: { documentRecordId: docId },
	});
	if (!sent) {
		// Inngest unreachable. Document renders are small (a single PDF,
		// ~1-2s), so fall back to inline execution — better UX than
		// leaving the user staring at a "queue unreachable" error in
		// dev when they forgot to run `npx inngest-cli@latest dev`.
		// Long-running flows (DOB correction) deliberately don't have
		// this fallback — they MUST queue.
		try {
			await renderAndStoreResolution(docId);
			await db.insert(documentAuditEvents).values({
				id: randomUUID(),
				documentRecordId: docId,
				type: 'rendered_inline_fallback',
				metadata: { reason: 'Inngest unreachable, ran inline' },
				timestamp: new Date().toISOString(),
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error({ docId, err: msg }, 'inline render fallback failed');
			await db
				.update(documentRecords)
				.set({ status: 'failed', updatedAt: new Date().toISOString() })
				.where(eq(documentRecords.id, docId));
			await db.insert(documentAuditEvents).values({
				id: randomUUID(),
				documentRecordId: docId,
				type: 'render_failed',
				metadata: { reason: msg },
				timestamp: new Date().toISOString(),
			});
			return { ok: false, error: `Render failed: ${msg}` };
		}
	}

	// Auto-pair: every Distribution Authorization spawns a paired
	// Beneficiary Receipt & Release. The R&R is what the beneficiary
	// signs to acknowledge receipt + release further claims; together
	// the pair is the audit-defense bundle. Idempotency via the
	// (org, 'distribution_doc', auth.id) source key on the R&R.
	// Non-fatal — a failure here doesn't roll back the Authorization
	// that just succeeded; the user can manually draft the R&R from
	// the catalog.
	if (template.id === 'distribution-authorization' && !args.source?.kind?.includes('paired')) {
		try {
			const authVars = parsed.data as Record<string, unknown>;
			const beneficiaryName = String(authVars.beneficiaryName ?? '');
			const amountCents = Number(authVars.amountCents ?? 0);
			const distributionDate = String(authVars.distributionDate ?? '');
			const taxYear = Number(authVars.taxYear ?? 0);
			const character = String(authVars.character ?? 'income') as 'principal' | 'income' | 'dni';
			const beneficiaryRelationship =
				authVars.beneficiaryRelationship != null
					? String(authVars.beneficiaryRelationship)
					: null;

			if (beneficiaryName && amountCents > 0 && distributionDate && taxYear) {
				const rrId = randomUUID();
				const rrNow = new Date().toISOString();
				await db.insert(documentRecords).values({
					id: rrId,
					organizationId: orgId,
					resolutionType: 'beneficiary-receipt-and-release',
					entityType: 'beneficial_trust',
					style: 'pdf',
					templateId: 'beneficiary-receipt-and-release',
					templateVersion: '1',
					variables: {
						beneficiaryName,
						beneficiaryRelationship,
						amountCents,
						distributionDate,
						taxYear,
						character,
						authorizationDocumentId: docId,
					},
					draft: '',
					signers: [
						{
							id: randomUUID(),
							role: 'Beneficiary',
							expectedName: beneficiaryName,
							signedName: null,
							signedAt: null,
							signedIp: null,
						},
					],
					status: 'rendering',
					sourceKind: 'distribution_doc',
					sourceId: docId,
					createdAt: rrNow,
					updatedAt: rrNow,
				});
				await db.insert(documentAuditEvents).values({
					id: randomUUID(),
					documentRecordId: rrId,
					type: 'drafted',
					metadata: {
						userId,
						templateId: 'beneficiary-receipt-and-release',
						templateVersion: '1',
						pairedWith: docId,
						autoPaired: true,
					},
					timestamp: rrNow,
				});
				const rrSent = await safeSend({
					name: 'trust/resolution.requested',
					data: { documentRecordId: rrId },
				});
				if (!rrSent) {
					try {
						await renderAndStoreResolution(rrId);
					} catch (rrErr) {
						const rrMsg = rrErr instanceof Error ? rrErr.message : String(rrErr);
						logger.warn(
							{ rrId, err: rrMsg },
							'paired R&R inline render failed (non-fatal)',
						);
						await db
							.update(documentRecords)
							.set({ status: 'failed', updatedAt: new Date().toISOString() })
							.where(eq(documentRecords.id, rrId));
					}
				}
			}
		} catch (err) {
			logger.warn(
				{ docId, err: err instanceof Error ? err.message : err },
				'paired R&R auto-spawn threw (non-fatal)',
			);
		}
	}

	revalidatePath('/trust-documents');
	return { ok: true, documentRecordId: docId };
}
