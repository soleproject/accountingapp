'use server';

import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { contacts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import {
	addContactTypeTag,
	VENDOR_TYPE_TAG_CHARITY_501C3,
} from '@/lib/accounting/vendor-classification';

export interface CreateOrTagCharityContactResult {
	ok: boolean;
	contactId?: string;
	error?: string;
}

/**
 * Inline "+ Add new charity" flow from the Pick-Charity dropdown.
 *
 * Idempotent on contact name within the org:
 *   - existing active contact with the same name → stamp 'charity_501c3'
 *     typeTag (no-op if already stamped), return its id
 *   - no match → insert a fresh active contact with the typeTag, return
 *     the new id
 *
 * Name match is case-insensitive on a trimmed comparison. The hidden
 * unique constraint UNIQUE(org, is_active, contact_name) lives in the
 * DB but isn't case-insensitive — if the user types a name that differs
 * only by case from an existing contact, the case-insensitive lookup
 * catches it and we re-use the existing row rather than failing on the
 * constraint.
 */
export async function createOrTagCharityContact(args: {
	name: string;
}): Promise<CreateOrTagCharityContactResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const name = (args.name ?? '').trim();
	if (!name) return { ok: false, error: 'Charity name is required' };
	if (name.length > 200) return { ok: false, error: 'Charity name too long (max 200)' };

	const [existing] = await db
		.select({ id: contacts.id })
		.from(contacts)
		.where(
			and(
				eq(contacts.organizationId, orgId),
				eq(contacts.isActive, true),
				sql`lower(${contacts.contactName}) = lower(${name})`,
			),
		)
		.limit(1);

	if (existing) {
		await addContactTypeTag({
			organizationId: orgId,
			contactId: existing.id,
			tag: VENDOR_TYPE_TAG_CHARITY_501C3,
		});
		revalidatePath('/trust-review');
		revalidatePath('/contacts');
		return { ok: true, contactId: existing.id };
	}

	const contactId = randomUUID();
	try {
		await db.insert(contacts).values({
			id: contactId,
			organizationId: orgId,
			contactName: name,
			typeTags: [VENDOR_TYPE_TAG_CHARITY_501C3],
			isActive: true,
		});
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : 'Failed to create charity contact',
		};
	}

	revalidatePath('/trust-review');
	revalidatePath('/contacts');
	return { ok: true, contactId };
}
