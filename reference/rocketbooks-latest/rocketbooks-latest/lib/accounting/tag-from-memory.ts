import 'server-only';
import { randomUUID } from 'crypto';
import { and, count, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	fixedAssets,
	rentalProperties,
	trustReviewFindings,
} from '@/db/schema/schema';
import { logger } from '@/lib/logger';
import { getSystemTagDimension, type SystemTagEntityType } from '@/lib/tags/dimensions';
import { setJournalEntryTags } from '@/lib/tags/store';
import { PROPERTY_RELEVANT_DETAIL_TYPES, lookupTagMemory, type TagMemoryHit } from './tag-memory';

export interface MaybeAutoTagResult {
	outcome: 'auto_applied' | 'suggested' | 'untagged_finding' | 'noop';
	appliedTags?: Array<{ entityType: SystemTagEntityType; entityId: string; matchedAmount: number }>;
	suggestedTags?: Array<{ entityType: SystemTagEntityType; entityId: string; matchedAmount: number }>;
}

/**
 * Post-categorize hook. Walks tag memory for the JE's category line
 * and, for each dimension that returned a hit:
 *
 *   exact         → apply the tag now + drop TRUST_TAG_AUTO_APPLIED
 *                   (Decisioned audit)
 *   tolerance     → drop TRUST_TAG_SUGGESTED (Open) with picker
 *                   prefilled in metadata. (Phase B will gate this
 *                   through an LLM before promoting to applied.)
 *
 * Plus: if NO dimension auto-applied AND the category is a
 * property-relevant account on an org with active properties or
 * assets, drop TRUST_PROPERTY_EXPENSE_UNTAGGED (Open).
 *
 * Findings are idempotent (per JE+code dedupe). All work is
 * best-effort — failures log + swallow so JE post never breaks.
 */
export async function maybeAutoTagFromMemory(args: {
	organizationId: string;
	transactionId: string;
	journalEntryId: string;
	bankAccountId: string;
	categoryAccountId: string;
	contactId: string | null;
	amount: number;
	description: string | null;
}): Promise<MaybeAutoTagResult> {
	try {
		const [acct] = await db
			.select({
				detailType: chartOfAccounts.detailType,
				accountName: chartOfAccounts.accountName,
				accountNumber: chartOfAccounts.accountNumber,
			})
			.from(chartOfAccounts)
			.where(
				and(
					eq(chartOfAccounts.id, args.categoryAccountId),
					eq(chartOfAccounts.organizationId, args.organizationId),
				),
			)
			.limit(1);
		if (!acct) return { outcome: 'noop' };

		const hits = await lookupTagMemory({
			organizationId: args.organizationId,
			categoryAccountId: args.categoryAccountId,
			amount: args.amount,
			contactId: args.contactId,
			description: args.description,
			excludeTransactionId: args.transactionId,
		});

		const exactHits = hits.filter((h) => h.matchType === 'exact');
		const toleranceHits = hits.filter((h) => h.matchType === 'tolerance');

		if (exactHits.length > 0) {
			await setJournalEntryTags({
				organizationId: args.organizationId,
				journalEntryId: args.journalEntryId,
				bankAccountId: args.bankAccountId,
				tags: exactHits.map((h) => ({ entityType: h.entityType, entityId: h.entityId })),
			});

			await insertFindingIfMissing({
				organizationId: args.organizationId,
				journalEntryId: args.journalEntryId,
				code: 'TRUST_TAG_AUTO_APPLIED',
				message: await formatAutoAppliedMessage(args.organizationId, exactHits),
				metadata: {
					tags: exactHits.map((h) => ({
						entityType: h.entityType,
						entityId: h.entityId,
						matchedAmount: h.matchedAmount,
						matchCount: h.matchCount,
					})),
					categoryAccountId: args.categoryAccountId,
				},
			});
		}

		if (toleranceHits.length > 0) {
			await insertFindingIfMissing({
				organizationId: args.organizationId,
				journalEntryId: args.journalEntryId,
				code: 'TRUST_TAG_SUGGESTED',
				message: await formatSuggestedMessage(args.organizationId, toleranceHits, args.amount),
				metadata: {
					tags: toleranceHits.map((h) => ({
						entityType: h.entityType,
						entityId: h.entityId,
						matchedAmount: h.matchedAmount,
						matchCount: h.matchCount,
					})),
					txnAmount: args.amount,
					categoryAccountId: args.categoryAccountId,
				},
			});
		}

		// If at least one dimension auto-applied, the user already got the
		// signal — skip the "untagged" finding even if the account is
		// property-relevant. Only the no-hit case needs prompting.
		if (exactHits.length > 0) {
			return {
				outcome: 'auto_applied',
				appliedTags: exactHits.map((h) => ({
					entityType: h.entityType,
					entityId: h.entityId,
					matchedAmount: h.matchedAmount,
				})),
				suggestedTags: toleranceHits.map((h) => ({
					entityType: h.entityType,
					entityId: h.entityId,
					matchedAmount: h.matchedAmount,
				})),
			};
		}
		if (toleranceHits.length > 0) {
			return {
				outcome: 'suggested',
				suggestedTags: toleranceHits.map((h) => ({
					entityType: h.entityType,
					entityId: h.entityId,
					matchedAmount: h.matchedAmount,
				})),
			};
		}

		// No memory hit at all. Fire the untagged finding only if the
		// account is property-relevant AND the org has any taggable
		// dimension instance.
		const isPropertyRelevant =
			acct.detailType != null && PROPERTY_RELEVANT_DETAIL_TYPES.has(acct.detailType);
		if (!isPropertyRelevant) return { outcome: 'noop' };

		const [propCount] = await db
			.select({ n: count() })
			.from(rentalProperties)
			.where(
				and(
					eq(rentalProperties.organizationId, args.organizationId),
					eq(rentalProperties.status, 'active'),
				),
			);
		const [assetCountRow] = await db
			.select({ n: count() })
			.from(fixedAssets)
			.where(
				and(
					eq(fixedAssets.organizationId, args.organizationId),
					eq(fixedAssets.status, 'active'),
				),
			);
		const hasTaggableDim = (propCount?.n ?? 0) > 0 || (assetCountRow?.n ?? 0) > 0;
		if (!hasTaggableDim) return { outcome: 'noop' };

		await insertFindingIfMissing({
			organizationId: args.organizationId,
			journalEntryId: args.journalEntryId,
			code: 'TRUST_PROPERTY_EXPENSE_UNTAGGED',
			message: `${acct.accountNumber ?? ''} ${acct.accountName} expense isn't tagged to a property, asset, or loan. Tag it so the per-dimension sub-ledger rolls up correctly.`,
			metadata: {
				categoryAccountId: args.categoryAccountId,
				accountName: acct.accountName,
				accountNumber: acct.accountNumber,
			},
		});
		return { outcome: 'untagged_finding' };
	} catch (err) {
		logger.warn(
			{
				err: err instanceof Error ? err.message : err,
				txnId: args.transactionId,
				jeId: args.journalEntryId,
			},
			'maybeAutoTagFromMemory failed (non-fatal)',
		);
		return { outcome: 'noop' };
	}
}

