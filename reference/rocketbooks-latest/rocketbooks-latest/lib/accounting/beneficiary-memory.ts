import 'server-only';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	transactions,
	journalEntryLines,
	chartOfAccounts,
	trustBeneficiaries,
} from '@/db/schema/schema';
import { qualifiesAsOf } from '@/lib/accounting/trust-reroute';

const PER_BENEFICIARY_DETAIL_TYPES = [
	'trust_food_minors_incapacitated',
	'trust_clothing_minors_incapacitated',
	'trust_distributions_to_beneficiaries',
	'trust_medical_wellness',
] as const;
const FOOD_OR_CLOTHING_DETAIL_TYPES = new Set<string>([
	'trust_food_minors_incapacitated',
	'trust_clothing_minors_incapacitated',
]);

export interface BeneficiaryMemoryResult {
	beneficiaryId: string;
	matchCount: number;
	mostRecent: string | null;
}

/**
 * Per-org "this merchant on this account got tagged to this beneficiary
 * last time" lookup. Mirrors lookupVendorMemory's match rule
 * (contactId OR description), but additionally filters to lines that
 * actually hit the given category account AND had a beneficiary tag.
 *
 * Returns the most-frequent past beneficiary; ties break on
 * most-recent. Returns null when there's no prior tagged history for
 * this merchant+account pair.
 *
 * Caller is responsible for confirming the category itself is a
 * per-beneficiary account (815/820/310/635) — this fn doesn't gate on
 * detail_type because callers usually already know.
 */
export async function lookupBeneficiaryMemory(args: {
	organizationId: string;
	categoryAccountId: string;
	contactId?: string | null;
	description?: string | null;
	type?: string | null;
}): Promise<BeneficiaryMemoryResult | null> {
	const description = (args.description ?? '').trim();
	const contactId = args.contactId ?? null;
	if (!description && !contactId) return null;

	const matchByDesc = description
		? sql`(${transactions.bankDescription} = ${description} OR ${transactions.description} = ${description})`
		: null;
	const matchByContact = contactId ? eq(transactions.contactId, contactId) : null;
	const merchantMatch =
		matchByDesc && matchByContact
			? sql`(${matchByContact} OR ${matchByDesc})`
			: matchByContact ?? matchByDesc;
	if (!merchantMatch) return null;

	const conditions = [
		eq(transactions.organizationId, args.organizationId),
		isNotNull(transactions.journalEntryId),
		// Same gate as category memory: only user-confirmed (or
		// high-confidence-AI) rows feed memory. Otherwise an auto-tag
		// applied via memory would reinforce itself indefinitely.
		eq(transactions.reviewed, true),
		eq(journalEntryLines.accountId, args.categoryAccountId),
		isNotNull(journalEntryLines.beneficiaryId),
		merchantMatch,
	];
	if (args.type) conditions.push(eq(transactions.type, args.type));

	// Walk through the txn's JE → its lines → group the category-line's
	// beneficiary_id. We join JE lines on accountId so we only pick up
	// the category-side line (the only line that carries a beneficiary
	// tag per auto-post.ts).
	const rows = await db
		.select({
			beneficiaryId: journalEntryLines.beneficiaryId,
			n: sql<number>`COUNT(*)::int`.as('n'),
			mostRecent: sql<string>`MAX(${transactions.date})`.as('most_recent'),
		})
		.from(transactions)
		.innerJoin(
			journalEntryLines,
			eq(journalEntryLines.journalEntryId, transactions.journalEntryId),
		)
		.where(and(...conditions))
		.groupBy(journalEntryLines.beneficiaryId)
		.orderBy(desc(sql`COUNT(*)`), desc(sql`MAX(${transactions.date})`));

	const top = rows[0];
	if (!top?.beneficiaryId) return null;
	return {
		beneficiaryId: top.beneficiaryId,
		matchCount: top.n,
		mostRecent: top.mostRecent,
	};
}

/**
 * Same as lookupBeneficiaryMemory, but also confirms the suggested
 * beneficiary still QUALIFIES (under 21 OR incapacitated as of asOfDate)
 * when the category is a food/clothing account (815/820). For 310/635
 * the qualification gate doesn't apply, so the raw memory result passes
 * through.
 *
 * Use this from auto-tag paths where we'd otherwise silently apply a
 * stale tag that the rules engine would then BLOCK on. Returns null
 * when the historical pick is no longer valid — let the caller fall
 * through to "leave it untagged and surface a finding."
 */
export async function lookupBeneficiaryMemoryWithQualifyingCheck(args: {
	organizationId: string;
	categoryAccountId: string;
	categoryDetailType: string | null;
	asOfDate: string;
	contactId?: string | null;
	description?: string | null;
	type?: string | null;
}): Promise<BeneficiaryMemoryResult | null> {
	const memory = await lookupBeneficiaryMemory(args);
	if (!memory) return null;
	const requiresQualifying =
		!!args.categoryDetailType && FOOD_OR_CLOTHING_DETAIL_TYPES.has(args.categoryDetailType);
	if (!requiresQualifying) return memory;

	const [bene] = await db
		.select({
			dateOfBirth: trustBeneficiaries.dateOfBirth,
			incapacitatedSince: trustBeneficiaries.incapacitatedSince,
			notIncapacitatedSince: trustBeneficiaries.notIncapacitatedSince,
		})
		.from(trustBeneficiaries)
		.where(
			and(
				eq(trustBeneficiaries.id, memory.beneficiaryId),
				eq(trustBeneficiaries.organizationId, args.organizationId),
			),
		)
		.limit(1);
	if (!bene) return null;
	// Point-in-time check using the effective-date columns so a beneficiary
	// whose recovery date is AFTER the asOfDate still passes.
	if (!qualifiesAsOf(bene, args.asOfDate)) return null;
	return memory;
}

/**
 * Resolve a chart-of-accounts.detail_type for a given account id (org-
 * scoped) so callers can decide whether the qualifying-check version of
 * the lookup applies. Returns null if account isn't in the org.
 */
export async function getAccountDetailType(args: {
	organizationId: string;
	accountId: string;
}): Promise<string | null> {
	const [row] = await db
		.select({ detailType: chartOfAccounts.detailType })
		.from(chartOfAccounts)
		.where(
			and(
				eq(chartOfAccounts.id, args.accountId),
				eq(chartOfAccounts.organizationId, args.organizationId),
			),
		)
		.limit(1);
	return row?.detailType ?? null;
}

/**
 * Returns true iff the given detail_type slug is one of the per-
 * beneficiary trust accounts. Exposed so callers can decide whether
 * to bother with the memory lookup at all.
 */
export function isPerBeneficiaryDetailType(detailType: string | null | undefined): boolean {
	return !!detailType && (PER_BENEFICIARY_DETAIL_TYPES as readonly string[]).includes(detailType);
}
