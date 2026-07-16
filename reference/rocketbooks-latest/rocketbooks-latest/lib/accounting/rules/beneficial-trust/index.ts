import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	trustBeneficiaries,
	contacts,
	receiptMatchApplications,
} from '@/db/schema/schema';
import { getOrgFeature } from '../../get-org-feature';
import { isIncapacitatedAsOf } from '../../trust-reroute';
import { evaluateLineAccountEligibility } from './eligibility';
import { evaluateLineValidationGates, evaluateJournalEntryValidationGates } from './validation-gates';
import { evaluateLineAssetRules } from './asset-rules';
import { evaluateLineDeferredRules } from './deferred';
import type {
	TrustAccountSummary,
	TrustBeneficiarySummary,
	TrustContactSummary,
	TrustLineContext,
	TrustJournalEntryContext,
} from './context';
import type {
	TrustEvaluationInput,
	TrustEvaluationResult,
	TrustFinding,
} from './types';

export type { TrustEvaluationInput, TrustEvaluationResult, TrustFinding } from './types';
export type { TrustFindingCode, TrustFindingSeverity } from './types';

const EMPTY_RESULT: TrustEvaluationResult = {
	findings: [],
	blocked: false,
	blockMessage: null,
	memoSuffix: null,
};

const BANK_DETAIL_TYPES = new Set<string>([
	'checking',
	'savings',
	'cash_on_hand',
	'money_market',
	'trust_account',
	'rents_held_in_trust',
	'credit_card',
	'cd',
]);

// auto-create-bank-coa.ts builds detail slugs as `{base}_{last4}` (e.g.
// `checking_6084`) so two checking accounts in the same org don't collide
// on the UNIQUE(org, gaap_type, detail_type) constraint. Match the prefix
// so per-account bank slugs are still recognized as bank lines.
const BANK_DETAIL_TYPE_PREFIXES = ['checking_', 'savings_', 'money_market_', 'cd_', 'credit_card_'];

/**
 * Evaluate a pending journal-entry creation against the beneficial-trust
 * rule pack. Early-returns an empty result if the org doesn't have the
 * beneficial_trust feature enabled — safe to call on every createJournal
 * Entry invocation regardless of org type.
 *
 * Architecture: this is hooked inside `createJournalEntry` (lib/accounting/
 * posting.ts) so EVERY JE-creation path is covered automatically — the
 * standard auto-post flow, QBO promotion + mirror, receipt apply-match,
 * and any future path that lands on createJournalEntry. Per-site hooks
 * are not necessary.
 *
 * The caller (posting.ts → createJournalEntry) is responsible for:
 *   - Throwing a JournalEntryError when `blocked` is true
 *   - Appending `memoSuffix` to the JE memo when present so warnings are
 *     visible on the GL
 */
export async function evaluateBeneficialTrustJournalEntry(
	input: TrustEvaluationInput,
): Promise<TrustEvaluationResult> {
	const enabled = await getOrgFeature(input.organizationId, 'beneficial_trust');
	if (!enabled) return EMPTY_RESULT;

	const ctx = await loadAggregateContext(input);
	if (!ctx) return EMPTY_RESULT;

	const findings: TrustFinding[] = [];

	// Per-line rules: each line evaluated independently against its account.
	for (const line of input.lines) {
		const account = ctx.accountsById.get(line.accountId);
		if (!account) continue;
		const debit = Number(line.debit ?? 0);
		const credit = Number(line.credit ?? 0);
		const amount = debit + credit;
		if (amount <= 0) continue;

		const beneficiaryId = line.beneficiaryId ?? null;
		const linkedBeneficiary = beneficiaryId
			? ctx.beneficiaries.find((b) => b.id === beneficiaryId) ?? null
			: null;

		const lineCtx: TrustLineContext = {
			organizationId: input.organizationId,
			date: input.date,
			account,
			amount,
			debit,
			credit,
			contactId: line.contactId ?? null,
			contact: line.contactId ? ctx.contactsById.get(line.contactId) ?? null : null,
			memo: line.memo ?? input.memo ?? '',
			beneficiaries: ctx.beneficiaries,
			beneficiaryId,
			linkedBeneficiary,
		};

		findings.push(...(await evaluateLineAccountEligibility(lineCtx)));
		findings.push(...evaluateLineValidationGates(lineCtx));
		findings.push(...(await evaluateLineAssetRules(lineCtx)));
		findings.push(...evaluateLineDeferredRules(lineCtx));
	}

	// JE-level rules: things that depend on the whole entry, not a single
	// line. Currently the no-receipt-withdrawal gate (only fires for
	// transaction-sourced JEs).
	const jeCtx: TrustJournalEntryContext = {
		organizationId: input.organizationId,
		date: input.date,
		memo: input.memo ?? '',
		sourceType: input.sourceType,
		sourceId: input.sourceId,
		type: inferTransactionType(input.lines, ctx.accountsById),
		hasReceipt: ctx.hasReceipt,
	};
	findings.push(...evaluateJournalEntryValidationGates(jeCtx));

	return compileResult(dedupeFindings(findings));
}

