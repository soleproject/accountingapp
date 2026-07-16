import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { trustReviewFindings } from '@/db/schema/schema';
import { getDemandNoteOutstanding } from '../../trust-beneficiary-balance';
import type { TrustLineContext, TrustBeneficiarySummary } from './context';
import type { TrustFinding } from './types';

/**
 * Account-eligibility & posting-intent rules. Inspects the destination
 * account (by detailType) and produces blocks/warnings appropriate for
 * the spec.
 *
 * Per-line rule module — called once per JE line by the main evaluator.
 *
 * Phase 4d: per-line `beneficiaryId` tag drives precise enforcement on
 * 815/820 (Food/Clothing for minors or incapacitated), 310 (taxable
 * distributions → K-1), and 635 (medical recipient). When the tag is
 * missing on a per-beneficiary account, fires
 * TRUST_BENEFICIARY_LINKAGE_REQUIRED so the Trust Review queue surfaces
 * a tagger inline.
 *
 * Sourced from `Beneficial Trust Logic.docx` (see
 * [[reference-beneficial-trust-spec]]) — specifically the COA-SPECIFIC
 * LOGIC section.
 */
export async function evaluateLineAccountEligibility(
	ctx: TrustLineContext,
): Promise<TrustFinding[]> {
	const findings: TrustFinding[] = [];
	const { detailType, accountName, accountNumber } = ctx.account;

	switch (detailType) {
		case 'trust_food_minors_incapacitated':
			findings.push(...checkFoodOrClothing(ctx, 'food'));
			break;

		case 'trust_clothing_minors_incapacitated':
			findings.push(...checkFoodOrClothing(ctx, 'clothing'));
			break;

		case 'trust_business_income':
			findings.push({
				code: 'TRUST_450_BUSINESS_INCOME_BLOCKED',
				severity: 'block',
				message: `Beneficial trusts must not receive business income directly. Route the business activity through an LLC/S-Corp and post the K-1 to account 455 (K-1 Income) instead. (Blocked: ${accountNumber} ${accountName})`,
				metadata: { accountNumber, detailType },
			});
			break;

		case 'trust_distributions_to_beneficiaries':
			findings.push(...(await check310Distribution(ctx)));
			break;

		case 'trust_k1_income':
			findings.push({
				code: 'TRUST_455_FLAG_K1_ISSUANCE',
				severity: 'warn',
				message: `K-1 income posted — retain the source K-1 form and reconcile at year-end.`,
				metadata: { accountNumber, detailType },
			});
			break;

		case 'trust_trustee_compensation':
			findings.push({
				code: 'TRUST_510_FLAG_1099_ISSUANCE',
				severity: 'warn',
				message: `Trustee compensation requires a 1099-MISC at year-end. Tag the trustee contact (${ctx.contact?.contactName ?? 'recipient unknown'}) for 1099 issuance.`,
				metadata: { accountNumber, detailType },
			});
			break;

		case 'charitable_contributions':
			findings.push({
				code: 'TRUST_515_VERIFY_501C3',
				severity: 'warn',
				message: `Verify recipient${ctx.contact ? ` (${ctx.contact.contactName})` : ''} is a registered 501(c)(3) and retain the tax receipt.`,
				metadata: { accountNumber, detailType },
			});
			break;

		case 'auto':
			findings.push({
				code: 'TRUST_605_VERIFY_TRUST_OWNED_VEHICLE',
				severity: 'warn',
				message: `Vehicle expenses are only allowed on trust-owned vehicles. If the vehicle is shared with the trustee, attach mileage log + reimburse personal-use miles at the IRS rate.`,
				metadata: { accountNumber, detailType },
			});
			break;

		case 'entertainment_meals':
			// 710 M&E lines have to be attributable to SOMEONE — either a
			// beneficiary (probably miscategorized, should be 815) or a
			// trustee contact (admin meal). Anything else is a black-hole
			// expense the trustee can't justify at audit time.
			if (!ctx.linkedBeneficiary && !contactIsTrustee(ctx.contact)) {
				findings.push({
					code: 'TRUST_710_ATTRIBUTION_REQUIRED',
					severity: 'warn',
					message: `Meals & Entertainment (710) posted without a beneficiary tag or a trustee-attributed contact. Either tag a beneficiary (recategorize to 815 if it's qualifying food/clothing) or set a contact marked as a trustee — admin meals need trustee attribution for the audit trail.`,
					metadata: { accountNumber, accountId: ctx.account.id, detailType },
				});
			}
			break;

		case 'trust_medical_wellness':
			// Phase 4d: recipient identification can come from EITHER an explicit
			// beneficiary tag OR a contact (e.g. the medical provider). Only fire
			// when neither is set.
			if (!ctx.linkedBeneficiary && !ctx.contact) {
				findings.push({
					code: 'TRUST_635_RECIPIENT_REQUIRED',
					severity: 'warn',
					message: `Medical/wellness expense without a named recipient. Tag the beneficiary receiving care OR set a contact (the medical provider).`,
					metadata: { accountNumber, detailType },
				});
			}
			break;

		case 'trust_property_taxes':
		case 'trust_non_property_taxes':
			findings.push(...check505Vs705Routing(ctx));
			break;

		// Capital gains: every deposit on 420 or 425 needs an explicit
		// short/long decision (with the option to route long-term to
		// corpus when the trust instrument allows). Even when the user
		// posted to the "right" account, we want the confirmation step
		// so K-1 prep at year-end has a clean audit trail per gain.
		case 'trust_short_term_capital_gains':
		case 'trust_long_term_capital_gains':
			if (ctx.credit > 0) {
				findings.push({
					code: 'TRUST_CAPITAL_GAIN_NEEDS_HOLDING_PERIOD',
					severity: 'warn',
					message: `Capital-gain deposit posted to ${accountNumber} ${accountName}. Confirm holding period (short-term ≤ 1 year → 420, long-term > 1 year → 425) and whether the trust instrument routes long-term gains to corpus.`,
					metadata: { accountNumber, accountId: ctx.account.id, detailType, currentAccountId: ctx.account.id },
				});
			}
			break;
	}

	// Corpus equity bucket: any deposit landing on the org's Trust
	// Corpus account needs explicit user confirmation that it's really
	// principal vs income — getting this wrong shows up at year-end as
	// either missing DNI (income misposted as corpus) or phantom K-1
	// allocations (corpus misposted as income). Triggered off the equity
	// account-type rather than a trust-specific detail_type because
	// QBO-derived charts park the corpus account on the generic
	// opening_balance_equity detail.
	if (
		ctx.account.accountType === 'equity'
		&& ctx.credit > 0
		&& detailType !== 'trust_distributions_to_beneficiaries'
	) {
		findings.push({
			code: 'TRUST_DEPOSIT_NEEDS_CORPUS_OR_INCOME_CLASSIFICATION',
			severity: 'warn',
			message: `Deposit landed on equity account ${accountNumber} ${accountName}. Confirm it's a true corpus contribution / return of principal — not income that should hit a 4xx account (interest, K-1, rental, etc.).`,
			metadata: { accountNumber, accountId: ctx.account.id, detailType, currentAccountId: ctx.account.id },
		});
	}

	// Demand notes (260 trustee + 265.x per-beneficiary): every advance
	// should be backed by a signed promissory note. The source spec
	// treats 26x as a running balance without per-draw formality, but
	// IRS / UTC best practice requires a master note (otherwise the
	// IRS can recharacterize advances as taxable distributions).
	//
	// To avoid hundreds of warnings when a future repost runs through
	// pre-existing 26x lines, dedupe per-borrower: if there's already
	// an OPEN warning on this same account, suppress. One warning per
	// borrower at a time; the user resolves by attaching a promissory
	// note (Phase 2 template) or dismissing.
	if (
		detailType === 'trust_trustee_demand_note'
		|| (detailType && detailType.startsWith('trust_beneficiary_demand_note'))
	) {
		const [existing] = await db
			.select({ id: trustReviewFindings.id })
			.from(trustReviewFindings)
			.where(
				and(
					eq(trustReviewFindings.organizationId, ctx.organizationId),
					eq(trustReviewFindings.code, 'TRUST_DEMAND_NOTE_MISSING_NOTE'),
					isNull(trustReviewFindings.dismissedAt),
					sql`${trustReviewFindings.metadata}->>'accountId' = ${ctx.account.id}`,
				),
			)
			.limit(1);
		if (!existing) {
			const borrowerLabel = detailType === 'trust_trustee_demand_note'
				? 'Trustee Demand Note (260)'
				: `${accountNumber} ${accountName}`;
			findings.push({
				code: 'TRUST_DEMAND_NOTE_MISSING_NOTE',
				severity: 'warn',
				message: `Demand-note activity recorded on ${borrowerLabel} without a backing promissory note on file. Attach (or draft) a master promissory note so advances aren't recharacterized as taxable distributions by the IRS. One warning surfaces per borrower until resolved.`,
				metadata: { accountNumber, accountId: ctx.account.id, detailType },
			});
		}
	}

	return findings;
}

