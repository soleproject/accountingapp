/**
 * Auto-tag historical journal_entry_lines.beneficiary_id for trust orgs
 * that have exactly ONE beneficiary on file. Per the (a)+(c) policy from
 * Phase 4d scoping: new postings only generate TRUST_BENEFICIARY_LINKAGE_
 * REQUIRED findings going forward (no retroactive flagging for multi-
 * beneficiary orgs), but single-beneficiary orgs get the linkage "for
 * free" since there's no ambiguity.
 *
 * Only tags lines that posted to a per-beneficiary account
 * (815/820/310/635 — the four where the rules engine cares about the
 * tag). 265.x demand-note sub-accounts are inherently per-beneficiary
 * via the account itself — no per-line tag needed.
 *
 * After tagging, replays the rules engine on every affected JE so the
 * Trust Review queue findings update (e.g. a TRUST_BENEFICIARY_LINKAGE_
 * REQUIRED finding disappears, a TRUST_310_FLAG_K1_ISSUANCE now names
 * the recipient).
 *
 * Idempotent: skips lines that already have beneficiary_id set.
 *
 * Usage:
 *   $env:POSTGRES_URL = "..."
 *   npx tsx scripts/backfill-trust-beneficiary-autotag.ts --org <uuid>
 *   npx tsx scripts/backfill-trust-beneficiary-autotag.ts --all
 *   npx tsx scripts/backfill-trust-beneficiary-autotag.ts --org <uuid> --dry-run
 */

import { randomUUID } from 'crypto';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	trustBeneficiaries,
	trustReviewFindings,
	journalEntries,
	journalEntryLines,
	chartOfAccounts,
	organizations,
	organizationAccountingFeatures,
} from '@/db/schema/schema';
import { evaluateBeneficialTrustJournalEntry } from '@/lib/accounting/rules/beneficial-trust';

const PER_BENEFICIARY_DETAIL_TYPES = [
	'trust_food_minors_incapacitated',
	'trust_clothing_minors_incapacitated',
	'trust_distributions_to_beneficiaries',
	'trust_medical_wellness',
] as const;

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
		console.error('Usage: backfill-trust-beneficiary-autotag.ts (--org <uuid> | --all) [--dry-run]');
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
): Promise<{ tagged: number; jesReevaluated: number; skipped: string | null }> {
	console.log(`\n=== Org: ${org.name} (${org.id}) ===`);

	const benes = await db
		.select({ id: trustBeneficiaries.id, fullName: trustBeneficiaries.fullName })
		.from(trustBeneficiaries)
		.where(eq(trustBeneficiaries.organizationId, org.id));

	if (benes.length === 0) {
		console.log('  No beneficiaries on file — skipping.');
		return { tagged: 0, jesReevaluated: 0, skipped: 'no beneficiaries' };
	}
	if (benes.length > 1) {
		console.log(`  ${benes.length} beneficiaries on file — auto-tag skipped (ambiguous).`);
		console.log('  Use the Trust Review inline tagger to resolve TRUST_BENEFICIARY_LINKAGE_REQUIRED findings manually.');
		return { tagged: 0, jesReevaluated: 0, skipped: `${benes.length} beneficiaries (ambiguous)` };
	}
	const sole = benes[0];
	console.log(`  Sole beneficiary: ${sole.fullName} (${sole.id})`);

	// Find untagged lines on per-beneficiary accounts for this org.
	const candidates = await db
		.select({
			lineId: journalEntryLines.id,
			journalEntryId: journalEntryLines.journalEntryId,
			accountNumber: chartOfAccounts.accountNumber,
			detailType: chartOfAccounts.detailType,
		})
		.from(journalEntryLines)
		.innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalEntryLines.accountId))
		.innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
		.where(
			and(
				eq(journalEntries.organizationId, org.id),
				eq(chartOfAccounts.organizationId, org.id),
				isNull(journalEntryLines.beneficiaryId),
				inArray(chartOfAccounts.detailType, [...PER_BENEFICIARY_DETAIL_TYPES]),
			),
		);

	console.log(`  Untagged lines on per-beneficiary accounts: ${candidates.length}`);

	if (candidates.length === 0) {
		return { tagged: 0, jesReevaluated: 0, skipped: null };
	}

	const breakdown = candidates.reduce<Record<string, number>>((acc, c) => {
		acc[c.accountNumber] = (acc[c.accountNumber] ?? 0) + 1;
		return acc;
	}, {});
	for (const [acct, n] of Object.entries(breakdown)) {
		console.log(`    ${acct}: ${n}`);
	}

	if (dryRun) {
		return { tagged: candidates.length, jesReevaluated: 0, skipped: null };
	}

	// Tag all candidate lines in one statement.
	const lineIds = candidates.map((c) => c.lineId);
	await db
		.update(journalEntryLines)
		.set({ beneficiaryId: sole.id })
		.where(inArray(journalEntryLines.id, lineIds));

	// Re-evaluate every affected JE so findings reflect the new tag (linkage
	// warnings disappear, K-1 findings now name the recipient, demand-note
	// balance check fires for any 310 distributions).
	const affectedJeIds = Array.from(new Set(candidates.map((c) => c.journalEntryId)));
	console.log(`  Re-evaluating ${affectedJeIds.length} affected JEs...`);

	let jesReevaluated = 0;
	for (const jeId of affectedJeIds) {
		await reevaluateJe(org.id, jeId);
		jesReevaluated++;
	}

	return { tagged: candidates.length, jesReevaluated, skipped: null };
}

