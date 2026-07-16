'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { documentRecords } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { createServiceClient } from '@/lib/supabase/service';
import { TRUST_DOCUMENTS_BUCKET } from '@/lib/storage/trust-documents';
import { logger } from '@/lib/logger';

export interface DeleteDocumentResult {
	ok: boolean;
	error?: string;
}

/**
 * Remove a document_records row + every artifact attached to it.
 *
 * Database side: documentVersions + documentAuditEvents both ON DELETE
 * CASCADE off the record id, so a single delete handles them.
 *
 * Storage side: list every object under {orgId}/{docId}/ (rendered
 * versions) AND {orgId}/uploads/{docId}/ (user-supplied uploads) and
 * remove them. Listing-then-removing is two round trips but the
 * alternative — tracking every stored path on the record — couples
 * the GL state to the storage layout and would drift first time
 * someone uploads outside the action.
 */
export async function deleteDocument(args: { documentRecordId: string }): Promise<DeleteDocumentResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const [doc] = await db
		.select({ id: documentRecords.id, organizationId: documentRecords.organizationId })
		.from(documentRecords)
		.where(
			and(
				eq(documentRecords.id, args.documentRecordId),
				eq(documentRecords.organizationId, orgId),
			),
		)
		.limit(1);
	if (!doc) return { ok: false, error: 'Document not found' };

	// Cascade-find paired docs (e.g., the auto-spawned R&R for a
	// Distribution Authorization). Both records get deleted together
	// — leaving an orphan R&R after deleting its Authorization would
	// confuse the audit trail.
	const pairedRows = await db
		.select({ id: documentRecords.id })
		.from(documentRecords)
		.where(
			and(
				eq(documentRecords.organizationId, orgId),
				eq(documentRecords.sourceKind, 'distribution_doc'),
				eq(documentRecords.sourceId, args.documentRecordId),
			),
		);

	const allIds = [args.documentRecordId, ...pairedRows.map((r) => r.id)];

	// Storage cleanup — list under both prefixes for each doc, remove
	// what's there. We don't fail the whole operation on a storage
	// hiccup; the DB rows go away either way.
	const supa = createServiceClient();
	for (const id of allIds) {
		const prefixes = [`${orgId}/${id}`, `${orgId}/uploads/${id}`];
		for (const prefix of prefixes) {
			const { data: list, error: listErr } = await supa.storage
				.from(TRUST_DOCUMENTS_BUCKET)
				.list(prefix);
			if (listErr) {
				logger.warn({ prefix, err: listErr.message }, 'storage list failed during delete');
				continue;
			}
			if (!list || list.length === 0) continue;
			const paths = list.map((entry) => `${prefix}/${entry.name}`);
			const { error: rmErr } = await supa.storage.from(TRUST_DOCUMENTS_BUCKET).remove(paths);
			if (rmErr) {
				logger.warn({ prefix, err: rmErr.message }, 'storage remove failed during delete');
			}
		}
	}

	// Delete paired rows first (FK cascade isn't set up between
	// paired docs since the link is via source_id, not a direct FK).
	for (const id of allIds) {
		await db.delete(documentRecords).where(eq(documentRecords.id, id));
	}

	if (pairedRows.length > 0) {
		logger.info(
			{ primaryId: args.documentRecordId, pairedCount: pairedRows.length },
			'deleted document with paired cascade',
		);
	}

	revalidatePath('/trust-documents');
	return { ok: true };
}
