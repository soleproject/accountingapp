import 'server-only';
import { randomUUID } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	assetBooks,
	assetCategories,
	assetDepreciationRuns,
	fixedAssets,
} from '@/db/schema/schema';
import { createJournalEntry, JournalEntryError } from './posting';
import {
	computeDepreciation,
	type DepreciationConvention,
	type DepreciationMethod,
} from './asset-depreciation';

export interface RunAssetDepreciationCoreArgs {
	organizationId: string;
	periodEndDate: string;
	bookType: 'fiduciary' | 'tax';
	triggeredBy: 'manual' | 'cron';
	triggeredByUserId?: string | null;
	/** When 'auto_only', limits to assets whose auto_depreciate flag is on.
	 *  'all_active' is the manual-run default — every active asset gets
	 *  considered. */
	scope: 'all_active' | 'auto_only';
}

export interface RunAssetDepreciationCoreResult {
	ok: boolean;
	error?: string;
	runId?: string;
	journalEntryId?: string | null;
	assetsIncluded?: number;
	totalExpense?: number;
	skipped?: Array<{ assetId: string; assetName: string; reason: string }>;
	/** True when the call short-circuited because a run already exists for
	 *  (org, book, period). Distinct from a fresh run — caller may want to
	 *  surface differently. */
	alreadyExisted?: boolean;
}

/**
 * Shared engine for the manual run action AND the monthly cron. Mirrors
 * the action's contract but takes orgId explicitly (no session lookup)
 * and accepts a scope filter (all active vs auto-only).
 *
 * Idempotent at the (org, book, period_end_date) level. Posts a single
 * grouped JE summing per-category, updates each asset's accumulated
 * state, and records an asset_depreciation_runs row.
 */
