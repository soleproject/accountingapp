import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	journalEntryLines,
	trustBeneficiaries,
} from '@/db/schema/schema';
import { qualifiesAsOf } from './trust-reroute';
import { isTrust815Or820BeneActionableCode } from './trust-food-clothing-codes';

// Code constants + type guards live in trust-food-clothing-codes.ts so
// client components can import them without pulling this server-only
// module into the client bundle. Re-imported here for the resolvers below.

const FOOD_DETAIL_TYPE = 'trust_food_minors_incapacitated';
const CLOTHING_DETAIL_TYPE = 'trust_clothing_minors_incapacitated';
const MEALS_DETAIL_TYPE = 'entertainment_meals';

/**
 * Locate the food/clothing line on a JE and determine its kind. Used to
 * resolve "on-source" 815/820 codes whose metadata doesn't carry an
 * accountId (the rules engine emits accountNumber + detailType only, and
 * the BENE_CONFIRMED audit is even sparser). Walks JE lines, joins to
 * CoA, picks the first line whose account is an 815 or 820.
 */
async function findFoodClothingLineOnJe(args: {
	organizationId: string;
	journalEntryId: string;
}): Promise<
	| { ok: true; accountId: string; kind: '815' | '820' }
	| { ok: false; error: string }
> {
	const rows = await db
		.select({
			accountId: journalEntryLines.accountId,
			detailType: chartOfAccounts.detailType,
		})
		.from(journalEntryLines)
		.innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalEntryLines.accountId))
		.where(
			and(
				eq(journalEntryLines.journalEntryId, args.journalEntryId),
				eq(chartOfAccounts.organizationId, args.organizationId),
			),
		);
	for (const r of rows) {
		if (r.detailType === FOOD_DETAIL_TYPE) {
			return { ok: true, accountId: r.accountId, kind: '815' };
		}
		if (r.detailType === CLOTHING_DETAIL_TYPE) {
			return { ok: true, accountId: r.accountId, kind: '820' };
		}
	}
	return { ok: false, error: 'No 815/820 line found on this JE — nothing to reassign' };
}

/**
 * Resolve the "from" and "to" accounts a 815/820 action needs to operate
 * on, given just a finding's code + metadata.
 *
 *   sourceAccountId        — where the JE line currently lives. For
 *                            on-source codes this is the 815/820 acct
 *                            itself; for REROUTED_TO_DEMAND_NOTE the line
 *                            has already been moved to a 26x.
 *   foodClothingAccountId  — canonical 815/820 acct id (== sourceAccountId
 *                            on on-source codes).
 *   kind                   — '815' for food, '820' for clothing.
 *
 * Parallel to resolve710Context in trust-710-reroute.ts.
 */
export async function resolve815Or820Context(args: {
	organizationId: string;
	code: string;
	metadata: unknown;
	journalEntryId: string;
}): Promise<
	| { ok: true; kind: '815' | '820'; sourceAccountId: string; foodClothingAccountId: string }
	| { ok: false; error: string }
> {
	if (!isTrust815Or820BeneActionableCode(args.code)) {
		return { ok: false, error: `815/820 actions don't apply to ${args.code} findings` };
	}
	const isRerouted =
		args.code === 'TRUST_815_REROUTED_TO_DEMAND_NOTE'
		|| args.code === 'TRUST_820_REROUTED_TO_DEMAND_NOTE';
	const kindFromCode: '815' | '820' = args.code.startsWith('TRUST_820_') ? '820' : '815';

	if (isRerouted) {
		const meta = (args.metadata ?? {}) as { fromAccountId?: string; toAccountId?: string };
		if (!meta.fromAccountId || !meta.toAccountId) {
			return { ok: false, error: 'Decisioned finding is missing from/to account metadata' };
		}
		return {
			ok: true,
			kind: kindFromCode,
			sourceAccountId: meta.toAccountId,
			foodClothingAccountId: meta.fromAccountId,
		};
	}

	// On-source code (open, warn, or bene-confirmed) — the line is still on
	// the 815/820 account. Metadata may or may not carry accountId, so find
	// it by joining JE lines to CoA by detail_type.
	const found = await findFoodClothingLineOnJe({
		organizationId: args.organizationId,
		journalEntryId: args.journalEntryId,
	});
	if (!found.ok) return found;
	return {
		ok: true,
		kind: found.kind,
		sourceAccountId: found.accountId,
		foodClothingAccountId: found.accountId,
	};
}

