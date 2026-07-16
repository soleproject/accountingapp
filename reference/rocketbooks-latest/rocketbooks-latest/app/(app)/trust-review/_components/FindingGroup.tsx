'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FindingsTable, type FindingRowData } from './FindingsTable';
import type { BeneficiaryOption } from './BeneficiaryPickerInline';
import type { TrusteePick } from './AssignTrusteeButton';
import type { IncomeAccountPick } from './ClassifyDepositButtons';
import type { LoanPick } from './LinkPaymentToLoanButton';
import type { ExpenseAccountPick } from './ReclassifyAssetButton';
import type { AccountPick } from './RecategorizeNonTrustButton';
import type { RentalPropertyPick } from './LinkToPropertyButton';
import type { DimensionRender } from './ApplyTagButton';

interface Props {
	code: string;
	codeLabel: string;
	items: FindingRowData[];
	beneficiaryOptions: BeneficiaryOption[];
	trusteeOptions: TrusteePick[];
	incomeAccounts: IncomeAccountPick[];
	expenseAccounts: ExpenseAccountPick[];
	allAccounts: AccountPick[];
	corpusAvailable: boolean;
	loans: LoanPick[];
	rentalProperties: RentalPropertyPick[];
	tagDimensions: DimensionRender[];
	vendorClassificationByContact?: Record<string, {
		vendorType: 'loan' | 'credit_card' | 'lease' | 'unclassified';
		contactId: string;
		contactName: string;
		loans: Array<{ id: string; displayName: string }>;
	}>;
	creditCardAccounts?: AccountPick[];
	leaseAccounts?: AccountPick[];
	vehicles?: Array<{ id: string; name: string; sublabel?: string | null }>;
	charities?: Array<{ id: string; contactName: string }>;
	/** Render shape for the header badge. 'pending' shows the standard
	 *  yellow WARN (or red BLOCK) pill; 'decisioned' shows a green
	 *  DECISIONED pill (audit-trail record of a past action); 'dismissed'
	 *  shows a burnt-orange DISMISSED pill (already set aside by the user
	 *  or the system). */
	kind?: 'pending' | 'decisioned' | 'dismissed';
}

const SEVERITY_PALETTE: Record<string, string> = {
	warn: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
	block: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};
const DECISIONED_PILL_CLS =
	'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200';
const DISMISSED_PILL_CLS =
	'bg-orange-200 text-orange-900 dark:bg-orange-900/50 dark:text-orange-200';

/**
 * Per-code collapsible group. Header row always renders chevron + severity
 * pill + label + count; when expanded, additionally renders a free-text
 * search input on the same row that narrows the rows below by contact /
 * amount / date (substring match on any of them).
 *
 * The search runs entirely client-side against the items already loaded
 * for the group — no extra round-trips. Filtered items are passed to
 * FindingsTable, so the select-all + bulk-dismiss controls scope to
 * what's currently visible.
 *
 * Custom open/close state (instead of <details>/<summary>) so the search
 * input can sit in the header row without click-event collisions.
 */
