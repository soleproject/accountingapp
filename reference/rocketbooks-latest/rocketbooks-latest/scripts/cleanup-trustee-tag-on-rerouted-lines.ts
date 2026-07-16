/**
 * Strip the trustee contact off JE lines that landed on a reroute target
 * (815 / 26x demand note) but still carry a `trustee`-tagged contact —
 * an artifact of bouncing a 710 from trustee-attribution back into a
 * beneficiary reroute. The trustee tag belongs to admin meals on 710,
 * not to demand-note advances; without this cleanup the Decisioned
 * rerouted-to-demand-note group misleadingly shows "Trustee" as the
 * contact instead of the transaction's actual vendor.
 *
 * For each affected line:
 *   - If the JE's source is a transaction, set contactId to the
 *     transaction's vendor contactId (typically the original Plaid
 *     vendor).
 *   - Otherwise (manual JE), set contactId to NULL.
 *
 * Skips lines on 710 accounts — a trustee contact on a 710 line is
 * intentional (admin-meal attribution). Idempotent.
 *
 * Usage:
 *   $env:POSTGRES_URL = "..."
 *   npx tsx scripts/cleanup-trustee-tag-on-rerouted-lines.ts --org <uuid>
 *   npx tsx scripts/cleanup-trustee-tag-on-rerouted-lines.ts --all
 *   npx tsx scripts/cleanup-trustee-tag-on-rerouted-lines.ts --org <uuid> --dry-run
 */

import { and, eq, inArray, isNotNull, ne, notInArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	contacts,
	journalEntries,
	journalEntryLines,
	organizations,
	organizationAccountingFeatures,
	transactions,
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
		console.error('Usage: cleanup-trustee-tag-on-rerouted-lines.ts (--org <uuid> | --all) [--dry-run]');
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
): Promise<{ linesUpdated: number; linesSetToNull: number }> {
	console.log(`\n=== Org: ${org.name} (${org.id}) ===`);

	// 1. Org's 710 accounts (we'll EXCLUDE these — trustee on 710 is legit).
	const meAccts = await db
		.select({ id: chartOfAccounts.id })
		.from(chartOfAccounts)
		.where(
			and(
				eq(chartOfAccounts.organizationId, org.id),
				eq(chartOfAccounts.detailType, 'entertainment_meals'),
			),
		);
	const meAccountIds = meAccts.map((a) => a.id);

	// 2. Trustee contact ids.
	const trusteeRows = await db
		.select({ id: contacts.id })
		.from(contacts)
		.where(
			and(
				eq(contacts.organizationId, org.id),
				sql`${contacts.typeTags}::jsonb ? 'trustee'`,
			),
		);
	if (trusteeRows.length === 0) {
		console.log('  No trustee contacts on this org — skipping.');
		return { linesUpdated: 0, linesSetToNull: 0 };
	}
	const trusteeIds = trusteeRows.map((t) => t.id);

	// 3. Affected lines: non-710 account, trustee contact, on a live
	//    (non-reversed-pair) JE.
	const baseConditions = [
		eq(journalEntries.organizationId, org.id),
		isNotNull(journalEntryLines.contactId),
		inArray(journalEntryLines.contactId, trusteeIds),
		sql`${journalEntries.reversalOfId} IS NULL`,
		sql`NOT EXISTS (SELECT 1 FROM journal_entries cnt WHERE cnt.reversal_of_id = ${journalEntries.id})`,
	];
	if (meAccountIds.length > 0) {
		baseConditions.push(notInArray(journalEntryLines.accountId, meAccountIds));
	}

	const affectedLines = await db
		.select({
			id: journalEntryLines.id,
			journalEntryId: journalEntryLines.journalEntryId,
			accountId: journalEntryLines.accountId,
			contactId: journalEntryLines.contactId,
			jeSourceType: journalEntries.sourceType,
			jeSourceId: journalEntries.sourceId,
		})
		.from(journalEntryLines)
		.innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
		.where(and(...baseConditions));

	console.log(`  Affected lines (non-710 with trustee contact): ${affectedLines.length}`);
	if (affectedLines.length === 0) {
		return { linesUpdated: 0, linesSetToNull: 0 };
	}

	// 4. Batch-load the transactions for any transaction-sourced JEs.
	const txnIds = Array.from(
		new Set(
			affectedLines
				.filter((l) => l.jeSourceType === 'transaction' && !!l.jeSourceId)
				.map((l) => l.jeSourceId as string),
		),
	);
	const txnRows = txnIds.length > 0
		? await db
				.select({ id: transactions.id, contactId: transactions.contactId })
				.from(transactions)
				.where(
					and(
						eq(transactions.organizationId, org.id),
						inArray(transactions.id, txnIds),
					),
				)
		: [];
	const vendorByTxnId = new Map(txnRows.map((t) => [t.id, t.contactId ?? null]));

	let linesUpdated = 0;
	let linesSetToNull = 0;

	for (const line of affectedLines) {
		const isTxn = line.jeSourceType === 'transaction' && !!line.jeSourceId;
		const newContact = isTxn ? vendorByTxnId.get(line.jeSourceId as string) ?? null : null;
		if (newContact === line.contactId) continue; // no-op (vendor IS the trustee?)
		if (!dryRun) {
			await db
				.update(journalEntryLines)
				.set({ contactId: newContact })
				.where(eq(journalEntryLines.id, line.id));
		}
		if (newContact === null) linesSetToNull++;
		else linesUpdated++;
	}

	console.log(
		`  Lines ${dryRun ? 'WOULD restore vendor' : 'restored to vendor'}: ${linesUpdated}` +
			` (set to NULL — manual JE: ${linesSetToNull})`,
	);
	void ne; // keep import slot
	return { linesUpdated, linesSetToNull };
}

async function main() {
	const args = parseArgs();
	console.log(`Trustee-tag-on-rerouted-line cleanup: ${args.dryRun ? 'DRY RUN' : 'WRITE'}`);

	const orgs = await resolveOrgs(args);
	if (orgs.length === 0) {
		console.log('No trust-feature-enabled orgs found.');
		process.exit(0);
	}
	console.log(`Orgs to process: ${orgs.length}`);

	let totalUpdated = 0;
	let totalNullified = 0;
	for (const o of orgs) {
		const r = await processOrg(o, args.dryRun);
		totalUpdated += r.linesUpdated;
		totalNullified += r.linesSetToNull;
	}

	console.log(`\n=== Totals ===`);
	console.log(`  Lines ${args.dryRun ? 'WOULD restore vendor' : 'restored to vendor'}: ${totalUpdated}`);
	console.log(`  Lines ${args.dryRun ? 'WOULD set' : 'set'} to NULL (manual JE): ${totalNullified}`);
	process.exit(0);
}

main().catch((err) => {
	console.error('CLEANUP ERROR:', err);
	process.exit(1);
});
