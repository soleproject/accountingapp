'use server';

import { revalidatePath } from 'next/cache';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { type TagEntityType } from '@/lib/tags/dimensions';
import {
	assertJournalEntryInOrg,
	setJournalEntryTags,
	validateTagsForOrg,
} from '@/lib/tags/store';

export interface TagJournalLinesResult {
	ok: boolean;
	error?: string;
	updated?: number;
}

export interface TagPatchEntry {
	entityType: TagEntityType;
	entityId: string | null;
}

/**
 * Unified tag setter for a JE's category (non-bank) lines. Each entry
 * in `tags` applies (or clears, when entityId is null) one dimension.
 *
 * Generic over dimensions — adding a new system dimension requires no
 * change here, just a new entry in lib/tags/dimensions.ts.
 */
export async function tagJournalLines(args: {
	journalEntryId: string;
	bankAccountId: string;
	tags: TagPatchEntry[];
}): Promise<TagJournalLinesResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	if (!args.journalEntryId) return { ok: false, error: 'Missing journalEntryId' };
	if (!args.bankAccountId) return { ok: false, error: 'Missing bankAccountId' };

	for (const t of args.tags) {
		if (!t.entityType || typeof t.entityType !== 'string') {
			return { ok: false, error: 'Missing or invalid entityType' };
		}
	}

	if (!(await assertJournalEntryInOrg({ journalEntryId: args.journalEntryId, organizationId: orgId }))) {
		return { ok: false, error: 'JE not found in this organization' };
	}

	const settingTags = args.tags.filter((t): t is { entityType: TagEntityType; entityId: string } => !!t.entityId);
	const v = await validateTagsForOrg({ organizationId: orgId, tags: settingTags });
	if (v.invalid) return { ok: false, error: v.invalid.reason };

	const r = await setJournalEntryTags({
		organizationId: orgId,
		journalEntryId: args.journalEntryId,
		bankAccountId: args.bankAccountId,
		tags: args.tags,
	});

	revalidatePath(`/transactions/${args.journalEntryId}`);
	revalidatePath('/rental-properties');
	revalidatePath('/assets');
	revalidatePath('/loans');
	return { ok: true, updated: r.updatedLines };
}
