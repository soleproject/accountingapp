import type { TrustLineContext } from './context';
import type { TrustFinding } from './types';

/**
 * Stubs for posting-shape rules that the spec requires but that need
 * additional product infrastructure before they can run. Each fires a
 * single warning so the operator knows the limitation is intentional
 * (rather than a silent gap in coverage).
 *
 * As the underlying infrastructure ships, move each case out of this
 * file into a real rule module (probably `posting-shape.ts`).
 *
 * What's needed for each:
 *
 *   TRUST_DEFERRED_LOAN_SPLIT_NEEDED → UI to populate the `loans` table
 *     and amortization schedule, plus a transaction → loan linkage so
 *     we know which schedule row this payment satisfies.
 *
 *   TRUST_DEFERRED_RENTAL_NET_NEEDED → UI to set
 *     journal_entry_lines.rental_property_id at categorization time, and
 *     a "compute net" step that posts only the net to 430 while keeping
 *     gross income and expenses in sub-ledger lines.
 *
 *   TRUST_DEFERRED_PERSONAL_USE_LEASE → UI to populate the
 *     `personal_use_lease_agreements` table per trustee/beneficiary; a
 *     cron / monthly job to post the $300-500 lease income to 440.
 */
export function evaluateLineDeferredRules(ctx: TrustLineContext): TrustFinding[] {
	const findings: TrustFinding[] = [];

	switch (ctx.account.detailType) {
		case 'notes_payable':
			findings.push({
				code: 'TRUST_DEFERRED_LOAN_SPLIT_NEEDED',
				severity: 'warn',
				message: `Loan payment posted to 250 Notes Payable without principal/interest split. Pick the loan + schedule row this payment satisfies and we'll repost as a proper 3-line P/I/bank JE.`,
				metadata: { accountNumber: ctx.account.accountNumber, accountId: ctx.account.id },
			});
			break;

		case 'trust_rental_income_net':
			findings.push({
				code: 'TRUST_DEFERRED_RENTAL_NET_NEEDED',
				severity: 'warn',
				message: `Rental income posted to 430. Link this line to a rental property so the per-property sub-ledger (gross rent − expenses) ties out — only the net amount should hit 430.`,
				metadata: { accountNumber: ctx.account.accountNumber, accountId: ctx.account.id },
			});
			break;

		case 'trust_personal_use_lease_income':
			findings.push({
				code: 'TRUST_DEFERRED_PERSONAL_USE_LEASE',
				severity: 'warn',
				message: `Trustee personal-use lease income (440) posted. Automatic monthly posting from personal_use_lease_agreements is not yet wired — confirm a written lease agreement exists and the monthly amount matches.`,
				metadata: { accountNumber: ctx.account.accountNumber },
			});
			break;
	}

	return findings;
}
