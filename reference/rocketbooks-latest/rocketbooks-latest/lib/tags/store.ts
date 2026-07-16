import 'server-only';
import { randomUUID } from 'crypto';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	journalEntries,
	journalEntryLineTags,
	journalEntryLines,
} from '@/db/schema/schema';
import {
	type TagEntityType,
	loadDimensionMeta,
} from './dimensions';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface LineTag {
	entityType: TagEntityType;
	entityId: string;
}

/** "What is currently set on this JE?" — one row per dimension that
 *  has a tag on at least one category line. Returns a flat shape
 *  rather than per-line because the panel currently applies one tag
 *  per dimension to all category lines of a JE; mixed states only
 *  happen when the DB was manually edited. */
export interface JournalEntryTagSnapshot {
	tags: LineTag[];
}

/**
 * Read the currently-set tags on a JE's category lines. The bank-side
 * line is excluded (identified by bankAccountId — same convention as
 * the writers below). Returns at most one row per (entityType) — the
 * first non-bank line's tag wins for that dimension.
 */
export async function readJournalEntryTags(args: {
	journalEntryId: string;
	bankAccountId: string;
}): Promise<JournalEntryTagSnapshot> {
	const rows = await db
		.select({
			lineId: journalEntryLines.id,
			accountId: journalEntryLines.accountId,
			entityType: journalEntryLineTags.entityType,
			entityId: journalEntryLineTags.entityId,
		})
		.from(journalEntryLines)
		.leftJoin(
			journalEntryLineTags,
			eq(journalEntryLineTags.journalEntryLineId, journalEntryLines.id),
		)
		.where(eq(journalEntryLines.journalEntryId, args.journalEntryId));

	const byDim = new Map<TagEntityType, LineTag>();
	for (const r of rows) {
		if (r.accountId === args.bankAccountId) continue;
		if (!r.entityType || !r.entityId) continue;
		if (!byDim.has(r.entityType)) {
			byDim.set(r.entityType, { entityType: r.entityType, entityId: r.entityId });
		}
	}
	return { tags: Array.from(byDim.values()) };
}

/**
 * Set or clear a single dimension across all category (non-bank) lines
 * of a JE. Passing entityId=null clears it; otherwise upserts.
 *
 * Composable into a larger transaction via the `tx` arg.
 */
export async function setJournalEntryTag(args: {
	organizationId: string;
	journalEntryId: string;
	bankAccountId: string;
	entityType: TagEntityType;
	entityId: string | null;
	tx?: Tx;
}): Promise<{ updatedLines: number }> {
	const run = async (innerTx: Tx) => {
		const categoryLineIds = await innerTx
			.select({ id: journalEntryLines.id })
			.from(journalEntryLines)
			.where(
				and(
					eq(journalEntryLines.journalEntryId, args.journalEntryId),
					ne(journalEntryLines.accountId, args.bankAccountId),
				),
			);
		if (categoryLineIds.length === 0) return { updatedLines: 0 };
		const ids = categoryLineIds.map((r) => r.id);

		// Clear existing tags of this dimension on these lines first —
		// upsert semantics. (UNIQUE (line_id, entity_type) makes a true
		// upsert with ON CONFLICT possible, but the clearing path is
		// needed for the entityId=null case anyway.)
		await innerTx
			.delete(journalEntryLineTags)
			.where(
				and(
					inArray(journalEntryLineTags.journalEntryLineId, ids),
					eq(journalEntryLineTags.entityType, args.entityType),
				),
			);

		if (args.entityId) {
			await innerTx.insert(journalEntryLineTags).values(
				ids.map((lineId) => ({
					id: randomUUID(),
					organizationId: args.organizationId,
					journalEntryLineId: lineId,
					entityType: args.entityType,
					entityId: args.entityId!,
				})),
			);
		}

		return { updatedLines: ids.length };
	};

	return args.tx ? run(args.tx) : db.transaction(run);
}

/**
 * Multi-dimension setter. Each entry in tags[] applies (or clears)
 * one dimension. All mutations run in a single transaction.
 */
export async function setJournalEntryTags(args: {
	organizationId: string;
	journalEntryId: string;
	bankAccountId: string;
	tags: Array<{ entityType: TagEntityType; entityId: string | null }>;
	tx?: Tx;
}): Promise<{ updatedLines: number }> {
	if (args.tags.length === 0) return { updatedLines: 0 };
	const run = async (innerTx: Tx) => {
		let updated = 0;
		for (const t of args.tags) {
			const r = await setJournalEntryTag({
				organizationId: args.organizationId,
				journalEntryId: args.journalEntryId,
				bankAccountId: args.bankAccountId,
				entityType: t.entityType,
				entityId: t.entityId,
				tx: innerTx,
			});
			updated = Math.max(updated, r.updatedLines);
		}
		return { updatedLines: updated };
	};
	return args.tx ? run(args.tx) : db.transaction(run);
}

/**
 * Validate every tag in `tags` belongs to the org. Returns the first
 * invalid one (or null if all pass) so callers can short-circuit with
 * a meaningful error.
 */
export async function validateTagsForOrg(args: {
	organizationId: string;
	tags: Array<{ entityType: TagEntityType; entityId: string }>;
}): Promise<{ invalid: { entityType: TagEntityType; entityId: string; reason: string } | null }> {
	for (const t of args.tags) {
		const dim = await loadDimensionMeta(args.organizationId, t.entityType);
		if (!dim) {
			return {
				invalid: {
					entityType: t.entityType,
					entityId: t.entityId,
					reason: `Unknown tag dimension: ${t.entityType}`,
				},
			};
		}
		const ok = await dim.validateEntity(args.organizationId, t.entityId);
		if (!ok) {
			return {
				invalid: {
					entityType: t.entityType,
					entityId: t.entityId,
					reason: `${dim.label} not in this organization`,
				},
			};
		}
	}
	return { invalid: null };
}

/** Verify that a JE belongs to the given org. Used by every public
 *  tagging action to gate cross-org tag attempts. */
export async function assertJournalEntryInOrg(args: {
	journalEntryId: string;
	organizationId: string;
}): Promise<boolean> {
	const [je] = await db
		.select({ id: journalEntries.id })
		.from(journalEntries)
		.where(
			and(
				eq(journalEntries.id, args.journalEntryId),
				eq(journalEntries.organizationId, args.organizationId),
			),
		)
		.limit(1);
	return !!je;
}

/** Return the set of category-line ids on a JE that currently carry
 *  ANY tag (used for rollups + queries that need to filter by tagged
 *  status). */
export async function getLineIdsWithTag(args: {
	organizationId: string;
	entityType: TagEntityType;
	entityId: string;
}): Promise<string[]> {
	const rows = await db
		.select({ lineId: journalEntryLineTags.journalEntryLineId })
		.from(journalEntryLineTags)
		.where(
			and(
				eq(journalEntryLineTags.organizationId, args.organizationId),
				eq(journalEntryLineTags.entityType, args.entityType),
				eq(journalEntryLineTags.entityId, args.entityId),
			),
		);
	return rows.map((r) => r.lineId);
}

/** Build a Drizzle EXISTS clause to filter journalEntryLines by tag.
 *  Use inside a .where(...). Returns sql for composition. */
export function existsTagClause(args: {
	entityType: TagEntityType;
	entityId: string;
}) {
	return sql`EXISTS (
		SELECT 1 FROM ${journalEntryLineTags} jelt
		WHERE jelt.journal_entry_line_id = ${journalEntryLines.id}
			AND jelt.entity_type = ${args.entityType}
			AND jelt.entity_id = ${args.entityId}
	)`;
}
