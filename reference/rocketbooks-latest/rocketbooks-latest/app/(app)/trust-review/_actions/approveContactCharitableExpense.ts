'use server';

import { randomUUID } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	contacts,
	journalEntryLines,
	trustReviewFindings,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import {
	addContactTypeTag,
	VENDOR_TYPE_TAG_CHARITY_501C3,
} from '@/lib/accounting/vendor-classification';

export interface ApproveContactCharitableExpenseResult {
	ok: boolean;
	processed: number;
	failed: Array<{ findingId: string; error: string }>;
	error?: string;
}

/**
 * Confirm a TRUST_515_VERIFY_501C3 finding by stamping the picked
 * charity contact with 'charity_501c3' typeTag, updating each finding's
 * 515 line.contactId to point at the verified charity (if different
 * from what's currently on the line), inserting a
 * TRUST_515_RECIPIENT_VERIFIED audit, and dismissing the finding.
 *
 * The typeTag is the durable signal: once a contact is tagged as
 * 'charity_501c3', the rules engine can short-circuit future 515
 * postings to the same vendor (no warning re-fired). Idempotent on
 * re-stamp.
 */
export async function approveContactCharitableExpense(args: {
	/** Source contact when scoped to a single sub-group / row. Null when
	 *  called from the toolbar across multiple contacts — the action
	 *  doesn't actually use it (only charityContactId is needed), but
	 *  keeping the field documents the call site. */
	contactId?: string | null;
	findingIds: string[];
	charityContactId: string;
}): Promise<ApproveContactCharitableExpenseResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const userId = await getEffectiveUserId();

	if (args.findingIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No findings selected' };
	}
	if (!args.charityContactId) {
		return { ok: false, processed: 0, failed: [], error: 'No charity picked' };
	}

	const [charity] = await db
		.select({ id: contacts.id, contactName: contacts.contactName })
		.from(contacts)
		.where(
			and(
				eq(contacts.id, args.charityContactId),
				eq(contacts.organizationId, orgId),
			),
		)
		.limit(1);
	if (!charity) {
		return { ok: false, processed: 0, failed: [], error: 'Charity contact not in this organization' };
	}

	await addContactTypeTag({
		organizationId: orgId,
		contactId: charity.id,
		tag: VENDOR_TYPE_TAG_CHARITY_501C3,
	});

	const failed: Array<{ findingId: string; error: string }> = [];
	let processed = 0;

	for (const findingId of args.findingIds) {
		try {
			const ok = await approveOneFinding({ orgId, userId, findingId, charity });
			if (ok.ok) processed += 1;
			else failed.push({ findingId, error: ok.error ?? 'Failed' });
		} catch (err) {
			failed.push({
				findingId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	revalidatePath('/trust-review');
	revalidatePath('/contacts');
	return { ok: failed.length === 0, processed, failed };
}

async function approveOneFinding(args: {
	orgId: string;
	userId: string | null;
	findingId: string;
	charity: { id: string; contactName: string };
}): Promise<{ ok: true } | { ok: false; error: string }> {
	const { orgId, userId, findingId, charity } = args;

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
	if (!finding) return { ok: false, error: 'Finding not found' };
	if (finding.organizationId !== orgId) return { ok: false, error: 'Not authorized' };
	if (finding.code !== 'TRUST_515_VERIFY_501C3') {
		return { ok: false, error: `approveContactCharitableExpense doesn't apply to ${finding.code}` };
	}

	// Find every 515 line on the JE (detail_type 'charitable_contributions').
	const charLines = await db
		.select({ accountId: journalEntryLines.accountId })
		.from(journalEntryLines)
		.innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalEntryLines.accountId))
		.where(
			and(
				eq(journalEntryLines.journalEntryId, finding.journalEntryId),
				eq(chartOfAccounts.organizationId, orgId),
				eq(chartOfAccounts.detailType, 'charitable_contributions'),
			),
		);
	if (charLines.length === 0) {
		return { ok: false, error: 'No 515 (charitable_contributions) line on this JE' };
	}
	const accountIds = Array.from(new Set(charLines.map((l) => l.accountId)));

	try {
		await db.transaction(async (tx) => {
			// Point the 515 line(s) at the verified charity. Soft change —
			// the JE balance is unaffected; only the contact attribution
			// moves. Non-515 lines on the JE (bank-side, etc.) untouched.
			await tx
				.update(journalEntryLines)
				.set({ contactId: charity.id })
				.where(
					and(
						eq(journalEntryLines.journalEntryId, finding.journalEntryId),
						inArray(journalEntryLines.accountId, accountIds),
					),
				);

			await tx.insert(trustReviewFindings).values({
				id: randomUUID(),
				organizationId: orgId,
				journalEntryId: finding.journalEntryId,
				code: 'TRUST_515_RECIPIENT_VERIFIED',
				severity: 'warn',
				message: `515 line tagged to ${charity.contactName} — recipient verified as a registered 501(c)(3).`,
				metadata: {
					charityContactId: charity.id,
					charityName: charity.contactName,
				},
			});

			await tx
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedByUserId: userId,
					dismissedNote: `Auto-dismissed: 515 recipient ${charity.contactName} verified as 501(c)(3).`,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(trustReviewFindings.id, finding.id));
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to verify' };
	}

	return { ok: true };
}
