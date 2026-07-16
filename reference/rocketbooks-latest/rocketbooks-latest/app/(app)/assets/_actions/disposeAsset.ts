'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { randomUUID } from 'crypto';
import {
	assetBooks,
	assetCategories,
	chartOfAccounts,
	fixedAssets,
	loans,
	trustReviewFindings,
} from '@/db/schema/schema';
import { getOrgFeature } from '@/lib/accounting/get-org-feature';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { createJournalEntry, JournalEntryError } from '@/lib/accounting/posting';
import { draftResolution } from '../../trust-documents/_actions/draftResolution';
import { prefillAssetDispositionFromAsset } from '@/lib/resolutions/from-finding';
import { logger } from '@/lib/logger';

const Schema = z.object({
	assetId: z.string().min(1),
	disposalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	proceeds: z.coerce.number().nonnegative().default(0),
	fees: z.coerce.number().nonnegative().default(0),
	/** Bank/cash account that receives the proceeds. Required when
	 *  proceeds > 0; ignored for write-off ($0 proceeds) dispositions. */
	bankAccountId: z.string().optional().or(z.literal('')),
	notes: z.string().max(2000).optional().or(z.literal('')),
	/** Caller has acknowledged the "outstanding loan against this asset"
	 *  warning. Required when any linked loan has a non-zero current
	 *  principal; pass true after surfacing the confirmation in the UI. */
	acknowledgeOutstandingLoan: z.boolean().default(false),
});

export interface DisposeAssetResult {
	ok: boolean;
	error?: string;
	gain?: number;
	loss?: number;
	journalEntryId?: string;
	/** When the action refuses because of an unacknowledged linked loan,
	 *  this carries the loan info so the modal can re-prompt with the
	 *  acknowledge flag. */
	requiresLoanAck?: {
		totalLoanBalance: number;
		loans: Array<{ id: string; displayName: string; currentPrincipal: number }>;
	};
}

/**
 * Dispose of a fixed asset (sale, write-off, trade-in). Computes the
 * gain or loss and posts a single JE that:
 *
 *   Dr  Cash / Bank             proceeds - fees  (omitted when 0)
 *   Dr  Accumulated Depreciation  current accumulated value
 *   Cr  Asset account             cost basis (or FMV-at-DOD for inherited)
 *   Dr/Cr Loss/Gain on Sale       plug to balance
 *
 * Marks status='disposed' + stamps disposal_* columns. Posts under
 * sourceType='fixed_asset_disposal' for audit traceability. Asset is
 * immutable afterwards.
 */
