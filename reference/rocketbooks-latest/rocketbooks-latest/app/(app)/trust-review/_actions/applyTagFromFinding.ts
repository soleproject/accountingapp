'use server';

import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
	journalEntries,
	transactions,
	trustReviewFindings,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { type TagEntityType } from '@/lib/tags/dimensions';
import { setJournalEntryTags, validateTagsForOrg } from '@/lib/tags/store';

export interface ApplyTagResult {
	ok: boolean;
	error?: string;
}

export interface TagPickerEntry {
	entityType: TagEntityType;
	entityId: string;
}

/**
 * Resolution for the new tag-memory findings:
 *
 *   TRUST_TAG_SUGGESTED              → caller passes [] for tags; the
 *                                       action reads the suggestion
 *                                       straight out of finding.metadata
 *                                       (memory hit at ±5%).
 *   TRUST_PROPERTY_EXPENSE_UNTAGGED  → caller passes the user-picked
 *                                       tags from the row's picker.
 *
 * In both cases: set the tags on every non-bank line of the JE, drop
 * a TRUST_TAG_AUTO_APPLIED audit (Decisioned), dismiss the original.
 * Generic over dimensions — any system tag dimension can flow through.
 */
export async function applyTagFromFinding(args: {
	findingId: string;
	tags: TagPickerEntry[];
}): Promise<ApplyTagResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const userId = await getEffectiveUserId();

	const [finding] = await db
		.select({
			id: trustReviewFindings.id,
			code: trustReviewFindings.code,
			organizationId: trustReviewFindings.organizationId,
			journalEntryId: trustReviewFindings.journalEntryId,
			metadata: trustReviewFindings.metadata,
		})
		.from(trustReviewFindings)
		.where(eq(trustReviewFindings.id, args.findingId))
		.limit(1);
	if (!finding) return { ok: false, error: 'Finding not found' };
	if (finding.organizationId !== orgId) return { ok: false, error: 'Not authorized' };
	if (
		finding.code !== 'TRUST_TAG_SUGGESTED'
		&& finding.code !== 'TRUST_PROPERTY_EXPENSE_UNTAGGED'
	) {
		return { ok: false, error: 'Wrong finding code for this action' };
	}

	// Resolve which tags to apply. For SUGGESTED, metadata.tags carries
	// them; for UNTAGGED, caller passes them.
	let tags: TagPickerEntry[];
	if (finding.code === 'TRUST_TAG_SUGGESTED') {
		const meta = (finding.metadata ?? {}) as {
			tags?: Array<{ entityType: string; entityId: string }>;
		};
		tags = (meta.tags ?? [])
			.filter((t) => typeof t.entityType === 'string' && t.entityType.length > 0)
			.map((t) => ({ entityType: t.entityType as TagEntityType, entityId: t.entityId }));
	} else {
		tags = args.tags.filter((t) => typeof t.entityType === 'string' && t.entityType.length > 0);
	}
	if (tags.length === 0) {
		return { ok: false, error: 'No valid tag dimensions to apply' };
	}

	const v = await validateTagsForOrg({ organizationId: orgId, tags });
	if (v.invalid) return { ok: false, error: v.invalid.reason };

	const [je] = await db
		.select({ id: journalEntries.id })
		.from(journalEntries)
		.where(eq(journalEntries.id, finding.journalEntryId))
		.limit(1);
	if (!je) return { ok: false, error: 'JE not found' };

	const [txn] = await db
		.select({ accountId: transactions.accountId })
		.from(transactions)
		.where(
			and(
				eq(transactions.journalEntryId, je.id),
				eq(transactions.organizationId, orgId),
			),
		)
		.limit(1);
	if (!txn?.accountId) {
		return { ok: false, error: 'No source bank account on this JE' };
	}

	try {
		await db.transaction(async (tx) => {
			await setJournalEntryTags({
				organizationId: orgId,
				journalEntryId: je.id,
				bankAccountId: txn.accountId!,
				tags,
				tx,
			});

			await tx.insert(trustReviewFindings).values({
				id: randomUUID(),
				organizationId: orgId,
				journalEntryId: je.id,
				code: 'TRUST_TAG_AUTO_APPLIED',
				severity: 'warn',
				message:
					finding.code === 'TRUST_TAG_SUGGESTED'
						? 'Suggested tag applied by user.'
						: 'Tag applied by user from the untagged-finding picker.',
				metadata: {
					tags,
					resolvedFrom: finding.code,
				},
			});

			await tx
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedByUserId: userId,
					dismissedNote: 'Tag applied.',
					updatedAt: new Date().toISOString(),
				})
				.where(eq(trustReviewFindings.id, finding.id));
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to apply tag' };
	}

	revalidatePath('/trust-review');
	revalidatePath('/rental-properties');
	revalidatePath('/assets');
	revalidatePath('/loans');
	revalidatePath(`/transactions/${je.id}`);
	return { ok: true };
}
