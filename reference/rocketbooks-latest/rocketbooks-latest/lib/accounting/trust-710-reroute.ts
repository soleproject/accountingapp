import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts, contacts, transactions, trustBeneficiaries } from '@/db/schema/schema';
import { qualifiesAsOf } from './trust-reroute';

/**
 * Codes whose findings drive the 710 per-row actions (Beneficiary +
 * Trustee, single + split). The open code is the original "needs
 * attribution" finding; the two decisioned codes are audit-trail records
 * of a prior reroute that the user may want to change.
 */
export const TRUST_710_ACTIONABLE_CODES = [
	'TRUST_710_ATTRIBUTION_REQUIRED',
	'TRUST_710_REROUTED_TO_FOOD',
	'TRUST_710_REROUTED_TO_DEMAND_NOTE',
	'TRUST_710_ATTRIBUTED_TO_TRUSTEE',
] as const;
export type Trust710ActionableCode = (typeof TRUST_710_ACTIONABLE_CODES)[number];

const TRUST_710_ACTIONABLE_SET: ReadonlySet<string> = new Set(TRUST_710_ACTIONABLE_CODES);

export function isTrust710ActionableCode(code: string): code is Trust710ActionableCode {
	return TRUST_710_ACTIONABLE_SET.has(code);
}

/**
 * Pull the two account ids the per-row 710 actions need out of a finding's
 * metadata, branching on whether the finding is the open
 * TRUST_710_ATTRIBUTION_REQUIRED or one of the decisioned reroute codes.
 *
 *   sourceAccountId   — where the JE line currently lives. For OPEN the
 *                       line is on the original 710 account; for
 *                       DECISIONED it has already been moved to the
 *                       rerouted destination (815 or a 26x demand note).
 *   originalAccountId — the original 710 account, used for the audit-
 *                       trail message ("rerouted FROM 710 …") regardless
 *                       of path. Equals sourceAccountId for OPEN.
 */
export function resolve710Context(
	code: string,
	rawMetadata: unknown,
): { ok: true; sourceAccountId: string; originalAccountId: string } | { ok: false; error: string } {
	if (!isTrust710ActionableCode(code)) {
		return { ok: false, error: `710 actions don't apply to ${code} findings` };
	}
	const meta = (rawMetadata ?? {}) as {
		accountId?: string;
		fromAccountId?: string;
		toAccountId?: string;
	};
	// Codes whose line currently lives on the original 710 account (the
	// open attribution finding AND the trustee re-attribution audit) use
	// metadata.accountId. The reroute audits live on the rerouted target
	// and carry the original via fromAccountId/toAccountId.
	if (code === 'TRUST_710_ATTRIBUTION_REQUIRED' || code === 'TRUST_710_ATTRIBUTED_TO_TRUSTEE') {
		if (!meta.accountId) return { ok: false, error: 'Finding has no accountId metadata' };
		return { ok: true, sourceAccountId: meta.accountId, originalAccountId: meta.accountId };
	}
	if (!meta.fromAccountId || !meta.toAccountId) {
		return { ok: false, error: 'Decisioned finding is missing from/to account metadata' };
	}
	return { ok: true, sourceAccountId: meta.toAccountId, originalAccountId: meta.fromAccountId };
}

/**
 * Audit-trail finding payload for "this 710 line is attributed to a
 * trustee" — parallel to build710RerouteFinding but for the trustee
 * path. Lives on the JE whose 710 line now has the trustee contact set.
 *
 * Fires from BOTH the open-finding trustee assignment (clearing
 * TRUST_710_ATTRIBUTION_REQUIRED) and the decisioned re-attribution
 * (reversing a prior reroute and posting back to 710). Surfaces in the
 * Decisioned tab as its own group so users can see every trustee-attributed
 * 710 in one place + re-decide from there.
 */
