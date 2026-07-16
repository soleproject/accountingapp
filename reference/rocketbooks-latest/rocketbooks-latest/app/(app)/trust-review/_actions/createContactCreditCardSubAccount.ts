'use server';

import { randomUUID } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { chartOfAccounts, contacts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';

export interface CreateContactCreditCardSubAccountResult {
	ok: boolean;
	accountId?: string;
	error?: string;
}

/**
 * Create a per-card sub-account under the canonical 215 Credit Cards
 * Payable parent. Used by the "+" icon next to "Credit Card" in the
 * Not-a-Loan menu — clicking that icon for, e.g., Capital One with the
 * user-supplied last-4 "1234" produces:
 *
 *   215.{seq}  Capital One CC ...1234
 *
 * with parent_account_id pointing at 215. Last-4 is optional; if blank,
 * the name omits the suffix ("Capital One CC"). If 215 itself doesn't
 * exist yet, the action creates it inline before inserting the sub.
 *
 * Sub-account number is the next sequential under the parent (1-indexed)
 * so naming stays predictable even when the user creates multiple cards
 * for the same vendor.
 *
 * When 215 doesn't exist yet, the action creates it inline with the same
 * defaults (gaap=current_liability, detail_type=credit_card, normal=credit)
 * before inserting the sub-account, so the user never needs a separate
 * "create parent first" step.
 */
export async function createContactCreditCardSubAccount(args: {
	contactId: string;
	last4?: string | null;
}): Promise<CreateContactCreditCardSubAccountResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	// Last-4 validation: digits only, exactly 4. Reject other shapes with a
	// clear message so the UI can re-prompt rather than silently dropping.
	const last4 = (args.last4 ?? '').trim();
	if (last4 && !/^\d{4}$/.test(last4)) {
		return { ok: false, error: 'Last 4 must be exactly 4 digits (or left blank)' };
	}

	// Resolve / create the 215 parent. detail_type='credit_card' +
	// parent_account_id IS NULL singles out the parent vs. its children.
	let parentId: string;
	const [existingParent] = await db
		.select({ id: chartOfAccounts.id })
		.from(chartOfAccounts)
		.where(
			and(
				eq(chartOfAccounts.organizationId, orgId),
				eq(chartOfAccounts.detailType, 'credit_card'),
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
				accountNumber: '215',
				accountName: 'Credit Cards Payable',
				gaapType: 'current_liability',
				accountType: 'credit_card',
				detailType: 'credit_card',
				normalBalance: 'credit',
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
				error: err instanceof Error ? err.message : 'Failed to create 215 parent',
			};
		}
	}

	// Pull contact name for the sub-account label.
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

	// Next sequence under this parent.
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

	const accountNumber = `215.${seq}`;
	const accountName = last4
		? `${contact.contactName} CC …${last4}`
		: `${contact.contactName} CC`;

	const accountId = randomUUID();
	try {
		await db.insert(chartOfAccounts).values({
			id: accountId,
			organizationId: orgId,
			parentAccountId: parentId,
			accountNumber,
			accountName,
			gaapType: 'current_liability',
			accountType: 'credit_card',
			detailType: 'credit_card',
			normalBalance: 'credit',
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
