/**
 * Retroactive reroute for 710 (Meals & Entertainment) lines that were
 * tagged with a beneficiary BEFORE the per-row + bulk Beneficiary action
 * was upgraded to auto-reroute. Those lines stayed on 710 with just a
 * beneficiary_id set — the rule's "needs attribution" finding cleared,
 * but the GL didn't move the spend off the admin-expense account and the
 * demand-note balance never updated.
 *
 * For each JE with a beneficiary-tagged 710 line, this script:
 *   1. Reverses the existing JE via reverseJournalEntry
 *   2. Posts a new JE in its place:
 *        - 710 lines WITH a beneficiary tag → swap to 815 (qualifying)
 *          or that beneficiary's 26x demand note (non-qualifying)
 *        - 710 lines WITHOUT a beneficiary tag → carry over as-is
 *          (those are legitimate admin meals)
 *        - Every non-710 line → carry over as-is
 *   3. Re-points transactions.journalEntryId at the new JE
 *   4. Inserts a TRUST_710_REROUTED_TO_FOOD / _TO_DEMAND_NOTE finding
 *      on the new JE for each rerouted line
 *   5. Auto-dismisses any open TRUST_710_ATTRIBUTION_REQUIRED finding
 *      on the old JE with a note pointing at the new JE
 *
 * Idempotent at the JE level — after a successful run a JE's beneficiary-
 * tagged debits are on 815/26x, not 710, so a re-run finds nothing on
 * that JE. Per-org or --all. Dry-run shows the count + breakdown without
 * touching the GL.
 *
 * Usage:
 *   $env:POSTGRES_URL = "..."
 *   npx tsx scripts/backfill-710-bene-reroute.ts --org <uuid>
 *   npx tsx scripts/backfill-710-bene-reroute.ts --all
 *   npx tsx scripts/backfill-710-bene-reroute.ts --org <uuid> --dry-run
 */

