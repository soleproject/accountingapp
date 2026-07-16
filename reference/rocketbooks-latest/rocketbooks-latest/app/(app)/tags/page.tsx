import Link from 'next/link';
import { TagExplorerView } from './_components/TagExplorerView';
import { TagManageView } from './_components/TagManageView';
import { TagTriageView } from './_components/TagTriageView';

type Tab = 'explorer' | 'manage' | 'triage';

interface PageProps {
	searchParams: Promise<{ tab?: string }>;
}

const TAB_LABELS: Record<Tab, string> = {
	explorer: 'Explorer',
	manage: 'Manage dimensions',
	triage: 'Triage',
};

const TAB_DESCRIPTIONS: Record<Tab, string> = {
	explorer:
		'Browse every tag dimension and the entities tagged within each. Click an entity to see its lines + rollup.',
	manage:
		'See the system-defined tag dimensions. User-defined dimensions (Class, Location, custom) coming next.',
	triage:
		'Transactions that have a tag suggestion waiting or are sitting on a tag-relevant account without a tag yet.',
};

function isTab(v: string | undefined): v is Tab {
	return v === 'explorer' || v === 'manage' || v === 'triage';
}

export default async function TagsPage({ searchParams }: PageProps) {
	const sp = await searchParams;
	const tab: Tab = isTab(sp.tab) ? sp.tab : 'explorer';

	return (
		<div className="flex flex-col gap-4">
			<header>
				<h1 className="text-2xl font-semibold">Tags</h1>
				<p className="text-sm text-zinc-500 dark:text-zinc-400">
					Per-line attribution for cross-cutting rollups (rental property,
					fixed asset, loan — and whatever else gets added later).
				</p>
			</header>

			<nav className="flex flex-wrap items-center gap-2 border-b border-zinc-200 pb-1 dark:border-zinc-800">
				{(Object.keys(TAB_LABELS) as Tab[]).map((t) => {
					const active = tab === t;
					return (
						<Link
							key={t}
							href={`/tags?tab=${t}`}
							className={`rounded-t-md border-b-2 px-3 py-1.5 text-sm transition ${
								active
									? 'border-zinc-900 font-medium text-zinc-900 dark:border-zinc-100 dark:text-zinc-100'
									: 'border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
							}`}
						>
							{TAB_LABELS[t]}
						</Link>
					);
				})}
			</nav>

			<p className="text-xs text-zinc-500 dark:text-zinc-400">{TAB_DESCRIPTIONS[tab]}</p>

			{tab === 'explorer' && <TagExplorerView />}
			{tab === 'manage' && <TagManageView />}
			{tab === 'triage' && <TagTriageView />}
		</div>
	);
}
