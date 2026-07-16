import Link from 'next/link';
import { and, count, eq, gte, isNull, sql, sum } from 'drizzle-orm';

/** Filter that excludes lines whose JE is one half of a reversal pair —
 *  either the counter entry (reversal_of_id IS NOT NULL) or an original
 *  that has been reversed (someone else's reversal_of_id points at it).
 *  Both are accounting no-ops and would otherwise inflate per-beneficiary
 *  totals after every reroute cycle. Callers must already have
 *  journalEntries joined into the FROM clause. */
const liveJeFilter = and(
	isNull(journalEntries.reversalOfId),
	sql`NOT EXISTS (SELECT 1 FROM journal_entries cnt WHERE cnt.reversal_of_id = ${journalEntries.id})`,
);
import { db } from '@/db/client';
import {
	trustBeneficiaries,
	journalEntries,
	journalEntryLines,
	chartOfAccounts,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getOrgFeature } from '@/lib/accounting/get-org-feature';
import { BeneficiaryRow } from './_components/BeneficiaryRow';

const CURRENCY_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function ageYearsFromDob(dob: string, asOfDate: string): number | null {
	try {
		const birth = new Date(dob);
		const as = new Date(asOfDate);
		if (Number.isNaN(birth.getTime()) || Number.isNaN(as.getTime())) return null;
		let years = as.getUTCFullYear() - birth.getUTCFullYear();
		const m = as.getUTCMonth() - birth.getUTCMonth();
		if (m < 0 || (m === 0 && as.getUTCDate() < birth.getUTCDate())) years--;
		return years;
	} catch {
		return null;
	}
}

