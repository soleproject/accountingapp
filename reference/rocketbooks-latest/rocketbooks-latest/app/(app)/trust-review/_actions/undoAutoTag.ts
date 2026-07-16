'use server';

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
import { setJournalEntryTags } from '@/lib/tags/store';

export interface UndoAutoTagResult {
	ok: boolean;
	error?: string;
}

/**
 * Reverse a TRUST_TAG_AUTO_APPLIED audit. Clears every dimension the
 * audit applied, dismisses the audit row, and re-runs the auto-tag
 * gate so the user gets re-prompted if the line is still on a
 * property-relevant account.
 */
export async function undoAutoTag(args: {
	findingId: string;
}): Promise<UndoAutoTagResult> {
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
	if (finding.code !== 'TRUST_TAG_AUTO_APPLIED') {
		return { ok: false, error: 'undoAutoTag only applies to AUTO_APPLIED audits' };
	}

	const meta = (finding.metadata ?? {}) as {
		tags?: Array<{ entityType: string; entityId: string }>;
	};
	const dimensionsToClear: TagEntityType[] = (meta.tags ?? [])
		.map((t) => t.entityType)
		.filter((s): s is string => typeof s === 'string' && s.length > 0);

	const [je] = await db
		.select({ id: journalEntries.id })
		.from(journalEntries)
		.where(eq(journalEntries.id, finding.journalEntryId))
		.limit(1);
	if (!je) return { ok: false, error: 'JE not found' };

	const [txn] = await db
		.select({
			id: transactions.id,
			accountId: transactions.accountId,
			amount: transactions.amount,
			contactId: transactions.contactId,
			bankDescription: transactions.bankDescription,
			description: transactions.description,
			categoryAccountId: transactions.categoryAccountId,
		})
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

	if (dimensionsToClear.length === 0) {
		await db
			.update(trustReviewFindings)
			.set({
				dismissedAt: new Date().toISOString(),
				dismissedByUserId: userId,
				dismissedNote: 'Audit dismissed (no tags to undo).',
				updatedAt: new Date().toISOString(),
			})
			.where(eq(trustReviewFindings.id, finding.id));
		return { ok: true };
	}

	try {
		await db.transaction(async (tx) => {
			await setJournalEntryTags({
				organizationId: orgId,
				journalEntryId: je.id,
				bankAccountId: txn.accountId!,
				tags: dimensionsToClear.map((entityType) => ({ entityType, entityId: null })),
				tx,
			});

			await tx
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedByUserId: userId,
					dismissedNote: 'Auto-tag reversed by user.',
					updatedAt: new Date().toISOString(),
				})
				.where(eq(trustReviewFindings.id, finding.id));
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to undo tag' };
	}

	// Re-run the auto-tag logic so the user gets re-prompted if still on
	// a property-relevant account. Memory just retracted, so this won't
	// re-apply; will fire UNTAGGED for visibility.
	if (txn.categoryAccountId) {
		const { maybeAutoTagFromMemory } = await import('@/lib/accounting/tag-from-memory');
		await maybeAutoTagFromMemory({
			organizationId: orgId,
			transactionId: txn.id,
			journalEntryId: je.id,
			bankAccountId: txn.accountId,
			categoryAccountId: txn.categoryAccountId,
			contactId: txn.contactId,
			amount: Math.abs(Number(txn.amount ?? 0)),
			description: txn.bankDescription ?? txn.description,
		});
	}

	revalidatePath('/trust-review');
	revalidatePath('/rental-properties');
	revalidatePath('/assets');
	revalidatePath('/loans');
	revalidatePath(`/transactions/${je.id}`);
	return { ok: true };
}
