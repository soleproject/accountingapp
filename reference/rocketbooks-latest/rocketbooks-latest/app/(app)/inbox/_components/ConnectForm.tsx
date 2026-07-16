'use client';

import Link from 'next/link';
import { useState, useTransition, useMemo } from 'react';
import {
	KNOWN_PROVIDERS,
	PROVIDER_PRESETS,
	detectProviderByEmail,
	isMicrosoftPersonalDomain,
	type ProviderKey,
} from '@/lib/email-accounts/providers';
import { testConnectionAction, saveAccountAction } from '../_actions/connect';
import type { TestConnectionResult } from '@/lib/email-accounts/test-connection';

type KnownProvider = Exclude<ProviderKey, 'imap'>;

interface Props {
	/** Inbox root URL for the current shell — '/inbox' or '/organizer/inbox'.
	 *  Used for the Cancel link and to tell the server action where to
	 *  redirect after a successful save. */
	basePath: string;
}

export function ConnectForm({ basePath }: Props) {
	const [provider, setProvider] = useState<KnownProvider>('gmail');
	const [emailAddress, setEmailAddress] = useState('');
	const [password, setPassword] = useState('');
	const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [isTesting, startTestTransition] = useTransition();
	const [isSaving, startSaveTransition] = useTransition();

	const preset = PROVIDER_PRESETS[provider];
	const detected = useMemo(() => detectProviderByEmail(emailAddress), [emailAddress]);
	const microsoftWarn = useMemo(() => isMicrosoftPersonalDomain(emailAddress), [emailAddress]);

	// If the user types a recognizable address before picking a provider,
	// help them by snapping the selection to the detected match. Won't
	// fight a deliberate override — only fires when they haven't picked.
	const handleEmailChange = (value: string) => {
		setEmailAddress(value);
		const d = detectProviderByEmail(value);
		if (d && d !== provider && KNOWN_PROVIDERS.includes(d)) {
			setProvider(d);
		}
	};

	const handleTest = () => {
		setError(null);
		setTestResult(null);
		startTestTransition(async () => {
			try {
				const r = await testConnectionAction({ emailAddress, password, provider });
				setTestResult(r);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		});
	};

	const handleSave = () => {
		setError(null);
		startSaveTransition(async () => {
			try {
				await saveAccountAction({ emailAddress, password, provider, returnTo: basePath });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes('NEXT_REDIRECT')) return;
				setError(msg);
			}
		});
	};

	const canSubmit = emailAddress.trim().length > 0 && password.trim().length > 0;
	const isBusy = isTesting || isSaving;

	return (
		<div className="flex flex-col gap-6">
			{/* Provider picker */}
			<div className="flex flex-col gap-2">
				<span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Provider</span>
				<div className="grid grid-cols-3 gap-2">
					{KNOWN_PROVIDERS.map((key) => {
						const p = PROVIDER_PRESETS[key];
						const active = provider === key;
						return (
							<button
								type="button"
								key={key}
								onClick={() => setProvider(key)}
								className={`rounded-md border px-4 py-3 text-sm font-medium transition-colors ${
									active
										? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
										: 'border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300'
								}`}
							>
								{p.label}
							</button>
						);
					})}
				</div>
				{detected && detected !== provider && (
					<div className="text-xs text-zinc-500">
						Address looks like {PROVIDER_PRESETS[detected].label}. Switch?{' '}
						<button type="button" onClick={() => setProvider(detected)} className="text-blue-600 hover:underline">
							Use {PROVIDER_PRESETS[detected].label}
						</button>
					</div>
				)}
			</div>

			{/* Microsoft-personal warning */}
			{microsoftWarn && (
				<div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
					<strong>Outlook.com / Hotmail accounts can't be connected this way.</strong>{' '}
					Microsoft disabled basic-auth IMAP for personal accounts in September 2024. Only OAuth works, which we don't support yet.
				</div>
			)}

			{/* Walkthrough */}
			<div className="rounded-md border border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
				<div className="mb-2 flex items-center justify-between text-sm">
					<span className="font-medium">Get an app password for {preset.label}</span>
					<a
						href={preset.appPasswordUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="text-blue-600 hover:underline dark:text-blue-400"
					>
						Open {preset.label} settings ↗
					</a>
				</div>
				<ol className="ml-5 list-decimal space-y-1 text-sm text-zinc-700 dark:text-zinc-300">
					{preset.walkthrough.map((step, i) => (
						<li key={i}>{step}</li>
					))}
				</ol>
			</div>

			{/* Credentials */}
			<div className="grid gap-4 sm:grid-cols-2">
				<Field label="Email address" htmlFor="emailAddress">
					<input
						id="emailAddress"
						type="email"
						required
						autoComplete="username"
						value={emailAddress}
						onChange={(e) => handleEmailChange(e.target.value)}
						placeholder={preset.key === 'icloud' ? 'name@icloud.com' : `name@${preset.key === 'gmail' ? 'gmail.com' : 'yahoo.com'}`}
						className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
					/>
				</Field>
				<Field label="App password" htmlFor="password" hint="Paste the 16-character code — spaces are stripped automatically.">
					<input
						id="password"
						type="password"
						required
						autoComplete="new-password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						placeholder="abcd efgh ijkl mnop"
						className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
					/>
				</Field>
			</div>

			{/* Test result */}
			{testResult && (
				<div
					className={`rounded-md border px-3 py-2 text-sm ${
						testResult.allOk
							? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
							: 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300'
					}`}
				>
					{testResult.allOk ? (
						<>
							<strong>Connection works.</strong> IMAP and SMTP both authenticated.
						</>
					) : (
						<div className="flex flex-col gap-1">
							<strong>Connection failed:</strong>
							{!testResult.imap.ok && <span>IMAP: {testResult.imap.error}</span>}
							{!testResult.smtp.ok && <span>SMTP: {testResult.smtp.error}</span>}
						</div>
					)}
				</div>
			)}

			{error && (
				<div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
					{error}
				</div>
			)}

			{/* Actions */}
			<div className="flex items-center justify-end gap-2">
				<Link
					href={basePath}
					className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
				>
					Cancel
				</Link>
				<button
					type="button"
					onClick={handleTest}
					disabled={!canSubmit || isBusy}
					className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
				>
					{isTesting ? 'Testing…' : 'Test connection'}
				</button>
				<button
					type="button"
					onClick={handleSave}
					disabled={!canSubmit || isBusy || microsoftWarn}
					className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{isSaving ? 'Connecting…' : 'Connect'}
				</button>
			</div>
		</div>
	);
}

function Field({
	label,
	htmlFor,
	hint,
	children,
}: {
	label: string;
	htmlFor: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<label htmlFor={htmlFor} className="flex flex-col gap-1.5 text-sm">
			<span className="font-medium text-zinc-700 dark:text-zinc-300">
				{label}
				{hint && <span className="ml-2 font-normal text-zinc-400">{hint}</span>}
			</span>
			{children}
		</label>
	);
}
