'use server';

import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
	documentRecords,
	documentAuditEvents,
} from '@/db/schema/schema';
import { safeSend } from '@/lib/inngest';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { renderAndStoreResolution } from '@/lib/resolutions/render-and-store';
import { notifySignedFully } from '@/lib/email/trust-doc-emails';
import type { Signer } from '@/lib/resolutions/types';
import { logger } from '@/lib/logger';

export interface SubmitTypedSignatureResult {
	ok: boolean;
	allSigned?: boolean;
	error?: string;
}

/**
 * Typed-name e-signature capture — the Phase 1 substitute for a real
 * e-sig provider. Records the typed name + client IP + UTC timestamp
 * on the document's signers array AND writes a 'signed' audit event.
 * Pair with the rendered PDF + the audit trail to demonstrate intent
 * under UETA / federal E-SIGN.
 *
 * Once every required signer has signed, fires a re-render so the
 * PDF body picks up the names and dates in the signature blocks. The
 * status is left at 'draft' until that re-render lands (worker bumps
 * to 'signed'). Single-signer docs flip in one round trip.
 */
export async function submitTypedSignature(args: {
	documentRecordId: string;
	signerId: string;
	typedName: string;
}): Promise<SubmitTypedSignatureResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const userId = await getEffectiveUserId();
	if (!userId) return { ok: false, error: 'No session user' };

	const trimmedName = args.typedName.trim();
	if (trimmedName.length === 0) {
		return { ok: false, error: 'Type your full legal name' };
	}

	const [doc] = await db
		.select({
			id: documentRecords.id,
			signers: documentRecords.signers,
			status: documentRecords.status,
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
	if (doc.status === 'signed') return { ok: false, error: 'Already fully signed' };

	const signers = (doc.signers ?? []) as Signer[];
	const target = signers.find((s) => s.id === args.signerId);
	if (!target) return { ok: false, error: 'Signer not found on document' };
	if (target.signedAt) return { ok: false, error: 'Already signed' };

	const h = await headers();
	// Prefer the leftmost X-Forwarded-For (originating client) over
	// X-Real-IP. Falls back to '0.0.0.0' if behind a proxy that strips
	// both — the audit event still has the user id + timestamp.
	const xff = h.get('x-forwarded-for') ?? '';
	const ip = xff.split(',')[0]?.trim() || h.get('x-real-ip') || '0.0.0.0';

	const now = new Date().toISOString();
	const updatedSigners: Signer[] = signers.map((s) =>
		s.id === args.signerId
			? { ...s, signedName: trimmedName, signedAt: now, signedIp: ip }
			: s,
	);
	const allSigned = updatedSigners.every((s) => !!s.signedAt);

	await db
		.update(documentRecords)
		.set({
			signers: updatedSigners as unknown as object,
			status: allSigned ? 'signed' : 'draft',
			updatedAt: now,
		})
		.where(eq(documentRecords.id, args.documentRecordId));

	await db.insert(documentAuditEvents).values({
		id: randomUUID(),
		documentRecordId: args.documentRecordId,
		type: 'signed',
		metadata: {
			signerId: args.signerId,
			role: target.role,
			typedName: trimmedName,
			ip,
			userId,
		},
		timestamp: now,
	});

	// Re-render so the PDF body shows the new signature lines. Same
	// inline fallback as draftResolution — document renders are small
	// enough to run synchronously if Inngest isn't listening locally.
	if (allSigned) {
		const sent = await safeSend({
			name: 'trust/resolution.requested',
			data: { documentRecordId: args.documentRecordId },
		});
		if (!sent) {
			try {
				await renderAndStoreResolution(args.documentRecordId);
			} catch (err) {
				logger.error(
					{ docId: args.documentRecordId, err: err instanceof Error ? err.message : err },
					'inline re-render fallback failed after signature',
				);
				// Don't surface to the user — the signature itself succeeded
				// and the PDF preview will catch up when the user reopens
				// the page or triggers another render.
			}
		}

		// "Fully signed" email to the initiator. Non-fatal — a send
		// failure shouldn't affect the user's confirmed signature.
		await notifySignedFully({ documentRecordId: args.documentRecordId });
	}

	revalidatePath(`/trust-documents/${args.documentRecordId}`);
	revalidatePath('/trust-documents');
	return { ok: true, allSigned };
}
