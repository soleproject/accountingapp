'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { approveDebriefAction, beginInteractiveDebriefAction, approveItemAction, skipItemAction } from '../_actions/approveDebrief';
import type { DebriefView as DebriefViewData, DebriefItemView } from '@/lib/meetings/debrief-view';
import type { DocBranding } from '@/lib/documents/layout';
import { DebriefSession, type QueuedDeliverable } from './DebriefSession';

const STATUS_TONE: Record<string, string> = {
	executed: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
	skipped: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
	failed: 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300',
};
const STATUS_LABEL: Record<string, string> = { executed: 'Done', skipped: 'Skipped', failed: 'Failed' };

const BUCKETS: Array<{ key: 'ai' | 'user' | 'other'; title: string; blurb: string }> = [
	{ key: 'ai', title: 'RocketSuite can do these', blurb: 'Drafted / created on approval — review before sending.' },
	{ key: 'user', title: 'For you', blurb: 'Needs you to send, call, decide, or meet.' },
	{ key: 'other', title: 'For others on the call', blurb: 'Tracked against their contact — not contacted automatically.' },
];

interface Props {
	data: DebriefViewData;
	branding: DocBranding;
}

export function DebriefView({ data, branding }: Props) {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();
	const [pendingKind, setPendingKind] = useState<'auto' | 'interactive' | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [session, setSession] = useState<QueuedDeliverable[] | null>(null);

	const allItems = [...data.buckets.ai, ...data.buckets.user, ...data.buckets.other];
	const [draft, setDraft] = useState(
		allItems.map((it) => ({ id: it.id, include: it.status !== 'skipped', description: it.description })),
	);
	const editable = data.state === 'debrief_pending';
	const draftFor = (id: string) => draft.find((d) => d.id === id);

	const items = () => draft.map((d) => ({ id: d.id, include: d.include, description: d.description }));

	// "Approve & let AI draft" — silent path.
	const submit = () => {
		setError(null);
		setPendingKind('auto');
		startTransition(async () => {
			const r = await approveDebriefAction({ appointmentId: data.appointmentId, items: items() });
			setPendingKind(null);
			if (!r.ok) {
				setError(r.error ?? 'Something went wrong.');
				return;
			}
			router.refresh();
		});
	};

	// "Approve & create with me" — interactive path. Switches the page into the
	// session if there are AI deliverables to draft together; otherwise (only
	// tasks/notes) it behaves like the silent path.
	const createWithMe = () => {
		setError(null);
		setPendingKind('interactive');
		startTransition(async () => {
			const r = await beginInteractiveDebriefAction({ appointmentId: data.appointmentId, items: items() });
			setPendingKind(null);
			if (!r.ok) {
				setError(r.error ?? 'Something went wrong.');
				return;
			}
			if (r.queue && r.queue.length > 0) {
				setSession(r.queue);
			} else {
				router.refresh();
			}
		});
	};

	if (session) {
		return (
			<DebriefSession
				meetingTitle={data.meetingTitle}
				contactName={data.contactName}
				summaryMd={data.summaryMd}
				queue={session}
				branding={branding}
			/>
		);
	}

	const includedCount = draft.filter((d) => d.include).length;

	return (
		<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
			{/* LEFT: what happened */}
			<div className="flex flex-col gap-4">
				<Section title="Summary">
					{data.summaryMd ? (
						<p className="whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{data.summaryMd}</p>
					) : (
						<p className="px-4 py-3 text-sm text-zinc-500">No summary yet.</p>
					)}
				</Section>

				{data.decisions.length > 0 && (
					<Section title="Decisions">
						<ul className="list-disc px-4 py-3 pl-8 text-sm text-zinc-700 dark:text-zinc-300">
							{data.decisions.map((d, i) => <li key={i}>{d}</li>)}
						</ul>
					</Section>
				)}

				{data.transcript.length > 0 && (
					<Section title="Transcript">
						<details className="px-4 py-3 text-sm">
							<summary className="cursor-pointer text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
								{data.transcript.length} lines — click to expand
							</summary>
							<div className="mt-3 flex flex-col gap-2">
								{data.transcript.map((t, i) => (
									<p key={i} className="text-zinc-700 dark:text-zinc-300">
										<span className="font-medium text-zinc-500 dark:text-zinc-400">{t.speaker}: </span>
										{t.text}
									</p>
								))}
							</div>
						</details>
					</Section>
				)}
			</div>

			{/* RIGHT: who does what */}
			<div className="flex flex-col gap-4">
				{BUCKETS.map(({ key, title, blurb }) => {
					const items = data.buckets[key];
					if (items.length === 0) return null;
					return (
						<Section key={key} title={`${title} (${items.length})`}>
							<p className="px-4 pt-2 text-xs text-zinc-500">{blurb}</p>
							<ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
								{items.map((it) => (
									<DebriefItemRow
										key={it.id}
										item={it}
										appointmentId={data.appointmentId}
										editable={editable}
										draft={draftFor(it.id)}
										disabled={isPending}
										onToggle={(include) => setDraft((p) => p.map((d) => (d.id === it.id ? { ...d, include } : d)))}
										onEdit={(description) => setDraft((p) => p.map((d) => (d.id === it.id ? { ...d, description } : d)))}
										onChanged={() => router.refresh()}
									/>
								))}
							</ul>
						</Section>
					);
				})}

				{allItems.length === 0 && (
					<Section title="Action items">
						<p className="px-4 py-3 text-sm text-zinc-500">No action items were detected.</p>
					</Section>
				)}

				{editable ? (
					<div className="flex flex-col gap-2">
						<p className="text-xs text-zinc-500">
							The “can do” items go to RocketSuite, the rest become tasks. It never emails or texts anyone on your
							behalf. Choose how to handle the AI items:
						</p>
						{error && (
							<div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
								{error}
							</div>
						)}
						<div className="flex flex-wrap items-center justify-end gap-2">
							<button
								type="button"
								onClick={submit}
								disabled={isPending}
								className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
							>
								{pendingKind === 'auto' ? 'Working…' : allItems.length === 0 ? 'Mark reviewed' : 'Approve & let AI draft'}
							</button>
							{data.buckets.ai.some((it) => draftFor(it.id)?.include) && (
								<button
									type="button"
									onClick={createWithMe}
									disabled={isPending}
									className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
								>
									{pendingKind === 'interactive' ? 'Starting…' : 'Approve & create with me'}
								</button>
							)}
						</div>
						<p className="text-right text-[11px] text-zinc-400">
							{includedCount} item{includedCount === 1 ? '' : 's'} included
						</p>
					</div>
				) : (
					<p className="text-xs text-emerald-600 dark:text-emerald-400">Debrief complete.</p>
				)}
			</div>
		</div>
	);
}

