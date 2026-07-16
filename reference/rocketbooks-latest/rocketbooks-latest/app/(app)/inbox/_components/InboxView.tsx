import Link from 'next/link';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { emailAccounts, inboxMessages } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { DEMO_USER_ID, isDemoOrg } from '@/lib/auth/demo';
import { PROVIDER_PRESETS, type ProviderKey } from '@/lib/email-accounts/providers';
import { isCredsKeyConfigured } from '@/lib/email-accounts/crypto';

const RECENT_LIMIT = 50;

function fmtAgo(iso: string): string {
	const then = new Date(iso).getTime();
	const diffMs = Date.now() - then;
	const min = Math.floor(diffMs / 60_000);
	if (min < 1) return 'just now';
	if (min < 60) return `${min} min ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr} hr ago`;
	const days = Math.floor(hr / 24);
	if (days < 7) return `${days} d ago`;
	return new Date(iso).toLocaleDateString();
}

function preview(text: string, max = 90): string {
	const s = text.replace(/\s+/g, ' ').trim();
	return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function messageStatusTone(status: string): string {
	if (status === 'open') return 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300';
	if (status === 'triaged') return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300';
	if (status === 'archived') return 'bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400';
	return 'bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300';
}

function aiChip(aiStatus: string | null): React.ReactNode {
	if (aiStatus === 'drafted') return <span title="AI draft ready" className="text-violet-600 dark:text-violet-400">✨</span>;
	if (aiStatus === 'sent') return <span title="Replied" className="text-emerald-600 dark:text-emerald-400">✓</span>;
	if (aiStatus === 'pending') return <span title="AI drafting…" className="text-amber-600 dark:text-amber-400">…</span>;
	if (aiStatus === 'failed') return <span title="AI failed" className="text-red-600 dark:text-red-400">!</span>;
	return <span className="text-zinc-400">—</span>;
}

/**
 * Shared inbox landing view. Renders the same content whether the user
 * is in the (app) shell or the (organizer) shell — basePath disambiguates
 * which prefix to use for in-app links so navigation stays inside the
 * shell that loaded the page.
 */

function statusLabel(status: string): { label: string; tone: string } {
	if (status === 'ok')
		return { label: 'Connected', tone: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' };
	if (status === 'auth_failed')
		return { label: 'Re-auth required', tone: 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300' };
	if (status === 'connect_failed')
		return { label: 'Unreachable', tone: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300' };
	return { label: 'Not tested yet', tone: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300' };
}

function providerLabel(key: string): string {
	if (key === 'gmail' || key === 'yahoo' || key === 'icloud') {
		return PROVIDER_PRESETS[key as Exclude<ProviderKey, 'imap'>].label;
	}
	return 'IMAP';
}

export async function InboxView({ basePath }: { basePath: string }) {
	const user = await requireSession();
	const orgId = await getCurrentOrgId();
	const configured = isCredsKeyConfigured();

	// The inbox is normally a personal (user-scoped) view, and email_accounts
	// has no organization_id column. In the shared, read-only demo org we want
	// the seeded mailbox + messages to render for any viewer, so scope accounts
	// to the demo system user and messages to the demo org instead of the
	// current viewer. Mirrors how the rest of the demo workspace is org-shared.
	const demo = isDemoOrg(orgId);
	const accountsWhere = demo
		? eq(emailAccounts.userId, DEMO_USER_ID)
		: eq(emailAccounts.userId, user.id);
	const messagesWhere = demo
		? and(eq(inboxMessages.organizationId, orgId), eq(inboxMessages.source, 'email'))
		: and(eq(inboxMessages.userId, user.id), eq(inboxMessages.source, 'email'));

	const [accounts, messages] = await Promise.all([
		db
			.select({
				id: emailAccounts.id,
				emailAddress: emailAccounts.emailAddress,
				provider: emailAccounts.provider,
				connectionStatus: emailAccounts.connectionStatus,
				lastError: emailAccounts.lastError,
				lastPolledAt: emailAccounts.lastPolledAt,
				isActive: emailAccounts.isActive,
				createdAt: emailAccounts.createdAt,
			})
			.from(emailAccounts)
			.where(accountsWhere)
			.orderBy(desc(emailAccounts.createdAt)),
		db
			.select({
				id: inboxMessages.id,
				fromAddress: inboxMessages.fromAddress,
				fromName: inboxMessages.fromName,
				subject: inboxMessages.subject,
				body: inboxMessages.body,
				receivedAt: inboxMessages.receivedAt,
				status: inboxMessages.status,
				aiStatus: inboxMessages.aiStatus,
			})
			.from(inboxMessages)
			.where(messagesWhere)
			.orderBy(desc(inboxMessages.receivedAt))
			.limit(RECENT_LIMIT),
	]);

	return (
		<div className="flex flex-col gap-5">
			<header className="flex items-start justify-between gap-4">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
					<p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
						Connect a Gmail, Yahoo, or iCloud mailbox so the AI can read and draft replies on your behalf.
					</p>
				</div>
				<Link
					href={`${basePath}/connect`}
					className={`rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 ${
						!configured ? 'pointer-events-none opacity-50' : ''
					}`}
				>
					+ Connect account
				</Link>
			</header>

			{!configured && (
				<div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
					<strong>EMAIL_CREDS_KEY is not set on the server.</strong> Connecting accounts is disabled until the operator configures the encryption key.
				</div>
			)}

			<section>
				<h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
					Connected accounts
				</h2>
				{accounts.length === 0 ? (
					<div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-zinc-200 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
						No accounts connected yet.
					</div>
				) : (
					<div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40">
									<th className="px-3 py-2 font-medium">Email</th>
									<th className="px-3 py-2 font-medium">Provider</th>
									<th className="px-3 py-2 font-medium">Status</th>
									<th className="px-3 py-2 font-medium">Last polled</th>
								</tr>
							</thead>
							<tbody>
								{accounts.map((a) => {
									const s = statusLabel(a.connectionStatus);
									return (
										<tr key={a.id} className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-900">
											<td className="px-3 py-2 font-mono text-xs">{a.emailAddress}</td>
											<td className="px-3 py-2">{providerLabel(a.provider)}</td>
											<td className="px-3 py-2">
												<span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}>
													{s.label}
												</span>
												{a.lastError && (
													<div className="mt-0.5 text-xs text-zinc-500">{a.lastError}</div>
												)}
											</td>
											<td className="px-3 py-2 text-zinc-500">
												{a.lastPolledAt ? new Date(a.lastPolledAt).toLocaleString() : '—'}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
			</section>

			<section>
				<h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
					Recent messages
				</h2>
				{messages.length === 0 ? (
					<div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-zinc-200 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
						{accounts.length === 0
							? 'Connect an account above to start receiving mail.'
							: 'No messages yet — the poller will catch up on the next cycle (within a minute).'}
					</div>
				) : (
					<div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40">
									<th className="px-3 py-2 font-medium">From</th>
									<th className="px-3 py-2 font-medium">Subject</th>
									<th className="px-3 py-2 font-medium">Received</th>
									<th className="px-3 py-2 font-medium">Status</th>
									<th className="px-3 py-2 font-medium">AI</th>
								</tr>
							</thead>
							<tbody>
								{messages.map((m) => (
									<tr key={m.id} className="border-b border-zinc-100 last:border-b-0 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/40">
										<td className="px-3 py-2 align-top">
											<Link href={`${basePath}/${m.id}`} className="block">
												<div className="font-medium">{m.fromName || m.fromAddress}</div>
												{m.fromName && (
													<div className="text-xs text-zinc-500">{m.fromAddress}</div>
												)}
											</Link>
										</td>
										<td className="px-3 py-2 align-top">
											<Link href={`${basePath}/${m.id}`} className="block">
												<div className="font-medium text-blue-700 hover:underline dark:text-blue-400">{m.subject || '(no subject)'}</div>
												<div className="mt-0.5 text-xs text-zinc-500">{preview(m.body)}</div>
											</Link>
										</td>
										<td className="px-3 py-2 align-top whitespace-nowrap text-zinc-500">{fmtAgo(m.receivedAt)}</td>
										<td className="px-3 py-2 align-top">
											<span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${messageStatusTone(m.status)}`}>
												{m.status}
											</span>
										</td>
										<td className="px-3 py-2 align-top text-sm">
											{aiChip(m.aiStatus)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				<div className="mt-2 text-xs text-zinc-500">
					Latest {messages.length} of any messages for this user. AI drafts + detail view land in Phase 2.
				</div>
			</section>
		</div>
	);
}
