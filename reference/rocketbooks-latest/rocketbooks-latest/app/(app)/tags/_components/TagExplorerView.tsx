import Link from 'next/link';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	journalEntries,
	journalEntryLineTags,
	journalEntryLines,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import {
	loadDimensionsForOrg,
	type TagDimensionMeta,
	type TagOption,
} from '@/lib/tags/dimensions';

const CURRENCY_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

interface EntityStat {
	entityId: string;
	lineCount: number;
	jeCount: number;
	netAmount: number;
}

/**
 * Per-dimension rollup: list every entity that has any tagged line,
 * with how many lines + how much expense/income net is attributable
 * to it. Untagged entities are also listed (zero counts) so users can
 * see "you've got 3 properties but only tagged stuff to 2 of them."
 */
export async function TagExplorerView() {
	const orgId = await getCurrentOrgId();

	const dims = await loadDimensionsForOrg(orgId);
	const rendered = await Promise.all(
		dims.map(async (dim) => {
			const [options, stats] = await Promise.all([
				dim.loadOptions(orgId),
				loadStatsForDimension(orgId, dim.entityType),
			]);
			return { dim, options, stats };
		}),
	);

	return (
		<div className="flex flex-col gap-6">
			{rendered.map(({ dim, options, stats }) => (
				<DimensionCard
					key={dim.entityType}
					dim={dim}
					options={options}
					stats={stats}
				/>
			))}
		</div>
	);
}

async function loadStatsForDimension(
	orgId: string,
	entityType: string,
): Promise<EntityStat[]> {
	const rows = await db
		.select({
			entityId: journalEntryLineTags.entityId,
			lineCount: sql<number>`COUNT(*)::int`.as('lc'),
			jeCount: sql<number>`COUNT(DISTINCT ${journalEntries.id})::int`.as('jc'),
			netAmount: sql<string>`
				COALESCE(SUM(
					CASE
						WHEN lower(${chartOfAccounts.gaapType}) IN ('expense','expenses')
							THEN ${journalEntryLines.debit}::numeric - ${journalEntryLines.credit}::numeric
						WHEN lower(${chartOfAccounts.gaapType}) IN ('income','revenue')
							THEN ${journalEntryLines.credit}::numeric - ${journalEntryLines.debit}::numeric
						ELSE 0
					END
				), 0)::text`.as('net'),
		})
		.from(journalEntryLineTags)
		.innerJoin(
			journalEntryLines,
			eq(journalEntryLines.id, journalEntryLineTags.journalEntryLineId),
		)
		.innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
		.innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalEntryLines.accountId))
		.where(
			and(
				eq(journalEntryLineTags.organizationId, orgId),
				eq(journalEntryLineTags.entityType, entityType),
				eq(journalEntries.posted, true),
				isNull(journalEntries.reversalOfId),
			),
		)
		.groupBy(journalEntryLineTags.entityId);

	return rows.map((r) => ({
		entityId: r.entityId,
		lineCount: r.lineCount,
		jeCount: r.jeCount,
		netAmount: Number(r.netAmount ?? 0),
	}));
}

function DimensionCard({
	dim,
	options,
	stats,
}: {
	dim: TagDimensionMeta;
	options: TagOption[];
	stats: EntityStat[];
}) {
	const statsById = new Map(stats.map((s) => [s.entityId, s]));
	// Sort: tagged entities first by amount desc, then untagged entities
	// alphabetically. Untagged is a real signal worth surfacing.
	const tagged = options
		.filter((o) => statsById.has(o.id))
		.sort((a, b) => (statsById.get(b.id)!.netAmount - statsById.get(a.id)!.netAmount));
	const untagged = options.filter((o) => !statsById.has(o.id));
	const totalLines = stats.reduce((acc, s) => acc + s.lineCount, 0);
	const totalAmount = stats.reduce((acc, s) => acc + s.netAmount, 0);

	return (
		<section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
			<header className="flex items-baseline justify-between border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
				<h2 className="text-base font-medium">
					<span aria-hidden>{dim.emoji}</span> {dim.label}
				</h2>
				<span className="text-xs text-zinc-500">
					{options.length} {options.length === 1 ? 'entity' : 'entities'} ·{' '}
					{totalLines.toLocaleString()} tagged{' '}
					{totalLines === 1 ? 'line' : 'lines'}
					{totalAmount !== 0 && (
						<> · net {CURRENCY_FMT.format(totalAmount)}</>
					)}
				</span>
			</header>
			{options.length === 0 ? (
				<div className="px-4 py-6 text-center text-sm text-zinc-500">
					No {dim.label.toLowerCase()} records yet.
				</div>
			) : (
				<table className="w-full text-sm">
					<thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
						<tr>
							<th className="px-4 py-2 font-medium">Name</th>
							<th className="px-4 py-2 text-right font-medium">Lines</th>
							<th className="px-4 py-2 text-right font-medium">JEs</th>
							<th className="px-4 py-2 text-right font-medium">Net</th>
							<th className="px-4 py-2"></th>
						</tr>
					</thead>
					<tbody>
						{tagged.map((o) => {
							const s = statsById.get(o.id)!;
							return (
								<EntityRow
									key={o.id}
									entityType={dim.entityType}
									option={o}
									stat={s}
								/>
							);
						})}
						{untagged.map((o) => (
							<EntityRow
								key={o.id}
								entityType={dim.entityType}
								option={o}
								stat={null}
							/>
						))}
					</tbody>
				</table>
			)}
		</section>
	);
}

function EntityRow({
	entityType,
	option,
	stat,
}: {
	entityType: string;
	option: TagOption;
	stat: EntityStat | null;
}) {
	return (
		<tr className="border-t border-zinc-100 dark:border-zinc-800">
			<td className="px-4 py-2">
				<Link
					href={`/tags/${entityType}/${option.id}`}
					className="font-medium text-blue-600 hover:underline dark:text-blue-400"
				>
					{option.label}
				</Link>
				{option.subLabel && (
					<span className="ml-1 text-xs text-zinc-500">({option.subLabel})</span>
				)}
			</td>
			<td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
				{stat ? stat.lineCount.toLocaleString() : <span className="text-zinc-400">—</span>}
			</td>
			<td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
				{stat ? stat.jeCount.toLocaleString() : <span className="text-zinc-400">—</span>}
			</td>
			<td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
				{stat ? CURRENCY_FMT.format(stat.netAmount) : <span className="text-zinc-400">—</span>}
			</td>
			<td className="px-4 py-2">
				{!stat && (
					<span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-800">
						untagged
					</span>
				)}
			</td>
		</tr>
	);
}
