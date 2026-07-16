'use server';

import { randomUUID } from 'crypto';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	contacts,
	journalEntries,
	journalEntryLines,
	transactions,
	trustReviewFindings,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { evaluateBeneficialTrustJournalEntry } from '@/lib/accounting/rules/beneficial-trust';
import { createJournalEntry, reverseJournalEntry } from '@/lib/accounting/posting';
import {
	resolve710Context,
	build710TrusteeAttributionFinding,
} from '@/lib/accounting/trust-710-reroute';

export interface TagTrusteeResult {
	ok: boolean;
	error?: string;
}

/**
 * Set the contact on the journal-entry line referenced by a Trust Review
 * finding. Used by the per-row Trustee action on the Meals & Entertainment
 * (710) group — the trust rules engine considers a 710 line "attributed"
 * when its contact has `'trustee'` in typeTags, so pointing the line at a
 * trustee contact clears the warning.
 *
 * Two paths depending on the finding code:
 *   OPEN (TRUST_710_ATTRIBUTION_REQUIRED)
 *     - in-place: set contactId on the existing 710 line, re-evaluate rules
 *   DECISIONED (TRUST_710_REROUTED_TO_FOOD | TRUST_710_REROUTED_TO_DEMAND_NOTE)
 *     - reverse the rerouted JE, repost on the original 710 account with
 *       the trustee contact set + beneficiary cleared — end state matches
 *       what the OPEN path would have produced if the user had picked
 *       Trustee originally.
 *
 * Idempotent on re-tag with the same contact (OPEN path).
 */
export async function tagFindingTrusteeContact(args: {
	findingId: string;
	contactId: string;
}): Promise<TagTrusteeResult> {
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

	const [contact] = await db
		.select({
			id: contacts.id,
			typeTags: contacts.typeTags,
		})
		.from(contacts)
		.where(
			and(
				eq(contacts.id, args.contactId),
				eq(contacts.organizationId, orgId),
			),
		)
		.limit(1);
	if (!contact) return { ok: false, error: 'Contact not in this organization' };
	const tags = Array.isArray(contact.typeTags) ? contact.typeTags : [];
	const isTrustee = tags.some((t) => typeof t === 'string' && t.toLowerCase() === 'trustee');
	if (!isTrustee) {
		return {
			ok: false,
			error: 'Contact is not marked as a trustee. Mark them as a trustee on their contact page first.',
		};
	}

	const [trusteeRow] = await db
		.select({ contactName: contacts.contactName })
		.from(contacts)
		.where(eq(contacts.id, args.contactId))
		.limit(1);
	const trusteeName = trusteeRow?.contactName ?? 'trustee';

	const ctx = resolve710Context(finding.code, finding.metadata);
	if (!ctx.ok) return { ok: false, error: ctx.error };

	if (finding.code !== 'TRUST_710_ATTRIBUTION_REQUIRED' && finding.code !== 'TRUST_710_ATTRIBUTED_TO_TRUSTEE') {
		return await reroute710BackToOriginalWithTrustee({
			orgId,
			userId,
			finding,
			contactId: args.contactId,
			trusteeName,
			sourceAccountId: ctx.sourceAccountId,
			originalAccountId: ctx.originalAccountId,
		});
	}

	// OPEN-like path (open attribution OR already-trustee re-tag) — in-place
	// edit on the existing 710 line.
	await db
		.update(journalEntryLines)
		.set({ contactId: args.contactId })
		.where(
			and(
				eq(journalEntryLines.journalEntryId, finding.journalEntryId),
				eq(journalEntryLines.accountId, ctx.sourceAccountId),
			),
		);

	// Re-evaluate trust rules on the JE so the queue updates.
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

	const result = await evaluateBeneficialTrustJournalEntry({
		organizationId: orgId,
		date: je.date,
		memo: je.memo,
		sourceType: je.sourceType,
		sourceId: je.sourceId,
		lines: lines.map((l) => ({
			accountId: l.accountId,
			debit: Number(l.debit),
			credit: Number(l.credit),
			contactId: l.contactId,
			memo: l.memo,
			beneficiaryId: l.beneficiaryId ?? null,
		})),
	});

	// Compute the trustee-line debit + look up the 710 account so we can
	// add an audit finding to the Decisioned tab alongside the rules-
	// engine output.
	const trusteeLineDebit = lines
		.filter((l) => l.accountId === ctx.sourceAccountId)
		.reduce((acc, l) => acc + Number(l.debit ?? 0), 0);
	const [acct] = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
		})
		.from(chartOfAccounts)
		.where(eq(chartOfAccounts.id, ctx.originalAccountId))
		.limit(1);

	await db.transaction(async (tx) => {
		const priorDismissed = await tx
			.select({
				code: trustReviewFindings.code,
				dismissedAt: trustReviewFindings.dismissedAt,
				dismissedByUserId: trustReviewFindings.dismissedByUserId,
				dismissedNote: trustReviewFindings.dismissedNote,
			})
			.from(trustReviewFindings)
			.where(
				and(
					eq(trustReviewFindings.journalEntryId, je.id),
					isNotNull(trustReviewFindings.dismissedAt),
				),
			);
		const dismissedByCode = new Map(priorDismissed.map((d) => [d.code, d]));

		await tx
			.delete(trustReviewFindings)
			.where(eq(trustReviewFindings.journalEntryId, je.id));

		const ruleRows = result.findings.map((f) => {
			const dismiss = dismissedByCode.get(f.code);
			return {
				id: randomUUID(),
				organizationId: orgId,
				journalEntryId: je.id,
				code: f.code,
				severity: f.severity,
				message: f.message,
				metadata: f.metadata ?? null,
				dismissedAt: dismiss?.dismissedAt ?? null,
				dismissedByUserId: dismiss?.dismissedByUserId ?? null,
				dismissedNote: dismiss?.dismissedNote ?? null,
			};
		});

		// Insert the trustee attribution audit alongside the rule output.
		// Skipped when the 710 account row vanished (very-old data) since
		// the audit message embeds the account label.
		const auditRows = acct
			? [
					{
						id: randomUUID(),
						...build710TrusteeAttributionFinding({
							organizationId: orgId,
							journalEntryId: je.id,
							accountId: acct.id,
							accountNumber: acct.accountNumber,
							accountName: acct.accountName,
							trusteeLabel: trusteeName,
							trusteeCount: 1,
							amount: trusteeLineDebit,
						}),
					},
				]
			: [];

		const allRows = [...ruleRows, ...auditRows];
		if (allRows.length > 0) {
			await tx.insert(trustReviewFindings).values(allRows);
		}
	});

	revalidatePath('/trust-review');
	return { ok: true };
}

