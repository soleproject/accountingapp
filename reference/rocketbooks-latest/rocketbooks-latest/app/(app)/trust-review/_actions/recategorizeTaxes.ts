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

export type TaxTarget = 'property' | 'non_property';

export interface RecategorizeTaxesResult {
	ok: boolean;
	error?: string;
	newJournalEntryId?: string;
}

/**
 * Resolve a TRUST_505_705_LIKELY_MISROUTED finding by re-posting the
 * tax line onto the OTHER tax account (property ↔ non-property).
 *
 * Reverse + repost in one tx; insert a TRUST_TAXES_RECATEGORIZED audit
 * on the new JE; dismiss the original finding. No-op (action matches
 * the current account) returns an error rather than silently doing
 * nothing — the user clicked the wrong button.
 */
export async function recategorizeTaxes(args: {
	findingId: string;
	target: TaxTarget;
}): Promise<RecategorizeTaxesResult> {
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
	if (finding.code !== 'TRUST_505_705_LIKELY_MISROUTED') {
		return { ok: false, error: 'recategorizeTaxes only applies to TRUST_505_705_LIKELY_MISROUTED' };
	}

	const meta = (finding.metadata ?? {}) as { accountId?: string; currentDetailType?: string };
	if (!meta.accountId) return { ok: false, error: 'Finding metadata missing account id' };

	const targetDetailType = args.target === 'property'
		? 'trust_property_taxes'
		: 'trust_non_property_taxes';
	if (meta.currentDetailType === targetDetailType) {
		return { ok: false, error: 'Line is already on the requested tax account' };
	}

	const [targetAcct] = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
		})
		.from(chartOfAccounts)
		.where(
			and(
				eq(chartOfAccounts.organizationId, orgId),
				eq(chartOfAccounts.detailType, targetDetailType),
			),
		)
		.limit(1);
	if (!targetAcct) {
		return { ok: false, error: `No ${args.target === 'property' ? '505 Property' : '705 Non-Property'} tax account on this org` };
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
	const sourceLines = lines.filter((l) => l.accountId === meta.accountId);
	const otherLines = lines.filter((l) => l.accountId !== meta.accountId);
	if (sourceLines.length === 0) {
		return { ok: false, error: 'No matching tax line on this JE' };
	}
	const totalDebit = sourceLines.reduce((acc, l) => acc + Number(l.debit ?? 0), 0);
	if (totalDebit <= 0) {
		return { ok: false, error: 'Tax line has no debit — nothing to recategorize' };
	}

	let newJeId: string;
	try {
		await db.transaction(async (tx) => {
			await reverseJournalEntry(
				{
					organizationId: orgId,
					journalEntryId: je.id,
					reversalMemo: `Reversal — taxes recategorized to ${targetAcct.accountNumber ?? ''} ${targetAcct.accountName}`,
				},
				tx,
			);

			const newTaxLine = {
				accountId: targetAcct.id,
				debit: totalDebit,
				credit: 0,
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
					lines: [newTaxLine, ...carryoverLines],
				},
				tx,
			);
			newJeId = newJe.id;

			await tx.insert(trustReviewFindings).values({
				id: randomUUID(),
				organizationId: orgId,
				journalEntryId: newJe.id,
				code: 'TRUST_TAXES_RECATEGORIZED',
				severity: 'warn',
				message: `Tax line recategorized to ${targetAcct.accountNumber ?? ''} ${targetAcct.accountName} (was ${meta.currentDetailType === 'trust_property_taxes' ? '505 Property Taxes' : '705 Non-Property Taxes'}).`,
				metadata: {
					accountId: targetAcct.id,
					accountNumber: targetAcct.accountNumber,
					fromDetailType: meta.currentDetailType,
					toDetailType: targetDetailType,
					amount: totalDebit,
				},
			});

			await tx
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedByUserId: userId,
					dismissedNote: `Auto-dismissed: taxes recategorized to ${targetAcct.accountNumber ?? ''} ${targetAcct.accountName}.`,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(trustReviewFindings.id, finding.id));
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to recategorize taxes' };
	}

	revalidatePath('/trust-review');
	return { ok: true, newJournalEntryId: newJeId! };
}