export async function disposeAsset(args: {
	assetId: string;
	disposalDate: string;
	proceeds?: number;
	fees?: number;
	bankAccountId?: string;
	notes?: string;
	acknowledgeOutstandingLoan?: boolean;
}): Promise<DisposeAssetResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const parsed = Schema.safeParse(args);
	if (!parsed.success) {
		return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
	}
	const { assetId, disposalDate, proceeds, fees, bankAccountId, notes, acknowledgeOutstandingLoan } = parsed.data;

	// Refuse disposal when linked loans still have a balance and the
	// caller hasn't acknowledged. Modal re-prompts with the warning +
	// breakdown.
	const linkedLoans = await db
		.select({
			id: loans.id,
			displayName: loans.displayName,
			currentPrincipal: loans.currentPrincipal,
		})
		.from(loans)
		.where(
			and(
				eq(loans.organizationId, orgId),
				eq(loans.collateralAssetId, assetId),
			),
		);
	const outstandingLoans = linkedLoans
		.map((l) => ({
			id: l.id,
			displayName: l.displayName,
			currentPrincipal: Number(l.currentPrincipal),
		}))
		.filter((l) => l.currentPrincipal > 0);
	if (outstandingLoans.length > 0 && !acknowledgeOutstandingLoan) {
		return {
			ok: false,
			error: `This asset has ${outstandingLoans.length} outstanding loan${outstandingLoans.length === 1 ? '' : 's'} against it — confirm to dispose anyway.`,
			requiresLoanAck: {
				totalLoanBalance: outstandingLoans.reduce((a, l) => a + l.currentPrincipal, 0),
				loans: outstandingLoans,
			},
		};
	}

	const netProceeds = proceeds - fees;
	if (netProceeds < 0) {
		return { ok: false, error: 'Fees exceed proceeds — net would be negative.' };
	}
	if (netProceeds > 0 && !bankAccountId) {
		return { ok: false, error: 'Pick the bank account that received the proceeds.' };
	}

	const [asset] = await db
		.select({
			id: fixedAssets.id,
			name: fixedAssets.name,
			status: fixedAssets.status,
			acquisitionType: fixedAssets.acquisitionType,
			costBasis: fixedAssets.costBasis,
			fmvAtDod: fixedAssets.fmvAtDod,
			categoryId: fixedAssets.categoryId,
			assetAccountId: assetCategories.assetAccountId,
			accumulatedDepAccountId: assetCategories.accumulatedDepAccountId,
		})
		.from(fixedAssets)
		.innerJoin(assetCategories, eq(assetCategories.id, fixedAssets.categoryId))
		.where(and(eq(fixedAssets.id, assetId), eq(fixedAssets.organizationId, orgId)))
		.limit(1);
	if (!asset) return { ok: false, error: 'Asset not in this organization' };
	if (asset.status === 'disposed') return { ok: false, error: 'Asset is already disposed' };

	// Fiduciary book drives the GL — its accumulated_depreciation IS what
	// posted to the contra-asset account.
	const [book] = await db
		.select({ accumulatedDepreciation: assetBooks.accumulatedDepreciation })
		.from(assetBooks)
		.where(and(eq(assetBooks.assetId, assetId), eq(assetBooks.bookType, 'fiduciary')))
		.limit(1);
	const accumulated = Number(book?.accumulatedDepreciation ?? 0);

	const recordedBasis = asset.acquisitionType === 'inherited' && asset.fmvAtDod
		? Number(asset.fmvAtDod)
		: Number(asset.costBasis);
	const bookValue = recordedBasis - accumulated;
	const gainLoss = netProceeds - bookValue;
	const isGain = gainLoss > 0;
	const isLoss = gainLoss < 0;

	// Resolve gain/loss target accounts only when needed (avoids forcing
	// orgs that always sell at book value to seed these).
	let gainAccountId: string | null = null;
	let lossAccountId: string | null = null;
	if (isGain) {
		const [acct] = await db
			.select({ id: chartOfAccounts.id })
			.from(chartOfAccounts)
			.where(
				and(
					eq(chartOfAccounts.organizationId, orgId),
					eq(chartOfAccounts.accountNumber, '460'),
				),
			)
			.limit(1);
		if (!acct) {
			return {
				ok: false,
				error: 'No 460 Gain on Sale of Assets account on this org. Re-run the trust CoA seed.',
			};
		}
		gainAccountId = acct.id;
	}
	if (isLoss) {
		const [acct] = await db
			.select({ id: chartOfAccounts.id })
			.from(chartOfAccounts)
			.where(
				and(
					eq(chartOfAccounts.organizationId, orgId),
					eq(chartOfAccounts.accountNumber, '660'),
				),
			)
			.limit(1);
		if (!acct) {
			return {
				ok: false,
				error: 'No 660 Loss on Sale of Assets account on this org. Re-run the trust CoA seed.',
			};
		}
		lossAccountId = acct.id;
	}

	if (bankAccountId) {
		const [bank] = await db
			.select({ id: chartOfAccounts.id })
			.from(chartOfAccounts)
			.where(
				and(
					eq(chartOfAccounts.id, bankAccountId),
					eq(chartOfAccounts.organizationId, orgId),
				),
			)
			.limit(1);
		if (!bank) return { ok: false, error: 'Bank account not in this organization' };
	}

	let newJeId = '';
	try {
		await db.transaction(async (tx) => {
			const lines: Array<{
				accountId: string;
				debit: number;
				credit: number;
				contactId: string | null;
				memo: string | null;
			}> = [];

			// Cash debit (skipped on $0 write-off).
			if (netProceeds > 0 && bankAccountId) {
				lines.push({
					accountId: bankAccountId,
					debit: netProceeds,
					credit: 0,
					contactId: null,
					memo: `Proceeds from disposal of ${asset.name}`,
				});
			}

			// Clear accumulated depreciation (debit the contra to zero it).
			if (accumulated > 0) {
				lines.push({
					accountId: asset.accumulatedDepAccountId,
					debit: accumulated,
					credit: 0,
					contactId: null,
					memo: `Clear accumulated depreciation — ${asset.name}`,
				});
			}

			// Clear the asset (credit at recorded basis).
			lines.push({
				accountId: asset.assetAccountId,
				debit: 0,
				credit: recordedBasis,
				contactId: null,
				memo: `Dispose of asset ${asset.name}`,
			});

			// Plug: gain (credit) or loss (debit).
			if (isGain && gainAccountId) {
				lines.push({
					accountId: gainAccountId,
					debit: 0,
					credit: gainLoss,
					contactId: null,
					memo: `Gain on sale of ${asset.name}`,
				});
			} else if (isLoss && lossAccountId) {
				lines.push({
					accountId: lossAccountId,
					debit: -gainLoss, // gainLoss is negative; debit is positive
					credit: 0,
					contactId: null,
					memo: `Loss on sale of ${asset.name}`,
				});
			}

			const je = await createJournalEntry(
				{
					organizationId: orgId,
					date: disposalDate,
					memo: `Asset disposed: ${asset.name}${notes ? ` — ${notes}` : ''}`,
					posted: true,
					sourceType: 'fixed_asset_disposal',
					sourceId: assetId,
					lines,
				},
				tx,
			);
			newJeId = je.id;

			await tx
				.update(fixedAssets)
				.set({
					status: 'disposed',
					disposedAt: disposalDate,
					disposalProceeds: proceeds.toFixed(2),
					disposalFees: fees.toFixed(2),
					disposalJournalEntryId: je.id,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(fixedAssets.id, assetId));

			// When the user disposed despite an acknowledged outstanding
			// linked loan, drop a Trust Review finding tied to the disposal
			// JE so the trustee can revisit later. Skipped on non-trust orgs
			// (no rules engine subscription).
			if (outstandingLoans.length > 0) {
				const trustEnabled = await getOrgFeature(orgId, 'beneficial_trust');
				if (trustEnabled) {
					const totalOutstanding = outstandingLoans.reduce(
						(a, l) => a + l.currentPrincipal,
						0,
					);
					const loanList = outstandingLoans
						.map((l) => `${l.displayName} ($${l.currentPrincipal.toFixed(2)})`)
						.join(', ');
					await tx.insert(trustReviewFindings).values({
						id: randomUUID(),
						organizationId: orgId,
						journalEntryId: je.id,
						code: 'TRUST_DISPOSAL_WITH_OUTSTANDING_LOAN',
						severity: 'warn',
						message: `${asset.name} was disposed on ${disposalDate} while ${outstandingLoans.length} linked loan${outstandingLoans.length === 1 ? '' : 's'} still had a $${totalOutstanding.toFixed(2)} balance: ${loanList}. Confirm whether the buyer assumed the debt, the trustee paid the loan(s) off from proceeds, or the loan(s) need to be reassigned / written off.`,
						metadata: {
							assetId,
							assetName: asset.name,
							totalOutstanding,
							loans: outstandingLoans,
						},
					});
				}
			}
		});
	} catch (err) {
		if (err instanceof JournalEntryError) return { ok: false, error: err.message };
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to dispose asset' };
	}

	// Auto-draft the per-event Disposition Resolution. Same non-fatal
	// pattern as the contribution / acquisition hooks — a failure
	// here doesn't roll back the disposal that's already committed.
	// Source kind is 'disposed_asset' rather than 'fixed_asset' so it
	// doesn't collide with the original contribution / acquisition
	// doc keyed off the same asset id.
	try {
		const prefill = await prefillAssetDispositionFromAsset({
			organizationId: orgId,
			fixedAssetId: assetId,
		});
		if (prefill) {
			const r = await draftResolution({
				templateId: 'asset-disposition-resolution',
				variables: {
					...prefill,
					dispositionRationale: notes?.trim() || 'Disposition rationale pending — edit this resolution before signing.',
				},
				source: { kind: 'fixed_asset', id: `disposed:${assetId}` },
			});
			if (!r.ok && !r.needsTrustState) {
				logger.warn(
					{ assetId, err: r.error },
					'auto-draft disposition resolution failed (non-fatal)',
				);
			}
		}
	} catch (err) {
		logger.warn(
			{ assetId, err: err instanceof Error ? err.message : err },
			'auto-draft disposition resolution threw (non-fatal)',
		);
	}

	revalidatePath('/assets');
	revalidatePath(`/assets/${assetId}`);
	return {
		ok: true,
		gain: isGain ? gainLoss : undefined,
		loss: isLoss ? -gainLoss : undefined,
		journalEntryId: newJeId,
	};
}
