import { eq, count } from 'drizzle-orm';
import { db } from '@/db/client';
import { journalEntryLines } from '@/db/schema/schema';
import type { TrustLineContext } from './context';
import type { TrustFinding } from './types';

const ASSET_DETAIL_TYPES = new Set<string>([
	'land',
	'buildings',
	'furniture_fixtures',
	'machinery_equipment',
	'vehicles',
	'intangible_assets',
	'investments_other',
]);

/**
 * Asset capitalization warnings. Per spec: post the ORIGINAL purchase
 * price (cost basis) to the asset account once; all future maintenance,
 * insurance, repairs, etc. must route to expense accounts — NOT back to
 * the asset account.
 *
 * v1: when posting to an asset account that already has prior journal
 * entry lines, warn that this is likely not a first purchase. (Hard
 * enforcement would need a UI signal "this is a new purchase".)
 *
 * Asset-sale gain/loss auto-split (proceeds → 420/425 + basis removal)
 * is deferred — needs an explicit "this is a sale" signal from the UI
 * or AI categorizer.
 */
export async function evaluateLineAssetRules(ctx: TrustLineContext): Promise<TrustFinding[]> {
	if (ctx.account.gaapType !== 'asset') return [];
	if (!ctx.account.detailType || !ASSET_DETAIL_TYPES.has(ctx.account.detailType)) return [];

	const [row] = await db
		.select({ n: count() })
		.from(journalEntryLines)
		.where(eq(journalEntryLines.accountId, ctx.account.id));
	const priorPosts = row?.n ?? 0;

	if (priorPosts > 0) {
		return [
			{
				code: 'TRUST_ASSET_REPOST_REVIEW',
				severity: 'warn',
				message: `Asset account ${ctx.account.accountNumber} ${ctx.account.accountName} already has ${priorPosts} prior journal-entry line${priorPosts === 1 ? '' : 's'}. Asset accounts should only record the ORIGINAL purchase price (cost basis). Maintenance, repairs, and insurance must route to expense accounts. If this is a genuine additional purchase or a capital improvement, this warning can be ignored.`,
				metadata: {
					accountNumber: ctx.account.accountNumber,
					accountId: ctx.account.id,
					priorPosts,
				},
			},
		];
	}

	return [];
}