function DebriefItemRow({
	item,
	appointmentId,
	editable,
	draft,
	disabled,
	onToggle,
	onEdit,
	onChanged,
}: {
	item: DebriefItemView;
	appointmentId: string;
	editable: boolean;
	draft?: { include: boolean; description: string };
	disabled: boolean;
	onToggle: (v: boolean) => void;
	onEdit: (v: string) => void;
	onChanged: () => void;
}) {
	const [rowPending, startRow] = useTransition();
	const [rowError, setRowError] = useState<string | null>(null);
	// AI items "draft" their deliverable; user/other items just become a task.
	const approveLabel = item.bucket === 'ai' ? 'Draft it' : 'Approve';

	const runItem = (kind: 'approve' | 'skip') => {
		setRowError(null);
		startRow(async () => {
			const fn = kind === 'approve' ? approveItemAction : skipItemAction;
			const r = await fn({ appointmentId, itemId: item.id, description: draft?.description ?? item.description });
			if (!r.ok) {
				setRowError(r.error ?? 'Could not update this item.');
				return;
			}
			onChanged();
		});
	};

	if (!editable) {
		return (
			<li className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
				<div className="min-w-0">
					<div className="text-zinc-700 dark:text-zinc-300">{item.description}</div>
					<div className="mt-0.5 text-xs text-zinc-500">
						{item.actionLabel}
						{item.dueHint ? ` · ${item.dueHint}` : ''}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{item.status === 'executed' && item.resultDocId && (
						<Link href={`/organizer/create?doc=${item.resultDocId}`} className="text-xs text-indigo-600 hover:underline dark:text-indigo-400">Open draft</Link>
					)}
					{item.status === 'executed' && item.resultTaskId && (
						<Link href={`/organizer/tasks/${item.resultTaskId}/workspace`} className="text-xs text-indigo-600 hover:underline dark:text-indigo-400">Open task</Link>
					)}
					<span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_TONE[item.status] ?? STATUS_TONE.skipped}`}>
						{STATUS_LABEL[item.status] ?? item.status}
					</span>
				</div>
			</li>
		);
	}

	// Once acted on individually, show the outcome instead of the controls.
	if (item.status === 'executed' || item.status === 'skipped' || item.status === 'failed') {
		return (
			<li className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
				<div className="min-w-0">
					<div className={item.status === 'skipped' ? 'text-zinc-400 line-through' : 'text-zinc-700 dark:text-zinc-300'}>{item.description}</div>
					<div className="mt-0.5 text-xs text-zinc-500">{item.actionLabel}</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{item.status === 'executed' && item.resultDocId && (
						<Link href={`/organizer/create?doc=${item.resultDocId}`} className="text-xs text-indigo-600 hover:underline dark:text-indigo-400">Open draft</Link>
					)}
					{item.status === 'executed' && item.resultTaskId && (
						<Link href={`/organizer/tasks/${item.resultTaskId}/workspace`} className="text-xs text-indigo-600 hover:underline dark:text-indigo-400">Open task</Link>
					)}
					<span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_TONE[item.status] ?? STATUS_TONE.skipped}`}>
						{STATUS_LABEL[item.status] ?? item.status}
					</span>
				</div>
			</li>
		);
	}

	const rowBusy = disabled || rowPending;
	return (
		<li className="flex items-start gap-3 px-4 py-3 text-sm">
			<input
				type="checkbox"
				checked={draft?.include ?? true}
				onChange={(e) => onToggle(e.target.checked)}
				disabled={rowBusy}
				className="mt-1.5 h-4 w-4 shrink-0"
				aria-label="Include this item in bulk approval"
			/>
			<div className="min-w-0 flex-1">
				<textarea
					value={draft?.description ?? item.description}
					onChange={(e) => onEdit(e.target.value)}
					disabled={rowBusy || !(draft?.include ?? true)}
					rows={2}
					maxLength={1000}
					className="w-full resize-y rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm leading-relaxed focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950"
				/>
				<div className="mt-1 flex items-center justify-between gap-2">
					<span className="text-xs text-zinc-500">
						{item.actionLabel}
						{item.dueHint ? ` · ${item.dueHint}` : ''}
					</span>
					<span className="flex shrink-0 items-center gap-1.5">
						<button
							type="button"
							onClick={() => runItem('skip')}
							disabled={rowBusy}
							className="rounded px-2 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-900"
						>
							Skip
						</button>
						<button
							type="button"
							onClick={() => runItem('approve')}
							disabled={rowBusy}
							className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
						>
							{rowPending ? 'Working…' : approveLabel}
						</button>
					</span>
				</div>
				{rowError && <p className="mt-1 text-xs text-rose-600">{rowError}</p>}
			</div>
		</li>
	);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
			<header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
				<h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">{title}</h2>
			</header>
			{children}
		</section>
	);
}