export interface FoodClothingTarget {
	accountId: string;
	accountNumber: string | null;
	accountName: string;
	/** Keeps on 815/820 if bene qualifies, else 26x demand note. */
	routedTo: 'food_clothing_source' | 'demand_note_26x';
	kind: '815' | '820';
	beneficiaryId: string;
	beneficiaryName: string;
	ageNote: string;
}

/**
 * Decide where a re-tagged food/clothing line should land given a new
 * beneficiary and the asOf date. Qualifying (under 21 OR incapacitated at
 * the JE date) → org's 815 or 820 account per `kind`; non-qualifying →
 * that beneficiary's 26x demand note.
 *
 * Parallel to resolveBeneficiary710Target. Returns the same shape so the
 * audit-builder helpers can reuse the structure.
 */
export async function resolveFoodClothingTargetForBeneficiary(args: {
	organizationId: string;
	beneficiaryId: string;
	kind: '815' | '820';
	asOfDate: string;
}): Promise<{ ok: true; target: FoodClothingTarget } | { ok: false; error: string }> {
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
		const targetDetailType = args.kind === '815' ? FOOD_DETAIL_TYPE : CLOTHING_DETAIL_TYPE;
		const [acct] = await db
			.select({
				id: chartOfAccounts.id,
				accountNumber: chartOfAccounts.accountNumber,
				accountName: chartOfAccounts.accountName,
			})
			.from(chartOfAccounts)
			.where(
				and(
					eq(chartOfAccounts.organizationId, args.organizationId),
					eq(chartOfAccounts.detailType, targetDetailType),
				),
			)
			.limit(1);
		if (!acct) {
			return {
				ok: false,
				error: `No ${args.kind} account seeded — can't reassign ${bene.fullName}'s line.`,
			};
		}
		return {
			ok: true,
			target: {
				accountId: acct.id,
				accountNumber: acct.accountNumber,
				accountName: acct.accountName,
				routedTo: 'food_clothing_source',
				kind: args.kind,
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
			kind: args.kind,
			beneficiaryId: bene.id,
			beneficiaryName: bene.fullName,
			ageNote,
		},
	};
}

/**
 * Look up the canonical 815 Food account on this org — needed when a 710
 * line gets bene-attributed and the action emits an 815-family audit
 * (because the bene tag re-characterizes the line as food, regardless of
 * whether the GL line ultimately lands on 815 or a 26x demand note).
 */
export async function resolveTrust815Account(orgId: string): Promise<
	| { ok: true; accountId: string; accountNumber: string | null; accountName: string }
	| { ok: false; error: string }
> {
	const [acct] = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
		})
		.from(chartOfAccounts)
		.where(
			and(
				eq(chartOfAccounts.organizationId, orgId),
				eq(chartOfAccounts.detailType, FOOD_DETAIL_TYPE),
			),
		)
		.limit(1);
	if (!acct) {
		return { ok: false, error: "No 815 Food account seeded on this org." };
	}
	return {
		ok: true,
		accountId: acct.id,
		accountNumber: acct.accountNumber,
		accountName: acct.accountName,
	};
}

/**
 * Look up the canonical 710 Meals & Entertainment account on this org —
 * needed when a 815 line gets re-attributed to a trustee (admin meal),
 * which lands on 710 with the trustee contact set.
 */
export async function resolveTrust710Account(orgId: string): Promise<
	| { ok: true; accountId: string; accountNumber: string | null; accountName: string }
	| { ok: false; error: string }
