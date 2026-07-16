/**
 * Backfill trust review findings for journal entries that were posted before
 * or during a window where the rules engine didn't fire (e.g. a Plaid bulk
 * sync that outran the dev server's module loading). Idempotent: skips any
 * JE that already has at least one finding row.
 *
 * The script does NOT modify JE memos (the `· [trust review needed]` marker
 * is a posting-time concern; rewriting historical memos would be misleading).
 * It only inserts new rows in `trust_review_findings`. The Trust Review queue
 * picks them up immediately.
 *
 * Block-severity findings (e.g. food/clothing posted with no qualifying
 * beneficiary) are surfaced too, so the user can see which historical JEs
 * violated rules that would have blocked them at posting time. Those JEs
 * stay on the books; the user can reverse them manually if needed.
 *
 * Usage:
 *   $env:POSTGRES_URL = "..."
 *   npx tsx scripts/backfill-trust-findings.ts --org <uuid>      # one org
 *   npx tsx scripts/backfill-trust-findings.ts --all             # every enabled trust org
 *   npx tsx scripts/backfill-trust-findings.ts --org <uuid> --dry-run
 *
 * Re-runnable: the (org, JE) idempotency check means re-running on the same
 * data is a no-op for already-flagged JEs.
 */

import { randomUUID } from 'crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	journalEntries,
	journalEntryLines,
	trustReviewFindings,
	organizationAccountingFeatures,
	organizations,
} from '@/db/schema/schema';
import { evaluateBeneficialTrustJournalEntry } from '@/lib/accounting/rules/beneficial-trust';

const PROGRESS_EVERY = 100;

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
		console.error('Usage: backfill-trust-findings.ts (--org <uuid> | --all) [--dry-run]');
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
	// --all: every org with beneficial_trust feature pack enabled.
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

async function backfillOrg(org: { id: string; name: string }, dryRun: boolean): Promise<{
	scanned: number;
	alreadyFlagged: number;
	newlyFlagged: number;
	findingsInserted: number;
	blockedSeen: number;
}> {
	console.log(`\n=== Org: ${org.name} (${org.id}) ===`);

	// Find every JE on this org that has zero findings yet. The NOT EXISTS
	// makes this idempotent: re-runs skip already-flagged JEs immediately.
	const jeRows = await db
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
				sql`NOT EXISTS (SELECT 1 FROM ${trustReviewFindings} f WHERE f.journal_entry_id = ${journalEntries.id})`,
			),
		);

	// Count of JEs that already have findings, for reporting.
	const [alreadyRow] = await db
		.select({
			n: sql<number>`count(distinct ${trustReviewFindings.journalEntryId})::int`,
		})
		.from(trustReviewFindings)
		.where(eq(trustReviewFindings.organizationId, org.id));
	const alreadyFlagged = alreadyRow?.n ?? 0;

	console.log(`  Unflagged JEs to scan: ${jeRows.length}`);
	console.log(`  Already-flagged JEs (skipped): ${alreadyFlagged}`);

	let newlyFlagged = 0;
	let findingsInserted = 0;
	let blockedSeen = 0;
	let scanned = 0;

	for (const je of jeRows) {
		scanned++;

		const lines = await db
			.select({
				accountId: journalEntryLines.accountId,
				debit: journalEntryLines.debit,
				credit: journalEntryLines.credit,
				contactId: journalEntryLines.contactId,
				memo: journalEntryLines.memo,
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
			})),
		});

		if (result.findings.length === 0) {
			if (scanned % PROGRESS_EVERY === 0) {
				console.log(`  ...scanned ${scanned}/${jeRows.length} (newlyFlagged ${newlyFlagged})`);
			}
			continue;
		}

		newlyFlagged++;
		findingsInserted += result.findings.length;
		if (result.blocked) blockedSeen++;

		if (!dryRun) {
			await db.insert(trustReviewFindings).values(
				result.findings.map((f) => ({
					id: randomUUID(),
					organizationId: org.id,
					journalEntryId: je.id,
					code: f.code,
					severity: f.severity,
					message: f.message,
					metadata: f.metadata ?? null,
				})),
			);
		}

		if (scanned % PROGRESS_EVERY === 0) {
			console.log(`  ...scanned ${scanned}/${jeRows.length} (newlyFlagged ${newlyFlagged})`);
		}
	}

	console.log(`  Scanned: ${scanned}`);
	console.log(`  Newly flagged JEs: ${newlyFlagged}`);
	console.log(`  Finding rows ${dryRun ? 'WOULD insert' : 'inserted'}: ${findingsInserted}`);
	console.log(`  JEs with at least one block-severity finding: ${blockedSeen}`);

	return { scanned, alreadyFlagged, newlyFlagged, findingsInserted, blockedSeen };
}

async function main() {
	const args = parseArgs();
	console.log(`Backfill mode: ${args.dryRun ? 'DRY RUN' : 'WRITE'}`);

	const orgs = await resolveOrgs(args);
	if (orgs.length === 0) {
		console.log('No trust-feature-enabled orgs found.');
		process.exit(0);
	}
	console.log(`Orgs to process: ${orgs.length}`);

	const totals = { scanned: 0, alreadyFlagged: 0, newlyFlagged: 0, findingsInserted: 0, blockedSeen: 0 };
	for (const o of orgs) {
		const r = await backfillOrg(o, args.dryRun);
		totals.scanned += r.scanned;
		totals.alreadyFlagged += r.alreadyFlagged;
		totals.newlyFlagged += r.newlyFlagged;
		totals.findingsInserted += r.findingsInserted;
		totals.blockedSeen += r.blockedSeen;
	}

	console.log(`\n=== Totals ===`);
	console.log(`  Orgs processed: ${orgs.length}`);
	console.log(`  JEs scanned: ${totals.scanned}`);
	console.log(`  JEs already had findings (skipped): ${totals.alreadyFlagged}`);
	console.log(`  JEs newly flagged: ${totals.newlyFlagged}`);
	console.log(`  Finding rows ${args.dryRun ? 'WOULD insert' : 'inserted'}: ${totals.findingsInserted}`);
	console.log(`  JEs that should have BLOCKED at posting time: ${totals.blockedSeen}`);
	if (totals.blockedSeen > 0 && !args.dryRun) {
		console.log(`\n  ⚠️  ${totals.blockedSeen} JEs violated block-severity rules. Review them in the Trust Review queue and reverse on the books if appropriate.`);
	}

	process.exit(0);
}

main().catch((err) => {
	console.error('BACKFILL ERROR:', err);
	process.exit(1);
});
