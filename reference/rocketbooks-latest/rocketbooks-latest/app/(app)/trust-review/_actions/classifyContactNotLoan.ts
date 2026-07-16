'use server';

import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	journalEntries,
	journalEntryLines,
	transactions,
	trustReviewFindings,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { createJournalEntry, reverseJournalEntry } from '@/lib/accounting/posting';
import {
	addContactTypeTag,
	VENDOR_TYPE_TAG_CREDIT_CARD,
	VENDOR_TYPE_TAG_LEASE,
} from '@/lib/accounting/vendor-classification';

export type NotLoanClassification = 'credit_card' | 'lease' | 'other';

export interface ClassifyContactNotLoanResult {
	ok: boolean;
	processed: number;
	failed: Array<{ findingId: string; error: string }>;
	error?: string;
}

/**
 * Per-contact bulk action for "this contact isn't a loan vendor" on a
 * TRUST_DEFERRED_LOAN_SPLIT_NEEDED group.
 *
 *   classification = 'credit_card' → stamp 'credit_card_issuer' typeTag
 *                                    on the contact
 *   classification = 'lease'        → stamp 'lease_company' typeTag
 *   classification = 'other'        → no tag stamped (contact stays
 *                                     unclassified for vendor-bucket
 *                                     purposes; the user picked a
 *                                     concrete CoA destination)
 *
 * After the typeTag write, every supplied finding's JE is reversed and
 * reposted with the 250 Notes Payable line replaced by a line on
 * `targetAccountId`. Findings are dismissed; a TRUST_NON_TRUST_RECATEGORIZED
 * audit is inserted on each new JE.
 *
 * Sequential per finding so a single bad JE surfaces in `failed` without
 * aborting the rest. revalidatePath fires once at the end.
 */
