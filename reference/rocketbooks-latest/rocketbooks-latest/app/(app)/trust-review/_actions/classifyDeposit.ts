'use server';

import { randomUUID } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	journalEntries,
	journalEntryLines,
	trustReviewFindings,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { createJournalEntry, reverseJournalEntry } from '@/lib/accounting/posting';
import { draftResolution } from '../../trust-documents/_actions/draftResolution';
import { logger } from '@/lib/logger';
import { prefillBillOfSaleFromCorpusFinding } from '@/lib/resolutions/from-finding';

export type DepositClassification = 'corpus' | 'income';

export interface ClassifyDepositResult {
	ok: boolean;
	error?: string;
	newJournalEntryId?: string;
	/** When decision='corpus', the system auto-drafts a Bill of Sale
	 *  documenting the contribution. UI can use this to surface a
	 *  "View / sign draft" affordance after the classification. */
	billOfSaleDocumentId?: string;
}

/**
 * Resolve a TRUST_DEPOSIT_NEEDS_CORPUS_OR_INCOME_CLASSIFICATION finding by
 * confirming the line should stay on the corpus equity account OR by
 * rerouting it to a 4xx income account.
 *
 * 'corpus' → if the line is already on an equity account, no JE change
 * (just drop a TRUST_DEPOSIT_CLASSIFIED_AS_CORPUS audit on the JE and
 * dismiss the original). If the line is somehow on a non-equity account
 * when classified as corpus, reverse + repost on the org's first equity
 * account (excluding the Distributions equity).
 *
 * 'income' → reverse the JE and repost the line on the picked 4xx
 * income account, then audit + dismiss.
 *
 * Split (two-account) classification is deferred — manual JE for that
 * case until we surface the modal.
 */
