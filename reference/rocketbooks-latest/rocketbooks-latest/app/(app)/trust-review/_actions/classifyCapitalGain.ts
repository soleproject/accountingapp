'use server';

import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
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
import { prefillCapitalGainToCorpusFromFinding } from '@/lib/resolutions/from-finding';
import { logger } from '@/lib/logger';

export type CapitalGainClassification = 'short_term' | 'long_term_income' | 'long_term_corpus';

export interface ClassifyCapitalGainResult {
	ok: boolean;
	error?: string;
	newJournalEntryId?: string;
	/** When decision='long_term_corpus', auto-drafts the per-event
	 *  Capital Gain to Corpus memo and returns its id so the UI can
	 *  prompt the user to review / sign. */
	corpusMemoDocumentId?: string;
}

/**
 * Resolve a TRUST_CAPITAL_GAIN_NEEDS_HOLDING_PERIOD finding.
 *
 *   short_term         → ensure on 420 (reverse + repost from 425 if needed)
 *   long_term_income   → ensure on 425 (reverse + repost from 420 if needed)
 *   long_term_corpus   → reverse + repost on the org's corpus equity account
 *                        (per trust instrument that routes long-term gains
 *                        to principal instead of distributable income)
 *
 * Audit finding emitted on the live JE in every case.
 */