/**
 * Decisioned-row path. The JE currently has the line on the rerouted
 * destination (815 or a 26x demand note). Reverse it and repost on the
 * original 710 account with the trustee contact set and the beneficiary
 * tag cleared, so the resulting GL state matches what would have been
 * posted had the user picked Trustee on the original open finding.
 */
async function reroute710BackToOriginalWithTrustee(args: {
	orgId: string;
	userId: string | null;
	finding: {
		id: string;
		journalEntryId: string;
	};
	contactId: string;
	trusteeName: string;
	sourceAccountId: string;
	originalAccountId: string;
}): Promise<TagTrusteeResult> {
	const { orgId, userId, finding, contactId, trusteeName, sourceAccountId, originalAccountId } = args;

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

	const meLines = lines.filter((l) => l.accountId === sourceAccountId);
	const otherLines = lines.filter((l) => l.accountId !== sourceAccountId);
	if (meLines.length === 0) {
		return { ok: false, error: 'No matching line found on this JE — nothing to re-route back to 710' };
	}
	const totalDebit = meLines.reduce((acc, l) => acc + Number(l.debit ?? 0), 0);
	if (totalDebit <= 0) {
		return { ok: false, error: 'Line has no positive debit amount to re-route' };
	}
	const sharedMemo = meLines[0]?.memo ?? null;

	const [originalAcct] = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
		})
		.from(chartOfAccounts)
		.where(eq(chartOfAccounts.id, originalAccountId))
		.limit(1);
	if (!originalAcct) return { ok: false, error: 'Original 710 account missing from CoA' };

	try {
		await db.transaction(async (tx) => {
			await reverseJournalEntry(
				{
					organizationId: orgId,
					journalEntryId: je.id,
					reversalMemo: `Reversal — 710 line re-attributed to trustee (was rerouted to a beneficiary)`,
				},
				tx,
			);

			const newCategoryLine = {
				accountId: originalAccountId,
				debit: totalDebit,
				credit: 0,
				contactId,
				memo: sharedMemo,
				beneficiaryId: null,
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
					lines: [newCategoryLine, ...carryoverLines],
				},
				tx,
			);

			if (je.sourceType === 'transaction' && je.sourceId) {
				await tx
					.update(transactions)
					.set({ journalEntryId: newJe.id, categoryAccountId: originalAccountId })
					.where(
						and(
							eq(transactions.id, je.sourceId),
							eq(transactions.organizationId, orgId),
						),
					);
			}

			await tx.insert(trustReviewFindings).values({
				id: randomUUID(),
				...build710TrusteeAttributionFinding({
					organizationId: orgId,
					journalEntryId: newJe.id,
					accountId: originalAcct.id,
					accountNumber: originalAcct.accountNumber,
					accountName: originalAcct.accountName,
					trusteeLabel: trusteeName,
					trusteeCount: 1,
					amount: totalDebit,
				}),
			});

			// Dismiss every still-open finding on the reversed JE — see
			// reroute710ToBeneficiary for the rationale.
			await tx
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedByUserId: userId,
					dismissedNote: `Auto-dismissed: prior reroute reversed; 710 line re-attributed to trustee. See JE ${newJe.id.slice(0, 8)}.`,
					updatedAt: new Date().toISOString(),
				})
				.where(
					and(
						eq(trustReviewFindings.journalEntryId, finding.journalEntryId),
						isNull(trustReviewFindings.dismissedAt),
					),
				);
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to re-route' };
	}

	revalidatePath('/trust-review');
	revalidatePath('/trust-beneficiaries');
	return { ok: true };
}