> {
	const [acct] = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
		})
		.from(chartOfAccounts)
		.where(
			and(
				eq(chartOfAccounts.organizationId, orgId),
				eq(chartOfAccounts.detailType, MEALS_DETAIL_TYPE),
			),
		)
		.limit(1);
	if (!acct) {
		return {
			ok: false,
			error: "No 710 Meals & Entertainment account seeded — can't attribute to trustee.",
		};
	}
	return {
		ok: true,
		accountId: acct.id,
		accountNumber: acct.accountNumber,
		accountName: acct.accountName,
	};
}

/**
 * Audit-trail finding for "a 815/820 line was tagged with a qualifying
 * beneficiary and stays on the food/clothing account". Lands on the new
 * JE after the unified bene action reverses + reposts.
 */
export function buildFoodClothingConfirmedFinding(args: {
	organizationId: string;
	journalEntryId: string;
	target: FoodClothingTarget;
	amount: number;
}): {
	organizationId: string;
	journalEntryId: string;
	code: 'TRUST_815_BENE_CONFIRMED_QUALIFYING' | 'TRUST_820_BENE_CONFIRMED_QUALIFYING';
	severity: 'warn';
	message: string;
	metadata: Record<string, unknown>;
} {
	const code = args.target.kind === '815'
		? 'TRUST_815_BENE_CONFIRMED_QUALIFYING'
		: 'TRUST_820_BENE_CONFIRMED_QUALIFYING';
	const acctLabel = args.target.accountNumber
		? `${args.target.accountNumber} ${args.target.accountName}`
		: args.target.accountName;
	return {
		organizationId: args.organizationId,
		journalEntryId: args.journalEntryId,
		code,
		severity: 'warn',
		message: `${acctLabel} line tagged for ${args.target.beneficiaryName} (${args.target.ageNote}) — qualifying beneficiary confirmed; stays on ${acctLabel}.`,
		metadata: {
			accountId: args.target.accountId,
			accountNumber: args.target.accountNumber,
			beneficiaryId: args.target.beneficiaryId,
			amount: args.amount,
		},
	};
}

/**
 * Audit-trail finding for "a 815/820 line was rerouted to a beneficiary's
 * 26x demand note because they don't qualify". Mirrors the rules engine's
 * own _REROUTED_TO_DEMAND_NOTE finding emitted on first post — same code,
 * same metadata shape (fromAccountId / toAccountId / detailType so
 * resolve815Or820Context can re-resolve later).
 */
export function buildFoodClothingRerouteToDemandNoteFinding(args: {
	organizationId: string;
	journalEntryId: string;
	fromAccountId: string;
	fromAccountNumber: string | null;
	fromAccountName: string;
	fromDetailType: string;
	target: FoodClothingTarget;
	amount: number;
}): {
	organizationId: string;
	journalEntryId: string;
	code: 'TRUST_815_REROUTED_TO_DEMAND_NOTE' | 'TRUST_820_REROUTED_TO_DEMAND_NOTE';
	severity: 'warn';
	message: string;
	metadata: Record<string, unknown>;
} {
	const code = args.target.kind === '815'
		? 'TRUST_815_REROUTED_TO_DEMAND_NOTE'
		: 'TRUST_820_REROUTED_TO_DEMAND_NOTE';
	const fromLabel = args.fromAccountNumber
		? `${args.fromAccountNumber} ${args.fromAccountName}`
		: args.fromAccountName;
	const toLabel = args.target.accountNumber
		? `${args.target.accountNumber} ${args.target.accountName}`
		: args.target.accountName;
	const item = args.target.kind === '815' ? 'food' : 'clothing';
	return {
		organizationId: args.organizationId,
		journalEntryId: args.journalEntryId,
		code,
		severity: 'warn',
		message: `${fromLabel} line tagged for ${args.target.beneficiaryName} (${args.target.ageNote}) — rerouted to ${toLabel} (demand note): adult-beneficiary ${item} books as a non-qualifying personal advance.`,
		metadata: {
			accountNumber: args.target.accountNumber,
			fromAccountId: args.fromAccountId,
			fromAccountNumber: args.fromAccountNumber,
			toAccountId: args.target.accountId,
			toAccountNumber: args.target.accountNumber,
			beneficiaryId: args.target.beneficiaryId,
			detailType: args.fromDetailType,
		},
	};
}