export async function classifyCapitalGain(args: {
	findingId: string;
	decision: CapitalGainClassification;
}): Promise<ClassifyCapitalGainResult> {
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
	if (finding.code !== 'TRUST_CAPITAL_GAIN_NEEDS_HOLDING_PERIOD') {
		return { ok: false, error: `classifyCapitalGain only applies to CAPITAL_GAIN_NEEDS_HOLDING_PERIOD findings` };
	}

	const meta = (finding.metadata ?? {}) as { accountId?: string; currentAccountId?: string };
	const sourceAccountId = meta.currentAccountId ?? meta.accountId;
	if (!sourceAccountId) return { ok: false, error: 'Finding metadata missing account id' };

	// Resolve target accounts: short-term 420, long-term 425, corpus equity.
	const candidates = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
			accountType: chartOfAccounts.accountType,
			detailType: chartOfAccounts.detailType,
		})
		.from(chartOfAccounts)
		.where(eq(chartOfAccounts.organizationId, orgId));
	const shortTermAccount = candidates.find((a) => a.detailType === 'trust_short_term_capital_gains');
	const longTermAccount = candidates.find((a) => a.detailType === 'trust_long_term_capital_gains');
	const corpusAccount = candidates.find(
		(a) =>
			a.accountType === 'equity'
			&& a.detailType !== 'trust_distributions_to_beneficiaries'
			&& a.detailType !== 'retained_earnings',
	);

	let targetAccountId: string;
	let auditCode:
		| 'TRUST_CAPITAL_GAIN_CLASSIFIED_SHORT_TERM'
		| 'TRUST_CAPITAL_GAIN_CLASSIFIED_LONG_TERM_INCOME'
		| 'TRUST_CAPITAL_GAIN_CLASSIFIED_LONG_TERM_CORPUS';
	let auditMessageSuffix: string;

	if (args.decision === 'short_term') {
		if (!shortTermAccount) return { ok: false, error: 'No 420 short-term capital-gains account on this org' };
		targetAccountId = shortTermAccount.id;
		auditCode = 'TRUST_CAPITAL_GAIN_CLASSIFIED_SHORT_TERM';
		auditMessageSuffix = `classified short-term — on ${shortTermAccount.accountNumber ?? ''} ${shortTermAccount.accountName}`;
	} else if (args.decision === 'long_term_income') {
		if (!longTermAccount) return { ok: false, error: 'No 425 long-term capital-gains account on this org' };
		targetAccountId = longTermAccount.id;
		auditCode = 'TRUST_CAPITAL_GAIN_CLASSIFIED_LONG_TERM_INCOME';
		auditMessageSuffix = `classified long-term income — on ${longTermAccount.accountNumber ?? ''} ${longTermAccount.accountName}`;
	} else {
		if (!corpusAccount) return { ok: false, error: 'No corpus equity account found on this org' };
		targetAccountId = corpusAccount.id;
		auditCode = 'TRUST_CAPITAL_GAIN_CLASSIFIED_LONG_TERM_CORPUS';
		auditMessageSuffix = `classified long-term to corpus — on ${corpusAccount.accountNumber ?? ''} ${corpusAccount.accountName}`;
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
		return { ok: false, error: 'No matching capital-gain line on this JE' };
	}
	const totalCredit = sourceLines.reduce((acc, l) => acc + Number(l.credit ?? 0), 0);
	if (totalCredit <= 0) {
		return { ok: false, error: 'Source line has no credit amount — not a gain deposit' };
	}

	const noChange = sourceAccountId === targetAccountId;

	let newJeId: string | undefined;
	// Pre-allocate the audit finding id so we can both (a) record it in
	// the transaction and (b) use it as the source key when auto-
	// drafting the corpus-allocation memo after commit.
	const auditFindingId = randomUUID();
	try {
		await db.transaction(async (tx) => {
			if (!noChange) {
				await reverseJournalEntry(
					{
						organizationId: orgId,
						journalEntryId: je.id,
						reversalMemo: `Reversal — capital gain ${auditMessageSuffix}`,
					},
					tx,
				);
				const newGainLine = {
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
						lines: [newGainLine, ...carryoverLines],
					},
					tx,
				);
				newJeId = newJe.id;
			}

			const auditJeId = newJeId ?? je.id;
			await tx.insert(trustReviewFindings).values({
				id: auditFindingId,
				organizationId: orgId,
				journalEntryId: auditJeId,
				code: auditCode,
				severity: 'warn',
				message: `Capital gain ${auditMessageSuffix}.`,
				metadata: {
					accountId: targetAccountId,
					fromAccountId: sourceAccountId,
					toAccountId: targetAccountId,
					amount: totalCredit,
				},
			});

			void and;
			await tx
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedByUserId: userId,
					dismissedNote: `Auto-dismissed: capital gain ${auditMessageSuffix}.`,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(trustReviewFindings.id, finding.id));
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to classify capital gain' };
	}

	// Auto-draft the per-event Capital Gain to Corpus memo when the
	// user routed the gain to principal. Idempotency lives in
	// draftResolution. Non-fatal — a draft hiccup shouldn't roll back
	// the GL classification.
	let corpusMemoDocumentId: string | undefined;
	if (args.decision === 'long_term_corpus') {
		try {
			const prefill = await prefillCapitalGainToCorpusFromFinding({
				organizationId: orgId,
				findingId: auditFindingId,
			});
			if (prefill) {
				const r = await draftResolution({
					templateId: 'capital-gain-to-corpus-memo',
					variables: {
						...prefill,
						// Allocation justification is required by the schema
						// but a judgment-call field. Seed a placeholder the
						// user MUST edit before signing; the form will be
						// reachable for editing pre-signature.
						allocationJustification: 'Allocation rationale pending — edit this memo before signing.',
					},
					source: { kind: 'deposit_finding', id: auditFindingId },
				});
				if (r.ok && r.documentRecordId) {
					corpusMemoDocumentId = r.documentRecordId;
				} else if (!r.needsTrustState) {
					logger.warn(
						{ findingId: auditFindingId, err: r.error },
						'auto-draft capital-gain corpus memo failed (non-fatal)',
					);
				}
			}
		} catch (err) {
			logger.warn(
				{ findingId: auditFindingId, err: err instanceof Error ? err.message : err },
				'auto-draft capital-gain corpus memo threw (non-fatal)',
			);
		}
	}

	revalidatePath('/trust-review');
	return { ok: true, newJournalEntryId: newJeId, corpusMemoDocumentId };
}