export function build710TrusteeAttributionFinding(args: {
	organizationId: string;
	journalEntryId: string;
	accountId: string;
	accountNumber: string | null;
	accountName: string;
	/** Display name of the trustee (or comma-joined names for splits). */
	trusteeLabel: string;
	/** When > 1, the JE has the 710 amount split across this many trustees. */
	trusteeCount: number;
	amount: number;
}): {
	organizationId: string;
	journalEntryId: string;
	code: 'TRUST_710_ATTRIBUTED_TO_TRUSTEE';
	severity: 'warn';
	message: string;
	metadata: Record<string, unknown>;
} {
	const acctLabel = args.accountNumber
		? `${args.accountNumber} ${args.accountName}`
		: args.accountName;
	const message = args.trusteeCount > 1
		? `${acctLabel} line split across ${args.trusteeCount} trustees (${args.trusteeLabel}) — admin meal attribution recorded.`
		: `${acctLabel} line attributed to trustee ${args.trusteeLabel} — admin meal expense.`;
	return {
		organizationId: args.organizationId,
		journalEntryId: args.journalEntryId,
		code: 'TRUST_710_ATTRIBUTED_TO_TRUSTEE',
		severity: 'warn',
		message,
		metadata: {
			accountId: args.accountId,
			accountNumber: args.accountNumber,
			trusteeCount: args.trusteeCount,
			amount: args.amount,
		},
	};
}

/**
 * When a 710 line carries a trustee contact (set by a prior trustee
 * attribution), a beneficiary reroute should NOT carry that trustee tag
 * onto the new demand-note / 815 line — the new posting is about the
 * vendor (e.g. Chick-fil-A), not about the trustee who paid. Returns the
 * transaction's vendor contactId when the source line's contact is a
 * trustee + the JE is transaction-sourced; otherwise returns the source
 * contactId unchanged.
 */
export async function resolveVendorContactForReroute(args: {
	organizationId: string;
	sourceContactId: string | null;
	jeSourceType: string | null;
	jeSourceId: string | null;
}): Promise<string | null> {
	if (!args.sourceContactId) return null;

	const [c] = await db
		.select({ typeTags: contacts.typeTags })
		.from(contacts)
		.where(
			and(
				eq(contacts.id, args.sourceContactId),
				eq(contacts.organizationId, args.organizationId),
			),
		)
		.limit(1);
	const tags = Array.isArray(c?.typeTags) ? c!.typeTags : [];
	const isTrustee = tags.some(
		(t) => typeof t === 'string' && t.toLowerCase() === 'trustee',
	);
	if (!isTrustee) return args.sourceContactId;

	if (args.jeSourceType !== 'transaction' || !args.jeSourceId) {
		// Manual JE: no canonical vendor to fall back to. Drop the trustee
		// tag so the rerouted line doesn't misleadingly show "Trustee" in
		// the Decisioned vendor column.
		return null;
	}
	const [tx] = await db
		.select({ contactId: transactions.contactId })
		.from(transactions)
		.where(
			and(
				eq(transactions.id, args.jeSourceId),
				eq(transactions.organizationId, args.organizationId),
			),
		)
		.limit(1);
	return tx?.contactId ?? null;
}

export interface Target710Resolution {
	accountId: string;
	accountNumber: string | null;
	accountName: string;
	/** How this target was chosen — drives the finding message + code. */
	routedTo: 'food_815' | 'demand_note_26x';
	beneficiaryId: string;
	beneficiaryName: string;
	/** Pre-formatted age/status note for the audit message. */
	ageNote: string;
}

/**
 * Resolve the correct target account when a 710 (Meals & Entertainment)
 * line gets tagged with a beneficiary. Semantically, a beneficiary tag on
 * 710 means "this meal was for the beneficiary personally, not admin" —
 * which means the line shouldn't be on 710 at all. Where it lands depends
 * on whether the beneficiary qualifies under the food/clothing carve-out:
 *
 *   qualifies (under 21 OR incapacitated as of JE date)
 *      → 815 Food (Minors / Incapacitated)
 *   doesn't qualify
 *      → that beneficiary's own 26x demand-note account
 *
 * Returns null if no usable target exists for the chosen routing — caller
 * should surface the reason (no 815 account seeded, no demand note for the
 * beneficiary, beneficiary outside this org, etc.) and skip the reroute.
 */
