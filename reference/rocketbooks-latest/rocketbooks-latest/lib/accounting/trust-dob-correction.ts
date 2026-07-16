import 'server-only';
import { randomUUID } from 'crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	journalEntries,
	journalEntryLines,
	transactions,
	trustBeneficiaries,
	trustReviewFindings,
} from '@/db/schema/schema';
import { repostTransactionJE, type TransactionForPosting } from './auto-post';
import { qualifiesAsOf, isIncapacitatedAsOf } from './trust-reroute';

const FOOD_OR_CLOTHING_DETAIL_TYPES = new Set<string>([
	'trust_food_minors_incapacitated',
	'trust_clothing_minors_incapacitated',
]);

const REROUTED_FINDING_CODES = new Set([
	'TRUST_815_REROUTED_TO_DEMAND_NOTE',
	'TRUST_820_REROUTED_TO_DEMAND_NOTE',
]);

export interface DobCorrectionItem {
	jeId: string;
	transactionId: string | null;
	jeDate: string;
	amount: number;
	fromAccountId: string;
	fromAccountNumber: string | null;
	fromAccountName: string;
	toAccountId: string;
	toAccountNumber: string | null;
	toAccountName: string;
	/** True iff the JE has sourceType='transaction' — those go through
	 *  repostTransactionJE. Non-transaction JEs (manual entries, etc.) are
	 *  surfaced in the diff but skipped by the auto-repost path. */
	canAutoRepost: boolean;
}

export interface DobCorrectionDiff {
	beneficiaryId: string;
	beneficiaryName: string;
	oldDob: string | null;
	newDob: string;
	/** 815/820 → 26x: was qualifying with old DOB, isn't with new. */
	rerouteOut: DobCorrectionItem[];
	/** 26x → 815/820: was rerouted because didn't qualify, now does. Only
	 *  includes JEs with a TRUST_815/820_REROUTED_TO_DEMAND_NOTE finding,
	 *  so we don't accidentally re-classify deliberate non-qualifying
	 *  advances. */
	rerouteIn: DobCorrectionItem[];
	/** JEs the rules would now flag differently but that we can't auto-
	 *  repost (manual journal entries with no source transaction).
	 *  Caller should surface as "fix manually". */
	manualReview: DobCorrectionItem[];
}

/**
 * Compute the side effects of changing a beneficiary's DOB without
 * applying anything. Walks every JE on this org tagged with the
 * beneficiary that touches 815/820/26x, simulates the qualifying check
 * with the new DOB, and groups the resulting differences.
 *
 * The 26x → 815 direction (rerouteIn) is intentionally narrow: only
 * 26x lines whose JE has a TRUST_815/820_REROUTED_TO_DEMAND_NOTE
 * finding are eligible. A "naked" 26x post may have been a deliberate
 * non-qualifying advance the user wanted; we don't touch those.
 */
