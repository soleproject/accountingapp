import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts, trustBeneficiaries } from '@/db/schema/schema';

const FOOD_OR_CLOTHING_DETAIL_TYPES = new Set<string>([
	'trust_food_minors_incapacitated',
	'trust_clothing_minors_incapacitated',
]);

function ageYearsFromDob(dob: string, asOfDate: string): number | null {
	const birth = new Date(dob);
	const as = new Date(asOfDate);
	if (Number.isNaN(birth.getTime()) || Number.isNaN(as.getTime())) return null;
	let years = as.getUTCFullYear() - birth.getUTCFullYear();
	const m = as.getUTCMonth() - birth.getUTCMonth();
	if (m < 0 || (m === 0 && as.getUTCDate() < birth.getUTCDate())) years--;
	return years;
}

/**
 * Point-in-time incapacitation check. Returns true iff the beneficiary
 * was on the "is incapacitated" side of the most recent transition AS OF
 * the supplied date. Handles a single back-and-forth flip (incap → recovery)
 * with the two effective-date columns; if you need multi-cycle history,
 * graduate to a status-log table.
 *
 *   incapacitated_since IS NULL                        → never incapacitated
 *   incapacitated_since > asOfDate                     → not yet at that date
 *   not_incapacitated_since IS NULL                    → still incapacitated
 *   not_incapacitated_since <= asOfDate                → already recovered by then
 *   else                                                → was incapacitated at asOfDate
 */
export function isIncapacitatedAsOf(
	b: {
		incapacitatedSince: string | null;
		notIncapacitatedSince: string | null;
	},
	asOfDate: string,
): boolean {
	if (!b.incapacitatedSince) return false;
	if (b.incapacitatedSince > asOfDate) return false;
	if (b.notIncapacitatedSince && b.notIncapacitatedSince <= asOfDate) return false;
	return true;
}

/**
 * As-of qualifying check for 815/820 routing. Replaces the previous
 * live-flag check on TrustBeneficiarySummary.isIncapacitated.
 */
export function qualifiesAsOf(
	b: {
		dateOfBirth: string | null;
		incapacitatedSince: string | null;
		notIncapacitatedSince: string | null;
	},
	asOfDate: string,
): boolean {
	if (isIncapacitatedAsOf(b, asOfDate)) return true;
	if (!b.dateOfBirth) return false;
	const age = ageYearsFromDob(b.dateOfBirth, asOfDate);
	return age !== null && age < 21;
}

export interface TrustRerouteResult {
	/** The account the post should actually land on. When rerouted, this is
	 *  the beneficiary's demand-note account; otherwise it's the original
	 *  categoryAccountId the caller passed in. */
	categoryAccountId: string;
	/** Populated only when a reroute actually happened. Carries the human-
	 *  readable context so the caller can write a warning finding. */
	reroute: {
		fromAccountId: string;
		fromAccountNumber: string | null;
		fromAccountName: string;
		toAccountId: string;
		toAccountNumber: string | null;
		toAccountName: string;
		beneficiaryId: string;
		beneficiaryName: string;
		ageNote: string;
		detailType: string;
	} | null;
}

/**
 * Decide whether a per-beneficiary trust posting needs to reroute to the
 * tagged beneficiary's demand-note account. Triggers only for 815 (Food)
 * and 820 (Clothing) when the tagged beneficiary doesn't qualify
 * (under 21 OR incapacitated as of asOfDate).
 *
 * Spec behavior: instead of blocking the posting, we redirect it to the
 * beneficiary's 26x demand-note account so the trust still books the
 * advance, just as a loan to the beneficiary rather than a qualifying
 * support expense. The caller is responsible for surfacing the reroute
 * as a Trust Review finding (TRUST_815_REROUTED_TO_DEMAND_NOTE /
 * TRUST_820_*) when this fn returns a non-null `reroute`.
 *
 * No-op cases (returns input unchanged):
 *   - org doesn't have trust enabled (caller already checked)
 *   - categoryAccountId isn't 815/820 detail_type
 *   - no beneficiary tag
 *   - beneficiary qualifies (under 21 OR incapacitated)
 *   - beneficiary has no demand-note account on file (rare — emits null,
 *     caller should fall back to the original post + a "set up demand
 *     note" finding)
 */
