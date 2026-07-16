'use server';

import { randomUUID } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { chartOfAccounts, contacts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';

export interface CreateContactLeaseSubAccountResult {
	ok: boolean;
	accountId?: string;
	error?: string;
}

/**
 * Create a per-lease sub-account under the canonical 680 Rents & Leases
 * parent. Mirror of createContactCreditCardSubAccount for the lease side:
 *
 *   680.{seq}  Mercedes-Benz Financial Services Lease 2024 GLE
 *
 * with parent_account_id pointing at 680. The lease name is optional but
 * recommended so multiple leases from the same vendor are distinguishable
 * (e.g. "GLE 2024" vs "X3 2023" for Mercedes-Benz). If 680 itself doesn't
 * exist yet, it's created on the fly with detail_type 'rent_or_lease_buildings'.
 */
export async function createContactLeaseSubAccount(args: {
	contactId: string;
	leaseName?: string | null;
}): Promise<CreateContactLeaseSubAccountResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const leaseName = (args.leaseName ?? '').trim();
	// Cap at a sane length to avoid pathological inputs. Account names are
	// varchar in PG; the schema doesn't enforce a hard limit, but a 120-
	// char ceiling keeps UI layout sane.
	if (leaseName.length > 120) {
		return { ok: false, error: 'Lease name too long (max 120 chars)' };
	}

	let parentId: string;
	const [existingParent] = await db
		.select({ id: chartOfAccounts.id })
		.from(chartOfAccounts)
		.where(
			and(
				eq(chartOfAccounts.organizationId, orgId),
				eq(chartOfAccounts.detailType, 'rent_or_lease_buildings'),
				isNull(chartOfAccounts.parentAccountId),
			),
		)
		.limit(1);
	if (existingParent) {
		parentId = existingParent.id;
	} else {
		parentId = randomUUID();
		try {
			await db.insert(chartOfAccounts).values({
				id: parentId,
				organizationId: orgId,
				accountNumber: '680',
				accountName: 'Rents & Leases',
				gaapType: 'expense',
				accountType: 'expenses',
				detailType: 'rent_or_lease_buildings',
				normalBalance: 'debit',
				isActive: true,
				isTemporary: false,
				createdByAi: false,
				systemGenerated: false,
				needsReview: false,
				passedNameContactCheck: true,
			});
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : 'Failed to create 680 parent',
			};
		}
	}

	const [contact] = await db
		.select({
			id: contacts.id,
			contactName: contacts.contactName,
		})
		.from(contacts)
		.where(
			and(eq(contacts.id, args.contactId), eq(contacts.organizationId, orgId)),
		)
		.limit(1);
	if (!contact) return { ok: false, error: 'Contact not in this organization' };

	const siblings = await db
		.select({ accountNumber: chartOfAccounts.accountNumber })
		.from(chartOfAccounts)
		.where(
			and(
				eq(chartOfAccounts.organizationId, orgId),
				eq(chartOfAccounts.parentAccountId, parentId),
			),
		);
	const seq = siblings.length + 1;

	const accountNumber = `680.${seq}`;
	const accountName = leaseName
		? `${contact.contactName} Lease — ${leaseName}`
		: `${contact.contactName} Lease`;

	const accountId = randomUUID();
	try {
		await db.insert(chartOfAccounts).values({
			id: accountId,
			organizationId: orgId,
			parentAccountId: parentId,
			accountNumber,
			accountName,
			gaapType: 'expense',
			accountType: 'expenses',
			detailType: 'rent_or_lease_buildings',
			normalBalance: 'debit',
			isActive: true,
			isTemporary: false,
			createdByAi: false,
			systemGenerated: false,
			needsReview: false,
			passedNameContactCheck: true,
		});
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : 'Failed to create sub-account',
		};
	}

	revalidatePath('/trust-review');
	revalidatePath('/chart-of-accounts');
	return { ok: true, accountId };
}