async function reevaluateJe(orgId: string, jeId: string): Promise<void> {
	const [je] = await db
		.select({
			id: journalEntries.id,
			date: journalEntries.date,
			memo: journalEntries.memo,
			sourceType: journalEntries.sourceType,
			sourceId: journalEntries.sourceId,
		})
		.from(journalEntries)
		.where(eq(journalEntries.id, jeId))
		.limit(1);
	if (!je) return;

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
		.where(eq(journalEntryLines.journalEntryId, jeId));

	const result = await evaluateBeneficialTrustJournalEntry({
		organizationId: orgId,
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

	await db.transaction(async (tx) => {
		const priorDismissed = await tx
			.select({
				code: trustReviewFindings.code,
				dismissedAt: trustReviewFindings.dismissedAt,
				dismissedByUserId: trustReviewFindings.dismissedByUserId,
				dismissedNote: trustReviewFindings.dismissedNote,
			})
			.from(trustReviewFindings)
			.where(
				and(
					eq(trustReviewFindings.journalEntryId, jeId),
					isNotNull(trustReviewFindings.dismissedAt),
				),
			);
		const dismissedByCode = new Map(priorDismissed.map((d) => [d.code, d]));

		await tx
			.delete(trustReviewFindings)
			.where(eq(trustReviewFindings.journalEntryId, jeId));

		if (result.findings.length > 0) {
			await tx.insert(trustReviewFindings).values(
				result.findings.map((f) => {
					const dismiss = dismissedByCode.get(f.code);
					return {
						id: randomUUID(),
						organizationId: orgId,
						journalEntryId: jeId,
						code: f.code,
						severity: f.severity,
						message: f.message,
						metadata: f.metadata ?? null,
						dismissedAt: dismiss?.dismissedAt ?? null,
						dismissedByUserId: dismiss?.dismissedByUserId ?? null,
						dismissedNote: dismiss?.dismissedNote ?? null,
					};
				}),
			);
		}
	});
}

async function main() {
	const args = parseArgs();
	console.log(`Auto-tag backfill: ${args.dryRun ? 'DRY RUN' : 'WRITE'}`);

	const orgs = await resolveOrgs(args);
	if (orgs.length === 0) {
		console.log('No trust-feature-enabled orgs found.');
		process.exit(0);
	}
	console.log(`Orgs to process: ${orgs.length}`);

	let totalTagged = 0;
	let totalJeReevaluated = 0;
	for (const o of orgs) {
		const r = await processOrg(o, args.dryRun);
		totalTagged += r.tagged;
		totalJeReevaluated += r.jesReevaluated;
	}

	console.log(`\n=== Totals ===`);
	console.log(`  Orgs processed: ${orgs.length}`);
	console.log(`  Lines ${args.dryRun ? 'WOULD tag' : 'tagged'}: ${totalTagged}`);
	console.log(`  JEs re-evaluated: ${totalJeReevaluated}`);

	process.exit(0);
}

main().catch((err) => {
	console.error('BACKFILL ERROR:', err);
	process.exit(1);
});
