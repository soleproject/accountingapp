'use server';

import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
	documentRecords,
	documentAuditEvents,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { safeSend } from '@/lib/inngest';
import { getTemplate } from '@/lib/resolutions/registry';
import { renderAndStoreResolution } from '@/lib/resolutions/render-and-store';
import type { Signer } from '@/lib/resolutions/types';
import { logger } from '@/lib/logger';

export interface UpdateDocumentVariablesResult {
	ok: boolean;
	error?: string;
}

/**
 * Edit the variables on a draft document and re-render. Refuses to
 * touch a document that already has any signatures — editing after
 * a signature is captured would invalidate the audit trail. The
 * UI hides the Edit button in that state too; this is the
 * server-side guard.
 *
 * On success the row's existing pdf_url gets overwritten when the
 * worker writes the new version (which uses version number n+1 in
 * the storage path — see lib/storage/trust-documents.ts), and a
 * fresh 'rendered' audit event lands on the trail.
 */
export async function updateDocumentVariables(args: {
	documentRecordId: string;
	variables: Record<string, unknown>;
}): Promise<UpdateDocumentVariablesResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const userId = await getEffectiveUserId();
	if (!userId) return { ok: false, error: 'No session user' };

	const [doc] = await db
		.select({
			id: documentRecords.id,
			templateId: documentRecords.templateId,
			signers: documentRecords.signers,
		})
		.from(documentRecords)
		.where(
			and(
				eq(documentRecords.id, args.documentRecordId),
				eq(documentRecords.organizationId, orgId),
			),
		)
		.limit(1);
	if (!doc) return { ok: false, error: 'Document not found' };

	const signers = (doc.signers ?? []) as Signer[];
	if (signers.some((s) => !!s.signedAt)) {
		return {
			ok: false,
			error: 'Cannot edit a document that has signatures. Delete + redraft instead.',
		};
	}

	const template = getTemplate(doc.templateId);
	if (!template) return { ok: false, error: `Unknown template: ${doc.templateId}` };

	const parsed = template.variablesSchema.safeParse(args.variables);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		return {
			ok: false,
			error: `${first?.path.join('.') ?? '(root)'} — ${first?.message ?? 'invalid'}`,
		};
	}

	const now = new Date().toISOString();
	await db
		.update(documentRecords)
		.set({
			variables: parsed.data as object,
			status: 'rendering',
			updatedAt: now,
		})
		.where(eq(documentRecords.id, args.documentRecordId));

	await db.insert(documentAuditEvents).values({
		id: randomUUID(),
		documentRecordId: args.documentRecordId,
		type: 'edited',
		metadata: { userId },
		timestamp: now,
	});

	// Same queue-or-inline fallback as draftResolution.
	const sent = await safeSend({
		name: 'trust/resolution.requested',
		data: { documentRecordId: args.documentRecordId },
	});
	if (!sent) {
		try {
			await renderAndStoreResolution(args.documentRecordId);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error({ docId: args.documentRecordId, err: msg }, 'inline re-render failed after edit');
			await db
				.update(documentRecords)
				.set({ status: 'failed', updatedAt: new Date().toISOString() })
				.where(eq(documentRecords.id, args.documentRecordId));
			return { ok: false, error: `Re-render failed: ${msg}` };
		}
	}

	revalidatePath('/trust-documents');
	revalidatePath(`/trust-documents/${args.documentRecordId}`);
	return { ok: true };
}
