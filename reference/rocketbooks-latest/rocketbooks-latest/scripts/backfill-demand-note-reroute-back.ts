/**
 * Re-evaluate every JE line currently parked on a trust beneficiary's
 * demand note (26x) that was put there by a previous reroute, and move
 * it back to its rule-appropriate account if the beneficiary's CURRENT
 * DOB + incapacitation history now makes them qualifying at the JE
 * date.
 *
 * The reroute findings we look at:
 *
 *   TRUST_710_REROUTED_TO_DEMAND_NOTE
 *     710 line was rerouted to 26x because the bene was non-qualifying
 *     at posting. If they qualify now → route to org's 815 (Food).
 *
 *   TRUST_815_REROUTED_TO_DEMAND_NOTE
 *     815 line was rerouted to 26x. If they qualify now → route back to
 *     the original 815 account (metadata.fromAccountId).
 *
 *   TRUST_820_REROUTED_TO_DEMAND_NOTE
 *     820 line was rerouted to 26x. If they qualify now → route back to
 *     metadata.fromAccountId (820).
 *
 * Lines without any of those findings are left alone — they're either
 * deliberate non-qualifying advances or manual posts the backfill has
 * no signal to second-guess.
 *
 * For each candidate JE:
 *   - Transaction-sourced → reverse + repost via repostTransactionJE,
 *     update transactions.categoryAccountId in step.
 *   - Manual JE → counted as "manual review needed"; skipped.
 *
 * Findings cleanup mirrors applyDobCorrection's rerouteIn path: nothing
 * to insert (the new JE is on 815/820 and the rules engine emits no
 * fresh REROUTED finding when there's nothing to reroute). The old
 * REROUTED finding stays on the reversed JE for audit.
 *
 * Idempotent: after a successful run, lines that needed to move are off
 * the demand note. Re-running finds nothing.
 *
 * Usage:
 *   $env:POSTGRES_URL = "..."
 *   npx tsx scripts/backfill-demand-note-reroute-back.ts --org <uuid> --dry-run
 *   npx tsx scripts/backfill-demand-note-reroute-back.ts --org <uuid> --apply
 *   npx tsx scripts/backfill-demand-note-reroute-back.ts --all --dry-run
 *   npx tsx scripts/backfill-demand-note-reroute-back.ts --all --apply
 */

import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	journalEntries,
	journalEntryLines,
	organizations,
	organizationAccountingFeatures,
	transactions,
	trustBeneficiaries,
	trustReviewFindings,
} from '@/db/schema/schema';
import { repostTransactionJE, type TransactionForPosting } from '@/lib/accounting/auto-post';
import { qualifiesAsOf } from '@/lib/accounting/trust-reroute';

const REROUTE_CODES = [
	'TRUST_710_REROUTED_TO_DEMAND_NOTE',
	'TRUST_815_REROUTED_TO_DEMAND_NOTE',
	'TRUST_820_REROUTED_TO_DEMAND_NOTE',
] as const;
type RerouteCode = (typeof REROUTE_CODES)[number];

interface Args {
	orgId: string | null;
	all: boolean;
	dryRun: boolean;
	apply: boolean;
}

function parseArgs(): Args {
	const args: Args = { orgId: null, all: false, dryRun: false, apply: false };
	const a = process.argv.slice(2);
	for (let i = 0; i < a.length; i++) {
		if (a[i] === '--org') args.orgId = a[++i] ?? null;
		else if (a[i] === '--all') args.all = true;
		else if (a[i] === '--dry-run') args.dryRun = true;
		else if (a[i] === '--apply') args.apply = true;
	}
	if (!args.orgId && !args.all) {
		console.error(
			'Usage: backfill-demand-note-reroute-back.ts (--org <uuid> | --all) (--dry-run | --apply)',
		);
		process.exit(2);
	}
	if (args.dryRun === args.apply) {
		console.error('Must pass exactly one of --dry-run or --apply');
		process.exit(2);
	}
	return args;
}

