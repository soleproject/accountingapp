/**
 * Cleanup: reverse every depreciation-run JE on this org, drop the run
 * audit rows, and reset every asset book's accumulated_depreciation to 0.
 * One-shot for test data — DO NOT run on production books.
 */

import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	assetBooks,
	assetDepreciationRuns,
	fixedAssets,
	journalEntries,
} from '@/db/schema/schema';
import { reverseJournalEntry } from '@/lib/accounting/posting';

async function main() {
	const orgIdIdx = process.argv.indexOf('--org');
	const orgId = orgIdIdx >= 0 ? process.argv[orgIdIdx + 1] : null;
	if (!orgId) {
		console.error('Usage: reset-dep-runs.ts --org <uuid>');
		process.exit(2);
	}

	const runs = await db
		.select({ id: assetDepreciationRuns.id, journalEntryId: assetDepreciationRuns.journalEntryId })
		.from(assetDepreciationRuns)
		.where(eq(assetDepreciationRuns.organizationId, orgId));
	console.log(`Found ${runs.length} depreciation run(s) on this org`);

	for (const r of runs) {
		console.log(`  Reversing JE ${r.journalEntryId.slice(0, 8)}...`);
		await reverseJournalEntry({
			organizationId: orgId,
			journalEntryId: r.journalEntryId,
			reversalMemo: `Reversal — depreciation run cleanup (test data)`,
		});
		await db.delete(assetDepreciationRuns).where(eq(assetDepreciationRuns.id, r.id));
	}

	// Reset accumulated state on all books for this org.
	const assets = await db
		.select({ id: fixedAssets.id })
		.from(fixedAssets)
		.where(eq(fixedAssets.organizationId, orgId));
	for (const a of assets) {
		await db
			.update(assetBooks)
			.set({ accumulatedDepreciation: '0.00', accumulatedThroughDate: null })
			.where(eq(assetBooks.assetId, a.id));
	}
	console.log(`Reset ${assets.length} asset(s) accumulated state`);

	// Sanity: surface any JEs still tagged sourceType='asset_depreciation_run'
	// that we may have missed (their source_id would now point at a deleted
	// run row).
	const lingering = await db
		.select({ id: journalEntries.id })
		.from(journalEntries)
		.where(
			and(
				eq(journalEntries.organizationId, orgId),
				eq(journalEntries.sourceType, 'asset_depreciation_run'),
				isNotNull(journalEntries.id),
			),
		);
	console.log(`JEs sourced from asset_depreciation_run still in DB (incl. reversers): ${lingering.length}`);
	process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
