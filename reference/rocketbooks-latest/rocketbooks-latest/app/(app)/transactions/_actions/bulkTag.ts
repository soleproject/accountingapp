'use server';

import { and, eq, inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { transactions } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { assertNotDemo } from '@/lib/auth/demo';
import { requireSession } from '@/lib/auth/session';
import { loadDimensionsForOrg, type TagEntityType } from '@/lib/tags/dimensions';
import { setJournalEntryTags, validateTagsForOrg } from '@/lib/tags/store';

export interface BulkTagState {
	ok?: boolean;
	error?: string;
	tagged?: number;
	skipped?: number;
}

const KEEP_SENTINEL = '__keep__';

/**
 * Bulk-tag many transactions from the /transactions list. For each
 * selected transaction whose JE is posted, apply the requested tag
 * dimensions to every non-bank line. Transactions without a posted
 * JE are skipped.
 *
 * Form encoding: one field per dimension (named by entity_type), with
 * three possible values:
 *   __keep__          — leave the dimension untouched
 *   "" (empty string) — clear the dimension
 *   {entity_id}       — set to this entity
 *
 * Generic — supports every dimension in TAG_DIMENSIONS without code
 * change here.
 */
export async function bulkTag(
	_prev: BulkTagState | undefined,
	formData: FormData,
): Promise<BulkTagState | undefined> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	assertNotDemo(orgId, 'tag transactions');

	const ids = formData.getAll('ids').map(String).filter(Boolean);
	if (ids.length === 0) return { error: 'No transactions selected' };

	const dims = await loadDimensionsForOrg(orgId);
	const patch: Array<{ entityType: TagEntityType; entityId: string | null }> = [];
	for (const dim of dims) {
		const raw = formData.get(dim.entityType);
		if (raw == null) continue;
		const v = String(raw);
		if (v === KEEP_SENTINEL) continue;
		patch.push({ entityType: dim.entityType, entityId: v || null });
	}
	if (patch.length === 0) return { error: 'Pick at least one tag dimension to set' };

	const settingTags = patch.filter((t): t is { entityType: TagEntityType; entityId: string } => !!t.entityId);
	const v = await validateTagsForOrg({ organizationId: orgId, tags: settingTags });
	if (v.invalid) return { error: v.invalid.reason };

	const txns = await db
		.select({
			id: transactions.id,
			journalEntryId: transactions.journalEntryId,
			accountId: transactions.accountId,
		})
		.from(transactions)
		.where(and(eq(transactions.organizationId, orgId), inArray(transactions.id, ids)));

	let tagged = 0;
	let skipped = 0;
	for (const t of txns) {
		if (!t.journalEntryId || !t.accountId) {
			skipped++;
			continue;
		}
		const r = await setJournalEntryTags({
			organizationId: orgId,
			journalEntryId: t.journalEntryId,
			bankAccountId: t.accountId,
			tags: patch,
		});
		if (r.updatedLines > 0) tagged++;
		else skipped++;
	}

	revalidatePath('/transactions');
	revalidatePath('/rental-properties');
	revalidatePath('/assets');
	revalidatePath('/loans');
	return { ok: true, tagged, skipped };
}