interface AggregateContext {
	accountsById: Map<string, TrustAccountSummary>;
	beneficiaries: TrustBeneficiarySummary[];
	contactsById: Map<string, TrustContactSummary>;
	hasReceipt: boolean;
}

async function loadAggregateContext(input: TrustEvaluationInput): Promise<AggregateContext | null> {
	const accountIds = Array.from(new Set(input.lines.map((l) => l.accountId).filter(Boolean)));
	const contactIds = Array.from(
		new Set(input.lines.map((l) => l.contactId).filter((c): c is string => !!c)),
	);

	const [accountsRows, beneficiariesRows, contactsRows, receiptRows] = await Promise.all([
		accountIds.length > 0
			? db
					.select({
						id: chartOfAccounts.id,
						accountNumber: chartOfAccounts.accountNumber,
						accountName: chartOfAccounts.accountName,
						gaapType: chartOfAccounts.gaapType,
						accountType: chartOfAccounts.accountType,
						detailType: chartOfAccounts.detailType,
						systemGenerated: chartOfAccounts.systemGenerated,
					})
					.from(chartOfAccounts)
					.where(inArray(chartOfAccounts.id, accountIds))
			: Promise.resolve([] as TrustAccountSummary[]),
		db
			.select({
				id: trustBeneficiaries.id,
				fullName: trustBeneficiaries.fullName,
				dateOfBirth: trustBeneficiaries.dateOfBirth,
				isIncapacitated: trustBeneficiaries.isIncapacitated,
				incapacitatedSince: trustBeneficiaries.incapacitatedSince,
				notIncapacitatedSince: trustBeneficiaries.notIncapacitatedSince,
				legalGuardianContactId: trustBeneficiaries.legalGuardianContactId,
				demandNoteAccountId: trustBeneficiaries.demandNoteAccountId,
			})
			.from(trustBeneficiaries)
			.where(eq(trustBeneficiaries.organizationId, input.organizationId)),
		contactIds.length > 0
			? db
					.select({
						id: contacts.id,
						contactName: contacts.contactName,
						typeTags: contacts.typeTags,
					})
					.from(contacts)
					.where(inArray(contacts.id, contactIds))
			: Promise.resolve([] as Array<{ id: string; contactName: string; typeTags: unknown }>),
		input.sourceType === 'transaction' && input.sourceId
			? db
					.select({ id: receiptMatchApplications.id })
					.from(receiptMatchApplications)
					.where(
						and(
							eq(receiptMatchApplications.organizationId, input.organizationId),
							eq(receiptMatchApplications.transactionId, input.sourceId),
						),
					)
					.limit(1)
			: Promise.resolve([] as Array<{ id: string }>),
	]);

	return {
		accountsById: new Map(accountsRows.map((a) => [a.id, a])),
		beneficiaries: beneficiariesRows.map((b) => ({
			id: b.id,
			fullName: b.fullName,
			dateOfBirth: b.dateOfBirth,
			isIncapacitated: b.isIncapacitated,
			incapacitatedSince: b.incapacitatedSince,
			notIncapacitatedSince: b.notIncapacitatedSince,
			legalGuardianContactId: b.legalGuardianContactId,
			demandNoteAccountId: b.demandNoteAccountId,
			ageYears: ageYearsFromDob(b.dateOfBirth, input.date),
			incapacitatedAtJeDate: isIncapacitatedAsOf(b, input.date),
		})),
		contactsById: new Map(
			contactsRows.map((c) => [
				c.id,
				{
					id: c.id,
					contactName: c.contactName,
					typeTags: normalizeTypeTags(c.typeTags),
				},
			]),
		),
		hasReceipt: receiptRows.length > 0,
	};
}

