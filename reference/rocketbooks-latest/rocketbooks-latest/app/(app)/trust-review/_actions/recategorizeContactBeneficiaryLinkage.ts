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

const APPLICABLE_CODES = new Set([
	'TRUST_BENEFICIARY_LINKAGE_REQUIRED',
	'TRUST_635_RECIPIENT_REQUIRED',
]);

export interface RecategorizeContactBeneficiaryLinkageResult {
	ok: boolean;
	processed: number;
	failed: Array<{ findingId: string; error: string }>;
	error?: string;
}

/**
 * "Not a per-beneficiary posting" recovery for linkage warnings (815 /
 * 820 / 310 / 635). Reverses each finding's JE and reposts with the
 * per-bene line replaced by a line on `targetAccountId`. The source line
 * is located via metadata.accountId (set by the eligibility rule when it
 * emits the warning).
 */
export async function recategorizeContactBeneficiaryLinkage(args: {
	findingIds: string[];
	targetAccountId: string;
}): Promise<RecategorizeContactBeneficiaryLinkageResult> {
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

	const failed: Array<{ findingId: string; error: string }> = [];
	let processed = 0;
	for (const findingId of args.findingIds) {
		try {
			const ok = await recategorizeOne({ orgId, userId, findingId, target });
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

async function recategorizeOne(args: {
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
	if (!APPLICABLE_CODES.has(finding.code)) {
		return { ok: false, error: `recategorizeContactBeneficiaryLinkage doesn't apply to ${finding.code}` };
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
		return { ok: false, error: 'No matching source line on this JE' };
	}
	const totalDebit = sourceLines.reduce((acc, l) => acc + Number(l.debit ?? 0), 0);
	const totalCredit = sourceLines.reduce((acc, l) => acc + Number(l.credit ?? 0), 0);

	try {
		await db.transaction(async (tx) => {
			await reverseJournalEntry(
				{
					organizationId: orgId,
					journalEntryId: je.id,
					reversalMemo: `Reversal — per-bene line recategorized to ${target.accountNumber ?? ''} ${target.accountName}`,
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
				message: `Moved from ${source?.accountNumber ?? ''} ${source?.accountName ?? 'per-bene account'} to ${target.accountNumber ?? ''} ${target.accountName} — not a per-beneficiary posting.`,
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
					dismissedNote: `Auto-dismissed: recategorized to ${target.accountNumber ?? ''} ${target.accountName} — not a per-beneficiary posting.`,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(trustReviewFindings.id, finding.id));
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to recategorize' };
	}

	return { ok: true };
}
