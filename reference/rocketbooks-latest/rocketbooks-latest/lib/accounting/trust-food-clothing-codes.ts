/**
 * Client-safe code constants + type guards for the 815/820 actions.
 * Lives outside trust-food-clothing-reroute.ts so client components (e.g.
 * FindingsTable) can import them without dragging the `'server-only'`
 * DB helpers into the client bundle.
 */

/** Bene-actionable codes — all 8 (4 × 815 + 4 × 820). */
export const TRUST_815_820_BENE_ACTIONABLE_CODES = [
	'TRUST_815_NO_QUALIFYING_BENEFICIARY',
	'TRUST_815_WARN_VERIFY_BENEFICIARY',
	'TRUST_815_REROUTED_TO_DEMAND_NOTE',
	'TRUST_815_BENE_CONFIRMED_QUALIFYING',
	'TRUST_820_NO_QUALIFYING_BENEFICIARY',
	'TRUST_820_WARN_VERIFY_BENEFICIARY',
	'TRUST_820_REROUTED_TO_DEMAND_NOTE',
	'TRUST_820_BENE_CONFIRMED_QUALIFYING',
] as const;
export type Trust815Or820BeneActionableCode =
	(typeof TRUST_815_820_BENE_ACTIONABLE_CODES)[number];

/** Trustee-actionable codes — 4 × 815 only; 820→trustee makes no sense. */
export const TRUST_815_TRUSTEE_ACTIONABLE_CODES = [
	'TRUST_815_NO_QUALIFYING_BENEFICIARY',
	'TRUST_815_WARN_VERIFY_BENEFICIARY',
	'TRUST_815_REROUTED_TO_DEMAND_NOTE',
	'TRUST_815_BENE_CONFIRMED_QUALIFYING',
] as const;
export type Trust815TrusteeActionableCode =
	(typeof TRUST_815_TRUSTEE_ACTIONABLE_CODES)[number];

const BENE_SET: ReadonlySet<string> = new Set(TRUST_815_820_BENE_ACTIONABLE_CODES);
const TRUSTEE_SET: ReadonlySet<string> = new Set(TRUST_815_TRUSTEE_ACTIONABLE_CODES);

export function isTrust815Or820BeneActionableCode(
	code: string,
): code is Trust815Or820BeneActionableCode {
	return BENE_SET.has(code);
}
export function isTrust815TrusteeActionableCode(
	code: string,
): code is Trust815TrusteeActionableCode {
	return TRUSTEE_SET.has(code);
}