/**
 * 815/820 check with Phase 4d per-beneficiary precision.
 *
 * Three states:
 *   1. No tag → TRUST_BENEFICIARY_LINKAGE_REQUIRED (warn). Trust Review
 *      surfaces a tagger inline. Posting still proceeds since blocking on
 *      a missing tag would interrupt Plaid sync; the user resolves at
 *      review time.
 *   2. Tagged + qualifies (age < 21 OR incapacitated) → no finding. Clean
 *      post; the spec is satisfied.
 *   3. Tagged + doesn't qualify → BLOCK (TRUST_815_NO_QUALIFYING_BENEFICIARY
 *      or TRUST_820_*) with the beneficiary's actual age/capacity in the
 *      message. Categorization UI should also reject this choice at UI
 *      time as defense in depth.
 */
function checkFoodOrClothing(
	ctx: TrustLineContext,
	kind: 'food' | 'clothing',
): TrustFinding[] {
	const label = kind === 'food' ? 'Food (815)' : 'Clothing (820)';
	const accountNumber = ctx.account.accountNumber;

	if (!ctx.linkedBeneficiary) {
		const qualifying = ctx.beneficiaries.filter(qualifies);
		const choices = qualifying.length > 0
			? ` Qualifying beneficiaries on file: ${qualifying.map(formatBeneficiary).join(', ')}.`
			: ' This trust has no qualifying beneficiary on file — add one or use a different expense account.';
		return [
			{
				code: 'TRUST_BENEFICIARY_LINKAGE_REQUIRED',
				severity: 'warn',
				message: `${label} expense posted without a tagged beneficiary. ${kind} can only be paid for a beneficiary under 21 OR incapacitated. Tag the recipient to clear this flag.${choices}`,
				metadata: { accountNumber, accountId: ctx.account.id, detailType: ctx.account.detailType },
			},
		];
	}

	if (!qualifies(ctx.linkedBeneficiary)) {
		// Defense in depth: the categorize action reroutes to the demand-note
		// account before the rule engine sees this JE, so in normal flow we
		// never land here. This fires only when a JE is posted directly
		// (manual JE entry, scripted post) bypassing the categorize action.
		// Severity is warn (not block) since the user has an alternate path
		// (recategorize to 26x manually) and we don't want sync to halt.
		const code =
			kind === 'food' ? 'TRUST_815_NO_QUALIFYING_BENEFICIARY' : 'TRUST_820_NO_QUALIFYING_BENEFICIARY';
		const note = ctx.linkedBeneficiary.incapacitatedAtJeDate
			? 'incapacitated'
			: ctx.linkedBeneficiary.ageYears !== null
				? `age ${ctx.linkedBeneficiary.ageYears}`
				: 'age unknown';
		return [
			{
				code,
				severity: 'warn',
				message: `${label} posted for ${ctx.linkedBeneficiary.fullName} (${note}). ${label} is meant for beneficiaries under 21 OR incapacitated — recategorize this line to ${ctx.linkedBeneficiary.fullName}'s demand note (26x) so it books as a non-qualifying advance, or re-tag with a qualifying beneficiary.`,
				metadata: { accountNumber, detailType: ctx.account.detailType, beneficiaryId: ctx.linkedBeneficiary.id },
			},
		];
	}

	// Tagged + qualifies → clean post, no finding emitted.
	return [];
}

