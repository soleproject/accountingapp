import Link from 'next/link';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	contacts,
	journalEntries,
	transactions,
	trustReviewFindings,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { loadAllDimensionOptions } from '@/lib/tags/dimensions';
import { ApplyTagButton, type DimensionRender } from '@/app/(app)/trust-review/_components/ApplyTagButton';

const TAG_FINDING_CODES = ['TRUST_TAG_SUGGESTED', 'TRUST_PROPERTY_EXPENSE_UNTAGGED'] as const;
const CURRENCY_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/**
 * Triage tab. Pulls every open tag-related finding so the user can
 * apply suggestions / pick tags from one place without going to
 * /trust-review and filtering down. Reuses ApplyTagButton, the same
 * component that wires from the trust-review queue — same actions,
 * same audit trail.
 */
export async function TagTriageView() {
	const orgId = await getCurrentOrgId();

	const [findings, dimensionData] = await Promise.all([
		db
			.select({
				id: trustReviewFindings.id,
				code: trustReviewFindings.code,
				message: trustReviewFindings.message,
				metadata: trustReviewFindings.metadata,
				createdAt: trustReviewFindings.createdAt,
				jeId: journalEntries.id,
				jeDate: journalEntries.date,
				jeMemo: journalEntries.memo,
				txnId: transactions.id,
				txnAmount: transactions.amount,
				txnContactName: contacts.contactName,
				accountNumber: chartOfAccounts.accountNumber,
				accountName: chartOfAccounts.accountName,
			})
			.from(trustReviewFindings)
			.innerJoin(journalEntries, eq(journalEntries.id, trustReviewFindings.journalEntryId))
			.leftJoin(transactions, eq(transactions.journalEntryId, journalEntries.id))
			.leftJoin(contacts, eq(contacts.id, transactions.contactId))
			.leftJoin(
				chartOfAccounts,
				eq(chartOfAccounts.id, transactions.categoryAccountId),
			)
			.where(
				and(
					eq(trustReviewFindings.organizationId, orgId),
					inArray(trustReviewFindings.code, [...TAG_FINDING_CODES]),
					isNull(trustReviewFindings.dismissedAt),
				),
			)
			.orderBy(asc(trustReviewFindings.code), desc(journalEntries.date)),
		loadAllDimensionOptions(orgId),
	]);

	const tagDimensions: DimensionRender[] = dimensionData.map(({ dimension, options }) => ({
		entityType: dimension.entityType,
		label: dimension.label,
		shortLabel: dimension.shortLabel,
		emoji: dimension.emoji,
		options,
	}));

	const suggested = findings.filter((f) => f.code === 'TRUST_TAG_SUGGESTED');
	const untagged = findings.filter((f) => f.code === 'TRUST_PROPERTY_EXPENSE_UNTAGGED');

	if (findings.length === 0) {
		return (
			<div className="rounded-lg border border-zinc-200 bg-white p-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
				Nothing to triage right now. Tag suggestions and untagged-expense
				warnings will show up here as new transactions post.
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-6">
			{suggested.length > 0 && (
				<TriageGroup
					title="Suggested tags"
					subtitle="Prior tag found at a similar amount — confirm to apply."
					rows={suggested}
					tagDimensions={tagDimensions}
				/>
			)}
			{untagged.length > 0 && (
				<TriageGroup
					title="Untagged on tag-relevant accounts"
					subtitle="These transactions hit accounts where the per-property / per-asset rollup needs a tag."
					rows={untagged}
					tagDimensions={tagDimensions}
				/>
			)}
		</div>
	);
}

interface TriageRow {
	id: string;
	code: string;
	message: string;
	metadata: unknown;
	jeId: string;
	jeDate: string;
	jeMemo: string | null;
	txnId: string | null;
	txnAmount: number | null;
	txnContactName: string | null;
	accountNumber: string | null;
	accountName: string | null;
}

function TriageGroup({
	title,
	subtitle,
	rows,
	tagDimensions,
}: {
	title: string;
	subtitle: string;
	rows: TriageRow[];
	tagDimensions: DimensionRender[];
}) {
	const isSuggested = rows[0]?.code === 'TRUST_TAG_SUGGESTED';

	return (
		<section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
			<header className="flex items-baseline justify-between border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
				<div>
					<h2 className="text-base font-medium">
						{title}{' '}
						<span className="ml-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
							{rows.length}
						</span>
					</h2>
					<p className="text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>
				</div>
			</header>
			<table className="w-full text-sm">
				<thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
					<tr>
						<th className="px-4 py-2 font-medium">Date</th>
						<th className="px-4 py-2 font-medium">Contact</th>
						<th className="px-4 py-2 font-medium">Account</th>
						<th className="px-4 py-2 text-right font-medium">Amount</th>
						<th className="px-4 py-2 font-medium">Message</th>
						<th className="px-4 py-2 text-right font-medium">Action</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((r) => (
						<tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
							<td className="px-4 py-2 tabular-nums text-zinc-700 dark:text-zinc-300">{r.jeDate}</td>
							<td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
								{r.txnContactName ?? <span className="text-zinc-400">—</span>}
							</td>
							<td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
								{r.accountNumber && (
									<span className="text-zinc-400">{r.accountNumber} · </span>
								)}
								{r.accountName ?? <span className="text-zinc-400">—</span>}
							</td>
							<td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
								{r.txnAmount != null ? CURRENCY_FMT.format(Math.abs(Number(r.txnAmount))) : '—'}
							</td>
							<td className="px-4 py-2 text-xs text-zinc-500 dark:text-zinc-400">
								<Link
									href={r.txnId ? `/transactions/${r.txnId}` : `/journal-entries/${r.jeId}`}
									className="text-blue-600 hover:underline dark:text-blue-400"
								>
									{r.message.length > 80 ? `${r.message.slice(0, 80)}…` : r.message}
								</Link>
							</td>
							<td className="px-4 py-2">
								<div className="flex justify-end">
									{isSuggested ? (
										<ApplyTagButton
											mode="suggested"
											findingId={r.id}
											suggestionLabel={summarizeSuggestion(r.metadata, tagDimensions)}
										/>
									) : (
										<ApplyTagButton
											mode="picker"
											findingId={r.id}
											dimensions={tagDimensions}
										/>
									)}
								</div>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</section>
	);
}

function summarizeSuggestion(metadata: unknown, dims: DimensionRender[]): string {
	const meta = (metadata ?? {}) as {
		tags?: Array<{ entityType: string; entityId: string }>;
	};
	const parts: string[] = [];
	for (const t of meta.tags ?? []) {
		const dim = dims.find((d) => d.entityType === t.entityType);
		if (!dim) continue;
		const opt = dim.options.find((o) => o.id === t.entityId);
		if (opt) parts.push(`${dim.shortLabel.toLowerCase()} "${opt.label}"`);
	}
	return parts.length > 0 ? parts.join(' + ') : 'the suggested tag';
}
