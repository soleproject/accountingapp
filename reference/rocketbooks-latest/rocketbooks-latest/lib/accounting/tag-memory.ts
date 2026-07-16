import 'server-only';
import { and, desc, eq, isNotNull, ne, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	journalEntryLineTags,
	journalEntryLines,
	transactions,
} from '@/db/schema/schema';
import { AUTO_TAG_DIMENSIONS, type SystemTagEntityType } from '@/lib/tags/dimensions';

/**
 * "Have we tagged a transaction like this before?" lookup. Walks past
 * reviewed transactions matching the same (vendor, category account)
 * and groups their tags by dimension. Returns one suggestion per
 * dimension — the best historical entity for that (vendor, account,
 * amount) triple.
 *
 * Amount disambiguates within a dimension: two rentals financed by
 * the same bank both posting to 250 Notes Payable would otherwise
 * collide. With amount, $2,140 → 123 Main St and $3,890 → 456 Oak Ave
 * cleanly separate.
 *
 * Match modes (per dimension):
 *   - exact      : amount within $0.01 of a historical match
 *   - tolerance  : within `tolerancePct` (default 5%) of historical
 *
 * Source of truth is the polymorphic journal_entry_line_tags table.
 * No separate memory table → reversing a tag retracts it from memory
 * automatically; the reviewed=true gate prevents auto-tag self-
 * reinforcement.
 */
export interface TagMemoryHit {
	entityType: SystemTagEntityType;
	entityId: string;
	matchType: 'exact' | 'tolerance';
	matchedAmount: number;
	matchCount: number;
	mostRecent: string;
}

const DEFAULT_TOLERANCE_PCT = 0.05;
const EXACT_EPSILON = 0.01;

export async function lookupTagMemory(args: {
	organizationId: string;
	categoryAccountId: string;
	amount: number;
	contactId?: string | null;
	description?: string | null;
	/** Exclude this txn id from the lookup so a fresh post doesn't
	 *  memorize itself. */
	excludeTransactionId?: string | null;
	tolerancePct?: number;
}): Promise<TagMemoryHit[]> {
	const description = (args.description ?? '').trim();
	const contactId = args.contactId ?? null;
	if (!description && !contactId) return [];
	if (!Number.isFinite(args.amount) || args.amount <= 0) return [];

	const tolerancePct = args.tolerancePct ?? DEFAULT_TOLERANCE_PCT;
	const amount = Math.abs(args.amount);

	const matchByDesc = description
		? sql`(${transactions.bankDescription} = ${description} OR ${transactions.description} = ${description})`
		: null;
	const matchByContact = contactId ? eq(transactions.contactId, contactId) : null;
	const merchantMatch =
		matchByDesc && matchByContact
			? or(matchByContact, matchByDesc)
			: matchByContact ?? matchByDesc;
	if (!merchantMatch) return [];

	const dimTypes = AUTO_TAG_DIMENSIONS.map((d) => d.entityType);
	if (dimTypes.length === 0) return [];

	const conditions = [
		eq(transactions.organizationId, args.organizationId),
		isNotNull(transactions.journalEntryId),
		eq(transactions.reviewed, true),
		eq(journalEntryLines.accountId, args.categoryAccountId),
		merchantMatch,
		sql`${journalEntryLineTags.entityType} IN (${sql.join(
			dimTypes.map((t) => sql`${t}`),
			sql`, `,
		)})`,
	];
	if (args.excludeTransactionId) {
		conditions.push(ne(transactions.id, args.excludeTransactionId));
	}

	// Per (entity_type, entity_id) row: max txn amount, count, most
	// recent date. We then bucket by entity_type and pick the best per
	// dimension (closest amount → most recent → highest count).
	const rows = await db
		.select({
			entityType: journalEntryLineTags.entityType,
			entityId: journalEntryLineTags.entityId,
			amount: sql<string>`MAX(ABS(${transactions.amount}))`.as('amt'),
			n: sql<number>`COUNT(*)::int`.as('n'),
			mostRecent: sql<string>`MAX(${transactions.date})`.as('most_recent'),
		})
		.from(transactions)
		.innerJoin(
			journalEntryLines,
			eq(journalEntryLines.journalEntryId, transactions.journalEntryId),
		)
		.innerJoin(
			journalEntryLineTags,
			eq(journalEntryLineTags.journalEntryLineId, journalEntryLines.id),
		)
		.where(and(...conditions))
		.groupBy(
			journalEntryLineTags.entityType,
			journalEntryLineTags.entityId,
			sql`ABS(${transactions.amount})`,
		)
		.orderBy(
			sql`ABS(ABS(${transactions.amount}) - ${amount})`,
			desc(sql`MAX(${transactions.date})`),
			desc(sql`COUNT(*)`),
		);

	const byDim = new Map<SystemTagEntityType, TagMemoryHit>();
	for (const r of rows) {
		const et = r.entityType as SystemTagEntityType;
		if (byDim.has(et)) continue; // already kept the best for this dim
		const matchedAmount = Number(r.amount ?? 0);
		const delta = Math.abs(matchedAmount - amount);
		let matchType: 'exact' | 'tolerance';
		if (delta <= EXACT_EPSILON) {
			matchType = 'exact';
		} else if (delta / Math.max(amount, matchedAmount) <= tolerancePct) {
			matchType = 'tolerance';
		} else {
			continue; // outside tolerance — skip
		}
		byDim.set(et, {
			entityType: et,
			entityId: r.entityId,
			matchType,
			matchedAmount,
			matchCount: r.n,
			mostRecent: r.mostRecent,
		});
	}

	return Array.from(byDim.values());
}

/**
 * Property-relevant detail types — used by the
 * TRUST_PROPERTY_EXPENSE_UNTAGGED finding gate. An untagged expense
 * on one of these accounts fires the finding when the org has any
 * active rental property OR fixed asset.
 *
 * Conservative list: accounts almost always property-attributable in
 * a beneficial-trust context. R&M and Utilities are included because
 * in the beneficial-trust CoA they're virtually always tied to
 * property; orgs without properties never see the finding because
 * the property-list check gates it.
 */
export const PROPERTY_RELEVANT_DETAIL_TYPES = new Set<string>([
	'trust_property_taxes', // 505
	'insurance', // 650 (Property Insurance)
	'rent_or_lease_buildings', // 680
	'repair_maintenance', // 685
	'utilities', // 725
]);