export async function previewDobCorrection(args: {
	organizationId: string;
	beneficiaryId: string;
	newDob: string;
}): Promise<DobCorrectionDiff> {
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
	if (!bene) throw new Error('Beneficiary not found');

	const empty: DobCorrectionDiff = {
		beneficiaryId: bene.id,
		beneficiaryName: bene.fullName,
		oldDob: bene.dateOfBirth,
		newDob: args.newDob,
		rerouteOut: [],
		rerouteIn: [],
		manualReview: [],
	};

	// Load every JE line tagged with this beneficiary, joined with account
	// + JE header + source-transaction (where applicable).
	const lines = await db
		.select({
			lineId: journalEntryLines.id,
			journalEntryId: journalEntryLines.journalEntryId,
			accountId: journalEntryLines.accountId,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
			detailType: chartOfAccounts.detailType,
			debit: journalEntryLines.debit,
			credit: journalEntryLines.credit,
			jeDate: journalEntries.date,
			jeSourceType: journalEntries.sourceType,
			jeSourceId: journalEntries.sourceId,
		})
		.from(journalEntryLines)
		.innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
		.innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalEntryLines.accountId))
		.where(
			and(
				eq(journalEntries.organizationId, args.organizationId),
				eq(journalEntryLines.beneficiaryId, args.beneficiaryId),
			),
		);
	if (lines.length === 0) return empty;

	// Pull rerouted findings keyed by JE id — needed to know which 26x
	// lines were originally 815/820 and which 815/820 account to route
	// them back to.
	const jeIds = Array.from(new Set(lines.map((l) => l.journalEntryId)));
	const findings = await db
		.select({
			journalEntryId: trustReviewFindings.journalEntryId,
			code: trustReviewFindings.code,
			metadata: trustReviewFindings.metadata,
		})
		.from(trustReviewFindings)
		.where(
			and(
				eq(trustReviewFindings.organizationId, args.organizationId),
				inArray(trustReviewFindings.journalEntryId, jeIds),
				inArray(trustReviewFindings.code, Array.from(REROUTED_FINDING_CODES)),
			),
		);
	const rerouteFindingByJe = new Map(findings.map((f) => [f.journalEntryId, f]));

	// For the rerouteIn direction we need to verify the original
	// "fromAccountId" still exists in the org's CoA (the spec accounts
	// stay around once seeded, but defensive). Build a lookup of org
	// accounts by id we'll need.
	const possibleAccountIds = Array.from(
		new Set(
			findings
				.map((f) => (f.metadata as { fromAccountId?: string } | null)?.fromAccountId ?? '')
				.filter(Boolean),
		),
	);
	const accountById = new Map<
		string,
		{ id: string; accountNumber: string | null; accountName: string }
	>();
	if (possibleAccountIds.length > 0) {
		const rows = await db
			.select({
				id: chartOfAccounts.id,
				accountNumber: chartOfAccounts.accountNumber,
				accountName: chartOfAccounts.accountName,
			})
			.from(chartOfAccounts)
			.where(
				and(
					eq(chartOfAccounts.organizationId, args.organizationId),
					inArray(chartOfAccounts.id, possibleAccountIds),
				),
			);
		for (const r of rows) accountById.set(r.id, r);
	}

	// Demand-note account for the destination of rerouteOut items.
	let demandNoteAcct: { id: string; accountNumber: string | null; accountName: string } | null = null;
	if (bene.demandNoteAccountId) {
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
		if (dn) demandNoteAcct = dn;
	}

	// Simulated beneficiary at the new DOB — same incapacitation history,
	// new DOB. Used by qualifiesAsOf per-JE date.
	const simulated = {
		dateOfBirth: args.newDob,
		incapacitatedSince: bene.incapacitatedSince,
		notIncapacitatedSince: bene.notIncapacitatedSince,
	};

	const rerouteOut: DobCorrectionItem[] = [];
	const rerouteIn: DobCorrectionItem[] = [];
	const manualReview: DobCorrectionItem[] = [];

	for (const l of lines) {
		if (!l.detailType) continue;
		const amount = Number(l.debit) > 0 ? Number(l.debit) : Number(l.credit);
		const onFoodOrClothing = FOOD_OR_CLOTHING_DETAIL_TYPES.has(l.detailType);
		const onDemandNote = l.detailType.startsWith('trust_beneficiary_demand_note__');

		const qualifiesNow = qualifiesAsOf(simulated, l.jeDate);

		if (onFoodOrClothing) {
			// Direction 1: was on 815/820; if simulated DOB makes them non-
			// qualifying, this JE should reroute to the beneficiary's demand
			// note.
			if (!qualifiesNow && demandNoteAcct) {
				const item: DobCorrectionItem = {
					jeId: l.journalEntryId,
					transactionId: l.jeSourceType === 'transaction' ? l.jeSourceId : null,
					jeDate: l.jeDate,
					amount,
					fromAccountId: l.accountId,
					fromAccountNumber: l.accountNumber,
					fromAccountName: l.accountName,
					toAccountId: demandNoteAcct.id,
					toAccountNumber: demandNoteAcct.accountNumber,
					toAccountName: demandNoteAcct.accountName,
					canAutoRepost: l.jeSourceType === 'transaction' && !!l.jeSourceId,
				};
				if (item.canAutoRepost) rerouteOut.push(item);
				else manualReview.push(item);
			}
			continue;
		}

		if (onDemandNote) {
			// Direction 2: only consider 26x lines whose JE has a REROUTED
			// finding pointing at an 815/820 source. If qualifying now, the
			// post should go back to that original account.
			if (!qualifiesNow) continue;
			const f = rerouteFindingByJe.get(l.journalEntryId);
			if (!f) continue;
			const meta = (f.metadata ?? {}) as {
				fromAccountId?: string;
				fromAccountNumber?: string;
			};
			if (!meta.fromAccountId) continue;
			const original = accountById.get(meta.fromAccountId);
			if (!original) continue;
			const item: DobCorrectionItem = {
				jeId: l.journalEntryId,
				transactionId: l.jeSourceType === 'transaction' ? l.jeSourceId : null,
				jeDate: l.jeDate,
				amount,
				fromAccountId: l.accountId,
				fromAccountNumber: l.accountNumber,
				fromAccountName: l.accountName,
				toAccountId: original.id,
				toAccountNumber: original.accountNumber,
				toAccountName: original.accountName,
				canAutoRepost: l.jeSourceType === 'transaction' && !!l.jeSourceId,
			};
			if (item.canAutoRepost) rerouteIn.push(item);
			else manualReview.push(item);
		}
	}

	return {
		beneficiaryId: bene.id,
		beneficiaryName: bene.fullName,
		oldDob: bene.dateOfBirth,
		newDob: args.newDob,
		rerouteOut,
		rerouteIn,
		manualReview,
	};
}


