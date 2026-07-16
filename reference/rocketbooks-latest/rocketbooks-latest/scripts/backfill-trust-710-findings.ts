/**
 * Targeted backfill: re-evaluate every JE on the given org that has at least
 * one line on a 710 Meals & Entertainment account, and insert the
 * TRUST_710_ATTRIBUTION_REQUIRED finding when the rule fires.
 *
 * The general backfill script (backfill-trust-findings.ts) skips JEs that
 * already have ANY findings, which means a newly-added rule code doesn't
 * land on JEs already flagged for other rules. This targeted script is
 * idempotent at the (je, code) level — it'll only insert TRUST_710_
 * ATTRIBUTION_REQUIRED rows that aren't already there.
 *
 * Usage:
 *   $env:POSTGRES_URL = "..."
 *   npx tsx scripts/backfill-trust-710-findings.ts --org <uuid>
 *   npx tsx scripts/backfill-trust-710-findings.ts --all
 *   npx tsx scripts/backfill-trust-710-findings.ts --org <uuid> --dry-run
 */

import { randomUUID } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	journalEntries,
	journalEntryLines,
	organizations,
	organizationAccountingFeatures,
	trustReviewFindings,
} from '@/db/schema/schema';
import { evaluateBeneficialTrustJournalEntry } from '@/lib/accounting/rules/beneficial-trust';

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
		console.error('Usage: backfill-trust-710-findings.ts (--org <uuid> | --all) [--dry-run]');
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
): Promise<{ scanned: number; flagged: number }> {
	console.log(`\n=== Org: ${org.name} (${org.id}) ===`);

	// Resolve 710-account ids in this org. Use detail_type so renumbered orgs still match.
	const accts = await db
		.select({ id: chartOfAccounts.id, accountNumber: chartOfAccounts.accountNumber })
		.from(chartOfAccounts)
		.where(
			and(
				eq(chartOfAccounts.organizationId, org.id),
				eq(chartOfAccounts.detailType, 'entertainment_meals'),
			),
		);
	if (accts.length === 0) {
		console.log('  No 710 (entertainment_meals) accounts found — skipping.');
		return { scanned: 0, flagged: 0 };
	}
	const meAccountIds = accts.map((a) => a.id);
	console.log(`  M&E accounts: ${accts.map((a) => a.accountNumber).join(', ')}`);

	// Find every JE that has at least one line on one of those accounts.
	// Two-step (subquery for the line filter, outer join to header) avoids
	// raw ANY($arr) marshaling problems in mixed scalar/array contexts.
	const meJeIdRows = await db
		.selectDistinct({ id: journalEntryLines.journalEntryId })
		.from(journalEntryLines)
		.innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
		.where(
			and(
				eq(journalEntries.organizationId, org.id),
				inArray(journalEntryLines.accountId, meAccountIds),
			),
		);
	const meJeIds = meJeIdRows.map((r) => r.id);
	const jeRows = meJeIds.length === 0
		? []
		: await db
			.select({
				id: journalEntries.id,
				date: journalEntries.date,
				memo: journalEntries.memo,
				sourceType: journalEntries.sourceType,
				sourceId: journalEntries.sourceId,
			})
			.from(journalEntries)
			.where(
				and(
					eq(journalEntries.organizationId, org.id),
					inArray(journalEntries.id, meJeIds),
				),
			);
	console.log(`  JEs touching M&E: ${jeRows.length}`);

	let scanned = 0;
	let flagged = 0;

	for (const je of jeRows) {
		scanned++;

		// Idempotency: skip if this JE already has a TRUST_710_ATTRIBUTION_
		// REQUIRED finding (regardless of dismissed state).
		const [existing] = await db
			.select({ id: trustReviewFindings.id })
			.from(trustReviewFindings)
			.where(
				and(
					eq(trustReviewFindings.journalEntryId, je.id),
					eq(trustReviewFindings.code, 'TRUST_710_ATTRIBUTION_REQUIRED'),
				),
			)
			.limit(1);
		if (existing) continue;

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
			.where(eq(journalEntryLines.journalEntryId, je.id));

		const result = await evaluateBeneficialTrustJournalEntry({
			organizationId: org.id,
			date: je.date,
			memo: je.memo,
			sourceType: je.sourceType,
			sourceId: je.sourceId,
			lines: lines.map((l) => ({
				accountId: l.accountId,
				debit: Number(l.debit),
				credit: Number(l.credit),
				contactId: l.contactId,
				memo: l.memo,
				beneficiaryId: l.beneficiaryId ?? null,
			})),
		});

		const meFinding = result.findings.find(
			(f) => f.code === 'TRUST_710_ATTRIBUTION_REQUIRED',
		);
		if (!meFinding) continue;

		if (dryRun) {
			flagged++;
			continue;
		}

		await db.insert(trustReviewFindings).values({
			id: randomUUID(),
			organizationId: org.id,
			journalEntryId: je.id,
			code: meFinding.code,
			severity: meFinding.severity,
			message: meFinding.message,
			metadata: meFinding.metadata ?? null,
		});
		flagged++;
	}

	return { scanned, flagged };
}

async function main() {
	const args = parseArgs();
	console.log(`710 attribution backfill: ${args.dryRun ? 'DRY RUN' : 'WRITE'}`);

	const orgs = await resolveOrgs(args);
	if (orgs.length === 0) {
		console.log('No trust-feature-enabled orgs found.');
		process.exit(0);
	}
	console.log(`Orgs to process: ${orgs.length}`);

	let totalScanned = 0;
	let totalFlagged = 0;
	for (const o of orgs) {
		const r = await processOrg(o, args.dryRun);
		totalScanned += r.scanned;
		totalFlagged += r.flagged;
	}

	console.log(`\n=== Totals ===`);
	console.log(`  JEs scanned: ${totalScanned}`);
	console.log(`  Findings ${args.dryRun ? 'WOULD insert' : 'inserted'}: ${totalFlagged}`);

	process.exit(0);
}

main().catch((err) => {
	console.error('BACKFILL ERROR:', err);
	process.exit(1);
});
