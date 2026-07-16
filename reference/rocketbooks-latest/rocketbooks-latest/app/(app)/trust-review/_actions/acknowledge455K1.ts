'use server';

import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { trustReviewFindings } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';

export interface Acknowledge455K1Result {
	ok: boolean;
	processed: number;
	failed: Array<{ findingId: string; error: string }>;
	error?: string;
}

/**
 * Per-contact bulk "acknowledge" for TRUST_455_FLAG_K1_ISSUANCE. The
 * K-1 source form is held off-system (no document tracking yet) — this
 * action just records that the user has it on file and dismisses the
 * warning. Inserts a TRUST_455_K1_ACKNOWLEDGED audit per JE.
 */
export async function acknowledge455K1(args: {
	findingIds: string[];
}): Promise<Acknowledge455K1Result> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const userId = await getEffectiveUserId();

	if (args.findingIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No findings selected' };
	}
	const failed: Array<{ findingId: string; error: string }> = [];
	let processed = 0;

	for (const findingId of args.findingIds) {
		try {
			const [finding] = await db
				.select({
					id: trustReviewFindings.id,
					code: trustReviewFindings.code,
					organizationId: trustReviewFindings.organizationId,
					journalEntryId: trustReviewFindings.journalEntryId,
				})
				.from(trustReviewFindings)
				.where(eq(trustReviewFindings.id, findingId))
				.limit(1);
			if (!finding) { failed.push({ findingId, error: 'Finding not found' }); continue; }
			if (finding.organizationId !== orgId) { failed.push({ findingId, error: 'Not authorized' }); continue; }
			if (finding.code !== 'TRUST_455_FLAG_K1_ISSUANCE') {
				failed.push({ findingId, error: `Doesn't apply to ${finding.code}` });
				continue;
			}

			await db.transaction(async (tx) => {
				await tx.insert(trustReviewFindings).values({
					id: randomUUID(),
					organizationId: orgId,
					journalEntryId: finding.journalEntryId,
					code: 'TRUST_455_K1_ACKNOWLEDGED',
					severity: 'warn',
					message: 'K-1 source form acknowledged as received and retained on file.',
					metadata: {},
				});
				await tx
					.update(trustReviewFindings)
					.set({
						dismissedAt: new Date().toISOString(),
						dismissedByUserId: userId,
						dismissedNote: 'Auto-dismissed: source K-1 acknowledged on file.',
						updatedAt: new Date().toISOString(),
					})
					.where(eq(trustReviewFindings.id, finding.id));
			});
			processed += 1;
		} catch (err) {
			failed.push({ findingId, error: err instanceof Error ? err.message : String(err) });
		}
	}

	revalidatePath('/trust-review');
	return { ok: failed.length === 0, processed, failed };
}