import { randomUUID } from 'crypto';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	journalEntries,
	journalEntryLines,
	organizations,
	organizationAccountingFeatures,
	transactions,
	trustReviewFindings,
} from '@/db/schema/schema';
import { createJournalEntry, reverseJournalEntry } from '@/lib/accounting/posting';
import {
	resolveBeneficiary710Target,
	build710RerouteFinding,
} from '@/lib/accounting/trust-710-reroute';

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
		console.error('Usage: backfill-710-bene-reroute.ts (--org <uuid> | --all) [--dry-run]');
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
): Promise<{ jesProcessed: number; linesRerouted: number; failed: number }> {
	console.log(`\n=== Org: ${org.name} (${org.id}) ===`);

	// 1. Find the org's 710 account ids.
	const meAccts = await db
		.select({ id: chartOfAccounts.id, accountNumber: chartOfAccounts.accountNumber, accountName: chartOfAccounts.accountName })
		.from(chartOfAccounts)
		.where(
			and(
				eq(chartOfAccounts.organizationId, org.id),
				eq(chartOfAccounts.detailType, 'entertainment_meals'),
			),
		);
	if (meAccts.length === 0) {
		console.log('  No 710 account on this org — skipping.');
		return { jesProcessed: 0, linesRerouted: 0, failed: 0 };
	}
	const meAccountIds = meAccts.map((a) => a.id);
	const meAccountById = new Map(meAccts.map((a) => [a.id, a]));

	// 2. Find every JE that has a beneficiary-tagged 710 line. Two-step
	// (line filter → JE header) to avoid the ANY(array) marshaling pitfall.
	const candidateLineRows = await db
		.selectDistinct({ journalEntryId: journalEntryLines.journalEntryId })
		.from(journalEntryLines)
		.innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
		.where(
			and(
				eq(journalEntries.organizationId, org.id),
				inArray(journalEntryLines.accountId, meAccountIds),
				isNotNull(journalEntryLines.beneficiaryId),
			),
		);
	const candidateJeIds = candidateLineRows.map((r) => r.journalEntryId);
	console.log(`  Candidate JEs (have beneficiary-tagged 710 lines): ${candidateJeIds.length}`);
	if (candidateJeIds.length === 0) {
		return { jesProcessed: 0, linesRerouted: 0, failed: 0 };
	}

	let jesProcessed = 0;
	let linesRerouted = 0;
	let failed = 0;

	for (const jeId of candidateJeIds) {
		try {
			const result = await rerouteOneJe({
				orgId: org.id,
				jeId,
				meAccountIds: new Set(meAccountIds),
				meAccountById,
				dryRun,
			});
			if (result.rerouted > 0) {
				jesProcessed++;
				linesRerouted += result.rerouted;
			}
		} catch (err) {
			failed++;
			console.error(
				`  JE ${jeId.slice(0, 8)} failed:`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	console.log(
		`  JEs ${dryRun ? 'WOULD reroute' : 'rerouted'}: ${jesProcessed}; lines ${dryRun ? 'WOULD move' : 'moved'}: ${linesRerouted}${failed > 0 ? `; failed: ${failed}` : ''}`,
	);
	return { jesProcessed, linesRerouted, failed };
}

async function rerouteOneJe(args: {
	orgId: string;
	jeId: string;
	meAccountIds: Set<string>;
	meAccountById: Map<string, { id: string; accountNumber: string | null; accountName: string }>;
	dryRun: boolean;
}): Promise<{ rerouted: number }> {
	const [je] = await db
		.select({
			id: journalEntries.id,
			date: journalEntries.date,
			memo: journalEntries.memo,
			sourceType: journalEntries.sourceType,
			sourceId: journalEntries.sourceId,
		})
		.from(journalEntries)
		.where(eq(journalEntries.id, args.jeId))
		.limit(1);
	if (!je) return { rerouted: 0 };

	const lines = await db
		.select({
			accountId: journalEntryLines.accountId,
			debit: journalEntryLines.debit,
			credit: journalEntryLines.credit,
			contactId: journalEntryLines.contactId,
			memo: journalEntryLines.memo,
			beneficiaryId: journalEntryLines.beneficiaryId,
		})
		.from(journalEntryLines)
		.where(eq(journalEntryLines.journalEntryId, args.jeId));

	// Partition: 710 lines WITH a tag → reroute; everything else → keep.
	const taggedMeLines = lines.filter(
		(l) => args.meAccountIds.has(l.accountId) && !!l.beneficiaryId,
	);
	if (taggedMeLines.length === 0) return { rerouted: 0 };

	// Resolve each tagged line's target. If any beneficiary can't be
	// routed (no demand note, no 815 account, etc.) abort this JE so the
	// script doesn't half-migrate the GL.
	type RerouteSpec = {
		original: typeof taggedMeLines[number];
		target: NonNullable<Awaited<ReturnType<typeof resolveBeneficiary710Target>> extends { ok: true; target: infer T } ? T : never>;
	};
	const reroutes: RerouteSpec[] = [];
	for (const l of taggedMeLines) {
		const r = await resolveBeneficiary710Target({
			organizationId: args.orgId,
			beneficiaryId: l.beneficiaryId!,
			asOfDate: je.date,
		});
		if (!r.ok) {
			throw new Error(`couldn't resolve target for bene ${l.beneficiaryId}: ${r.error}`);
		}
		reroutes.push({ original: l, target: r.target });
	}

	const carryoverLines = lines.filter(
		(l) => !(args.meAccountIds.has(l.accountId) && !!l.beneficiaryId),
	);

	if (args.dryRun) {
		const breakdown = reroutes.reduce<Record<string, number>>((acc, r) => {
			const k = r.target.routedTo;
			acc[k] = (acc[k] ?? 0) + 1;
			return acc;
		}, {});
		console.log(
			`  JE ${args.jeId.slice(0, 8)} (${je.date}): ${reroutes.length} line(s) → ${JSON.stringify(breakdown)}`,
		);
		return { rerouted: reroutes.length };
	}

	await db.transaction(async (tx) => {
		await reverseJournalEntry(
			{
				organizationId: args.orgId,
				journalEntryId: je.id,
				reversalMemo: `Reversal — 710 retroactively rerouted to per-beneficiary targets`,
			},
			tx,
		);

		const newRerouteLines = reroutes.map(({ original, target }) => ({
			accountId: target.accountId,
			debit: Number(original.debit ?? 0),
			credit: Number(original.credit ?? 0),
			contactId: original.contactId,
			memo: original.memo,
			beneficiaryId: original.beneficiaryId,
		}));
		const carryoverPayload = carryoverLines.map((l) => ({
			accountId: l.accountId,
			debit: Number(l.debit ?? 0),
			credit: Number(l.credit ?? 0),
			contactId: l.contactId,
			memo: l.memo,
			beneficiaryId: l.beneficiaryId ?? null,
		}));

		const newJe = await createJournalEntry(
			{
				organizationId: args.orgId,
				date: je.date,
				memo: je.memo,
				posted: true,
				sourceType: je.sourceType,
				sourceId: je.sourceId,
				lines: [...newRerouteLines, ...carryoverPayload],
			},
			tx,
		);

		// Re-point the source transaction. Don't touch categoryAccountId
		// when multiple reroute lines exist — there's no single canonical
		// category. Single-reroute case sets it to the new target.
		if (je.sourceType === 'transaction' && je.sourceId) {
			const set: { journalEntryId: string; categoryAccountId?: string } = {
				journalEntryId: newJe.id,
			};
			if (reroutes.length === 1) {
				set.categoryAccountId = reroutes[0].target.accountId;
			}
			await tx
				.update(transactions)
				.set(set)
				.where(
					and(
						eq(transactions.id, je.sourceId),
						eq(transactions.organizationId, args.orgId),
					),
				);
		}

		// Insert one reroute finding per moved line on the new JE.
		const originalAcctId = reroutes[0].original.accountId;
		const originalAcct = args.meAccountById.get(originalAcctId);
		for (const r of reroutes) {
			const f = build710RerouteFinding({
				organizationId: args.orgId,
				journalEntryId: newJe.id,
				originalAccountId: originalAcctId,
				originalAccountNumber: originalAcct?.accountNumber ?? null,
				originalAccountName: originalAcct?.accountName ?? '710 Meals & Entertainment',
				target: r.target,
				amount: Number(r.original.debit ?? 0),
			});
			await tx.insert(trustReviewFindings).values({
				id: randomUUID(),
				...f,
			});
		}

		// Auto-dismiss any open attribution-required finding on the OLD JE
		// (the user already attributed via the tag; the reroute formalizes
		// it on the GL).
		await tx
			.update(trustReviewFindings)
			.set({
				dismissedAt: new Date().toISOString(),
				dismissedNote: `Auto-dismissed: 710 line(s) retroactively rerouted to per-beneficiary targets. See JE ${newJe.id.slice(0, 8)}.`,
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(trustReviewFindings.journalEntryId, je.id),
					eq(trustReviewFindings.code, 'TRUST_710_ATTRIBUTION_REQUIRED'),
				),
			);
	});

	return { rerouted: reroutes.length };
}

async function main() {
	const args = parseArgs();
	console.log(`710 retroactive reroute: ${args.dryRun ? 'DRY RUN' : 'WRITE'}`);

	const orgs = await resolveOrgs(args);
	if (orgs.length === 0) {
		console.log('No trust-feature-enabled orgs found.');
		process.exit(0);
	}
	console.log(`Orgs to process: ${orgs.length}`);

	let totalJEs = 0;
	let totalLines = 0;
	let totalFailed = 0;
	for (const o of orgs) {
		const r = await processOrg(o, args.dryRun);
		totalJEs += r.jesProcessed;
		totalLines += r.linesRerouted;
		totalFailed += r.failed;
	}

	console.log(`\n=== Totals ===`);
	console.log(`  JEs ${args.dryRun ? 'WOULD reroute' : 'rerouted'}: ${totalJEs}`);
	console.log(`  Lines ${args.dryRun ? 'WOULD move' : 'moved'}: ${totalLines}`);
	if (totalFailed > 0) console.log(`  JEs failed: ${totalFailed}`);
	process.exit(0);
}

main().catch((err) => {
	console.error('BACKFILL ERROR:', err);
	process.exit(1);
});