export function FindingGroup({ code, codeLabel, items, beneficiaryOptions, trusteeOptions, incomeAccounts, expenseAccounts, allAccounts, corpusAvailable, loans, rentalProperties, tagDimensions, vendorClassificationByContact, creditCardAccounts, leaseAccounts, vehicles, charities, kind = 'pending' }: Props) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [processing, setProcessing] = useState(false);

	// FindingsTable can flip processing false within milliseconds for fast
	// actions (a single SQL UPDATE bulk-dismiss returns almost instantly),
	// which makes the spinner imperceptible. Hold the visible state for a
	// minimum window so the user always notices feedback fired.
	const SPINNER_MIN_VISIBLE_MS = 600;
	const [spinnerVisible, setSpinnerVisible] = useState(false);
	const turnedOnAt = useRef<number>(0);
	useEffect(() => {
		if (processing) {
			turnedOnAt.current = Date.now();
			setSpinnerVisible(true);
			return;
		}
		const elapsed = Date.now() - turnedOnAt.current;
		const hold = Math.max(0, SPINNER_MIN_VISIBLE_MS - elapsed);
		if (hold === 0) {
			setSpinnerVisible(false);
			return;
		}
		const t = setTimeout(() => setSpinnerVisible(false), hold);
		return () => clearTimeout(t);
	}, [processing]);

	const severity = items[0]?.severity ?? 'warn';
	const isBlock = severity === 'block';
	const isDecisioned = kind === 'decisioned';
	const isDismissed = kind === 'dismissed';
	const pillCls = isDecisioned
		? DECISIONED_PILL_CLS
		: isDismissed
			? DISMISSED_PILL_CLS
			: (SEVERITY_PALETTE[severity.toLowerCase()] ?? SEVERITY_PALETTE.warn);
	const pillLabel = isDecisioned
		? 'decisioned'
		: isDismissed
			? 'dismissed'
			: severity;

	const filteredItems = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return items;
		return items.filter((r) => {
			const contact = (r.jeContactName ?? '').toLowerCase();
			if (contact.includes(q)) return true;
			// Amount: match on raw number AND formatted-with-commas string so
			// "1,750" or "1750" both work.
			if (r.jeAmount !== null) {
				const raw = r.jeAmount.toString();
				const fmt = r.jeAmount.toLocaleString('en-US', { minimumFractionDigits: 2 });
				if (raw.includes(q) || fmt.includes(q)) return true;
			}
			// Date: ISO substring, so "2025-06" matches all June 2025 rows.
			if (r.jeDate && r.jeDate.includes(q)) return true;
			return false;
		});
	}, [items, query]);

	return (
		<div
			className={`rounded-lg border bg-white dark:bg-zinc-950 ${
				isDecisioned
					? 'border-emerald-300 dark:border-emerald-800'
					: isDismissed
						? 'border-orange-400 dark:border-orange-700'
						: isBlock
							? 'border-red-300 dark:border-red-800'
							: 'border-amber-300 dark:border-amber-800'
			}`}
		>
			<div className="flex items-center gap-3 px-4 py-3">
				<button
					type="button"
					onClick={() => setOpen((v) => !v)}
					aria-expanded={open}
					aria-label={open ? 'Collapse group' : 'Expand group'}
					className="flex flex-1 cursor-pointer items-center gap-3 text-left hover:opacity-80"
				>
					<svg
						className={`h-4 w-4 shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-90' : ''}`}
						viewBox="0 0 20 20"
						fill="currentColor"
						aria-hidden="true"
					>
						<path
							fillRule="evenodd"
							d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
							clipRule="evenodd"
						/>
					</svg>
					<span
						className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${pillCls}`}
					>
						{pillLabel}
					</span>
					<span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
						{codeLabel}
					</span>
				</button>

				{open && (
					<div className="relative w-64">
						<input
							type="text"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Filter by contact, amount, or date…"
							className={`w-full rounded-md border bg-white py-1.5 pl-3 pr-8 text-sm transition-shadow focus:outline-none focus:ring-2 dark:bg-zinc-900 ${
								query
									? 'border-blue-400 ring-2 ring-blue-200 focus:border-blue-500 focus:ring-blue-300 dark:border-blue-500 dark:ring-blue-900/50 dark:focus:border-blue-400 dark:focus:ring-blue-800'
									: 'border-zinc-300 focus:border-blue-400 focus:ring-blue-200 dark:border-zinc-700 dark:focus:border-blue-500 dark:focus:ring-blue-900/50'
							}`}
						/>
						{query && (
							<button
								type="button"
								onClick={() => setQuery('')}
								aria-label="Clear filter"
								title="Clear filter"
								className="absolute inset-y-0 right-2 my-auto flex h-5 w-5 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-200 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
							>
								<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
									<line x1="18" y1="6" x2="6" y2="18" />
									<line x1="6" y1="6" x2="18" y2="18" />
								</svg>
							</button>
						)}
					</div>
				)}

				{spinnerVisible && (
					<svg
						viewBox="0 0 24 24"
						width="14"
						height="14"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						className="animate-spin text-blue-600 dark:text-blue-400"
						aria-label="Bulk action in progress"
						role="status"
					>
						<path d="M21 12a9 9 0 11-6.219-8.56" />
					</svg>
				)}
				<span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium tabular-nums text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
					{open && query
						? `${filteredItems.length.toLocaleString()} / ${items.length.toLocaleString()}`
						: items.length.toLocaleString()}
				</span>
			</div>

			{open && (
				<FindingsTable
					code={code}
					items={filteredItems}
					beneficiaryOptions={beneficiaryOptions}
					trusteeOptions={trusteeOptions}
					incomeAccounts={incomeAccounts}
					expenseAccounts={expenseAccounts}
					allAccounts={allAccounts}
					corpusAvailable={corpusAvailable}
					loans={loans}
					rentalProperties={rentalProperties}
					tagDimensions={tagDimensions}
					vendorClassificationByContact={vendorClassificationByContact}
					creditCardAccounts={creditCardAccounts}
					leaseAccounts={leaseAccounts}
					vehicles={vehicles}
					charities={charities}
					onPendingChange={setProcessing}
				/>
			)}
		</div>
	);
}
