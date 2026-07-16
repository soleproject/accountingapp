'use server';

import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { documentRecords } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getResolutionSignedUrl } from '@/lib/storage/trust-documents';

export interface GetSignedUrlResult {
	ok: boolean;
	url?: string;
	error?: string;
}

/**
 * Resolve a time-limited download URL for the most recent rendered
 * version of a document. Scoped to the org so a leaked id doesn't
 * cross tenants. Returns null URL if rendering hasn't completed yet
 * (the worker writes pdf_url at the end of its store step).
 */
export async function getDocumentSignedUrl(args: { documentRecordId: string }): Promise<GetSignedUrlResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const [doc] = await db
		.select({ pdfUrl: documentRecords.pdfUrl })
		.from(documentRecords)
		.where(
			and(
				eq(documentRecords.id, args.documentRecordId),
				eq(documentRecords.organizationId, orgId),
			),
		)
		.limit(1);
	if (!doc) return { ok: false, error: 'Document not found' };
	if (!doc.pdfUrl) return { ok: false, error: 'PDF not yet rendered' };

	try {
		const url = await getResolutionSignedUrl(doc.pdfUrl);
		return { ok: true, url };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to sign URL' };
	}
}