export async function runAssetDepreciationCore(
	args: RunAssetDepreciationCoreArgs,
): Promise<RunAssetDepreciationCoreResult> {
	const { organizationId: orgId, periodEndDate, bookType, triggeredBy, triggeredByUserId, scope } = args;

	// Idempotency check.
	const [existingRun] = await db
		.select({
			id: assetDepreciationRuns.id,
			journalEntryId: assetDepreciationRuns.journalEntryId,
			assetsIncluded: assetDepreciationRuns.assetsIncluded,
			totalExpense: assetDepreciationRuns.totalExpense,
		})
		.from(assetDepreciationRuns)
		.where(
			and(
				eq(assetDepreciationRuns.organizationId, orgId),
				eq(assetDepreciationRuns.bookType, bookType),
				eq(assetDepreciationRuns.periodEndDate, periodEndDate),
			),
		)
		.limit(1);
	if (existingRun) {
		return {
			ok: true,
			alreadyExisted: true,
			runId: existingRun.id,
			journalEntryId: existingRun.journalEntryId,
			assetsIncluded: existingRun.assetsIncluded,
			totalExpense: Number(existingRun.totalExpense),
			skipped: [],
		};
	}

	const baseConditions = [
		eq(fixedAssets.organizationId, orgId),
		eq(fixedAssets.status, 'active'),
	];
	if (scope === 'auto_only') {
		baseConditions.push(eq(fixedAssets.autoDepreciate, true));
	}

	const rows = await db
		.select({
			assetId: fixedAssets.id,
			assetName: fixedAssets.name,
			inServiceDate: fixedAssets.inServiceDate,
			costBasis: fixedAssets.costBasis,
			fmvAtDod: fixedAssets.fmvAtDod,
			acquisitionType: fixedAssets.acquisitionType,
			salvageValue: fixedAssets.salvageValue,
			bookId: assetBooks.id,
			method: assetBooks.method,
			convention: assetBooks.convention,
			usefulLifeMonths: assetBooks.usefulLifeMonths,
			accumulatedDepreciation: assetBooks.accumulatedDepreciation,
			accumulatedThroughDate: assetBooks.accumulatedThroughDate,
			depExpenseAccountId: assetCategories.depExpenseAccountId,
			accumDepAccountId: assetCategories.accumulatedDepAccountId,
		})
		.from(fixedAssets)
		.innerJoin(
			assetBooks,
			and(eq(assetBooks.assetId, fixedAssets.id), eq(assetBooks.bookType, bookType)),
		)
		.innerJoin(assetCategories, eq(assetCategories.id, fixedAssets.categoryId))
		.where(and(...baseConditions));

	const skipped: Array<{ assetId: string; assetName: string; reason: string }> = [];
	type Bucket = { accountId: string; cents: number; count: number };
	const debitByCategory = new Map<string, Bucket>();
	const creditByCategory = new Map<string, Bucket>();
	const bookUpdates: Array<{
		bookId: string;
		newAccumulatedCents: number;
		throughDate: string;
	}> = [];

	for (const r of rows) {
		const basis = r.acquisitionType === 'inherited' && r.fmvAtDod
			? Number(r.fmvAtDod)
			: Number(r.costBasis);
		const result = computeDepreciation({
			depreciableBasisCents: Math.round(basis * 100),
			salvageValueCents: Math.round(Number(r.salvageValue) * 100),
			usefulLifeMonths: r.usefulLifeMonths,
			method: r.method as DepreciationMethod,
			convention: r.convention as DepreciationConvention,
			inServiceDate: r.inServiceDate,
			accumulatedThroughDate: r.accumulatedThroughDate,
			accumulatedToDateCents: Math.round(Number(r.accumulatedDepreciation) * 100),
			periodEndDate,
		});
		if (!result.ok) {
			skipped.push({ assetId: r.assetId, assetName: r.assetName, reason: result.skipReason });
			continue;
		}

		const debit = debitByCategory.get(r.depExpenseAccountId) ?? {
			accountId: r.depExpenseAccountId,
			cents: 0,
			count: 0,
		};
		debit.cents += result.expenseCents;
		debit.count += 1;
		debitByCategory.set(r.depExpenseAccountId, debit);

		const credit = creditByCategory.get(r.accumDepAccountId) ?? {
			accountId: r.accumDepAccountId,
			cents: 0,
			count: 0,
		};
		credit.cents += result.expenseCents;
		credit.count += 1;
		creditByCategory.set(r.accumDepAccountId, credit);

		bookUpdates.push({
			bookId: r.bookId,
			newAccumulatedCents:
				Math.round(Number(r.accumulatedDepreciation) * 100) + result.expenseCents,
			throughDate: result.throughDate,
		});
	}

	const totalCents = [...debitByCategory.values()].reduce((a, b) => a + b.cents, 0);
	if (totalCents === 0 || bookUpdates.length === 0) {
		return {
			ok: true,
			runId: undefined,
			journalEntryId: null,
			assetsIncluded: 0,
			totalExpense: 0,
			skipped,
		};
	}

	const pe = new Date(periodEndDate);
	const periodStart = new Date(Date.UTC(pe.getUTCFullYear(), pe.getUTCMonth(), 1))
		.toISOString()
		.slice(0, 10);

	const runId = randomUUID();
	let newJeId: string | null = null;
	try {
		await db.transaction(async (tx) => {
			const lines: Array<{
				accountId: string;
				debit: number;
				credit: number;
				contactId: string | null;
				memo: string | null;
			}> = [];
			for (const b of debitByCategory.values()) {
				lines.push({
					accountId: b.accountId,
					debit: b.cents / 100,
					credit: 0,
					contactId: null,
					memo: `Depreciation (${b.count} asset${b.count === 1 ? '' : 's'})`,
				});
			}
			for (const b of creditByCategory.values()) {
				lines.push({
					accountId: b.accountId,
					debit: 0,
					credit: b.cents / 100,
					contactId: null,
					memo: `Depreciation (${b.count} asset${b.count === 1 ? '' : 's'})`,
				});
			}

			const je = await createJournalEntry(
				{
					organizationId: orgId,
					date: periodEndDate,
					memo: `Depreciation run — ${bookType} book — period ending ${periodEndDate}${triggeredBy === 'cron' ? ' (auto)' : ''}`,
					posted: true,
					sourceType: 'asset_depreciation_run',
					sourceId: runId,
					// Depreciation is a period-end adjusting entry — flag it so it
					// lands in the Adjustments column of the adjusted trial balance.
					isAdjusting: true,
					lines,
				},
				tx,
			);
			newJeId = je.id;

			const bookIds = bookUpdates.map((u) => u.bookId);
			// Bump each asset's accumulated state. One UPDATE per book — small
			// list in practice (per-org active asset count).
			for (const u of bookUpdates) {
				await tx
					.update(assetBooks)
					.set({
						accumulatedDepreciation: (u.newAccumulatedCents / 100).toFixed(2),
						accumulatedThroughDate: u.throughDate,
						updatedAt: new Date().toISOString(),
					})
					.where(eq(assetBooks.id, u.bookId));
			}
			void inArray;
			void bookIds;

			await tx.insert(assetDepreciationRuns).values({
				id: runId,
				organizationId: orgId,
				bookType,
				periodStartDate: periodStart,
				periodEndDate,
				journalEntryId: je.id,
				triggeredBy,
				triggeredByUserId: triggeredByUserId ?? null,
				assetsIncluded: bookUpdates.length,
				totalExpense: (totalCents / 100).toFixed(2),
			});
		});
	} catch (err) {
		if (err instanceof JournalEntryError) return { ok: false, error: err.message };
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to post depreciation JE' };
	}

	return {
		ok: true,
		runId,
		journalEntryId: newJeId,
		assetsIncluded: bookUpdates.length,
		totalExpense: totalCents / 100,
		skipped,
	};
}