export default async function TrustBeneficiariesPage() {
	const orgId = await getCurrentOrgId();
	const trustEnabled = await getOrgFeature(orgId, 'beneficial_trust');

	const today = new Date().toISOString().slice(0, 10);
	const yearStart = `${new Date().getUTCFullYear()}-01-01`;

	// Resolve the org's 310 Distributions account id once — used in the K-1
	// YTD subquery so we only sum distributions, not every line tagged with
	// a beneficiary.
	const [distAccount] = await db
		.select({ id: chartOfAccounts.id })
		.from(chartOfAccounts)
		.where(
			and(
				eq(chartOfAccounts.organizationId, orgId),
				eq(chartOfAccounts.detailType, 'trust_distributions_to_beneficiaries'),
			),
		)
		.limit(1);
	const distAccountId = distAccount?.id ?? null;

	const beneficiaries = await db
		.select({
			id: trustBeneficiaries.id,
			fullName: trustBeneficiaries.fullName,
			dateOfBirth: trustBeneficiaries.dateOfBirth,
			isIncapacitated: trustBeneficiaries.isIncapacitated,
			relationship: trustBeneficiaries.relationship,
			demandNoteAccountId: trustBeneficiaries.demandNoteAccountId,
			demandNoteAccountNumber: chartOfAccounts.accountNumber,
		})
		.from(trustBeneficiaries)
		.leftJoin(chartOfAccounts, eq(chartOfAccounts.id, trustBeneficiaries.demandNoteAccountId))
		.where(eq(trustBeneficiaries.organizationId, orgId))
		.orderBy(trustBeneficiaries.fullName);

	// Per-beneficiary aggregates: demand-note outstanding (debit-credit on
	// their 26x), tagged-line count, K-1 YTD (sum of debits to 310 tagged
	// with this beneficiary in the current year).
	const enriched = await Promise.all(
		beneficiaries.map(async (b) => {
			const ageYears = b.dateOfBirth ? ageYearsFromDob(b.dateOfBirth, today) : null;
			const qualifies = b.isIncapacitated || (ageYears !== null && ageYears < 21);

			let outstanding = 0;
			let demandNoteLineCount = 0;
			if (b.demandNoteAccountId) {
				const [bal] = await db
					.select({
						debit: sql<string>`coalesce(sum(${journalEntryLines.debit}), 0)::text`,
						credit: sql<string>`coalesce(sum(${journalEntryLines.credit}), 0)::text`,
						n: count(),
					})
					.from(journalEntryLines)
					.innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
					.where(and(eq(journalEntryLines.accountId, b.demandNoteAccountId), liveJeFilter));
				outstanding = Math.round((Number(bal?.debit ?? 0) - Number(bal?.credit ?? 0)) * 100) / 100;
				demandNoteLineCount = bal?.n ?? 0;
			}

			const [taggedCountRow] = await db
				.select({ n: count() })
				.from(journalEntryLines)
				.innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
				.where(and(eq(journalEntryLines.beneficiaryId, b.id), liveJeFilter));

			let k1Ytd = 0;
			if (distAccountId) {
				const [k1Row] = await db
					.select({
						total: sql<string>`coalesce(sum(${journalEntryLines.debit}), 0)::text`,
					})
					.from(journalEntryLines)
					.innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
					.where(
						and(
							eq(journalEntryLines.beneficiaryId, b.id),
							eq(journalEntryLines.accountId, distAccountId),
							gte(journalEntries.date, yearStart),
							liveJeFilter,
						),
					);
				k1Ytd = Math.round(Number(k1Row?.total ?? 0) * 100) / 100;
			}

			return {
				...b,
				ageYears,
				qualifies,
				outstanding,
				demandNoteLineCount,
				taggedCount: taggedCountRow?.n ?? 0,
				k1Ytd,
			};
		}),
	);

	return (
		<div className="flex flex-col gap-4">
			<header className="flex items-end justify-between">
				<div>
					<h1 className="text-2xl font-semibold">Trust Beneficiaries</h1>
					<p className="text-sm text-zinc-500 dark:text-zinc-400">
						{trustEnabled
							? `${beneficiaries.length} on file`
							: 'Beneficial-trust accounting is not enabled on this organization.'}
					</p>
				</div>
			</header>

			{!trustEnabled && (
				<div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
					Beneficiaries are added when the trust is first onboarded. This page
					only shows them for organizations whose parent Enterprise has Entity
					Type Onboarding enabled AND has been set to a trust entity type.
				</div>
			)}

			{enriched.length === 0 && trustEnabled && (
				<div className="rounded-lg border border-zinc-200 bg-white p-10 text-center text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
					No beneficiaries on file yet.
				</div>
			)}

			{enriched.length > 0 && (
				<div className="overflow-hidden rounded-xl border border-zinc-400 bg-amber-50 shadow-lg shadow-zinc-300/60 ring-1 ring-zinc-900/5 transition-all hover:shadow-amber-600/60 hover:ring-2 hover:ring-amber-600/70 dark:border-zinc-500 dark:bg-amber-950/20 dark:shadow-black/60 dark:ring-white/10 dark:hover:shadow-amber-500/60 dark:hover:ring-amber-500/60">
					<table className="w-full text-sm">
						<thead className="bg-amber-100/60 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-amber-900/30">
							<tr>
								<th className="px-4 py-2 font-medium">Name</th>
								<th className="px-4 py-2 font-medium">DOB / Age</th>
								<th className="px-4 py-2 font-medium">Eligibility</th>
								<th className="px-4 py-2 text-right font-medium">Demand Note</th>
								<th className="px-4 py-2 text-right font-medium">Outstanding</th>
								<th className="px-4 py-2 text-right font-medium">Tagged Lines</th>
								<th className="px-4 py-2 text-right font-medium">K-1 YTD</th>
								<th className="px-4 py-2 text-right font-medium" />
							</tr>
						</thead>
						<tbody>
							{enriched.map((b) => (
								<BeneficiaryRow
									key={b.id}
									id={b.id}
									fullName={b.fullName}
									relationship={b.relationship}
									dateOfBirth={b.dateOfBirth}
									ageYears={b.ageYears}
									eligibility={
										<EligibilityPill
											qualifies={b.qualifies}
											isIncapacitated={b.isIncapacitated}
											ageYears={b.ageYears}
										/>
									}
									demandNoteCell={
										b.demandNoteAccountNumber ? (
											<>
												{b.demandNoteLineCount > 0 ? (
													<Link
														href={`/journal-entries?categoryId=${b.demandNoteAccountId}`}
														className="text-blue-600 hover:underline dark:text-blue-400"
													>
														{b.demandNoteLineCount.toLocaleString()}
													</Link>
												) : (
													<span>0</span>
												)}
												<div className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
													acct {b.demandNoteAccountNumber}
												</div>
											</>
										) : (
											<span className="text-xs text-zinc-400">not seeded</span>
										)
									}
									outstanding={b.outstanding}
									outstandingHint={b.outstanding > 0}
									taggedCount={b.taggedCount}
									k1Ytd={b.k1Ytd}
								/>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

function EligibilityPill({
	qualifies,
	isIncapacitated,
	ageYears,
}: {
	qualifies: boolean;
	isIncapacitated: boolean;
	ageYears: number | null;
}) {
	if (qualifies) {
		const reason = isIncapacitated
			? 'incapacitated'
			: ageYears !== null
				? `minor (age ${ageYears})`
				: 'minor';
		return (
			<span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
				815/820 eligible · {reason}
			</span>
		);
	}
	return (
		<span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
			Adult · not eligible for 815/820
		</span>
	);
}
