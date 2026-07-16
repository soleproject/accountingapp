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

export interface RecategorizeFindingToAccountResult {
	ok: boolean;
	processed: number;
	failed: Array<{ findingId: string; error: string }>;
	error?: string;
}

/**
 * Generic per-contact bulk recategorize: each finding's JE gets reversed
 * + reposted with the source line replaced by a line on `targetAccountId`.
 * Inserts a TRUST_NON_TRUST_RECATEGORIZED audit per JE and dismisses the
 * originating finding.
 *
 * The source line on the JE is located by either:
 *   - finding.metadata.accountId  (when the rule emits it — eligibility
 *     does this for LINKAGE_REQUIRED, 635, asset, non-trust, etc.)
 *   - or a CoA join on detail_type (for warnings whose metadata is sparse
 *     — vehicle 'auto', charitable 'charitable_contributions', etc.)
 *
 * Used as the "Not this kind / Other → CoA" shared backend across most
 * trust-review warnings.
 */
export async function recategorizeFindingToAccount(args: {
	findingIds: string[];
	targetAccountId: string;
	applicableCodes: readonly string[];
	sourceLine:
		| { kind: 'metadata_account_id' }
		| { kind: 'detail_type'; detailType: string };
	/** Optional verb for the audit message, e.g. "vehicle expense" →
	 *  "Moved from X to Y — not a vehicle expense." Defaults to a generic
	 *  message. */
	auditVerb?: string;
}): Promise<RecategorizeFindingToAccountResult> {
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

	const codeSet = new Set(args.applicableCodes);
	const failed: Array<{ findingId: string; error: string }> = [];
	let processed = 0;

	for (const findingId of args.findingIds) {
		try {
			const ok = await recategorizeOne({
				orgId,
				userId,
				findingId,
				target,
				codeSet,
				sourceLine: args.sourceLine,
				auditVerb: args.auditVerb,
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

async function recategorizeOne(args: {
	orgId: string;
	userId: string | null;
	findingId: string;
	target: { id: string; accountNumber: string | null; accountName: string };
	codeSet: ReadonlySet<string>;
	sourceLine:
		| { kind: 'metadata_account_id' }
		| { kind: 'detail_type'; detailType: string };
	auditVerb?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
	const { orgId, userId, findingId, target, codeSet, sourceLine, auditVerb } = args;

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
	if (!codeSet.has(finding.code)) {
		return { ok: false, error: `Recategorize doesn't apply to ${finding.code}` };
	}

	let sourceAccountId: string | null = null;
	let sourceAccountNumber: string | null = null;
	let sourceAccountName: string | null = null;

	if (sourceLine.kind === 'metadata_account_id') {
		const meta = (finding.metadata ?? {}) as { accountId?: string };
		if (!meta.accountId) return { ok: false, error: 'Finding metadata missing accountId' };
		sourceAccountId = meta.accountId;
		const [s] = await db
			.select({
				accountNumber: chartOfAccounts.accountNumber,
				accountName: chartOfAccounts.accountName,
			})
			.from(chartOfAccounts)
			.where(eq(chartOfAccounts.id, meta.accountId))
			.limit(1);
		sourceAccountNumber = s?.accountNumber ?? null;
		sourceAccountName = s?.accountName ?? null;
	} else {
		const [s] = await db
			.select({
				accountId: journalEntryLines.accountId,
				accountNumber: chartOfAccounts.accountNumber,
				accountName: chartOfAccounts.accountName,
			})
			.from(journalEntryLines)
			.innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalEntryLines.accountId))
			.where(
				and(
					eq(journalEntryLines.journalEntryId, finding.journalEntryId),
					eq(chartOfAccounts.organizationId, orgId),
					eq(chartOfAccounts.detailType, sourceLine.detailType),
				),
			)
			.limit(1);
		if (!s) return { ok: false, error: `No line with detail_type=${sourceLine.detailType} on this JE` };
		sourceAccountId = s.accountId;
		sourceAccountNumber = s.accountNumber;
		sourceAccountName = s.accountName;
	}

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
	const sourceLines = lines.filter((l) => l.accountId === sourceAccountId);
	const otherLines = lines.filter((l) => l.accountId !== sourceAccountId);
	if (sourceLines.length === 0) {
		return { ok: false, error: 'No matching source line on this JE' };
	}
	const totalDebit = sourceLines.reduce((acc, l) => acc + Number(l.debit ?? 0), 0);
	const totalCredit = sourceLines.reduce((acc, l) => acc + Number(l.credit ?? 0), 0);
	const verb = auditVerb ?? '';

	try {
		await db.transaction(async (tx) => {
			await reverseJournalEntry(
				{
					organizationId: orgId,
					journalEntryId: je.id,
					reversalMemo: `Reversal — line recategorized to ${target.accountNumber ?? ''} ${target.accountName}${verb ? ` (not ${verb})` : ''}`,
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
				message: `Moved from ${sourceAccountNumber ?? ''} ${sourceAccountName ?? ''} to ${target.accountNumber ?? ''} ${target.accountName}${verb ? ` — not ${verb}` : ''}.`,
				metadata: {
					accountId: target.id,
					accountNumber: target.accountNumber,
					fromAccountId: sourceAccountId,
					fromAccountNumber: sourceAccountNumber,
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
					dismissedNote: `Auto-dismissed: recategorized to ${target.accountNumber ?? ''} ${target.accountName}${verb ? ` — not ${verb}` : ''}.`,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(trustReviewFindings.id, finding.id));
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to recategorize' };
	}

	return { ok: true };
}