/**
 * 310 Distribution check with Phase 4d precision.
 *
 * Behavior:
 *   - Always emits TRUST_310_FLAG_K1_ISSUANCE (warn) — distributions
 *     always generate a K-1. Message includes the recipient name when
 *     tagged, prompts for tagging when not.
 *   - When no tag → also emits TRUST_BENEFICIARY_LINKAGE_REQUIRED so the
 *     Trust Review queue surfaces a tagger.
 *   - When tagged → looks up the linked beneficiary's 265.x demand-note
 *     balance via getDemandNoteOutstanding. If balance > 0 (beneficiary
 *     still owes the trust), emits TRUST_310_DEMAND_NOTE_NOT_EXHAUSTED
 *     (warn) with the dollar figure. Spec says "only post if exhausted"
 *     but we don't block since the user may have a legitimate reason
 *     (e.g. partial distribution while balance remains).
 */
async function check310Distribution(ctx: TrustLineContext): Promise<TrustFinding[]> {
	const findings: TrustFinding[] = [];
	const accountNumber = ctx.account.accountNumber;

	if (!ctx.linkedBeneficiary) {
		findings.push({
			code: 'TRUST_BENEFICIARY_LINKAGE_REQUIRED',
			severity: 'warn',
			message: `Distribution (310) posted without a tagged beneficiary. K-1 forms are issued per recipient — tag the beneficiary so a K-1 can be prepared.`,
			metadata: { accountNumber, accountId: ctx.account.id, detailType: ctx.account.detailType },
		});
		findings.push({
			code: 'TRUST_310_FLAG_K1_ISSUANCE',
			severity: 'warn',
			message: `Taxable K-1 distribution flagged for issuance. Tag the recipient beneficiary so the K-1 can be prepared.`,
			metadata: { accountNumber, accountId: ctx.account.id, detailType: ctx.account.detailType },
		});
		return findings;
	}

	const b = ctx.linkedBeneficiary;
	findings.push({
		code: 'TRUST_310_FLAG_K1_ISSUANCE',
		severity: 'warn',
		message: `Taxable K-1 distribution to ${b.fullName} flagged for issuance. Confirm this is a real draw (not a reimbursement) and prepare a K-1 at year-end.`,
		metadata: { accountNumber, detailType: ctx.account.detailType, beneficiaryId: b.id },
	});

	if (b.demandNoteAccountId) {
		const outstanding = await getDemandNoteOutstanding({
			demandNoteAccountId: b.demandNoteAccountId,
		});
		if (outstanding > 0) {
			findings.push({
				code: 'TRUST_310_DEMAND_NOTE_NOT_EXHAUSTED',
				severity: 'warn',
				message: `${b.fullName}'s demand-note balance is $${outstanding.toFixed(2)} (still owed to the trust). Spec recommends exhausting the demand note before posting a taxable distribution — either receive reimbursement (credit 265.x) or roll the balance into this distribution.`,
				metadata: { accountNumber, accountId: ctx.account.id, beneficiaryId: b.id, outstandingBalance: outstanding },
			});
		}
	}

	return findings;
}

