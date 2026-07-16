import Link from 'next/link';
import { requireSession } from '@/lib/auth/session';
import { isCredsKeyConfigured } from '@/lib/email-accounts/crypto';
import { ConnectForm } from './ConnectForm';

/**
 * Shared connect-account view. basePath is the inbox root for the
 * current shell ('/inbox' or '/organizer/inbox'); passed down to
 * ConnectForm so the Cancel link + after-save redirect stay within the
 * shell that loaded the page.
 */
export async function ConnectView({ basePath }: { basePath: string }) {
	await requireSession();
	const configured = isCredsKeyConfigured();

	return (
		<div className="mx-auto flex max-w-3xl flex-col gap-5">
			<header>
				<nav className="mb-2 text-sm text-zinc-500 dark:text-zinc-400">
					<Link href={basePath} className="hover:text-zinc-700 hover:underline dark:hover:text-zinc-300">
						Inbox
					</Link>
					<span className="mx-1 text-zinc-300 dark:text-zinc-600">/</span>
					<span>Connect account</span>
				</nav>
				<h1 className="text-2xl font-semibold tracking-tight">Connect an email account</h1>
				<p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
					Generate an app password from your email provider, then paste it here. We'll verify the connection before saving.
				</p>
			</header>

			{!configured ? (
				<div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
					<strong>EMAIL_CREDS_KEY is not configured on this server.</strong> Accounts can't be connected
					until the operator sets it. Generate a key with:
					<pre className="mt-2 overflow-x-auto rounded bg-white p-2 font-mono text-xs dark:bg-zinc-900">
						node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
					</pre>
				</div>
			) : (
				<div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
					<ConnectForm basePath={basePath} />
				</div>
			)}
		</div>
	);
}