/**
 * Repost a pre-computed batch of DOB-correction items. Used by the
 * Inngest worker that runs DOB corrections in the background — the
 * caller has already taken a snapshot of `items` (the diff at queue
 * time) so the work can be sliced across many steps without re-running
 * the preview between batches.
 *
 * Does NOT write the new DOB — that's the worker's responsibility
 * (so it happens once at the start of the run, not once per batch).
 * Items that aren't auto-repostable are returned as failures so the
 * caller can tally them; we don't throw mid-batch.
 */
export async function repostDobCorrectionItems(args: {
	organizationId: string;
	beneficiaryId: string;
	items: DobCorrectionItem[];
}): Promise<{ reposted: number; failed: Array<{ jeId: string; error: string }> }> {
	const failed: Array<{ jeId: string; error: string }> = [];
	let reposted = 0;
	for (const item of args.items) {
		if (!item.canAutoRepost) {
			failed.push({ jeId: item.jeId, error: 'not auto-repostable (manual JE)' });
			continue;
		}
		try {
			await repostOneItem({
				orgId: args.organizationId,
				item,
				beneficiaryId: args.beneficiaryId,
			});
			reposted += 1;
		} catch (err) {
			failed.push({
				jeId: item.jeId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return { reposted, failed };
}

async function repostOneItem(args: {
	orgId: string;
	item: DobCorrectionItem;
	beneficiaryId: string;
}): Promise<void> {
	if (!args.item.transactionId) {
		throw new Error('manual JE — skip');
	}

	// Pull the live transaction so we can rebuild TransactionForPosting
	// with the corrected categoryAccountId.
	const [txn] = await db
		.select()
		.from(transactions)
		.where(
			and(
				eq(transactions.id, args.item.transactionId),
				eq(transactions.organizationId, args.orgId),
			),
		)
		.limit(1);
	if (!txn) throw new Error('transaction not found');
	if (!txn.journalEntryId) throw new Error('transaction has no JE');
	if (!txn.type) throw new Error('transaction has no type');
	if (!txn.accountId) throw new Error('transaction has no bank account');
	if (txn.amount == null) throw new Error('transaction has no amount');

	const txnForPosting: TransactionForPosting = {
		id: txn.id,
		organizationId: args.orgId,
		date: txn.date,
		type: txn.type,
		amount: txn.amount,
		accountId: txn.accountId,
		categoryAccountId: args.item.toAccountId,
		contactId: txn.contactId ?? null,
		bankDescription: txn.bankDescription,
		userDescription: txn.userDescription,
		beneficiaryId: args.beneficiaryId,
	};

	const r = await repostTransactionJE({
		txn: txnForPosting,
		existingJournalEntryId: txn.journalEntryId,
	});

	// Keep transactions.categoryAccountId in sync — repostTransactionJE
	// only touches journalEntryId.
	await db
		.update(transactions)
		.set({ categoryAccountId: args.item.toAccountId })
		.where(eq(transactions.id, txn.id));

	const newJeId = r.replacementId;
	if (!newJeId) return;

	// Findings cleanup tied to the NEW JE (the reverser JE doesn't get
	// findings — it's just the GL counter-entry).
	const fromIsFoodOrClothing = args.item.fromAccountNumber === '815'
		|| args.item.fromAccountNumber === '820';
	const toIsFoodOrClothing = args.item.toAccountNumber === '815'
		|| args.item.toAccountNumber === '820';

	if (fromIsFoodOrClothing) {
		// rerouteOut: was 815/820 → now 26x. Insert a REROUTED finding on the
		// new JE so the audit trail captures "originally 815".
		const isFood = args.item.fromAccountNumber === '815';
		await db.insert(trustReviewFindings).values({
			id: randomUUID(),
			organizationId: args.orgId,
			journalEntryId: newJeId,
			code: isFood
				? 'TRUST_815_REROUTED_TO_DEMAND_NOTE'
				: 'TRUST_820_REROUTED_TO_DEMAND_NOTE',
			severity: 'warn',
			message: `Reposted to ${args.item.toAccountNumber ?? ''} ${args.item.toAccountName} after a beneficiary DOB correction — the original ${args.item.fromAccountNumber ?? ''} ${args.item.fromAccountName} post is no longer qualifying at this JE date.`,
			metadata: {
				accountNumber: args.item.toAccountNumber,
				fromAccountId: args.item.fromAccountId,
				fromAccountNumber: args.item.fromAccountNumber,
				toAccountId: args.item.toAccountId,
				toAccountNumber: args.item.toAccountNumber,
				beneficiaryId: args.beneficiaryId,
				reason: 'dob_correction',
			},
		});
	} else if (toIsFoodOrClothing) {
		// rerouteIn: was 26x → now 815/820. The old REROUTED finding is no
		// longer accurate. It lived on the OLD JE (which is now reversed);
		// the new JE is on 815/820 so the rule engine won't emit a fresh
		// REROUTED finding on its own. Nothing to insert. The historical
		// finding stays on the reversed JE for the audit trail.
	}

	// Suppress the unused-import warning when isNull/sql go unused in
	// branches that don't touch them.
	void isNull;
	void sql;
}
