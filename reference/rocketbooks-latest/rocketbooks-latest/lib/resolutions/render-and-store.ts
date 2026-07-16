import 'server-only';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
	documentRecords,
	documentVersions,
	documentAuditEvents,
} from '@/db/schema/schema';
import { renderResolutionPdf } from './render';
import { loadTrustHeader } from './trust-header';
import { uploadResolutionPdf } from '@/lib/storage/trust-documents';
import { notifyDraftReady } from '@/lib/email/trust-doc-emails';
import type { Signer } from './types';

/**
 * Render-then-store a single document. Same logic the Inngest worker
 * runs, factored out so the dev fallback can call it inline when the
 * Inngest dev server isn't listening. Production keeps using the
 * worker (step.run checkpoints + retries); this function is the
 * primitive both paths call.
 *
 * Throws on any failure — caller decides whether to write a
 * render_failed audit event + flip the row's status. The Inngest
 * function does that wrapping; the inline fallback in
 * draftResolution does too.
 */
export async function renderAndStoreResolution(documentRecordId: string): Promise<void> {
	const [doc] = await db
		.select({
			id: documentRecords.id,
			organizationId: documentRecords.organizationId,
			templateId: documentRecords.templateId,
			templateVersion: documentRecords.templateVersion,
			variables: documentRecords.variables,
			signers: documentRecords.signers,
		})
		.from(documentRecords)
		.where(eq(documentRecords.id, documentRecordId))
		.limit(1);
	if (!doc) throw new Error(`Document ${documentRecordId} not found`);
	if (!doc.organizationId) throw new Error(`Document ${documentRecordId} missing organizationId`);

	const orgId = doc.organizationId;
	const trust = await loadTrustHeader(orgId);
	const draftedAt = new Date().toISOString();
	const pdfBytes = await renderResolutionPdf({
		templateId: doc.templateId,
		variables: (doc.variables ?? {}) as Record<string, unknown>,
		trust,
		signers: (doc.signers ?? []) as Signer[],
		draftedAt,
	});

	const existingVersions = await db
		.select({ id: documentVersions.id })
		.from(documentVersions)
		.where(eq(documentVersions.documentRecordId, documentRecordId));
	const versionNumber = existingVersions.length + 1;

	const { path } = await uploadResolutionPdf({
		organizationId: orgId,
		documentRecordId,
		versionNumber,
		pdfBytes,
	});

	const now = new Date().toISOString();
	await db.insert(documentVersions).values({
		id: randomUUID(),
		documentRecordId,
		createdAt: now,
		versionNumber,
		variables: (doc.variables ?? {}) as object,
		draft: '',
		pdfUrl: path,
		signers: (doc.signers ?? []) as object,
		templateId: doc.templateId,
		templateVersion: doc.templateVersion,
	});

	await db
		.update(documentRecords)
		.set({ pdfUrl: path, status: 'draft', updatedAt: now })
		.where(eq(documentRecords.id, documentRecordId));

	await db.insert(documentAuditEvents).values({
		id: randomUUID(),
		documentRecordId,
		type: 'rendered',
		metadata: { versionNumber, bytes: pdfBytes.length, draftedAt },
		timestamp: now,
	});

	revalidatePath('/trust-documents');
	revalidatePath(`/trust-documents/${documentRecordId}`);

	// "Draft ready" email — only on the FIRST render. Re-renders after
	// edits or signature lands shouldn't spam the inbox; the user is
	// already actively in the doc when those happen.
	if (versionNumber === 1) {
		await notifyDraftReady({ documentRecordId });
	}
}
