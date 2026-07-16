'use client';

import { useState } from 'react';
import type { TelegramConnectState } from '@/lib/messaging/telegram-connect';

/**
 * "Connect Telegram" affordance for the Texts page. A collapsible button that
 * expands to the org's invite QR + link. Sharing the link with a contact or
 * adding the bot to a group routes those messages into the Texts inbox — no
 * phone number, no per-message cost. Props are plain data (server-precomputed).
 */
export function ConnectTelegram({ state }: { state: TelegramConnectState }) {
	const [open, setOpen] = useState(false);
	const [copied, setCopied] = useState(false);

	const copy = async () => {
		if (!state.inviteLink) return;
		try {
			await navigator.clipboard.writeText(state.inviteLink);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			/* clipboard blocked — the link is still visible to copy manually */
		}
	};

	return (
		<div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
			>
				<span className="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-100">
					<TelegramIcon />
					Connect Telegram
					{state.connectedChats > 0 && (
						<span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-950/50 dark:text-sky-300">
							{state.connectedChats} connected
						</span>
					)}
				</span>
				<span className="text-zinc-400">{open ? '▲' : '▼'}</span>
			</button>

			{open && (
				<div className="border-t border-zinc-200 px-4 py-4 dark:border-zinc-800">
					{!state.configured ? (
						<p className="text-sm text-zinc-500 dark:text-zinc-400">
							Telegram isn&apos;t enabled on this workspace yet — check back soon.
						</p>
					) : !state.inviteLink ? (
						<p className="text-sm text-amber-600 dark:text-amber-400">
							Telegram is being set up. Refresh in a moment to get your connect link.
						</p>
					) : (
						<div className="flex flex-col gap-4 sm:flex-row sm:items-start">
							{state.qrDataUrl && (
								// eslint-disable-next-line @next/next/no-img-element
								<img
									src={state.qrDataUrl}
									alt="Telegram connect QR"
									className="h-40 w-40 shrink-0 rounded-md border border-zinc-200 dark:border-zinc-800"
								/>
							)}
							<div className="min-w-0 flex-1">
								<p className="text-sm text-zinc-700 dark:text-zinc-300">
									Share this with a contact, or add the bot to a group, to route those messages into your inbox here.
								</p>
								<ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-400">
									<li>Open the link (or scan the QR) — it opens the Rocketbooks bot in Telegram.</li>
									<li>Press <strong>Start</strong> (or, for a group, add the bot then send the link).</li>
									<li>Messages appear here; your replies go back to them on Telegram.</li>
								</ol>
								<div className="mt-3 flex flex-wrap items-center gap-2">
									<a
										href={state.inviteLink}
										target="_blank"
										rel="noreferrer"
										className="truncate rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-xs text-sky-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-sky-300"
									>
										{state.inviteLink}
									</a>
									<button
										type="button"
										onClick={copy}
										className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-700"
									>
										{copied ? 'Copied!' : 'Copy link'}
									</button>
								</div>
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function TelegramIcon() {
	return (
		<svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 text-sky-500" aria-hidden="true">
			<path d="M21.94 4.6a1 1 0 0 0-1.32-.98L2.9 10.53c-.9.35-.86 1.65.06 1.95l4.4 1.4 1.7 5.16c.22.66 1.05.86 1.55.37l2.36-2.3 4.4 3.24c.6.45 1.47.12 1.63-.62l3-13.9a1 1 0 0 0-.06-.63zM9.3 14.1l7.9-5.9-6.3 6.7-.1 3-1.5-3.8z" />
		</svg>
	);
}
