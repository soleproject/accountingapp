import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, loans } from '@/db/schema/schema';

/**
 * Vendor classification for 250 Notes Payable findings. Drives the two-
 * level sub-grouping (Loans / Credit Cards / Leases / Unclassified) and
 * the per-contact action set on TRUST_DEFERRED_LOAN_SPLIT_NEEDED rows.
 *
 * Resolution priority (highest first):
 *   1. typeTags 'credit_card_issuer'  → credit_card
 *   2. typeTags 'lease_company'        → lease
 *   3. typeTags 'loan_vendor' OR contact has a row in `loans`  → loan
 *   4. otherwise                        → unclassified
 *
 * typeTags is a learn-on-click classification: per-contact actions stamp
 * the appropriate tag so future findings auto-bucket without re-asking.
 * The `loans` table is a backup signal so contacts that already have a
 * tracked loan don't need an explicit 'loan_vendor' tag.
 */
export type VendorType = 'loan' | 'credit_card' | 'lease' | 'unclassified';

export const VENDOR_TYPE_TAG_CREDIT_CARD = 'credit_card_issuer';
export const VENDOR_TYPE_TAG_LEASE = 'lease_company';
export const VENDOR_TYPE_TAG_LOAN = 'loan_vendor';
/** 501(c)(3) charity classification — drives the Pick-Charity dropdown
 *  on TRUST_515_VERIFY_501C3 and lets the rules engine short-circuit
 *  future 515 postings to the same vendor. */
export const VENDOR_TYPE_TAG_CHARITY_501C3 = 'charity_501c3';

export interface VendorClassification {
	vendorType: VendorType;
	contactId: string;
	contactName: string;
	/** Loans bound to this contact in the `loans` table, sorted by status.
	 *  Used by the per-contact picker to preselect when there's exactly
	 *  one + offer "create new" when there's zero. */
	loans: Array<{ id: string; displayName: string }>;
}

/**
 * Bulk resolver: given a set of contact ids, return their VendorType +
 * any bound loans. One query per backing table (no N+1).
 */
export async function resolveVendorClassifications(
	orgId: string,
	contactIds: string[],
): Promise<Map<string, VendorClassification>> {
	const result = new Map<string, VendorClassification>();
	if (contactIds.length === 0) return result;

	const contactRows = await db
		.select({
			id: contacts.id,
			contactName: contacts.contactName,
			typeTags: contacts.typeTags,
		})
		.from(contacts)
		.where(
			and(
				eq(contacts.organizationId, orgId),
				inArray(contacts.id, contactIds),
			),
		);

	// Build contact → loans map in a single query.
	const loanRows = await db
		.select({
			id: loans.id,
			displayName: loans.displayName,
			lenderContactId: loans.lenderContactId,
			status: loans.status,
		})
		.from(loans)
		.where(
			and(
				eq(loans.organizationId, orgId),
				inArray(loans.lenderContactId, contactIds),
			),
		);
	const loansByContact = new Map<string, Array<{ id: string; displayName: string }>>();
	for (const r of loanRows) {
		if (!r.lenderContactId) continue;
		const list = loansByContact.get(r.lenderContactId) ?? [];
		list.push({ id: r.id, displayName: r.displayName });
		loansByContact.set(r.lenderContactId, list);
	}

	for (const c of contactRows) {
		const tags = Array.isArray(c.typeTags)
			? (c.typeTags as unknown[]).filter((t): t is string => typeof t === 'string')
			: [];
		const tagSet = new Set(tags.map((t) => t.toLowerCase()));
		const contactLoans = loansByContact.get(c.id) ?? [];

		let vendorType: VendorType;
		if (tagSet.has(VENDOR_TYPE_TAG_CREDIT_CARD)) {
			vendorType = 'credit_card';
		} else if (tagSet.has(VENDOR_TYPE_TAG_LEASE)) {
			vendorType = 'lease';
		} else if (tagSet.has(VENDOR_TYPE_TAG_LOAN) || contactLoans.length > 0) {
			vendorType = 'loan';
		} else {
			vendorType = 'unclassified';
		}

		result.set(c.id, {
			vendorType,
			contactId: c.id,
			contactName: c.contactName,
			loans: contactLoans,
		});
	}

	return result;
}

/**
 * Add a typeTag to a contact's array in a single SQL round-trip. No-op
 * if the tag is already present. Returns true on write, false if the tag
 * was already set.
 */
export async function addContactTypeTag(args: {
	organizationId: string;
	contactId: string;
	tag: string;
}): Promise<boolean> {
	const [c] = await db
		.select({ typeTags: contacts.typeTags })
		.from(contacts)
		.where(
			and(
				eq(contacts.id, args.contactId),
				eq(contacts.organizationId, args.organizationId),
			),
		)
		.limit(1);
	if (!c) return false;
	const tags = Array.isArray(c.typeTags)
		? (c.typeTags as unknown[]).filter((t): t is string => typeof t === 'string')
		: [];
	if (tags.some((t) => t.toLowerCase() === args.tag.toLowerCase())) {
		return false;
	}
	await db
		.update(contacts)
		.set({ typeTags: [...tags, args.tag] })
		.where(
			and(
				eq(contacts.id, args.contactId),
				eq(contacts.organizationId, args.organizationId),
			),
		);
	return true;
}