export async function resolveBeneficiary710Target(args: {
	organizationId: string;
	beneficiaryId: string;
	asOfDate: string;
}): Promise<{ ok: true; target: Target710Resolution } | { ok: false; error: string }> {
	const [bene] = await db
		.select({
			id: trustBeneficiaries.id,
			fullName: trustBeneficiaries.fullName,
			dateOfBirth: trustBeneficiaries.dateOfBirth,
			incapacitatedSince: trustBeneficiaries.incapacitatedSince,
			notIncapacitatedSince: trustBeneficiaries.notIncapacitatedSince,
			demandNoteAccountId: trustBeneficiaries.demandNoteAccountId,
		})
		.from(trustBeneficiaries)
		.where(
			and(
				eq(trustBeneficiaries.id, args.beneficiaryId),
				eq(trustBeneficiaries.organizationId, args.organizationId),
			),
		)
		.limit(1);
	if (!bene) {
		return { ok: false, error: 'Beneficiary not found in this organization' };
	}

	const qualifies = qualifiesAsOf(bene, args.asOfDate);
	const ageYears = bene.dateOfBirth
		? Math.max(
				0,
				new Date(args.asOfDate).getUTCFullYear() - new Date(bene.dateOfBirth).getUTCFullYear(),
			)
		: null;
	const ageNote = qualifies
		? (ageYears !== null ? `age ${ageYears}` : 'qualifying')
		: (ageYears !== null ? `age ${ageYears}` : 'age unknown');

	if (qualifies) {
		const [food] = await db
			.select({
				id: chartOfAccounts.id,
				accountNumber: chartOfAccounts.accountNumber,
				accountName: chartOfAccounts.accountName,
			})
			.from(chartOfAccounts)
			.where(
				and(
					eq(chartOfAccounts.organizationId, args.organizationId),
					eq(chartOfAccounts.detailType, 'trust_food_minors_incapacitated'),
				),
			)
			.limit(1);
		if (!food) {
			return {
				ok: false,
				error: `No 815 Food account seeded — can't reroute ${bene.fullName}'s meal.`,
			};
		}
		return {
			ok: true,
			target: {
				accountId: food.id,
				accountNumber: food.accountNumber,
				accountName: food.accountName,
				routedTo: 'food_815',
				beneficiaryId: bene.id,
				beneficiaryName: bene.fullName,
				ageNote,
			},
		};
	}

	if (!bene.demandNoteAccountId) {
		return {
			ok: false,
			error: `${bene.fullName} has no 26x demand-note account on file — can't reroute.`,
		};
	}
	const [dn] = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
		})
		.from(chartOfAccounts)
		.where(
			and(
				eq(chartOfAccounts.id, bene.demandNoteAccountId),
				eq(chartOfAccounts.organizationId, args.organizationId),
			),
		)
		.limit(1);
	if (!dn) {
		return { ok: false, error: `${bene.fullName}'s demand-note account is missing.` };
	}
	return {
		ok: true,
		target: {
			accountId: dn.id,
			accountNumber: dn.accountNumber,
			accountName: dn.accountName,
			routedTo: 'demand_note_26x',
			beneficiaryId: bene.id,
			beneficiaryName: bene.fullName,
			ageNote,
		},
	};
}

/**
 * Build the reroute finding payload for direct insert into
 * trust_review_findings. Co-located with the resolver so wording stays
 * in sync with the routing logic.
 */
export function build710RerouteFinding(args: {
	organizationId: string;
	journalEntryId: string;
	originalAccountNumber: string | null;
	originalAccountName: string;
	originalAccountId: string;
	target: Target710Resolution;
	amount: number;
}): {
	organizationId: string;
	journalEntryId: string;
	code: 'TRUST_710_REROUTED_TO_FOOD' | 'TRUST_710_REROUTED_TO_DEMAND_NOTE';
	severity: 'warn';
	message: string;
	metadata: Record<string, unknown>;
} {
	const isFood = args.target.routedTo === 'food_815';
	const code = isFood
		? 'TRUST_710_REROUTED_TO_FOOD'
		: 'TRUST_710_REROUTED_TO_DEMAND_NOTE';
	const fromLabel = args.originalAccountNumber
		? `${args.originalAccountNumber} ${args.originalAccountName}`
		: args.originalAccountName;
	const toLabel = args.target.accountNumber
		? `${args.target.accountNumber} ${args.target.accountName}`
		: args.target.accountName;
	const message = isFood
		? `${fromLabel} line tagged for ${args.target.beneficiaryName} (${args.target.ageNote}) — rerouted to ${toLabel}: 815 is the correct home for qualifying-beneficiary food.`
		: `${fromLabel} line tagged for ${args.target.beneficiaryName} (${args.target.ageNote}) — rerouted to ${toLabel} (demand note): adult-beneficiary meals book as non-qualifying personal advances.`;
	return {
		organizationId: args.organizationId,
		journalEntryId: args.journalEntryId,
		code,
		severity: 'warn',
		message,
		metadata: {
			accountNumber: args.target.accountNumber,
			fromAccountId: args.originalAccountId,
			fromAccountNumber: args.originalAccountNumber,
			toAccountId: args.target.accountId,
			toAccountNumber: args.target.accountNumber,
			beneficiaryId: args.target.beneficiaryId,
			amount: args.amount,
		},
	};
}