function contactIsTrustee(c: TrustLineContext['contact']): boolean {
	if (!c) return false;
	return c.typeTags.some((t) => t.toLowerCase() === 'trustee');
}

/**
 * Point-in-time qualifying check: incapacitated AT the JE date OR under
 * 21 at the JE date. Uses incapacitatedAtJeDate (which loadAggregateContext
 * computes via isIncapacitatedAsOf), so flipping the live flag today
 * doesn't retroactively invalidate qualifying-at-the-time posts.
 */
function qualifies(b: TrustBeneficiarySummary): boolean {
	if (b.incapacitatedAtJeDate) return true;
	if (b.ageYears !== null && b.ageYears < 21) return true;
	return false;
}

function formatBeneficiary(b: TrustBeneficiarySummary): string {
	const note = b.incapacitatedAtJeDate ? 'incapacitated' : `age ${b.ageYears}`;
	return `${b.fullName} (${note})`;
}

function check505Vs705Routing(ctx: TrustLineContext): TrustFinding[] {
	const memo = ctx.memo.toLowerCase();
	if (!memo) return [];

	const propertyHints = ['property tax', 'real estate', 'land tax', 'building tax', 'parcel'];
	const memoLooksPropertyish = propertyHints.some((h) => memo.includes(h));
	const isProp = ctx.account.detailType === 'trust_property_taxes';

	if (isProp && !memoLooksPropertyish) {
		return [
			{
				code: 'TRUST_505_705_LIKELY_MISROUTED',
				severity: 'warn',
				message: `Posted to 505 Property Taxes but description "${ctx.memo}" doesn't look property-related. Consider 705 Non-Property Taxes (vehicle, sales, use).`,
				metadata: { accountNumber: ctx.account.accountNumber, accountId: ctx.account.id, currentDetailType: ctx.account.detailType },
			},
		];
	}
	if (!isProp && memoLooksPropertyish) {
		return [
			{
				code: 'TRUST_505_705_LIKELY_MISROUTED',
				severity: 'warn',
				message: `Posted to 705 Non-Property Taxes but description "${ctx.memo}" looks like property tax. Consider 505 Property Taxes.`,
				metadata: { accountNumber: ctx.account.accountNumber, accountId: ctx.account.id, currentDetailType: ctx.account.detailType },
			},
		];
	}
	return [];
}