async function insertFindingIfMissing(args: {
	organizationId: string;
	journalEntryId: string;
	code: string;
	message: string;
	metadata: Record<string, unknown>;
}): Promise<void> {
	const existing = await db
		.select({ id: trustReviewFindings.id })
		.from(trustReviewFindings)
		.where(
			and(
				eq(trustReviewFindings.journalEntryId, args.journalEntryId),
				eq(trustReviewFindings.code, args.code),
			),
		)
		.limit(1);
	if (existing.length > 0) return;
	await db.insert(trustReviewFindings).values({
		id: randomUUID(),
		organizationId: args.organizationId,
		journalEntryId: args.journalEntryId,
		code: args.code,
		severity: 'warn',
		message: args.message,
		metadata: args.metadata,
	});
}

async function describeTag(
	orgId: string,
	hit: TagMemoryHit,
): Promise<string | null> {
	const dim = getSystemTagDimension(hit.entityType);
	if (!dim) return null;
	// Use the dimension loader to find a label — overshoots (loads all
	// options), but keeps the formatting in one place per dimension.
	const opts = await dim.loadOptions(orgId);
	const opt = opts.find((o) => o.id === hit.entityId);
	if (!opt) return `${dim.label} ${hit.entityId.slice(0, 8)}`;
	return `${dim.label.toLowerCase()} "${opt.label}"`;
}

async function formatAutoAppliedMessage(orgId: string, hits: TagMemoryHit[]): Promise<string> {
	const parts = (await Promise.all(hits.map((h) => describeTag(orgId, h)))).filter((s): s is string => !!s);
	const tag = parts.length > 0 ? parts.join(' + ') : 'a prior tag';
	return `Auto-tagged to ${tag} based on a prior tag with the same vendor, account, and amount. Reverse on the transaction's Tags panel if wrong.`;
}

async function formatSuggestedMessage(
	orgId: string,
	hits: TagMemoryHit[],
	currentAmount: number,
): Promise<string> {
	const parts = (await Promise.all(hits.map((h) => describeTag(orgId, h)))).filter((s): s is string => !!s);
	const tag = parts.length > 0 ? parts.join(' + ') : 'a prior tag';
	const sample = hits[0];
	const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
	return `Suggested tag: ${tag}. Prior tag was for ${fmt(sample.matchedAmount)}; this transaction is ${fmt(currentAmount)} (within tolerance). Confirm on the transaction's Tags panel.`;
}
