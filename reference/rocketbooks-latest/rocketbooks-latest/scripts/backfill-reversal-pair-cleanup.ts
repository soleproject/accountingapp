/**
 * One-shot cleanup for the two reversal-pair bugs in the trust reroute
 * flow:
 *
 *   1. reverseJournalEntry historically dropped beneficiaryId on counter
 *      lines, so per-beneficiary views (e.g. /trust-beneficiaries/<id>)
 *      saw the original debit but never the credit that cancelled it.
 *      This script copies beneficiaryId from each original line onto the
 *      matching counter line.
 *
 *   2. The reroute actions only dismissed the triggering finding on
 *      reversal, leaving other open findings (notably
 *      TRUST_NO_RECEIPT_POSSIBLE_DISTRIBUTION) hanging on JEs that no
 *      longer represent live postings. This script dismisses every still-
 *      open finding on JEs that have been reversed by a later counter.
 *
 * Idempotent: re-runs only touch counter lines that still have a NULL
 * beneficiaryId where their pair has one set, and findings that are still
 * open on already-reversed JEs.
 *
 * Pair matching is by (counterJE, accountId, debit↔credit swap). When
 * multiple original lines on the same account match a counter, the script
 * skips that line with a warning rather than guessing.
 *
 * Usage:
 *   $env:POSTGRES_URL = "..."
 *   npx tsx scripts/backfill-reversal-pair-cleanup.ts --org <uuid>
 *   npx tsx scripts/backfill-reversal-pair-cleanup.ts --all
 *   npx tsx scripts/backfill-reversal-pair-cleanup.ts --org <uuid> --dry-run
 */

import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	journalEntries,
	journalEntryLines,
	organizations,
	organizationAccountingFeatures,
	trustReviewFindings,
} from '@/db/schema/schema';

interface Args {
	orgId: string | null;
	all: boolean;
	dryRun: boolean;
}

