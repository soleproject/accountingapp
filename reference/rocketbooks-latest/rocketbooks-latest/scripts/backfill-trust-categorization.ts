/**
 * Backfill categorization + JE posting for trust orgs' uncategorized
 * transactions. Use after seeding trust PFC overrides on an existing
 * org so historical Plaid imports get retroactively categorized,
 * posted to the GL, and pass through the trust rules engine (which
 * populates the Trust Review queue with findings).
 *
 * Pipeline per uncategorized transaction:
 *   1. Look up PFC from plaid_raw_transactions (joined by reference).
 *   2. Run resolvePfcCoa → category account from trust PFC override
 *      (seeded by seedTrustPfcOverrides) or canonical slot lookup.
 *   3. Update transactions.categoryAccountId.
 *   4. Post JE via createJournalEntryFromTransaction (this fires the
 *      trust rules engine inside posting.ts → writes trust_review_findings).
 *
 * Idempotent: skips transactions that already have a categoryAccountId
 * AND a journal_entry_id. Safe to re-run after future syncs.
 *
 * The seedTrustPfcOverrides call at the top is also idempotent — running
 * the backfill ensures overrides are in place even for orgs onboarded
 * before the override wiring was added.
 *
 * Usage:
 *   $env:POSTGRES_URL = "..."
 *   npx tsx scripts/backfill-trust-categorization.ts --org <uuid>
 *   npx tsx scripts/backfill-trust-categorization.ts --all
 *   npx tsx scripts/backfill-trust-categorization.ts --org <uuid> --dry-run
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	transactions,
	plaidRawTransactions,
	organizations,
	organizationAccountingFeatures,
} from '@/db/schema/schema';
import { resolvePfcCoa } from '@/lib/accounting/resolve-pfc-coa';
import { createJournalEntryFromTransaction, type TransactionForPosting } from '@/lib/accounting/auto-post';
import { JournalEntryError } from '@/lib/accounting/posting';
import { seedTrustPfcOverrides } from '@/lib/accounting/beneficial-trust-pfc-overrides';
import { seedBeneficialTrustCoa } from '@/lib/accounting/seed-beneficial-trust-coa';

const PROGRESS_EVERY = 50;

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
		console.error('Usage: backfill-trust-categorization.ts (--org <uuid> | --all) [--dry-run]');
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

interface BackfillTotals {
	scanned: number;
	noPfc: number;
	noResolution: number;
	categorized: number;
	jePosted: number;
	jeFailed: number;
}

async function backfillOrg(
	org: { id: string; name: string },
	dryRun: boolean,
): Promise<BackfillTotals> {
	console.log(`\n=== Org: ${org.name} (${org.id}) ===`);

	// Re-seed the trust COA first — idempotent, adds any accounts the
	// template has gained since the org was originally seeded (e.g. the
	// 001 Transfer Clearing account). Existing rows are untouched.
	const coaResult = await seedBeneficialTrustCoa({ organizationId: org.id });
	console.log(`  COA re-seed: ${coaResult.inserted} inserted, ${coaResult.skipped} skipped`);

	// Now ensure PFC overrides are in place (idempotent). Always runs even
	// in dry-run because the overrides table is config-only with no GL
	// impact, and without it the resolver returns null for everything and
	// the dry-run report is meaningless.
	const seedResult = await seedTrustPfcOverrides({ organizationId: org.id });
	console.log(`  Override seeding: ${seedResult.inserted} inserted, ${seedResult.updated} updated, ${seedResult.skipped} skipped${dryRun ? ' (config only — safe in dry-run)' : ''}`);

	// Pull uncategorized transactions joined with their PFC. Reference is
	// stored with a "plaid:" prefix; regexp_replace strips it for the join.
	const rows = await db
		.select({
			txnId: transactions.id,
			date: transactions.date,
			type: transactions.type,
			amount: transactions.amount,
			accountId: transactions.accountId,
			contactId: transactions.contactId,
			bankDescription: transactions.bankDescription,
			userDescription: transactions.description,
			pfcDetailed: sql<
				string | null
			>`${plaidRawTransactions.rawJson} -> 'personal_finance_category' ->> 'detailed'`,
		})
		.from(transactions)
		.leftJoin(
			plaidRawTransactions,
			sql`${plaidRawTransactions.plaidTransactionId} = regexp_replace(${transactions.reference}, '^plaid:', '')`,
		)
		.where(
			and(
				eq(transactions.organizationId, org.id),
				isNull(transactions.categoryAccountId),
			),
		);

	console.log(`  Uncategorized transactions to scan: ${rows.length}`);

	const totals: BackfillTotals = {
		scanned: 0,
		noPfc: 0,
		noResolution: 0,
		categorized: 0,
		jePosted: 0,
		jeFailed: 0,
	};

	for (const r of rows) {
		totals.scanned++;

		if (!r.pfcDetailed) {
			totals.noPfc++;
			continue;
		}

		const resolved = await resolvePfcCoa({
			organizationId: org.id,
			pfcDetailed: r.pfcDetailed,
		});

		if (!resolved || !resolved.categoryAccountId) {
			totals.noResolution++;
			continue;
		}

		totals.categorized++;

		if (dryRun) {
			if (totals.scanned % PROGRESS_EVERY === 0) {
				console.log(`  ...scanned ${totals.scanned}/${rows.length} (would-categorize ${totals.categorized})`);
			}
			continue;
		}

		// Live mode: update the category, then post a JE. Must do these in
		// order — categoryAccountId is required for createJournalEntryFromTransaction.
		await db
			.update(transactions)
			.set({
				categoryAccountId: resolved.categoryAccountId,
				reviewed: resolved.reviewedByDefault,
			})
			.where(eq(transactions.id, r.txnId));

		// Skip JE posting for non-deposit/withdrawal rows (auto-post would reject).
		const ttype = (r.type ?? '').toLowerCase();
		if (ttype !== 'deposit' && ttype !== 'withdrawal') {
			if (totals.scanned % PROGRESS_EVERY === 0) {
				console.log(`  ...scanned ${totals.scanned}/${rows.length} (categorized ${totals.categorized}, je-posted ${totals.jePosted})`);
			}
			continue;
		}

		const txn: TransactionForPosting = {
			id: r.txnId,
			organizationId: org.id,
			date: r.date,
			type: ttype,
			amount: Math.abs(r.amount ?? 0),
			accountId: r.accountId ?? '',
			categoryAccountId: resolved.categoryAccountId,
			contactId: r.contactId,
			bankDescription: r.bankDescription,
			userDescription: r.userDescription,
		};

		try {
			const jeId = await createJournalEntryFromTransaction(txn);
			await db
				.update(transactions)
				.set({ journalEntryId: jeId })
				.where(eq(transactions.id, r.txnId));
			totals.jePosted++;
		} catch (err) {
			totals.jeFailed++;
			if (err instanceof JournalEntryError) {
				console.warn(`  JE failed for txn ${r.txnId}: ${err.message}`);
			} else {
				console.warn(`  JE errored for txn ${r.txnId}:`, err instanceof Error ? err.message : err);
			}
		}

		if (totals.scanned % PROGRESS_EVERY === 0) {
			console.log(`  ...scanned ${totals.scanned}/${rows.length} (categorized ${totals.categorized}, je-posted ${totals.jePosted})`);
		}
	}

	console.log(`  Scanned: ${totals.scanned}`);
	console.log(`  No PFC available: ${totals.noPfc}`);
	console.log(`  Resolver returned no category: ${totals.noResolution}`);
	console.log(`  ${dryRun ? 'WOULD categorize' : 'Categorized'}: ${totals.categorized}`);
	console.log(`  ${dryRun ? 'WOULD post JE' : 'JE posted'}: ${totals.jePosted}`);
	console.log(`  JE failed: ${totals.jeFailed}`);

	return totals;
}

async function main() {
	const args = parseArgs();
	console.log(`Categorization backfill: ${args.dryRun ? 'DRY RUN' : 'WRITE'}`);

	const orgs = await resolveOrgs(args);
	if (orgs.length === 0) {
		console.log('No trust-feature-enabled orgs found.');
		process.exit(0);
	}
	console.log(`Orgs to process: ${orgs.length}`);

	const totals: BackfillTotals = {
		scanned: 0,
		noPfc: 0,
		noResolution: 0,
		categorized: 0,
		jePosted: 0,
		jeFailed: 0,
	};
	for (const o of orgs) {
		const t = await backfillOrg(o, args.dryRun);
		totals.scanned += t.scanned;
		totals.noPfc += t.noPfc;
		totals.noResolution += t.noResolution;
		totals.categorized += t.categorized;
		totals.jePosted += t.jePosted;
		totals.jeFailed += t.jeFailed;
	}

	console.log(`\n=== Totals ===`);
	console.log(`  Orgs processed: ${orgs.length}`);
	console.log(`  Transactions scanned: ${totals.scanned}`);
	console.log(`  Missing PFC: ${totals.noPfc}`);
	console.log(`  No resolution: ${totals.noResolution}`);
	console.log(`  ${args.dryRun ? 'WOULD categorize' : 'Categorized'}: ${totals.categorized}`);
	console.log(`  ${args.dryRun ? 'WOULD post JE' : 'JE posted'}: ${totals.jePosted}`);
	console.log(`  JE failed: ${totals.jeFailed}`);

	process.exit(0);
}

main().catch((err) => {
	console.error('BACKFILL ERROR:', err);
	process.exit(1);
});