/**
 * contacts.type_tags is `json default '[]'` — Drizzle types it as unknown.
 * Normalize to a string array, accepting both `["trustee", ...]` and the
 * defensive cases where the JSON is missing or holds non-string entries.
 */
function normalizeTypeTags(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter((t): t is string => typeof t === 'string');
}

function ageYearsFromDob(dob: string | null, asOfDate: string): number | null {
	if (!dob) return null;
	try {
		const birth = new Date(dob);
		const as = new Date(asOfDate);
		if (Number.isNaN(birth.getTime()) || Number.isNaN(as.getTime())) return null;
		let years = as.getUTCFullYear() - birth.getUTCFullYear();
		const m = as.getUTCMonth() - birth.getUTCMonth();
		if (m < 0 || (m === 0 && as.getUTCDate() < birth.getUTCDate())) years--;
		return years;
	} catch {
		return null;
	}
}

/**
 * Infer the "transaction type" (deposit vs withdrawal) from the line shape
 * — only meaningful for sourceType='transaction', which always has exactly
 * one bank-side line and one category-side line.
 */
function inferTransactionType(
	lines: TrustEvaluationInput['lines'],
	accountsById: Map<string, TrustAccountSummary>,
): 'deposit' | 'withdrawal' | null {
	if (lines.length !== 2) return null;
	const bankLine = lines.find((l) => {
		const a = accountsById.get(l.accountId);
		return !!a && isBankishAccount(a);
	});
	if (!bankLine) return null;
	if (Number(bankLine.debit ?? 0) > 0) return 'deposit';
	if (Number(bankLine.credit ?? 0) > 0) return 'withdrawal';
	return null;
}

function isBankishAccount(a: TrustAccountSummary): boolean {
	if (!a.detailType) return false;
	if (BANK_DETAIL_TYPES.has(a.detailType)) return true;
	return BANK_DETAIL_TYPE_PREFIXES.some((p) => a.detailType!.startsWith(p));
}

/**
 * Dedupe by (code + accountNumber metadata) — a JE-level finding that fires
 * once is fine; a per-line finding that fires twice for the same account is
 * usually a duplicate (e.g. multi-line entries that all post to the same
 * non-trust category). Different accounts producing the same code are kept.
 */
function dedupeFindings(findings: TrustFinding[]): TrustFinding[] {
	const seen = new Set<string>();
	const out: TrustFinding[] = [];
	for (const f of findings) {
		const acctNum = (f.metadata?.accountNumber as string | undefined) ?? '';
		const key = `${f.code}::${acctNum}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(f);
	}
	return out;
}

function compileResult(findings: TrustFinding[]): TrustEvaluationResult {
	const blocks = findings.filter((f) => f.severity === 'block');
	const warns = findings.filter((f) => f.severity === 'warn');
	const blockMessage = blocks.length > 0 ? blocks.map((b) => b.message).join(' · ') : null;
	const memoSuffix = warns.length > 0 ? warns.map((w) => w.message).join(' · ') : null;
	return {
		findings,
		blocked: blocks.length > 0,
		blockMessage,
		memoSuffix,
	};
}