export async function maybeRerouteFor815820(args: {
	organizationId: string;
	categoryAccountId: string;
	beneficiaryId: string | null;
	date: string;
}): Promise<TrustRerouteResult> {
	const passthrough: TrustRerouteResult = {
		categoryAccountId: args.categoryAccountId,
		reroute: null,
	};
	if (!args.beneficiaryId) return passthrough;

	const [categoryAcct] = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
			detailType: chartOfAccounts.detailType,
		})
		.from(chartOfAccounts)
		.where(
			and(
				eq(chartOfAccounts.id, args.categoryAccountId),
				eq(chartOfAccounts.organizationId, args.organizationId),
			),
		)
		.limit(1);
	if (!categoryAcct?.detailType) return passthrough;
	if (!FOOD_OR_CLOTHING_DETAIL_TYPES.has(categoryAcct.detailType)) return passthrough;

	const [bene] = await db
		.select({
			id: trustBeneficiaries.id,
			fullName: trustBeneficiaries.fullName,
			dateOfBirth: trustBeneficiaries.dateOfBirth,
			isIncapacitated: trustBeneficiaries.isIncapacitated,
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
	if (!bene) return passthrough;

	// Point-in-time: was this beneficiary qualifying AS OF the JE date?
	// Both age-out (DOB-driven) and incapacitation-flip (date-column-driven)
	// transitions are respected this way.
	const ageYears = bene.dateOfBirth ? ageYearsFromDob(bene.dateOfBirth, args.date) : null;
	if (qualifiesAsOf(bene, args.date)) return passthrough;

	// Beneficiary doesn't qualify. Need a demand-note account to reroute to.
	if (!bene.demandNoteAccountId) return passthrough;

	const [demandNote] = await db
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
	if (!demandNote) return passthrough;

	// "as-of" status drives the note — we already established they don't
	// qualify above. If they USED to be incapacitated but recovered, the
	// note reflects the age at the JE date (the most useful info for the
	// human reviewing the Trust Review row).
	const ageNote = ageYears !== null ? `age ${ageYears}` : 'age unknown';

	return {
		categoryAccountId: demandNote.id,
		reroute: {
			fromAccountId: categoryAcct.id,
			fromAccountNumber: categoryAcct.accountNumber,
			fromAccountName: categoryAcct.accountName,
			toAccountId: demandNote.id,
			toAccountNumber: demandNote.accountNumber,
			toAccountName: demandNote.accountName,
			beneficiaryId: bene.id,
			beneficiaryName: bene.fullName,
			ageNote,
			detailType: categoryAcct.detailType,
		},
	};
}

/**
 * Build the canonical reroute-warning finding payload for direct insert
 * into trust_review_findings. Co-located with the helper so the message
 * stays in sync with the routing logic.
 */
export function buildRerouteFinding(args: {
	organizationId: string;
	journalEntryId: string;
	reroute: NonNullable<TrustRerouteResult['reroute']>;
}): {
	organizationId: string;
	journalEntryId: string;
	code: 'TRUST_815_REROUTED_TO_DEMAND_NOTE' | 'TRUST_820_REROUTED_TO_DEMAND_NOTE';
	severity: 'warn';
	message: string;
	metadata: Record<string, unknown>;
} {
	const isFood = args.reroute.detailType === 'trust_food_minors_incapacitated';
	const code = isFood
		? 'TRUST_815_REROUTED_TO_DEMAND_NOTE'
		: 'TRUST_820_REROUTED_TO_DEMAND_NOTE';
	const fromLabel = args.reroute.fromAccountNumber
		? `${args.reroute.fromAccountNumber} ${args.reroute.fromAccountName}`
		: args.reroute.fromAccountName;
	const toLabel = args.reroute.toAccountNumber
		? `${args.reroute.toAccountNumber} ${args.reroute.toAccountName}`
		: args.reroute.toAccountName;
	return {
		organizationId: args.organizationId,
		journalEntryId: args.journalEntryId,
		code,
		severity: 'warn',
		message: `${fromLabel} requires the beneficiary to be under 21 OR incapacitated. ${args.reroute.beneficiaryName} (${args.reroute.ageNote}) doesn't qualify — posting was rerouted to ${toLabel} (demand note) as a non-qualifying advance.`,
		metadata: {
			accountNumber: args.reroute.toAccountNumber,
			fromAccountId: args.reroute.fromAccountId,
			fromAccountNumber: args.reroute.fromAccountNumber,
			toAccountId: args.reroute.toAccountId,
			toAccountNumber: args.reroute.toAccountNumber,
			beneficiaryId: args.reroute.beneficiaryId,
			detailType: args.reroute.detailType,
		},
	};
}
