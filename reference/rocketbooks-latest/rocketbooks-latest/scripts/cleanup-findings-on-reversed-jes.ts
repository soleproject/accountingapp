/**
 * Delete trust-review findings attached to any JE that's one half of a
 * reversal pair — either the original (someone's counter references it
 * via reversal_of_id) or the counter itself. Those findings are noise:
 * the JE no longer represents a live posting, so the rule it triggered
 * doesn't actively apply.
 *
 * Pair-wise this is what `reverseJournalEntry` now does going forward.
 * This script catches up the historical bloat — without it, every
 * reverse+repost cycle a transaction went through before today still has
 * its findings lingering in the Dismissed tab (or in some cases still in
 * Open).
 *
 * Idempotent. Org-scoped or --all.
 *
 * Usage:
 *   $env:POSTGRES_URL = "..."
 *   npx tsx scripts/cleanup-findings-on-reversed-jes.ts --org <uuid>
 *   npx tsx scripts/cleanup-findings-on-reversed-jes.ts --all
 *   npx tsx scripts/cleanup-findings-on-reversed-jes.ts --org <uuid> --dry-run
 */

import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	journalEntries,
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
		console.error('Usage: cleanup-findings-on-reversed-jes.ts (--org <uuid> | --all) [--dry-run]');
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
): Promise<{ findingsDeleted: number; reversedJeCount: number; counterJeCount: number }> {
	console.log(`\n=== Org: ${org.name} (${org.id}) ===`);

	const counterJes = await db
		.select({ id: journalEntries.id, reversalOfId: journalEntries.reversalOfId })
		.from(journalEntries)
		.where(
			and(
				eq(journalEntries.organizationId, org.id),
				isNotNull(journalEntries.reversalOfId),
			),
		);

	const counterIds = counterJes.map((c) => c.id);
	const reversedOriginalIds = counterJes
		.map((c) => c.reversalOfId)
		.filter((v): v is string => !!v);
	const deadJeIds = Array.from(new Set([...counterIds, ...reversedOriginalIds]));

	console.log(`  Reversed-pair JEs: ${reversedOriginalIds.length} originals + ${counterIds.length} counters = ${deadJeIds.length} total`);

	if (deadJeIds.length === 0) {
		return { findingsDeleted: 0, reversedJeCount: 0, counterJeCount: 0 };
	}

	// Count first so the dry-run report is meaningful.
	const toDelete = await db
		.select({ id: trustReviewFindings.id })
		.from(trustReviewFindings)
		.where(
			and(
				eq(trustReviewFindings.organizationId, org.id),
				inArray(trustReviewFindings.journalEntryId, deadJeIds),
			),
		);

	if (!dryRun && toDelete.length > 0) {
		await db
			.delete(trustReviewFindings)
			.where(
				and(
					eq(trustReviewFindings.organizationId, org.id),
					inArray(
						trustReviewFindings.id,
						toDelete.map((r) => r.id),
					),
				),
			);
	}

	console.log(
		`  Findings ${dryRun ? 'WOULD delete' : 'deleted'}: ${toDelete.length}`,
	);
	void or; // keep import slot in case future versions need OR for ad-hoc conditions
	return {
		findingsDeleted: toDelete.length,
		reversedJeCount: reversedOriginalIds.length,
		counterJeCount: counterIds.length,
	};
}

async function main() {
	const args = parseArgs();
	console.log(`Reversed-JE findings cleanup: ${args.dryRun ? 'DRY RUN' : 'WRITE'}`);

	const orgs = await resolveOrgs(args);
	if (orgs.length === 0) {
		console.log('No trust-feature-enabled orgs found.');
		process.exit(0);
	}
	console.log(`Orgs to process: ${orgs.length}`);

	let totalFindings = 0;
	let totalReversed = 0;
	let totalCounters = 0;
	for (const o of orgs) {
		const r = await processOrg(o, args.dryRun);
		totalFindings += r.findingsDeleted;
		totalReversed += r.reversedJeCount;
		totalCounters += r.counterJeCount;
	}

	console.log(`\n=== Totals ===`);
	console.log(`  Reversed-pair JEs scanned: ${totalReversed} originals + ${totalCounters} counters`);
	console.log(`  Findings ${args.dryRun ? 'WOULD delete' : 'deleted'}: ${totalFindings}`);
	process.exit(0);
}

main().catch((err) => {
	console.error('CLEANUP ERROR:', err);
	process.exit(1);
});