export async function classifyContactNotLoan(args: {
	/** Source contact for the typeTag stamp. Null when called from the
	 *  toolbar across multiple contacts — the stamp is skipped (no single
	 *  contact to classify) but the GL recategorization still applies to
	 *  every findingId. */
	contactId?: string | null;
	findingIds: string[];
	classification: NotLoanClassification;
	targetAccountId: string;
}): Promise<ClassifyContactNotLoanResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const userId = await getEffectiveUserId();

	if (args.findingIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No findings selected' };
	}

	const [target] = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
		})
		.from(chartOfAccounts)
		.where(
			and(
				eq(chartOfAccounts.id, args.targetAccountId),
				eq(chartOfAccounts.organizationId, orgId),
			),
		)
		.limit(1);
	if (!target) {
		return { ok: false, processed: 0, failed: [], error: 'Target account not in this organization' };
	}

	// Stamp the typeTag once up front so subsequent loads of this contact
	// already see the classification. No-op if already tagged. Skipped
	// entirely when called cross-contact (no single contact to stamp).
	if (args.contactId) {
		if (args.classification === 'credit_card') {
			await addContactTypeTag({
				organizationId: orgId,
				contactId: args.contactId,
				tag: VENDOR_TYPE_TAG_CREDIT_CARD,
			});
		} else if (args.classification === 'lease') {
			await addContactTypeTag({
				organizationId: orgId,
				contactId: args.contactId,
				tag: VENDOR_TYPE_TAG_LEASE,
			});
		}
	}

	const failed: Array<{ findingId: string; error: string }> = [];
	let processed = 0;

	for (const findingId of args.findingIds) {
		try {
			const ok = await recategorizeOneFinding({
				orgId,
				userId,
				findingId,
				target,
			});
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
	return { ok: failed.length === 0, processed, failed };
}

async function recategorizeOneFinding(args: {
	orgId: string;
	userId: string | null;
	findingId: string;
	target: { id: string; accountNumber: string | null; accountName: string };
}): Promise<{ ok: true } | { ok: false; error: string }> {
	const { orgId, userId, findingId, target } = args;

	const [finding] = await db
		.select({
			id: trustReviewFindings.id,
			code: trustReviewFindings.code,
			organizationId: trustReviewFindings.organizationId,
			journalEntryId: trustReviewFindings.journalEntryId,
			metadata: trustReviewFindings.metadata,
		})
		.from(trustReviewFindings)
		.where(eq(trustReviewFindings.id, findingId))
		.limit(1);
	if (!finding) return { ok: false, error: 'Finding not found' };
	if (finding.organizationId !== orgId) return { ok: false, error: 'Not authorized' };
	if (finding.code !== 'TRUST_DEFERRED_LOAN_SPLIT_NEEDED') {
		return { ok: false, error: `classifyContactNotLoan doesn't apply to ${finding.code}` };
	}

	const meta = (finding.metadata ?? {}) as { accountId?: string };
	if (!meta.accountId) return { ok: false, error: 'Finding metadata missing accountId' };

	const [source] = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
		})
		.from(chartOfAccounts)
		.where(eq(chartOfAccounts.id, meta.accountId))
		.limit(1);

	const [je] = await db
		.select({
			id: journalEntries.id,
			date: journalEntries.date,
			memo: journalEntries.memo,
			sourceType: journalEntries.sourceType,
			sourceId: journalEntries.sourceId,
		})
		.from(journalEntries)
		.where(eq(journalEntries.id, finding.journalEntryId))
		.limit(1);
	if (!je) return { ok: false, error: 'JE not found' };

	const lines = await db
		.select({
			accountId: journalEntryLines.accountId,
			debit: journalEntryLines.debit,
			credit: journalEntryLines.credit,
			contactId: journalEntryLines.contactId,
			memo: journalEntryLines.memo,
			beneficiaryId: journalEntryLines.beneficiaryId,
		})
		.from(journalEntryLines)
		.where(eq(journalEntryLines.journalEntryId, je.id));
	const sourceLines = lines.filter((l) => l.accountId === meta.accountId);
	const otherLines = lines.filter((l) => l.accountId !== meta.accountId);
	if (sourceLines.length === 0) {
		return { ok: false, error: 'No matching 250 line on this JE' };
	}
	const totalDebit = sourceLines.reduce((acc, l) => acc + Number(l.debit ?? 0), 0);
	const totalCredit = sourceLines.reduce((acc, l) => acc + Number(l.credit ?? 0), 0);

	try {
		await db.transaction(async (tx) => {
			await reverseJournalEntry(
				{
					organizationId: orgId,
					journalEntryId: je.id,
					reversalMemo: `Reversal — 250 line recategorized to ${target.accountNumber ?? ''} ${target.accountName}`,
				},
				tx,
			);

			const newLine = {
				accountId: target.id,
				debit: totalDebit,
				credit: totalCredit,
				contactId: sourceLines[0]?.contactId ?? null,
				memo: sourceLines[0]?.memo ?? null,
				beneficiaryId: sourceLines[0]?.beneficiaryId ?? null,
			};
			const carryoverLines = otherLines.map((l) => ({
				accountId: l.accountId,
				debit: Number(l.debit ?? 0),
				credit: Number(l.credit ?? 0),
				contactId: l.contactId,
				memo: l.memo,
				beneficiaryId: l.beneficiaryId ?? null,
			}));
			const newJe = await createJournalEntry(
				{
					organizationId: orgId,
					date: je.date,
					memo: je.memo,
					posted: true,
					sourceType: je.sourceType,
					sourceId: je.sourceId,
					lines: [newLine, ...carryoverLines],
				},
				tx,
			);

			if (je.sourceType === 'transaction' && je.sourceId) {
				await tx
					.update(transactions)
					.set({ journalEntryId: newJe.id, categoryAccountId: target.id })
					.where(
						and(
							eq(transactions.id, je.sourceId),
							eq(transactions.organizationId, orgId),
						),
					);
			}

			await tx.insert(trustReviewFindings).values({
				id: randomUUID(),
				organizationId: orgId,
				journalEntryId: newJe.id,
				code: 'TRUST_NON_TRUST_RECATEGORIZED',
				severity: 'warn',
				message: `Moved from ${source?.accountNumber ?? ''} ${source?.accountName ?? '250 Notes Payable'} to ${target.accountNumber ?? ''} ${target.accountName} — not a loan payment.`,
				metadata: {
					accountId: target.id,
					accountNumber: target.accountNumber,
					fromAccountId: meta.accountId,
					fromAccountNumber: source?.accountNumber ?? null,
					toAccountId: target.id,
					toAccountNumber: target.accountNumber,
					amount: totalDebit > 0 ? totalDebit : totalCredit,
				},
			});

			await tx
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedByUserId: userId,
					dismissedNote: `Auto-dismissed: recategorized to ${target.accountNumber ?? ''} ${target.accountName} — not a loan.`,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(trustReviewFindings.id, finding.id));
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to recategorize' };
	}

	return { ok: true };
}