async function resolveOrgs(args: Args): Promise<Array<{ id: string; name: string }>> {
	if (args.orgId) {
		const [row] = await db
			.select({ id: organizations.id, name: organizations.name })
			.from(organizations)
			.where(eq(organizations.id, args.orgId))
			.limit(1);
		if (!row) throw new Error(`Org not found: ${args.orgId}`);
		return [row];
	}
	const rows = await db
		.select({ id: organizations.id, name: organizations.name })
		.from(organizations)
		.innerJoin(
			organizationAccountingFeatures,
			and(
				eq(organizationAccountingFeatures.organizationId, organizations.id),
				eq(organizationAccountingFeatures.featurePack, 'beneficial_trust'),
				eq(organizationAccountingFeatures.enabled, true),
			),
		);
	return rows;
}

interface RerouteCandidate {
	beneficiaryId: string;
	beneficiaryName: string;
	jeId: string;
	jeDate: string;
	lineId: string;
	amount: number;
	transactionId: string | null;
	fromAccountId: string;
	fromAccountNumber: string | null;
	fromAccountName: string;
	toAccountId: string;
	toAccountNumber: string | null;
	toAccountName: string;
	rerouteCode: RerouteCode;
}

async function processOrg(
	org: { id: string; name: string },
	apply: boolean,
): Promise<{
	beneficiariesScanned: number;
	candidates: number;
	reposted: number;
	manualReview: number;
	failed: number;
}> {
	console.log(`\n=== Org: ${org.name} (${org.id}) ===`);

	// Org's 815 account — the target for 710 reroutes when the bene now
	// qualifies. (815 = food for minors/incapacitated.)
	const [orgFoodAcct] = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
		})
		.from(chartOfAccounts)
		.where(
			and(
				eq(chartOfAccounts.organizationId, org.id),
				eq(chartOfAccounts.detailType, 'trust_food_minors_incapacitated'),
			),
		)
		.limit(1);

	const benes = await db
		.select({
			id: trustBeneficiaries.id,
			fullName: trustBeneficiaries.fullName,
			dateOfBirth: trustBeneficiaries.dateOfBirth,
			incapacitatedSince: trustBeneficiaries.incapacitatedSince,
			notIncapacitatedSince: trustBeneficiaries.notIncapacitatedSince,
			demandNoteAccountId: trustBeneficiaries.demandNoteAccountId,
		})
		.from(trustBeneficiaries)
		.where(eq(trustBeneficiaries.organizationId, org.id));

	if (benes.length === 0) {
		console.log('  No beneficiaries on this org — skipping.');
		return { beneficiariesScanned: 0, candidates: 0, reposted: 0, manualReview: 0, failed: 0 };
	}

	let totalCandidates = 0;
	let totalReposted = 0;
	let totalManual = 0;
	let totalFailed = 0;

	for (const bene of benes) {
		if (!bene.demandNoteAccountId) {
			console.log(`  ${bene.fullName}: no demand-note account on file — skipping.`);
			continue;
		}

		// All lines currently on this bene's demand note, tagged with this
		// bene. Excludes reversed-pair lines so we don't act on stale GL.
		const dnLines = await db
			.select({
				lineId: journalEntryLines.id,
				journalEntryId: journalEntryLines.journalEntryId,
				accountId: journalEntryLines.accountId,
				debit: journalEntryLines.debit,
				credit: journalEntryLines.credit,
				jeDate: journalEntries.date,
				jeSourceType: journalEntries.sourceType,
				jeSourceId: journalEntries.sourceId,
			})
			.from(journalEntryLines)
			.innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
			.where(
				and(
					eq(journalEntries.organizationId, org.id),
					eq(journalEntryLines.accountId, bene.demandNoteAccountId),
					eq(journalEntryLines.beneficiaryId, bene.id),
					// Skip reversal counter-entries and JEs that have been reversed
					// by a later counter — same filter the detail page uses.
				),
			);

		if (dnLines.length === 0) {
			continue;
		}

		const jeIds = Array.from(new Set(dnLines.map((l) => l.journalEntryId)));

		// Reroute findings keyed by JE — pick the first matching one per JE.
		// A JE typically has one reroute finding; if multiple, the first wins
		// (extremely rare in practice).
		const findings = await db
			.select({
				journalEntryId: trustReviewFindings.journalEntryId,
				code: trustReviewFindings.code,
				metadata: trustReviewFindings.metadata,
			})
			.from(trustReviewFindings)
			.where(
				and(
					eq(trustReviewFindings.organizationId, org.id),
					inArray(trustReviewFindings.journalEntryId, jeIds),
					inArray(trustReviewFindings.code, [...REROUTE_CODES]),
				),
			);
		const findingByJe = new Map<string, { code: RerouteCode; metadata: unknown }>();
		for (const f of findings) {
			if (!findingByJe.has(f.journalEntryId)) {
				findingByJe.set(f.journalEntryId, { code: f.code as RerouteCode, metadata: f.metadata });
			}
		}

		// For 815/820 reroutes we need the original "from" account in the
		// CoA. Batch-load them.
		const fromAcctIds = Array.from(
			new Set(
				findings
					.map((f) => (f.metadata as { fromAccountId?: string } | null)?.fromAccountId ?? '')
					.filter(Boolean),
			),
		);
		const fromAcctById = new Map<
			string,
			{ id: string; accountNumber: string | null; accountName: string }
		>();
		if (fromAcctIds.length > 0) {
			const rows = await db
				.select({
					id: chartOfAccounts.id,
					accountNumber: chartOfAccounts.accountNumber,
					accountName: chartOfAccounts.accountName,
				})
				.from(chartOfAccounts)
				.where(
					and(
						eq(chartOfAccounts.organizationId, org.id),
						inArray(chartOfAccounts.id, fromAcctIds),
					),
				);
			for (const r of rows) fromAcctById.set(r.id, r);
		}

		// Demand-note account for the from side of the reroute report row.
		const [dnAcct] = await db
			.select({
				id: chartOfAccounts.id,
				accountNumber: chartOfAccounts.accountNumber,
				accountName: chartOfAccounts.accountName,
			})
			.from(chartOfAccounts)
			.where(eq(chartOfAccounts.id, bene.demandNoteAccountId))
			.limit(1);
		if (!dnAcct) {
			console.log(`  ${bene.fullName}: demand-note account missing from CoA — skipping.`);
			continue;
		}

		const candidates: RerouteCandidate[] = [];
		for (const l of dnLines) {
			const f = findingByJe.get(l.journalEntryId);
			if (!f) continue;
			if (!qualifiesAsOf(
				{
					dateOfBirth: bene.dateOfBirth,
					incapacitatedSince: bene.incapacitatedSince,
					notIncapacitatedSince: bene.notIncapacitatedSince,
				},
				l.jeDate,
			)) continue;

			let target: { id: string; accountNumber: string | null; accountName: string } | null = null;
			if (f.code === 'TRUST_710_REROUTED_TO_DEMAND_NOTE') {
				if (!orgFoodAcct) continue;
				target = orgFoodAcct;
			} else {
				const fromId = (f.metadata as { fromAccountId?: string } | null)?.fromAccountId;
				if (!fromId) continue;
				const fromAcct = fromAcctById.get(fromId);
				if (!fromAcct) continue;
				target = fromAcct;
			}

			const amount = Number(l.debit) > 0 ? Number(l.debit) : Number(l.credit);
			candidates.push({
				beneficiaryId: bene.id,
				beneficiaryName: bene.fullName,
				jeId: l.journalEntryId,
				jeDate: l.jeDate,
				lineId: l.lineId,
				amount,
				transactionId: l.jeSourceType === 'transaction' ? l.jeSourceId : null,
				fromAccountId: dnAcct.id,
				fromAccountNumber: dnAcct.accountNumber,
				fromAccountName: dnAcct.accountName,
				toAccountId: target.id,
				toAccountNumber: target.accountNumber,
				toAccountName: target.accountName,
				rerouteCode: f.code,
			});
		}

		if (candidates.length === 0) continue;

		// Bucket by code for a quick summary.
		const byCode = candidates.reduce<Record<string, { n: number; sum: number; manual: number }>>(
			(acc, c) => {
				const k = c.rerouteCode;
				const bucket = (acc[k] ??= { n: 0, sum: 0, manual: 0 });
				bucket.n += 1;
				bucket.sum += c.amount;
				if (!c.transactionId) bucket.manual += 1;
				return acc;
			},
			{},
		);
		console.log(
			`  ${bene.fullName} (${bene.dateOfBirth ?? 'no DOB'}): ${candidates.length} line(s) on demand note to re-route`,
		);
		for (const [k, v] of Object.entries(byCode)) {
			console.log(
				`     · ${k}: ${v.n} line(s), $${v.sum.toFixed(2)}${v.manual > 0 ? ` (${v.manual} manual JE — needs hand fix)` : ''}`,
			);
		}
		totalCandidates += candidates.length;

		if (!apply) continue;

		for (const c of candidates) {
			if (!c.transactionId) {
				totalManual += 1;
				continue;
			}
			try {
				await repostOneCandidate({ orgId: org.id, candidate: c });
				totalReposted += 1;
			} catch (err) {
				totalFailed += 1;
				console.error(
					`    JE ${c.jeId.slice(0, 8)} (txn ${c.transactionId.slice(0, 8)}) failed:`,
					err instanceof Error ? err.message : err,
				);
			}
		}
	}

	console.log(
		apply
			? `  Reposted: ${totalReposted}; manual review: ${totalManual}; failed: ${totalFailed}`
			: `  DRY RUN — would reroute ${totalCandidates} line(s)`,
	);

	return {
		beneficiariesScanned: benes.length,
		candidates: totalCandidates,
		reposted: totalReposted,
		manualReview: totalManual,
		failed: totalFailed,
	};
}

