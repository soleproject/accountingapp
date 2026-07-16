/**
 * Retroactive audit findings for 710 (Meals & Entertainment) lines that
 * already have a trustee contact attached but predate the
 * TRUST_710_ATTRIBUTED_TO_TRUSTEE audit-trail finding. Without this
 * backfill, JEs that were trustee-attributed before that finding existed
 * are correctly posted on the GL but invisible in the Decisioned tab.
 *
 * For each JE with at least one 710 line whose contact has 'trustee' in
 * typeTags AND no existing TRUST_710_ATTRIBUTED_TO_TRUSTEE finding, the
 * script inserts one audit finding describing the attribution (single or
 * split, with trustee names).
 *
 * Pure audit insert — does NOT touch the GL or any other findings.
 * Idempotent: re-runs find the same JEs and skip them because the audit
 * already exists.
 *
 * Usage:
 *   $env:POSTGRES_URL = "..."
 *   npx tsx scripts/backfill-710-trustee-attribution.ts --org <uuid>
 *   npx tsx scripts/backfill-710-trustee-attribution.ts --all
 *   npx tsx scripts/backfill-710-trustee-attribution.ts --org <uuid> --dry-run
 */

import { randomUUID } from 'crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	contacts,
	journalEntries,
	journalEntryLines,
	organizations,
	organizationAccountingFeatures,
	trustReviewFindings,
} from '@/db/schema/schema';
import { build710TrusteeAttributionFinding } from '@/lib/accounting/trust-710-reroute';

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
		console.error('Usage: backfill-710-trustee-attribution.ts (--org <uuid> | --all) [--dry-run]');
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
): Promise<{ jesInserted: number; jesSkipped: number; failed: number }> {
	console.log(`\n=== Org: ${org.name} (${org.id}) ===`);

	// 1. Org's 710 accounts (detail type 'entertainment_meals').
	const meAccts = await db
		.select({
			id: chartOfAccounts.id,
			accountNumber: chartOfAccounts.accountNumber,
			accountName: chartOfAccounts.accountName,
		})
		.from(chartOfAccounts)
		.where(
			and(
				eq(chartOfAccounts.organizationId, org.id),
				eq(chartOfAccounts.detailType, 'entertainment_meals'),
			),
		);
	if (meAccts.length === 0) {
		console.log('  No 710 account on this org — skipping.');
		return { jesInserted: 0, jesSkipped: 0, failed: 0 };
	}
	const meAccountIds = meAccts.map((a) => a.id);
	const meAccountById = new Map(meAccts.map((a) => [a.id, a]));

	// 2. Trustee contact ids. Cast to jsonb so the ? operator applies —
	//    contacts.type_tags is `json` (not jsonb) per the schema drift note.
	const trusteeRows = await db
		.select({ id: contacts.id, contactName: contacts.contactName })
		.from(contacts)
		.where(
			and(
				eq(contacts.organizationId, org.id),
				sql`${contacts.typeTags}::jsonb ? 'trustee'`,
			),
		);
	if (trusteeRows.length === 0) {
		console.log('  No trustee-tagged contacts on this org — skipping.');
		return { jesInserted: 0, jesSkipped: 0, failed: 0 };
	}
	const trusteeIds = trusteeRows.map((t) => t.id);
	const trusteeNameById = new Map(trusteeRows.map((t) => [t.id, t.contactName]));

	// 3. Candidate JEs: have at least one 710 line whose contact is a
	//    trustee. Two-step (line filter → JE id) for the same array-marshaling
	//    reason as backfill-710-bene-reroute.ts.
	const candidateLineRows = await db
		.selectDistinct({ journalEntryId: journalEntryLines.journalEntryId })
		.from(journalEntryLines)
		.innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
		.where(
			and(
				eq(journalEntries.organizationId, org.id),
				inArray(journalEntryLines.accountId, meAccountIds),
				inArray(journalEntryLines.contactId, trusteeIds),
			),
		);
	const candidateJeIds = candidateLineRows.map((r) => r.journalEntryId);
	console.log(`  Candidate JEs (have trustee-tagged 710 lines): ${candidateJeIds.length}`);
	if (candidateJeIds.length === 0) {
		return { jesInserted: 0, jesSkipped: 0, failed: 0 };
	}

	// 4. Skip JEs that already have the audit finding (idempotency).
	const existing = await db
		.selectDistinct({ journalEntryId: trustReviewFindings.journalEntryId })
		.from(trustReviewFindings)
		.where(
			and(
				eq(trustReviewFindings.organizationId, org.id),
				inArray(trustReviewFindings.journalEntryId, candidateJeIds),
				eq(trustReviewFindings.code, 'TRUST_710_ATTRIBUTED_TO_TRUSTEE'),
			),
		);
	const alreadyHas = new Set(existing.map((r) => r.journalEntryId));
	const toProcess = candidateJeIds.filter((id) => !alreadyHas.has(id));
	console.log(
		`  Already have audit finding: ${alreadyHas.size}; need backfill: ${toProcess.length}`,
	);

	let jesInserted = 0;
	let failed = 0;

	for (const jeId of toProcess) {
		try {
			const inserted = await backfillOneJe({
				orgId: org.id,
				jeId,
				meAccountIds: new Set(meAccountIds),
				meAccountById,
				trusteeNameById,
				dryRun,
			});
			if (inserted) jesInserted++;
		} catch (err) {
			failed++;
			console.error(
				`  JE ${jeId.slice(0, 8)} failed:`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	console.log(
		`  JEs ${dryRun ? 'WOULD insert audit for' : 'inserted audit on'}: ${jesInserted}${failed > 0 ? `; failed: ${failed}` : ''}`,
	);
	return { jesInserted, jesSkipped: alreadyHas.size, failed };
}

async function backfillOneJe(args: {
	orgId: string;
	jeId: string;
	meAccountIds: Set<string>;
	meAccountById: Map<string, { id: string; accountNumber: string | null; accountName: string }>;
	trusteeNameById: Map<string, string>;
	dryRun: boolean;
}): Promise<boolean> {
	const lines = await db
		.select({
			accountId: journalEntryLines.accountId,
			debit: journalEntryLines.debit,
			contactId: journalEntryLines.contactId,
		})
		.from(journalEntryLines)
		.where(eq(journalEntryLines.journalEntryId, args.jeId));

	const trusteeMeLines = lines.filter(
		(l) =>
			args.meAccountIds.has(l.accountId)
			&& l.contactId !== null
			&& args.trusteeNameById.has(l.contactId),
	);
	if (trusteeMeLines.length === 0) return false;

	const totalDebit = trusteeMeLines.reduce((acc, l) => acc + Number(l.debit ?? 0), 0);
	const trusteeNames = Array.from(
		new Set(trusteeMeLines.map((l) => args.trusteeNameById.get(l.contactId!) ?? 'trustee')),
	);
	const trusteeLabel = trusteeNames.join(', ');
	const trusteeCount = trusteeNames.length;

	const acctRow = args.meAccountById.get(trusteeMeLines[0].accountId);
	if (!acctRow) return false;

	if (args.dryRun) {
		console.log(
			`  JE ${args.jeId.slice(0, 8)}: ${trusteeMeLines.length} trustee-tagged 710 line(s), $${totalDebit.toFixed(2)} → ${trusteeCount > 1 ? `split across ${trusteeCount}: ${trusteeLabel}` : trusteeLabel}`,
		);
		return true;
	}

	await db.insert(trustReviewFindings).values({
		id: randomUUID(),
		...build710TrusteeAttributionFinding({
			organizationId: args.orgId,
			journalEntryId: args.jeId,
			accountId: acctRow.id,
			accountNumber: acctRow.accountNumber,
			accountName: acctRow.accountName,
			trusteeLabel,
			trusteeCount,
			amount: totalDebit,
		}),
	});

	return true;
}

async function main() {
	const args = parseArgs();
	console.log(`710 trustee-attribution backfill: ${args.dryRun ? 'DRY RUN' : 'WRITE'}`);

	const orgs = await resolveOrgs(args);
	if (orgs.length === 0) {
		console.log('No trust-feature-enabled orgs found.');
		process.exit(0);
	}
	console.log(`Orgs to process: ${orgs.length}`);

	let totalInserted = 0;
	let totalSkipped = 0;
	let totalFailed = 0;
	for (const o of orgs) {
		const r = await processOrg(o, args.dryRun);
		totalInserted += r.jesInserted;
		totalSkipped += r.jesSkipped;
		totalFailed += r.failed;
	}

	console.log(`\n=== Totals ===`);
	console.log(`  JEs ${args.dryRun ? 'WOULD insert audit for' : 'inserted audit on'}: ${totalInserted}`);
	console.log(`  JEs skipped (already have audit): ${totalSkipped}`);
	if (totalFailed > 0) console.log(`  JEs failed: ${totalFailed}`);
	process.exit(0);
}

main().catch((err) => {
	console.error('BACKFILL ERROR:', err);
	process.exit(1);
});