function parseArgs(): Args {
	const args: Args = { orgId: null, all: false, dryRun: false };
	const a = process.argv.slice(2);
	for (let i = 0; i < a.length; i++) {
		if (a[i] === '--org') args.orgId = a[++i] ?? null;
		else if (a[i] === '--all') args.all = true;
		else if (a[i] === '--dry-run') args.dryRun = true;
	}
	if (!args.orgId && !args.all) {
		console.error('Usage: backfill-reversal-pair-cleanup.ts (--org <uuid> | --all) [--dry-run]');
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

async function processOrg(
	org: { id: string; name: string },
	dryRun: boolean,
): Promise<{
	linesUpdated: number;
	linesSkippedAmbiguous: number;
	linesAlreadySet: number;
	findingsDismissed: number;
}> {
	console.log(`\n=== Org: ${org.name} (${org.id}) ===`);

	// 1. Counter JEs (reversal_of_id IS NOT NULL) for this org.
	const counterJes = await db
		.select({
			id: journalEntries.id,
			reversalOfId: journalEntries.reversalOfId,
		})
		.from(journalEntries)
		.where(
			and(
				eq(journalEntries.organizationId, org.id),
				isNotNull(journalEntries.reversalOfId),
			),
		);
	console.log(`  Counter JEs found: ${counterJes.length}`);

	let linesUpdated = 0;
	let linesSkippedAmbiguous = 0;
	let linesAlreadySet = 0;

	if (counterJes.length > 0) {
		const counterIds = counterJes.map((c) => c.id);
		const originalIds = counterJes
			.map((c) => c.reversalOfId)
			.filter((v): v is string => !!v);

		// All lines on both sides of every pair, in one shot.
		const allLines = await db
			.select({
				id: journalEntryLines.id,
				journalEntryId: journalEntryLines.journalEntryId,
				accountId: journalEntryLines.accountId,
				debit: journalEntryLines.debit,
				credit: journalEntryLines.credit,
				beneficiaryId: journalEntryLines.beneficiaryId,
			})
			.from(journalEntryLines)
			.where(inArray(journalEntryLines.journalEntryId, [...counterIds, ...originalIds]));

		const linesByJe = new Map<string, typeof allLines>();
		for (const l of allLines) {
			const arr = linesByJe.get(l.journalEntryId) ?? [];
			arr.push(l);
			linesByJe.set(l.journalEntryId, arr);
		}

		for (const counter of counterJes) {
			if (!counter.reversalOfId) continue;
			const counterLines = linesByJe.get(counter.id) ?? [];
			const origLines = linesByJe.get(counter.reversalOfId) ?? [];
			if (counterLines.length === 0 || origLines.length === 0) continue;

			for (const cl of counterLines) {
				if (cl.beneficiaryId !== null) {
					linesAlreadySet++;
					continue;
				}
				// Match: same accountId, debit↔credit swap.
				const cDebit = Number(cl.debit ?? 0);
				const cCredit = Number(cl.credit ?? 0);
				const candidates = origLines.filter((ol) => {
					if (ol.accountId !== cl.accountId) return false;
					const oDebit = Number(ol.debit ?? 0);
					const oCredit = Number(ol.credit ?? 0);
					return oDebit === cCredit && oCredit === cDebit;
				});
				if (candidates.length === 0) continue;
				if (candidates.length > 1) {
					// Disambiguate by picking the first candidate that still has
					// a beneficiaryId — keeps a deterministic choice on splits
					// where multiple lines on the same account net to the same
					// amount.
					const withBene = candidates.filter((c) => c.beneficiaryId !== null);
					if (withBene.length !== 1) {
						linesSkippedAmbiguous++;
						console.warn(
							`  Counter JE ${counter.id.slice(0, 8)} line on acct ${cl.accountId.slice(0, 8)}: ${candidates.length} matching originals, ${withBene.length} with bene — skipping`,
						);
						continue;
					}
					if (!dryRun) {
						await db
							.update(journalEntryLines)
							.set({ beneficiaryId: withBene[0].beneficiaryId })
							.where(eq(journalEntryLines.id, cl.id));
					}
					linesUpdated++;
					continue;
				}
				const match = candidates[0];
				if (match.beneficiaryId === null) continue; // nothing to copy
				if (!dryRun) {
					await db
						.update(journalEntryLines)
						.set({ beneficiaryId: match.beneficiaryId })
						.where(eq(journalEntryLines.id, cl.id));
				}
				linesUpdated++;
			}
		}
	}

	// 2. Findings still open on JEs that have been reversed. The relevant
	//    JEs are the originals — the IDs that some counter points at.
	const reversedOriginalIds = counterJes
		.map((c) => c.reversalOfId)
		.filter((v): v is string => !!v);

	let findingsDismissed = 0;
	if (reversedOriginalIds.length > 0) {
		const orphaned = await db
			.select({ id: trustReviewFindings.id, journalEntryId: trustReviewFindings.journalEntryId })
			.from(trustReviewFindings)
			.where(
				and(
					eq(trustReviewFindings.organizationId, org.id),
					inArray(trustReviewFindings.journalEntryId, reversedOriginalIds),
					isNull(trustReviewFindings.dismissedAt),
				),
			);
		if (!dryRun && orphaned.length > 0) {
			await db
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedNote: `Auto-dismissed: backfill cleanup — JE was reversed by a later counter entry.`,
					updatedAt: new Date().toISOString(),
				})
				.where(
					and(
						eq(trustReviewFindings.organizationId, org.id),
						inArray(
							trustReviewFindings.id,
							orphaned.map((o) => o.id),
						),
					),
				);
		}
		findingsDismissed = orphaned.length;
	}

	console.log(
		`  Counter lines ${dryRun ? 'WOULD update' : 'updated'}: ${linesUpdated}` +
			` (already set: ${linesAlreadySet}, ambiguous skipped: ${linesSkippedAmbiguous})`,
	);
	console.log(
		`  Orphan findings ${dryRun ? 'WOULD dismiss' : 'dismissed'}: ${findingsDismissed}`,
	);
	void sql; // silence unused-import when sql isn't reached on small orgs
	return { linesUpdated, linesSkippedAmbiguous, linesAlreadySet, findingsDismissed };
}

async function main() {
	const args = parseArgs();
	console.log(`Reversal-pair cleanup: ${args.dryRun ? 'DRY RUN' : 'WRITE'}`);

	const orgs = await resolveOrgs(args);
	if (orgs.length === 0) {
		console.log('No trust-feature-enabled orgs found.');
		process.exit(0);
	}
	console.log(`Orgs to process: ${orgs.length}`);

	let totalLines = 0;
	let totalAlready = 0;
	let totalAmbiguous = 0;
	let totalFindings = 0;
	for (const o of orgs) {
		const r = await processOrg(o, args.dryRun);
		totalLines += r.linesUpdated;
		totalAlready += r.linesAlreadySet;
		totalAmbiguous += r.linesSkippedAmbiguous;
		totalFindings += r.findingsDismissed;
	}

	console.log(`\n=== Totals ===`);
	console.log(`  Counter lines ${args.dryRun ? 'WOULD update' : 'updated'}: ${totalLines}`);
	console.log(`  Counter lines already had beneficiaryId: ${totalAlready}`);
	if (totalAmbiguous > 0) console.log(`  Skipped (ambiguous pair match): ${totalAmbiguous}`);
	console.log(`  Orphan findings ${args.dryRun ? 'WOULD dismiss' : 'dismissed'}: ${totalFindings}`);
	process.exit(0);
}

main().catch((err) => {
	console.error('CLEANUP ERROR:', err);
	process.exit(1);
});