export async function classifyDeposit(args: {
	findingId: string;
	decision: DepositClassification;
	/** Required when decision='income'. Must be a 4xx income/other_income account. */
	incomeAccountId?: string;
}): Promise<ClassifyDepositResult> {
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
	if (finding.code !== 'TRUST_DEPOSIT_NEEDS_CORPUS_OR_INCOME_CLASSIFICATION') {
		return { ok: false, error: `classifyDeposit only applies to DEPOSIT_NEEDS_CLASSIFICATION findings` };
	}

	const meta = (finding.metadata ?? {}) as { accountId?: string; currentAccountId?: string };
	const sourceAccountId = meta.currentAccountId ?? meta.accountId;
	if (!sourceAccountId) return { ok: false, error: 'Finding metadata missing account id' };

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

	let targetAccountId: string;
	let auditCode:
		| 'TRUST_DEPOSIT_CLASSIFIED_AS_CORPUS'
		| 'TRUST_DEPOSIT_CLASSIFIED_AS_INCOME';
	let auditMessageSuffix: string;

	if (args.decision === 'corpus') {
		// Find the org's corpus equity account (first equity that isn't the
		// Distributions equity). If the source is already an equity account,
		// keep it.
		const equityAccounts = await db
			.select({
				id: chartOfAccounts.id,
				accountNumber: chartOfAccounts.accountNumber,
				accountName: chartOfAccounts.accountName,
				detailType: chartOfAccounts.detailType,
			})
			.from(chartOfAccounts)
			.where(
				and(
					eq(chartOfAccounts.organizationId, orgId),
					eq(chartOfAccounts.accountType, 'equity'),
				),
			);
		const corpusCandidate = equityAccounts.find(
			(a) => a.detailType !== 'trust_distributions_to_beneficiaries' && a.detailType !== 'retained_earnings',
		) ?? equityAccounts.find((a) => a.id === sourceAccountId);
		if (!corpusCandidate) {
			return { ok: false, error: 'No corpus equity account found on this org' };
		}
		targetAccountId = corpusCandidate.id;
		auditCode = 'TRUST_DEPOSIT_CLASSIFIED_AS_CORPUS';
		auditMessageSuffix = `confirmed as corpus on ${corpusCandidate.accountNumber ?? ''} ${corpusCandidate.accountName}`;
	} else {
		if (!args.incomeAccountId) {
			return { ok: false, error: 'Income account is required when reclassifying as income' };
		}
		const [income] = await db
			.select({
				id: chartOfAccounts.id,
				accountNumber: chartOfAccounts.accountNumber,
				accountName: chartOfAccounts.accountName,
				accountType: chartOfAccounts.accountType,
			})
			.from(chartOfAccounts)
			.where(
				and(
					eq(chartOfAccounts.id, args.incomeAccountId),
					eq(chartOfAccounts.organizationId, orgId),
				),
			)
			.limit(1);
		if (!income) return { ok: false, error: 'Income account not in this organization' };
		if (!['income', 'other_income'].includes(income.accountType ?? '')) {
			return { ok: false, error: 'Selected account is not an income account' };
		}
		targetAccountId = income.id;
		auditCode = 'TRUST_DEPOSIT_CLASSIFIED_AS_INCOME';
		auditMessageSuffix = `reclassified to ${income.accountNumber ?? ''} ${income.accountName}`;
	}

	// Read the line we're acting on (and the rest, for carryover).
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
		return { ok: false, error: 'No matching deposit line on this JE — nothing to classify' };
	}
	const totalCredit = sourceLines.reduce((acc, l) => acc + Number(l.credit ?? 0), 0);
	if (totalCredit <= 0) {
		return { ok: false, error: 'Source line has no credit amount — not a deposit' };
	}

	// No-op case: confirming corpus on a line that's already on the corpus
	// account → just emit the audit and dismiss without touching the GL.
	const noChange = sourceAccountId === targetAccountId;

	let newJeId: string | undefined;
	// Pre-allocate the audit finding id so we can both (a) record it in
	// the transaction below and (b) use it as the source key for the
	// auto-draft Bill of Sale after the transaction commits.
	const auditFindingId = randomUUID();
	try {
		await db.transaction(async (tx) => {
			if (!noChange) {
				await reverseJournalEntry(
					{
						organizationId: orgId,
						journalEntryId: je.id,
						reversalMemo: `Reversal — deposit ${auditMessageSuffix}`,
					},
					tx,
				);

				const newDepositLine = {
					accountId: targetAccountId,
					debit: 0,
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
						lines: [newDepositLine, ...carryoverLines],
					},
					tx,
				);
				newJeId = newJe.id;
			}

			// Audit finding on the live JE (new one when we rerouted, original
			// otherwise).
			const auditJeId = newJeId ?? je.id;
			await tx.insert(trustReviewFindings).values({
				id: auditFindingId,
				organizationId: orgId,
				journalEntryId: auditJeId,
				code: auditCode,
				severity: 'warn',
				message: `Deposit ${auditMessageSuffix}.`,
				metadata: {
					accountId: targetAccountId,
					fromAccountId: sourceAccountId,
					toAccountId: targetAccountId,
					amount: totalCredit,
				},
			});

			// Dismiss the original (will already be gone if we reversed the JE
			// since reverseJournalEntry deletes findings on the reversed JE,
			// but this UPDATE is safe either way).
			void inArray;
			await tx
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedByUserId: userId,
					dismissedNote: `Auto-dismissed: deposit ${auditMessageSuffix}.`,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(trustReviewFindings.id, finding.id));
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to classify deposit' };
	}

	// Auto-draft the per-event Bill of Sale when the user classified
	// as corpus. Idempotency lives in draftResolution — calling this
	// for the same finding twice returns the same doc id. We do this
	// outside the GL transaction on purpose: a draft-doc failure
	// shouldn't roll back the classification (the user can always
	// manually draft later).
	let billOfSaleDocumentId: string | undefined;
	if (args.decision === 'corpus') {
		try {
			const prefill = await prefillBillOfSaleFromCorpusFinding({
				organizationId: orgId,
				findingId: auditFindingId,
			});
			if (prefill) {
				const r = await draftResolution({
					templateId: 'bill-of-sale',
					variables: prefill as unknown as Record<string, unknown>,
					source: { kind: 'deposit_finding', id: auditFindingId },
				});
				if (r.ok && r.documentRecordId) {
					billOfSaleDocumentId = r.documentRecordId;
				} else if (r.needsTrustState) {
					logger.info(
						{ findingId: auditFindingId },
						'auto-draft bill of sale skipped — trust state missing',
					);
				} else {
					logger.warn(
						{ findingId: auditFindingId, err: r.error },
						'auto-draft bill of sale failed (non-fatal)',
					);
				}
			}
		} catch (err) {
			logger.warn(
				{ findingId: auditFindingId, err: err instanceof Error ? err.message : err },
				'auto-draft bill of sale threw (non-fatal)',
			);
		}
	}

	revalidatePath('/trust-review');
	return { ok: true, newJournalEntryId: newJeId, billOfSaleDocumentId };
}
