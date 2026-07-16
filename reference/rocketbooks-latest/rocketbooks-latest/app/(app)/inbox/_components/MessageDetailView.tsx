import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { inboxMessages, emailAccounts } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';
import { getLinkedTasksFor } from '@/lib/task-links/queries';
import { ReplyComposerIsland } from './ReplyComposerIsland';
import { StatusButtons } from './StatusButtons';
import { DraftAgainButton } from './DraftAgainButton';

/**
 * Shared message detail view. basePath disambiguates between (app) and
 * (organizer) shells so the back link / breadcrumb stays in the right
 * place. Server component — auth + data loading; the interactive bits
 * (Reply composer, status buttons) are client child components.
 */

interface Props {
	basePath: string;
	messageId: string;
}

function statusTone(status: string): string {
	if (status === 'open') return 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300';
	if (status === 'triaged') return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300';
	if (status === 'archived') return 'bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400';
	return 'bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300';
}

function aiStatusLabel(s: string | null, reason: string | null): { label: string; tone: string } {
	if (s === 'pending')
		return { label: 'AI drafting…', tone: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300' };
	if (s === 'drafted')
		return { label: '✨ Draft ready', tone: 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300' };
	if (s === 'sent')
		return { label: '✓ Replied', tone: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' };
	if (s === 'skipped_noise')
		return {
			label: `Skipped (${reason ?? 'noise'})`,
			tone: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400',
		};
	if (s === 'failed')
		return { label: 'AI failed', tone: 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300' };
	return { label: '—', tone: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300' };
}

function preview(text: string, max = 140): string {
	const s = text.replace(/\s+/g, ' ').trim();
	return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export async function MessageDetailView({ basePath, messageId }: Props) {
	const user = await requireSession();
	const orgId = await getCurrentOrgId();
	// In the shared demo org messages belong to the demo system user, so match
	// on the org instead of the viewer; everywhere else this stays user-scoped.
	const ownerScope = isDemoOrg(orgId)
		? eq(inboxMessages.organizationId, orgId)
		: eq(inboxMessages.userId, user.id);

	const [row] = await db
		.select({
			id: inboxMessages.id,
			userId: inboxMessages.userId,
			fromAddress: inboxMessages.fromAddress,
			fromName: inboxMessages.fromName,
			subject: inboxMessages.subject,
			body: inboxMessages.body,
			bodyHtml: inboxMessages.bodyHtml,
			receivedAt: inboxMessages.receivedAt,
			status: inboxMessages.status,
			threadId: inboxMessages.threadId,
			aiStatus: inboxMessages.aiStatus,
			aiDraftSubject: inboxMessages.aiDraftSubject,
			aiDraftHtml: inboxMessages.aiDraftHtml,
			aiDraftText: inboxMessages.aiDraftText,
			aiModel: inboxMessages.aiModel,
			aiDraftedAt: inboxMessages.aiDraftedAt,
			aiSkipReason: inboxMessages.aiSkipReason,
			sentMessageId: inboxMessages.sentMessageId,
			sentAt: inboxMessages.sentAt,
			emailAccountId: inboxMessages.emailAccountId,
			provider: emailAccounts.provider,
		})
		.from(inboxMessages)
		.leftJoin(emailAccounts, eq(emailAccounts.id, inboxMessages.emailAccountId))
		.where(and(eq(inboxMessages.id, messageId), ownerScope))
		.limit(1);

	if (!row) notFound();

	// Tasks linked to this email (reverse of the task → email link).
	const linkedTasks = await getLinkedTasksFor(orgId, 'inbox_message', row.id);

	// Thread context: other messages in the same thread for this user,
	// chronological. Sent replies surface as separate "you replied" rows.
	const threadRows = row.threadId
		? await db
				.select({
					id: inboxMessages.id,
					fromAddress: inboxMessages.fromAddress,
					fromName: inboxMessages.fromName,
					subject: inboxMessages.subject,
					body: inboxMessages.body,
					receivedAt: inboxMessages.receivedAt,
					aiStatus: inboxMessages.aiStatus,
					aiDraftText: inboxMessages.aiDraftText,
					sentAt: inboxMessages.sentAt,
				})
				.from(inboxMessages)
				.where(and(eq(inboxMessages.userId, user.id), eq(inboxMessages.threadId, row.threadId)))
				.orderBy(asc(inboxMessages.receivedAt))
		: [];

	const otherInThread = threadRows.filter((r) => r.id !== row.id);
	const mayNotShowInSent = row.provider !== 'gmail';
	const ai = aiStatusLabel(row.aiStatus, row.aiSkipReason);

	return (
		<div className="mx-auto flex max-w-4xl flex-col gap-5">
			<header className="flex flex-col gap-3">
				<nav className="text-sm text-zinc-500 dark:text-zinc-400">
					<Link href={basePath} className="hover:text-zinc-700 hover:underline dark:hover:text-zinc-300">
						Inbox
					</Link>
					<span className="mx-1 text-zinc-300 dark:text-zinc-600">/</span>
					<span>{preview(row.subject ?? '(no subject)', 60)}</span>
				</nav>
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div>
						<h1 className="text-2xl font-semibold tracking-tight">{row.subject || '(no subject)'}</h1>
						<div className="mt-1 text-sm text-zinc-500">
							From{' '}
							<span className="font-medium text-zinc-700 dark:text-zinc-300">
								{row.fromName ? `${row.fromName} <${row.fromAddress}>` : row.fromAddress}
							</span>
							<span className="mx-2 text-zinc-300">·</span>
							{new Date(row.receivedAt).toLocaleString()}
						</div>
					</div>
					<div className="flex items-center gap-2">
						<span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(row.status)}`}>
							{row.status}
						</span>
						<span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${ai.tone}`}>
							{ai.label}
						</span>
						<StatusButtons messageId={row.id} currentStatus={row.status} />
					</div>
				</div>
			</header>

			<section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
				<div className="border-b border-zinc-200 px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
					Message
				</div>
				{row.bodyHtml ? (
					<iframe
						title="Email body"
						srcDoc={row.bodyHtml}
						sandbox=""
						className="h-[420px] w-full border-0 bg-white dark:bg-zinc-950"
					/>
				) : (
					<pre className="whitespace-pre-wrap break-words p-4 text-sm text-zinc-800 dark:text-zinc-200">
						{row.body}
					</pre>
				)}
			</section>

			{linkedTasks.length > 0 && (
				<section>
					<h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
						Linked tasks ({linkedTasks.length})
					</h2>
					<ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:divide-zinc-900 dark:border-zinc-800 dark:bg-zinc-950">
						{linkedTasks.map((t) => {
							const done = t.status === 'DONE';
							return (
								<li key={t.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
									<span className="flex min-w-0 items-center gap-2">
										<span className={`h-1.5 w-1.5 shrink-0 rounded-full ${done ? 'bg-emerald-400' : 'bg-amber-400'}`} aria-hidden="true" />
										<span className={`truncate ${done ? 'text-zinc-400 line-through dark:text-zinc-500' : 'text-zinc-800 dark:text-zinc-200'}`}>{t.title}</span>
									</span>
									{t.dueDate && (
										<span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
											{new Date(t.dueDate).toLocaleDateString()}
										</span>
									)}
								</li>
							);
						})}
					</ul>
				</section>
			)}

			{otherInThread.length > 0 && (
				<section>
					<h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
						Thread ({otherInThread.length} other {otherInThread.length === 1 ? 'message' : 'messages'})
					</h2>
					<ol className="space-y-2">
						{otherInThread.map((m) => (
							<li key={m.id} className="rounded-md border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-950">
								<div className="flex items-center justify-between gap-2">
									<div className="font-medium">
										{m.fromName || m.fromAddress}
									</div>
									<div className="text-xs text-zinc-500">{new Date(m.receivedAt).toLocaleString()}</div>
								</div>
								<div className="mt-1 text-xs text-zinc-500">{preview(m.body, 200)}</div>
								{m.aiStatus === 'sent' && m.aiDraftText && (
									<div className="mt-2 rounded border-l-2 border-emerald-400 bg-emerald-50/50 p-2 text-xs dark:bg-emerald-950/20">
										<div className="mb-1 font-medium text-emerald-700 dark:text-emerald-300">
											You replied {m.sentAt ? new Date(m.sentAt).toLocaleString() : ''}
										</div>
										<div className="text-zinc-700 dark:text-zinc-300">{preview(m.aiDraftText, 200)}</div>
									</div>
								)}
							</li>
						))}
					</ol>
				</section>
			)}

			<section>
				<h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
					AI reply
				</h2>
				{row.aiStatus === 'pending' && (
					<div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
						AI is drafting a reply — should appear within a minute. Refresh to check.
					</div>
				)}
				{row.aiStatus === 'failed' && (
					<div className="flex flex-col gap-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
						<div>
							<strong>AI draft failed.</strong> {row.aiSkipReason ?? 'Unknown error'}
						</div>
						<DraftAgainButton messageId={row.id} label="Retry" />
					</div>
				)}
				{row.aiStatus === 'skipped_noise' && (
					<div className="flex flex-col gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900/40">
						<div>
							AI skipped this — looks like <strong>{row.aiSkipReason ?? 'noise'}</strong> (newsletter, receipt, automated, etc.).
						</div>
						<DraftAgainButton messageId={row.id} />
					</div>
				)}
				{row.aiStatus === 'sent' && (
					<div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
						<div className="mb-2">
							<strong>Reply sent</strong>
							{row.sentAt && <span className="ml-2 text-zinc-600 dark:text-zinc-400">{new Date(row.sentAt).toLocaleString()}</span>}
						</div>
						{row.aiDraftSubject && (
							<div className="mt-1 text-xs text-zinc-700 dark:text-zinc-300">
								<span className="font-medium">Subject:</span> {row.aiDraftSubject}
							</div>
						)}
						{row.aiDraftText && (
							<pre className="mt-2 whitespace-pre-wrap break-words rounded bg-white p-2 text-xs text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
								{row.aiDraftText}
							</pre>
						)}
						{row.sentMessageId && (
							<div className="mt-2 text-xs text-zinc-500">
								Message-ID: <code className="font-mono">{row.sentMessageId}</code>
							</div>
						)}
					</div>
				)}
				{row.aiStatus === 'drafted' && row.aiDraftHtml && row.aiDraftSubject && (
					<div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
						<ReplyComposerIsland
							messageId={row.id}
							initialSubject={row.aiDraftSubject}
							initialHtml={row.aiDraftHtml}
							toAddress={row.fromAddress}
							mayNotShowInSent={mayNotShowInSent}
						/>
						{row.aiModel && (
							<div className="mt-2 text-xs text-zinc-500">
								Drafted with <code className="font-mono">{row.aiModel}</code>
								{row.aiDraftedAt && <span className="ml-2">at {new Date(row.aiDraftedAt).toLocaleString()}</span>}
							</div>
						)}
					</div>
				)}
				{!row.aiStatus && (
					<div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
						AI drafting isn't enabled for this source.
					</div>
				)}
			</section>
		</div>
	);
}
