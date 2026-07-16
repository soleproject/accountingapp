'use client';

import { useEffect, useState } from 'react';

interface CodeOption {
	code: string;
	label: string;
}

interface ContactOption {
	id: string;
	contactName: string;
}

interface SelectedFilters {
	q: string;
	code: string;
	severity: string;
	contactId: string;
	start: string;
	end: string;
}

interface PreserveParams {
	view?: string;
}

interface Props {
	codes: CodeOption[];
	contacts: ContactOption[];
	selected: SelectedFilters;
	preserve: PreserveParams;
}

const STORAGE_KEY = 'rs_trust_review_filters_open';

/**
 * Filter panel above the Trust Review groups. One <form method="get"> with
 * all the inputs — submit reloads the page with the picked filters in the
 * URL. Show/Hide toggle persists in localStorage. Mirrors the transactions
 * page FiltersPanel for visual consistency.
 */
export function TrustReviewFilters({ codes, contacts, selected, preserve }: Props) {
	const [open, setOpen] = useState(true);
	useEffect(() => {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (raw === '0') setOpen(false);
		} catch {
			// ignore
		}
	}, []);
	const toggle = () => {
		setOpen((prev) => {
			const next = !prev;
			try {
				localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
			} catch {
				// ignore
			}
			return next;
		});
	};

	const hasAnyFilter =
		!!selected.q ||
		!!selected.code ||
		!!selected.severity ||
		!!selected.contactId ||
		!!selected.start ||
		!!selected.end;

	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center gap-2">
				<button
					type="button"
					onClick={toggle}
					className={`rounded-md border px-3 py-1 text-sm font-medium transition-colors ${
						open
							? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
							: 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900'
					}`}
					aria-expanded={open}
					// Edge / Office form-fill extensions stamp `fdprocessedid` onto
					// form buttons after hydration, which React flags as a mismatch.
					// Suppress that specific warning so console stays quiet.
					suppressHydrationWarning
				>
					{open ? '▾ Hide Filters' : '▸ Show Filters'}
				</button>
				{!open && hasAnyFilter && (
					<>
						<a
							href={buildResetHref(preserve)}
							className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
						>
							Clear
						</a>
						<span className="text-xs text-zinc-500 dark:text-zinc-400">
							(active filters hidden)
						</span>
					</>
				)}
			</div>

			{open && (
				<form
					method="get"
					className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/40"
				>
					{preserve.view && <input type="hidden" name="view" value={preserve.view} />}

					<input
						type="text"
						name="q"
						defaultValue={selected.q}
						placeholder="Search findings — message, JE memo…"
						className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
					/>

					<div className="grid grid-cols-1 gap-3 md:grid-cols-3">
						<Field label="Warning Type">
							<select
								name="code"
								defaultValue={selected.code}
								className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
							>
								<option value="">All Types</option>
								{codes.map((c) => (
									<option key={c.code} value={c.code}>
										{c.label}
									</option>
								))}
							</select>
						</Field>
						<Field label="Severity">
							<select
								name="severity"
								defaultValue={selected.severity}
								className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
							>
								<option value="">All Severities</option>
								<option value="warn">Warn</option>
								<option value="block">Block</option>
							</select>
						</Field>
						<Field label="Contact">
							<select
								name="contactId"
								defaultValue={selected.contactId}
								className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
							>
								<option value="">All Contacts</option>
								{contacts.map((c) => (
									<option key={c.id} value={c.id}>
										{c.contactName}
									</option>
								))}
							</select>
						</Field>
					</div>

					<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
						<Field label="Start Date">
							<input
								type="date"
								name="start"
								defaultValue={selected.start}
								className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
							/>
						</Field>
						<Field label="End Date">
							<input
								type="date"
								name="end"
								defaultValue={selected.end}
								className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
							/>
						</Field>
					</div>

					<div className="flex items-center gap-2">
						<button
							type="submit"
							className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
						>
							Apply filters
						</button>
						{hasAnyFilter && (
							<a
								href={buildResetHref(preserve)}
								className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
							>
								Clear
							</a>
						)}
					</div>
				</form>
			)}
		</div>
	);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<label className="flex flex-col gap-1">
			<span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
			{children}
		</label>
	);
}

function buildResetHref(preserve: PreserveParams): string {
	const parts: string[] = [];
	if (preserve.view) parts.push(`view=${encodeURIComponent(preserve.view)}`);
	return parts.length === 0 ? '?' : `?${parts.join('&')}`;
}