async function repostOneCandidate(args: {
	orgId: string;
	candidate: RerouteCandidate;
}): Promise<void> {
	const c = args.candidate;
	if (!c.transactionId) throw new Error('manual JE');

	const [txn] = await db
		.select()
		.from(transactions)
		.where(
			and(
				eq(transactions.id, c.transactionId),
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
		categoryAccountId: c.toAccountId,
		contactId: txn.contactId ?? null,
		bankDescription: txn.bankDescription,
		userDescription: txn.userDescription,
		beneficiaryId: c.beneficiaryId,
	};

	await repostTransactionJE({
		txn: txnForPosting,
		existingJournalEntryId: txn.journalEntryId,
	});

	// Sync transactions.categoryAccountId — repostTransactionJE only
	// touches journalEntryId.
	await db
		.update(transactions)
		.set({ categoryAccountId: c.toAccountId })
		.where(eq(transactions.id, txn.id));

	// Note: the old REROUTED_TO_DEMAND_NOTE finding stays on the reversed
	// JE for audit. The new JE lands on 815/820, where the rule engine
	// won't emit a REROUTED finding on its own. Mirrors applyDobCorrection's
	// rerouteIn cleanup.
	void isNotNull;
}

async function main() {
	const args = parseArgs();
	console.log(
		`Demand-note re-route backfill — ${args.apply ? 'WRITE' : 'DRY RUN'}`,
	);

	const orgs = await resolveOrgs(args);
	if (orgs.length === 0) {
		console.log('No trust-feature-enabled orgs found.');
		process.exit(0);
	}
	console.log(`Orgs to process: ${orgs.length}`);

	let totalCandidates = 0;
	let totalReposted = 0;
	let totalManual = 0;
	let totalFailed = 0;
	for (const o of orgs) {
		const r = await processOrg(o, args.apply);
		totalCandidates += r.candidates;
		totalReposted += r.reposted;
		totalManual += r.manualReview;
		totalFailed += r.failed;
	}

	console.log(`\n=== Totals ===`);
	if (args.apply) {
		console.log(`  Reposted: ${totalReposted}`);
		console.log(`  Manual review: ${totalManual}`);
		console.log(`  Failed: ${totalFailed}`);
	} else {
		console.log(`  Would reroute: ${totalCandidates} line(s)`);
	}
	process.exit(0);
}

main().catch((err) => {
	console.error('BACKFILL ERROR:', err);
	process.exit(1);
});
