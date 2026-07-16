'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { DismissButton } from './DismissButton';
import { AddReceiptButton } from './AddReceiptButton';
import { BeneficiaryPickerInline, type BeneficiaryOption } from './BeneficiaryPickerInline';
import {
	AssignBeneficiaryButton,
	type AssignBeneficiaryKind,
	type BeneficiaryPick,
} from './AssignBeneficiaryButton';
import { AssignTrusteeButton, type TrusteePick } from './AssignTrusteeButton';
import { BulkAssignBeneficiaryButton } from './BulkAssignBeneficiaryButton';
import { BulkAssignTrusteeButton } from './BulkAssignTrusteeButton';
import { ClassifyDepositButtons, type IncomeAccountPick } from './ClassifyDepositButtons';
import { ClassifyCapitalGainButtons } from './ClassifyCapitalGainButtons';
import { RecategorizeTaxesButtons } from './RecategorizeTaxesButtons';
import { RerouteNoReceiptButton } from './RerouteNoReceiptButton';
import type { LoanPick } from './LinkPaymentToLoanButton';
import { Apply310Button } from './Apply310Button';
import { QueueK1Button } from './QueueK1Button';
import { DraftResolutionButton } from './DraftResolutionButton';
import { ReclassifyAssetButton, type ExpenseAccountPick } from './ReclassifyAssetButton';
import { RequestResolutionButton } from './RequestResolutionButton';
import { Reclassify450Button } from './Reclassify450Button';
import { RecategorizeNonTrustButton, type AccountPick } from './RecategorizeNonTrustButton';
import { BulkRerouteNoReceiptButton } from './BulkRerouteNoReceiptButton';
import { LinkToPropertyButton, type RentalPropertyPick } from './LinkToPropertyButton';
import { ApplyTagButton, type DimensionRender } from './ApplyTagButton';
import { UndoAutoTagButton } from './UndoAutoTagButton';
import { BulkRecategorizeNonTrustButton } from './BulkRecategorizeNonTrustButton';
import { BulkRecategorizeTaxesButton } from './BulkRecategorizeTaxesButton';
import { BulkReclassifyAssetButton } from './BulkReclassifyAssetButton';
import { LoanPaymentContactActions } from './LoanPaymentContactActions';
import { VehicleExpenseContactActions } from './VehicleExpenseContactActions';
import { CharitableExpenseContactActions } from './CharitableExpenseContactActions';
import { BeneficiaryLinkageContactActions } from './BeneficiaryLinkageContactActions';
import { TaxesContactActions } from './TaxesContactActions';
import { BusinessIncomeContactActions } from './BusinessIncomeContactActions';
import { Distribution310K1ContactActions } from './Distribution310K1ContactActions';
import { Distribution310DemandNoteContactActions } from './Distribution310DemandNoteContactActions';
import { K1Income455ContactActions } from './K1Income455ContactActions';
import { Trustee1099ContactActions } from './Trustee1099ContactActions';
import { AssetRepostContactActions } from './AssetRepostContactActions';
import { DisposalLoanContactActions } from './DisposalLoanContactActions';
import { NoReceiptContactActions } from './NoReceiptContactActions';
import { NonTrustContactActions } from './NonTrustContactActions';
import { DemandNoteMissingContactActions } from './DemandNoteMissingContactActions';
import { RentalPropertyContactActions } from './RentalPropertyContactActions';
import { PersonalUseLeaseContactActions } from './PersonalUseLeaseContactActions';
import { bulkDismissFindings } from '../_actions/bulkDismissFindings';
import {
	TRUST_815_820_BENE_ACTIONABLE_CODES,
	TRUST_815_TRUSTEE_ACTIONABLE_CODES,
} from '@/lib/accounting/trust-food-clothing-codes';

const FOOD_CLOTHING_BENE_SET: ReadonlySet<string> = new Set(TRUST_815_820_BENE_ACTIONABLE_CODES);
const FOOD_CLOTHING_TRUSTEE_SET: ReadonlySet<string> = new Set(TRUST_815_TRUSTEE_ACTIONABLE_CODES);

type VendorBucketKey = 'loan' | 'credit_card' | 'lease' | 'unclassified';
const VENDOR_BUCKET_ORDER: readonly VendorBucketKey[] = [
	'loan',
	'credit_card',
	'lease',
	'unclassified',
];
const VENDOR_BUCKET_LABELS: Record<VendorBucketKey, string> = {
	loan: 'Loans',
	credit_card: 'Credit Cards',
	lease: 'Leases',
	unclassified: 'Unclassified',
};

/** Above this many open rows we cap the rendered DOM and offer a
 *  "Show all" toggle. Picked at ~1 viewport's worth of rows — large
 *  enough to scroll comfortably, small enough that select-all stays
 *  snappy. Skipped when the group renders sub-groups (those provide
 *  their own collapse-driven row budget). */
const ROW_RENDER_CAP = 100;

/** Codes whose rows are DEPOSITS, where per-contact sub-grouping is
 *  unhelpful (usually one or two income sources per code, and the
 *  triage action is per-property / per-K-1, not per-payer). Every
 *  other code defaults to per-contact sub-grouping — vendor-side
 *  warnings almost always concentrate on a handful of repeat payees,
 *  and the sub-group sub-level select-all is the right unit of bulk
 *  action. */
const NO_SUB_GROUP_CODES = new Set<string>([
	'TRUST_450_BUSINESS_INCOME_BLOCKED',
	'TRUST_455_FLAG_K1_ISSUANCE',
	'TRUST_DEFERRED_RENTAL_NET_NEEDED',
	'TRUST_DEFERRED_PERSONAL_USE_LEASE',
	// Deposit-side classification codes — usually a small handful of
	// distinct payers per trust, and the resolution is per-JE judgment.
	'TRUST_DEPOSIT_NEEDS_CORPUS_OR_INCOME_CLASSIFICATION',
	'TRUST_CAPITAL_GAIN_NEEDS_HOLDING_PERIOD',
]);

const CURRENCY_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export interface FindingRowData {
	id: string;
	code: string;
	severity: string;
	message: string;
	metadata: unknown;
	createdAt: string;
	dismissedAt: string | null;
	dismissedNote: string | null;
	dismissedByEmail: string | null;
	journalEntryId: string;
	jeDate: string | null;
	jeMemo: string | null;
	jeAmount: number | null;
	jeContactName: string | null;
	/** Contact id corresponding to jeContactName (when known) — drives
	 *  the per-contact vendor-type lookup on the loan-payment finding.
	 *  Null when the JE has no source-transaction vendor (manual JE or
	 *  unmatched). */
	jeContactId: string | null;
	jeSourceType: string | null;
	jeSourceId: string | null;
}

interface Props {
	code: string;
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
	/** Vendor classification per contact id — only meaningful on the
	 *  TRUST_DEFERRED_LOAN_SPLIT_NEEDED finding. Drives the four-bucket
	 *  vendor-type sub-grouping (Loans / Credit Cards / Leases /
	 *  Unclassified) and the per-contact action set. Map serialized as a
	 *  plain object for the server→client boundary. */
	vendorClassificationByContact?: Record<string, {
		vendorType: 'loan' | 'credit_card' | 'lease' | 'unclassified';
		contactId: string;
		contactName: string;
		loans: Array<{ id: string; displayName: string }>;
	}>;
	/** All CC-payable accounts on this org (detail_type='credit_card').
	 *  Drives the eye-icon dropdown next to "Credit Card" in the Not-a-Loan
	 *  menu. Empty array → only the "+ add" icon is active. */
	creditCardAccounts?: AccountPick[];
	/** All lease accounts on this org (detail_type='rent_or_lease_buildings').
	 *  Same role as creditCardAccounts but for the Lease row. */
	leaseAccounts?: AccountPick[];
	/** Trust-owned vehicles (fixed_assets in the Vehicles category) — drives
	 *  the Pick-Vehicle dropdown on TRUST_605_VERIFY_TRUST_OWNED_VEHICLE. */
	vehicles?: Array<{ id: string; name: string; sublabel?: string | null }>;
	/** 501(c)(3) tagged contacts — drives the Pick-Charity dropdown on
	 *  TRUST_515_VERIFY_501C3. */
	charities?: Array<{ id: string; contactName: string }>;
	/** Fires whenever ANY bulk server action in this table goes from idle
	 *  to in-flight (and vice versa). Parent (FindingGroup) renders a
	 *  spinner next to the count badge while true. Selection transitions
	 *  don't trigger this — only real network work. */
	onPendingChange?: (pending: boolean) => void;
}

/**
 * Per-group table renderer. Owns the row-selection state needed for the
 * group-level bulk-dismiss button, and per-row affordances (Add Receipt
 * for no-receipt findings; inline beneficiary tagger for linkage codes;
 * Dismiss always).
 *
 * The select-all checkbox in the header reflects the indeterminate /
 * fully-selected state of OPEN (non-dismissed) rows only — dismissed
 * rows aren't dismiss-able again so they're never selectable.
 */
/**
 * Selection state — represented as a "mode + exceptions" pair so toggle-
 * all is O(1) regardless of group size. With 1,696 rows in a group the
 * naive "build a 1,696-id Set" approach freezes the main thread; this
 * shape lets the user select-all + dismiss-all snappy even at 10× that.
 *
 *   mode = 'none' + except = ∅                  → nothing selected
 *   mode = 'all'  + except = ∅                  → everything selected
 *   mode = 'all'  + except = {id1, id2}         → all except those two
 *   mode = 'none' + except = {id1, id2}         → only those two
 */
type SelectionState = { mode: 'all' | 'none'; except: Set<string> };

export function FindingsTable({ code, items, beneficiaryOptions, trusteeOptions, incomeAccounts, expenseAccounts, allAccounts, corpusAvailable, loans, rentalProperties, tagDimensions, vendorClassificationByContact, creditCardAccounts, leaseAccounts, vehicles, charities, onPendingChange }: Props) {
	const [sel, setSel] = useState<SelectionState>({ mode: 'none', except: new Set() });
	const [pending, startTransition] = useTransition();
	const [bulkError, setBulkError] = useState<string | null>(null);
	const [showAllRows, setShowAllRows] = useState(false);

	const openItems = useMemo(() => items.filter((r) => !r.dismissedAt), [items]);
	const openIds = useMemo(() => new Set(openItems.map((r) => r.id)), [openItems]);

	const isRowSelected = (id: string): boolean =>
		sel.mode === 'all' ? !sel.except.has(id) : sel.except.has(id);

	const selectedOpenCount = useMemo(() => {
		if (sel.mode === 'all') {
			let n = openItems.length;
			for (const id of sel.except) if (openIds.has(id)) n -= 1;
			return n;
		}
		let n = 0;
		for (const id of sel.except) if (openIds.has(id)) n += 1;
		return n;
	}, [sel, openItems, openIds]);

	const allOpenSelected = useMemo(() => {
		if (sel.mode !== 'all') return false;
		for (const id of sel.except) if (openIds.has(id)) return false;
		return true;
	}, [sel, openIds]);
	const someOpenSelected = selectedOpenCount > 0 && !allOpenSelected;

	const toggleRow = (id: string, checked: boolean) => {
		// Wrap in startTransition so the per-row re-render runs at low
		// priority — the checkbox UI updates immediately, the row className
		// change can lag a frame without blocking input.
		startTransition(() => {
			setSel((prev) => {
				const next = { mode: prev.mode, except: new Set(prev.except) };
				if (checked) {
					if (next.mode === 'all') next.except.delete(id);
					else next.except.add(id);
				} else {
					if (next.mode === 'all') next.except.add(id);
					else next.except.delete(id);
				}
				return next;
			});
		});
	};

	const toggleAll = (checked: boolean) => {
		// O(1): just swap the mode + clear exceptions. The expensive part is
		// re-rendering the rows; startTransition keeps the click responsive.
		startTransition(() => {
			setSel({ mode: checked ? 'all' : 'none', except: new Set() });
		});
	};

	// Concrete id list of currently-selected OPEN findings. mode='all' →
	// every open id minus exceptions; mode='none' → exceptions intersected
	// with open. Memoized so the bulk-action buttons get a stable reference
	// across renders.
	const selectedOpenIds = useMemo<string[]>(
		() =>
			sel.mode === 'all'
				? openItems.filter((r) => !sel.except.has(r.id)).map((r) => r.id)
				: Array.from(sel.except).filter((id) => openIds.has(id)),
		[sel, openItems, openIds],
	);

	// Counts in-flight server actions in this table (own bulk dismiss +
	// any child bulk-assign buttons reporting up via onChildPendingChange).
	// Used to fire onPendingChange so FindingGroup can render the spinner.
	const [actionInFlight, setActionInFlight] = useState(0);
	const isAnyActionPending = actionInFlight > 0;
	useEffect(() => {
		onPendingChange?.(isAnyActionPending);
	}, [isAnyActionPending, onPendingChange]);
	const onChildPendingChange = useCallback((p: boolean) => {
		setActionInFlight((c) => c + (p ? 1 : -1));
	}, []);

	const onBulkDismiss = () => {
		if (selectedOpenIds.length === 0) return;
		setBulkError(null);
		setActionInFlight((c) => c + 1);
		startTransition(async () => {
			try {
				const r = await bulkDismissFindings({ findingIds: selectedOpenIds });
				if (!r.ok) {
					setBulkError(r.error ?? 'Bulk dismiss failed');
					return;
				}
				setSel({ mode: 'none', except: new Set() });
				// revalidatePath in the action triggers a refresh so the
				// dismissed rows fade.
			} finally {
				setActionInFlight((c) => c - 1);
			}
		});
	};

	const clearSelection = () => {
		setSel({ mode: 'none', except: new Set() });
		setBulkError(null);
	};

	const subGroupByContact = !NO_SUB_GROUP_CODES.has(code);
	const isLoanPayment = code === 'TRUST_DEFERRED_LOAN_SPLIT_NEEDED';

	// Sub-group derivation. Each unique contact (plus an "Untagged" bucket
	// for null contacts) gets its own collapsible section. Sort by open
	// count descending so the largest sub-groups surface first.
	type SubGroup = {
		key: string;
		contactName: string;
		items: FindingRowData[];
		openItems: FindingRowData[];
	};
	const subGroups: SubGroup[] = useMemo(() => {
		if (!subGroupByContact) return [];
		const byContact = new Map<string, SubGroup>();
		for (const r of items) {
			const key = r.jeContactName?.trim() || '__untagged__';
			const display = r.jeContactName?.trim() || 'Untagged';
			let g = byContact.get(key);
			if (!g) {
				g = { key, contactName: display, items: [], openItems: [] };
				byContact.set(key, g);
			}
			g.items.push(r);
			if (!r.dismissedAt) g.openItems.push(r);
		}
		// Alphabetical by contact name (case-insensitive). The "Untagged"
		// bucket lands wherever 'U' sorts naturally so reviewers can find it
		// in the same scan pass.
		return Array.from(byContact.values()).sort((a, b) =>
			a.contactName.localeCompare(b.contactName, undefined, { sensitivity: 'base' }),
		);
	}, [items, subGroupByContact]);

	const [expandedSubGroups, setExpandedSubGroups] = useState<Set<string>>(new Set());
	const toggleSubGroup = (key: string) => {
		setExpandedSubGroups((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	// For the loan-payment finding, partition sub-groups into four vendor-
	// type buckets. Each bucket is a collapsible section above its contact
	// rows. Contact's vendor type comes from the first item's jeContactId
	// looked up in vendorClassificationByContact; null/missing → unclassified.
	type VendorBucket = {
		key: VendorBucketKey;
		label: string;
		subGroups: typeof subGroups;
	};
	const vendorBuckets: VendorBucket[] = useMemo(() => {
		if (!isLoanPayment) return [];
		const byBucket = new Map<VendorBucketKey, typeof subGroups>(
			VENDOR_BUCKET_ORDER.map((k) => [k, [] as typeof subGroups]),
		);
		for (const g of subGroups) {
			const firstItem = g.items[0];
			const contactId = firstItem?.jeContactId ?? null;
			const cls = contactId ? vendorClassificationByContact?.[contactId] : null;
			const vt: VendorBucketKey = cls?.vendorType ?? 'unclassified';
			byBucket.get(vt)!.push(g);
		}
		return VENDOR_BUCKET_ORDER.map((k) => ({
			key: k,
			label: VENDOR_BUCKET_LABELS[k],
			subGroups: byBucket.get(k) ?? [],
		}));
	}, [isLoanPayment, subGroups, vendorClassificationByContact]);

	const [expandedVendorBuckets, setExpandedVendorBuckets] = useState<Set<VendorBucketKey>>(
		// Default-expand Loans + Unclassified — those are where the user
		// most often has actionable work. Credit Cards / Leases collapse to
		// reduce noise until needed.
		new Set<VendorBucketKey>(['loan', 'unclassified']),
	);
	const toggleVendorBucket = (key: VendorBucketKey) => {
		setExpandedVendorBuckets((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const subGroupSelectedCount = (g: SubGroup): number => {
		if (sel.mode === 'all') {
			let n = g.openItems.length;
			for (const r of g.openItems) if (sel.except.has(r.id)) n -= 1;
			return n;
		}
		let n = 0;
		for (const r of g.openItems) if (sel.except.has(r.id)) n += 1;
		return n;
	};
	const toggleSubGroupAll = (g: SubGroup, checked: boolean) => {
		startTransition(() => {
			setSel((prev) => {
				const next = { mode: prev.mode, except: new Set(prev.except) };
				for (const r of g.openItems) {
					if (checked) {
						if (next.mode === 'all') next.except.delete(r.id);
						else next.except.add(r.id);
					} else {
						if (next.mode === 'all') next.except.add(r.id);
						else next.except.delete(r.id);
					}
				}
				return next;
			});
		});
	};

	// Cap rendered rows for very large flat groups. Skipped when sub-
	// grouping is on — collapsed sub-groups already keep the DOM small.
	const cappedItems = !subGroupByContact && !showAllRows && items.length > ROW_RENDER_CAP
		? items.slice(0, ROW_RENDER_CAP)
		: items;
	const isCapped = !subGroupByContact && cappedItems.length < items.length;

	// Per-rule per-row action: only the no-receipt code surfaces Add
	// Receipt; linkage codes surface the inline beneficiary tagger; the
	// 815/820 "no qualifying" manual-JE codes also surface the tagger but
	// with the qualifying filter.
	const showAddReceipt = code === 'TRUST_NO_RECEIPT_POSSIBLE_DISTRIBUTION';
	// 635 (Medical) also surfaces the inline beneficiary tagger — spec
	// requires a named recipient; tagging the beneficiary clears the
	// finding. The medical-provider contact half is not yet wired.
	const showLinkageTagger =
		code === 'TRUST_BENEFICIARY_LINKAGE_REQUIRED'
		|| code === 'TRUST_635_RECIPIENT_REQUIRED';
	// 815/820 family — every actionable code (open, warn, decisioned) gets
	// the Beneficiary icon; the 4 × 815 codes additionally get the Trustee
	// icon for "actually this was a trustee meal" recovery.
	const showFoodClothingBene = FOOD_CLOTHING_BENE_SET.has(code);
	const showFoodClothingTrustee = FOOD_CLOTHING_TRUSTEE_SET.has(code);
	const foodClothingBeneKind: AssignBeneficiaryKind | null = showFoodClothingBene
		? code.startsWith('TRUST_820_')
			? '820'
			: '815'
		: null;
	const showRecategorizeTaxes = code === 'TRUST_505_705_LIKELY_MISROUTED';
	const showLinkToLoan = code === 'TRUST_DEFERRED_LOAN_SPLIT_NEEDED';
	const showApply310 = code === 'TRUST_310_DEMAND_NOTE_NOT_EXHAUSTED';
	const showQueueK1 = code === 'TRUST_310_FLAG_K1_ISSUANCE';
	const showVehicleExpense = code === 'TRUST_605_VERIFY_TRUST_OWNED_VEHICLE';
	const showCharitable = code === 'TRUST_515_VERIFY_501C3';
	const showBeneLinkage = code === 'TRUST_BENEFICIARY_LINKAGE_REQUIRED' || code === 'TRUST_635_RECIPIENT_REQUIRED';
	const showTaxesActions = code === 'TRUST_505_705_LIKELY_MISROUTED';
	const showBusinessIncome = code === 'TRUST_450_BUSINESS_INCOME_BLOCKED';
	const show310K1 = code === 'TRUST_310_FLAG_K1_ISSUANCE';
	const show310DemandNote = code === 'TRUST_310_DEMAND_NOTE_NOT_EXHAUSTED';
	const show455K1 = code === 'TRUST_455_FLAG_K1_ISSUANCE';
	const show510_1099 = code === 'TRUST_510_FLAG_1099_ISSUANCE';
	const showAssetRepost = code === 'TRUST_ASSET_REPOST_REVIEW';
	const showDisposalLoan = code === 'TRUST_DISPOSAL_WITH_OUTSTANDING_LOAN';
	const showNoReceiptActions = code === 'TRUST_NO_RECEIPT_POSSIBLE_DISTRIBUTION';
	const showNonTrustActions = code === 'TRUST_NON_TRUST_CATEGORY_USED';
	const showDemandNoteMissing = code === 'TRUST_DEMAND_NOTE_MISSING_NOTE';
	const showRentalProperty = code === 'TRUST_DEFERRED_RENTAL_NET_NEEDED';
	const showPersonalUseLease = code === 'TRUST_DEFERRED_PERSONAL_USE_LEASE';
	const showReclassifyAsset = code === 'TRUST_ASSET_REPOST_REVIEW';
	const showRequestPersonalUseLease = code === 'TRUST_DEFERRED_PERSONAL_USE_LEASE';
	const showDraftPromissoryNote = code === 'TRUST_DEMAND_NOTE_MISSING_NOTE';
	const showReclassify450 = code === 'TRUST_450_BUSINESS_INCOME_BLOCKED';
	const showRecategorizeNonTrust = code === 'TRUST_NON_TRUST_CATEGORY_USED';
	const showLinkToProperty = code === 'TRUST_DEFERRED_RENTAL_NET_NEEDED';
	const showApplyTagSuggested = code === 'TRUST_TAG_SUGGESTED';
	const showApplyTagPicker = code === 'TRUST_PROPERTY_EXPENSE_UNTAGGED';
	const showUndoAutoTag = code === 'TRUST_TAG_AUTO_APPLIED';
	// Both the open 710-attribution code and the two decisioned reroute
	// codes surface the Beneficiary + Trustee actions. On decisioned rows
	// the action reverses the prior reroute and reposts on the new target
	// (handled inside the server actions).
	const showMeAttribution =
		code === 'TRUST_710_ATTRIBUTION_REQUIRED'
		|| code === 'TRUST_710_REROUTED_TO_FOOD'
		|| code === 'TRUST_710_REROUTED_TO_DEMAND_NOTE'
		|| code === 'TRUST_710_ATTRIBUTED_TO_TRUSTEE';
	const showDepositClassify = code === 'TRUST_DEPOSIT_NEEDS_CORPUS_OR_INCOME_CLASSIFICATION';
	const showCapitalGainClassify = code === 'TRUST_CAPITAL_GAIN_NEEDS_HOLDING_PERIOD';

	// Beneficiary picks for the 710 assign button — same shape as the
	// existing inline picker options.
	const beneficiaryPicks: BeneficiaryPick[] = beneficiaryOptions.map((b) => ({
		id: b.id,
		fullName: b.fullName,
		ageNote: b.ageNote,
	}));

	const renderRow = (r: FindingRowData) => {
		const accountNumber =
			(r.metadata as { accountNumber?: string } | null)?.accountNumber ?? null;
		const txnId = r.jeSourceType === 'transaction' ? r.jeSourceId : null;
		const isOpen = !r.dismissedAt;
		const isSelected = isRowSelected(r.id);
		return (
			<tr
				key={r.id}
				className={`border-t border-zinc-100 dark:border-zinc-800 ${
					r.dismissedAt ? 'opacity-60' : ''
				} ${isSelected ? 'bg-blue-50/40 dark:bg-blue-900/10' : ''}`}
			>
				<td className="w-8 px-3 py-2 align-top">
					<input
						type="checkbox"
						aria-label={`Select finding ${r.id.slice(0, 8)}`}
						checked={isSelected}
						onChange={(e) => toggleRow(r.id, e.currentTarget.checked)}
						disabled={!isOpen}
					/>
				</td>
				<td className="px-4 py-2 align-top tabular-nums text-zinc-700 dark:text-zinc-300">
					<div>{r.jeDate ?? '—'}</div>
					<div className="text-xs text-zinc-500">
						flagged {r.createdAt.slice(0, 10)}
					</div>
				</td>
				<td className="px-4 py-2 align-top text-zinc-700 dark:text-zinc-300">
					{r.jeContactName ? (
						<span className="max-w-xs truncate" title={r.jeContactName}>
							{r.jeContactName}
						</span>
					) : (
						<span className="text-zinc-400">—</span>
					)}
				</td>
				<td className="px-4 py-2 align-top text-right tabular-nums text-zinc-700 dark:text-zinc-300">
					{r.jeAmount !== null ? (
						CURRENCY_FMT.format(r.jeAmount)
					) : (
						<span className="text-zinc-400">—</span>
					)}
				</td>
				<td className="px-4 py-2 align-top text-zinc-700 dark:text-zinc-300">
					<Link
						href={`/journal-entries/${r.journalEntryId}`}
						className="font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
					>
						{r.journalEntryId.slice(0, 8)}
					</Link>
					{r.jeMemo && (
						<div
							className="mt-0.5 max-w-xs truncate text-xs text-zinc-500"
							title={r.jeMemo}
						>
							{r.jeMemo}
						</div>
					)}
					{accountNumber && (
						<div className="mt-0.5 text-xs text-zinc-500">acct {accountNumber}</div>
					)}
				</td>
				<td className="px-4 py-2 align-top text-zinc-700 dark:text-zinc-300">
					<div className="max-w-2xl">{r.message}</div>
					{r.dismissedAt && (
						<div className="mt-1 text-xs italic text-zinc-500">
							dismissed {r.dismissedAt.slice(0, 10)}
							{r.dismissedByEmail ? ` by ${r.dismissedByEmail}` : ''}
							{r.dismissedNote ? ` — "${r.dismissedNote}"` : ''}
						</div>
					)}
				</td>
				<td className="px-4 py-2 align-top">
					<div className="flex items-start justify-end gap-2">
						{showBeneLinkage && isOpen && r.jeContactId && (
							<BeneficiaryLinkageContactActions
								contactName={r.jeContactName ?? 'this contact'}
								findingIds={[r.id]}
								beneficiaries={beneficiaryOptions}
								allAccounts={allAccounts}
								muted
							/>
						)}
						{showMeAttribution && isOpen && (
							<>
								<AssignBeneficiaryButton
									findingId={r.id}
									beneficiaries={beneficiaryPicks}
									kind="710"
								/>
								<AssignTrusteeButton
									findingId={r.id}
									trustees={trusteeOptions}
									kind="710"
								/>
							</>
						)}
						{showFoodClothingBene && foodClothingBeneKind && isOpen && (
							<AssignBeneficiaryButton
								findingId={r.id}
								beneficiaries={beneficiaryPicks}
								kind={foodClothingBeneKind}
							/>
						)}
						{showFoodClothingTrustee && isOpen && (
							<AssignTrusteeButton
								findingId={r.id}
								trustees={trusteeOptions}
								kind="815"
							/>
						)}
						{showNoReceiptActions && isOpen && r.jeContactId && (
							<NoReceiptContactActions
								contactName={r.jeContactName ?? 'this contact'}
								findingIds={[r.id]}
								beneficiaries={beneficiaryPicks}
								allAccounts={allAccounts}
								transactionId={txnId}
								muted
							/>
						)}
						{showDepositClassify && isOpen && (
							<ClassifyDepositButtons
								findingId={r.id}
								incomeAccounts={incomeAccounts}
							/>
						)}
						{showCapitalGainClassify && isOpen && (
							<ClassifyCapitalGainButtons
								findingId={r.id}
								corpusAvailable={corpusAvailable}
							/>
						)}
						{showTaxesActions && isOpen && r.jeContactId && (
							<TaxesContactActions
								contactName={r.jeContactName ?? 'this contact'}
								findingIds={[r.id]}
								allAccounts={allAccounts}
								muted
							/>
						)}
						{showLinkToLoan && isOpen && r.jeContactId && (
							<LoanPaymentContactActions
								contactId={r.jeContactId}
								contactName={r.jeContactName ?? 'this contact'}
								findingIds={[r.id]}
								allLoans={loans}
								contactLoans={
									vendorClassificationByContact?.[r.jeContactId]?.loans ?? []
								}
								creditCardAccounts={creditCardAccounts ?? []}
								leaseAccounts={leaseAccounts ?? []}
								allAccounts={allAccounts}
								muted
							/>
						)}
						{show310DemandNote && isOpen && r.jeContactId && (
							<Distribution310DemandNoteContactActions
								contactName={r.jeContactName ?? 'this contact'}
								findingIds={[r.id]}
								allAccounts={allAccounts}
								muted
							/>
						)}
						{show310K1 && isOpen && r.jeContactId && (
							<Distribution310K1ContactActions
								contactName={r.jeContactName ?? 'this contact'}
								findingIds={[r.id]}
								allAccounts={allAccounts}
								muted
							/>
						)}
						{show455K1 && isOpen && r.jeContactId && (
							<K1Income455ContactActions
								contactName={r.jeContactName ?? 'this contact'}
								findingIds={[r.id]}
								allAccounts={allAccounts}
								muted
							/>
						)}
						{show510_1099 && isOpen && r.jeContactId && (
							<Trustee1099ContactActions
								contactName={r.jeContactName ?? 'this contact'}
								findingIds={[r.id]}
								trustees={trusteeOptions}
								allAccounts={allAccounts}
								muted
							/>
						)}
						{showVehicleExpense && isOpen && r.jeContactId && (
							<VehicleExpenseContactActions
								contactId={r.jeContactId}
								contactName={r.jeContactName ?? 'this contact'}
								findingIds={[r.id]}
								vehicles={vehicles ?? []}
								allAccounts={allAccounts}
								muted
							/>
						)}
						{showCharitable && isOpen && r.jeContactId && (
							<CharitableExpenseContactActions
								contactId={r.jeContactId}
								contactName={r.jeContactName ?? 'this contact'}
								findingIds={[r.id]}
								charities={charities ?? []}
								allAccounts={allAccounts}
								muted
							/>
						)}
						{showAssetRepost && isOpen && r.jeContactId && (
							<AssetRepostContactActions
								contactName={r.jeContactName ?? 'this contact'}
								findingIds={[r.id]}
								expenseAccounts={expenseAccounts}
								allAccounts={allAccounts}
								muted
							/>
						)}
						{showDisposalLoan && isOpen && r.jeContactId && (
							<DisposalLoanContactActions
								contactName={r.jeContactName ?? 'this contact'}
								findingIds={[r.id]}
								muted
							/>
						)}
						{showPersonalUseLease && isOpen && r.jeContactId && (
							<PersonalUseLeaseContactActions
								contactName={r.jeContactName ?? 'this contact'}
								findingIds={[r.id]}
								allAccounts={allAccounts}
								muted
							/>
						)}
						{showDemandNoteMissing && isOpen && r.jeContactId && (
							<DemandNoteMissingContactActions
								contactName={r.jeContactName ?? 'this contact'}
								findingIds={[r.id]}
								allAccounts={allAccounts}
								muted
							/>
						)}
						{showBusinessIncome && isOpen && r.jeContactId && (
							<BusinessIncomeContactActions
								contactName={r.jeContactName ?? 'this contact'}
								findingIds={[r.id]}
								allAccounts={allAccounts}
								muted
							/>
						)}
						{showNonTrustActions && isOpen && r.jeContactId && (
							<NonTrustContactActions
								contactName={r.jeContactName ?? 'this contact'}
								findingIds={[r.id]}
								allAccounts={allAccounts}
								muted
							/>
						)}
						{showRentalProperty && isOpen && r.jeContactId && (
							<RentalPropertyContactActions
								contactName={r.jeContactName ?? 'this contact'}
								findingIds={[r.id]}
								rentalProperties={rentalProperties}
								allAccounts={allAccounts}
								muted
							/>
						)}
						{showApplyTagSuggested && isOpen && (
							<ApplyTagButton
								mode="suggested"
								findingId={r.id}
								suggestionLabel={(() => {
									const meta = (r.metadata ?? {}) as {
										tags?: Array<{ entityType: string; entityId: string }>;
									};
									const labels: string[] = [];
									for (const t of meta.tags ?? []) {
										const dim = tagDimensions.find((d) => d.entityType === t.entityType);
										if (!dim) continue;
										const opt = dim.options.find((o) => o.id === t.entityId);
										if (opt) labels.push(`${dim.shortLabel.toLowerCase()} "${opt.label}"`);
									}
									return labels.join(' + ') || 'the suggested tag';
								})()}
							/>
						)}
						{showApplyTagPicker && isOpen && (
							<ApplyTagButton
								mode="picker"
								findingId={r.id}
								dimensions={tagDimensions}
							/>
						)}
						{showUndoAutoTag && !isOpen && (
							<UndoAutoTagButton findingId={r.id} />
						)}
						<DismissButton findingId={r.id} dismissed={!!r.dismissedAt} muted={showLinkToLoan || showVehicleExpense || showCharitable || showBeneLinkage || showTaxesActions || showBusinessIncome || show310K1 || show310DemandNote || show455K1 || show510_1099 || showAssetRepost || showDisposalLoan || showNoReceiptActions || showNonTrustActions || showDemandNoteMissing || showRentalProperty || showPersonalUseLease} />
					</div>
				</td>
			</tr>
		);
	};

	return (
		<div className="overflow-hidden border-t border-zinc-200 dark:border-zinc-800">
			{selectedOpenCount > 0 && (
				<div className="flex items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900">
					<div className="text-zinc-700 dark:text-zinc-300">
						<strong>{selectedOpenCount}</strong> selected
						{bulkError && (
							<span className="ml-3 text-xs text-red-600 dark:text-red-400">{bulkError}</span>
						)}
					</div>
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={() => startTransition(clearSelection)}
							disabled={pending}
							className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
						>
							Clear
						</button>
						{showMeAttribution && (
							<>
								<BulkAssignBeneficiaryButton
									findingIds={selectedOpenIds}
									beneficiaries={beneficiaryPicks}
									kind="710"
									onComplete={clearSelection}
									onPendingChange={onChildPendingChange}
								/>
								<BulkAssignTrusteeButton
									findingIds={selectedOpenIds}
									trustees={trusteeOptions}
									kind="710"
									onComplete={clearSelection}
									onPendingChange={onChildPendingChange}
								/>
							</>
						)}
						{showFoodClothingBene && foodClothingBeneKind && (
							<BulkAssignBeneficiaryButton
								findingIds={selectedOpenIds}
								beneficiaries={beneficiaryPicks}
								kind={foodClothingBeneKind}
								onComplete={clearSelection}
								onPendingChange={onChildPendingChange}
							/>
						)}
						{showFoodClothingTrustee && (
							<BulkAssignTrusteeButton
								findingIds={selectedOpenIds}
								trustees={trusteeOptions}
								kind="815"
								onComplete={clearSelection}
								onPendingChange={onChildPendingChange}
							/>
						)}
						{showAddReceipt && (
							<BulkRerouteNoReceiptButton
								findingIds={selectedOpenIds}
								beneficiaries={beneficiaryPicks}
								onComplete={clearSelection}
								onPendingChange={onChildPendingChange}
							/>
						)}
						{showRecategorizeTaxes && (
							<BulkRecategorizeTaxesButton
								findingIds={selectedOpenIds}
								onComplete={clearSelection}
								onPendingChange={onChildPendingChange}
							/>
						)}
						{showReclassifyAsset && (
							<BulkReclassifyAssetButton
								findingIds={selectedOpenIds}
								expenseAccounts={expenseAccounts}
								onComplete={clearSelection}
								onPendingChange={onChildPendingChange}
							/>
						)}
						{showRecategorizeNonTrust && (
							<BulkRecategorizeNonTrustButton
								findingIds={selectedOpenIds}
								accounts={allAccounts}
								onComplete={clearSelection}
								onPendingChange={onChildPendingChange}
							/>
						)}
						{showLinkToLoan && (
							<LoanPaymentContactActions
								contactName="selected"
								findingIds={selectedOpenIds}
								allLoans={loans}
								contactLoans={[]}
								creditCardAccounts={creditCardAccounts ?? []}
								leaseAccounts={leaseAccounts ?? []}
								allAccounts={allAccounts}
								onPendingChange={onChildPendingChange}
							/>
						)}
						{showVehicleExpense && (
							<VehicleExpenseContactActions
								contactName="selected"
								findingIds={selectedOpenIds}
								vehicles={vehicles ?? []}
								allAccounts={allAccounts}
								onPendingChange={onChildPendingChange}
							/>
						)}
						{showCharitable && (
							<CharitableExpenseContactActions
								contactName="selected"
								findingIds={selectedOpenIds}
								charities={charities ?? []}
								allAccounts={allAccounts}
								onPendingChange={onChildPendingChange}
							/>
						)}
						{showBeneLinkage && (
							<BeneficiaryLinkageContactActions
								contactName="selected"
								findingIds={selectedOpenIds}
								beneficiaries={beneficiaryOptions}
								allAccounts={allAccounts}
								onPendingChange={onChildPendingChange}
							/>
						)}
						{showTaxesActions && (
							<TaxesContactActions
								contactName="selected"
								findingIds={selectedOpenIds}
								allAccounts={allAccounts}
								onPendingChange={onChildPendingChange}
							/>
						)}
						{showBusinessIncome && (
							<BusinessIncomeContactActions
								contactName="selected"
								findingIds={selectedOpenIds}
								allAccounts={allAccounts}
								onPendingChange={onChildPendingChange}
							/>
						)}
						{show310K1 && (
							<Distribution310K1ContactActions
								contactName="selected"
								findingIds={selectedOpenIds}
								allAccounts={allAccounts}
								onPendingChange={onChildPendingChange}
							/>
						)}
						{show310DemandNote && (
							<Distribution310DemandNoteContactActions
								contactName="selected"
								findingIds={selectedOpenIds}
								allAccounts={allAccounts}
								onPendingChange={onChildPendingChange}
							/>
						)}
						{show455K1 && (
							<K1Income455ContactActions
								contactName="selected"
								findingIds={selectedOpenIds}
								allAccounts={allAccounts}
								onPendingChange={onChildPendingChange}
							/>
						)}
						{show510_1099 && (
							<Trustee1099ContactActions
								contactName="selected"
								findingIds={selectedOpenIds}
								trustees={trusteeOptions}
								allAccounts={allAccounts}
								onPendingChange={onChildPendingChange}
							/>
						)}
						{showAssetRepost && (
							<AssetRepostContactActions
								contactName="selected"
								findingIds={selectedOpenIds}
								expenseAccounts={expenseAccounts}
								allAccounts={allAccounts}
								onPendingChange={onChildPendingChange}
							/>
						)}
						{showDisposalLoan && (
							<DisposalLoanContactActions
								contactName="selected"
								findingIds={selectedOpenIds}
								onPendingChange={onChildPendingChange}
							/>
						)}
						{showNoReceiptActions && (
							<NoReceiptContactActions
								contactName="selected"
								findingIds={selectedOpenIds}
								beneficiaries={beneficiaryPicks}
								allAccounts={allAccounts}
								onPendingChange={onChildPendingChange}
							/>
						)}
						{showNonTrustActions && (
							<NonTrustContactActions
								contactName="selected"
								findingIds={selectedOpenIds}
								allAccounts={allAccounts}
								onPendingChange={onChildPendingChange}
							/>
						)}
						{showDemandNoteMissing && (
							<DemandNoteMissingContactActions
								contactName="selected"
								findingIds={selectedOpenIds}
								allAccounts={allAccounts}
								onPendingChange={onChildPendingChange}
							/>
						)}
						{showRentalProperty && (
							<RentalPropertyContactActions
								contactName="selected"
								findingIds={selectedOpenIds}
								rentalProperties={rentalProperties}
								allAccounts={allAccounts}
								onPendingChange={onChildPendingChange}
							/>
						)}
						{showPersonalUseLease && (
							<PersonalUseLeaseContactActions
								contactName="selected"
								findingIds={selectedOpenIds}
								allAccounts={allAccounts}
								onPendingChange={onChildPendingChange}
							/>
						)}
						<button
							type="button"
							onClick={onBulkDismiss}
							disabled={pending}
							className="rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
						>
							{pending ? 'Dismissing…' : `Dismiss ${selectedOpenCount}`}
						</button>
					</div>
				</div>
			)}

			<table className="w-full text-sm">
				<thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
					<tr>
						<th className="w-8 px-3 py-2">
							<input
								type="checkbox"
								aria-label="Select all open rows"
								checked={allOpenSelected}
								ref={(el) => {
									if (el) el.indeterminate = someOpenSelected;
								}}
								onChange={(e) => toggleAll(e.currentTarget.checked)}
								disabled={openItems.length === 0}
							/>
						</th>
						<th className="px-4 py-2 font-medium">Date</th>
						<th className="px-4 py-2 font-medium">Contact</th>
						<th className="px-4 py-2 text-right font-medium">Amount</th>
						<th className="px-4 py-2 font-medium">JE</th>
						<th className="px-4 py-2 font-medium">Message</th>
						<th className="px-4 py-2 text-right font-medium">
							<span className="sr-only">Actions</span>
						</th>
					</tr>
				</thead>
				<tbody>
					{(() => {
						const renderSubGroupTr = (g: SubGroup) => {
								const subSelected = subGroupSelectedCount(g);
								const allSubSelected = g.openItems.length > 0 && subSelected === g.openItems.length;
								const someSubSelected = subSelected > 0 && !allSubSelected;
								const expanded = expandedSubGroups.has(g.key);
								const subOpenIds = g.openItems.map((r) => r.id);
								const firstItem = g.items[0];
								const contactIdForActions = firstItem?.jeContactId ?? null;
								const contactCls = contactIdForActions
									? vendorClassificationByContact?.[contactIdForActions]
									: null;
								return (
									<Fragment key={g.key}>
										<tr className="border-t-2 border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/60">
											<td className="w-8 px-3 py-2 align-middle">
												<input
													type="checkbox"
													aria-label={`Select all ${g.contactName} rows`}
													checked={allSubSelected}
													ref={(el) => {
														if (el) el.indeterminate = someSubSelected;
													}}
													onChange={(e) => toggleSubGroupAll(g, e.currentTarget.checked)}
													disabled={g.openItems.length === 0}
												/>
											</td>
											<td colSpan={5} className="px-4 py-2">
												<button
													type="button"
													onClick={() => toggleSubGroup(g.key)}
													aria-expanded={expanded}
													className="flex items-center gap-2 text-left text-sm font-medium text-zinc-800 hover:opacity-80 dark:text-zinc-200"
												>
													<svg
														viewBox="0 0 20 20"
														width="12"
														height="12"
														fill="currentColor"
														className={`shrink-0 text-zinc-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
														aria-hidden="true"
													>
														<path
															fillRule="evenodd"
															d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
															clipRule="evenodd"
														/>
													</svg>
													{g.contactName}
													<span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-medium tabular-nums text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
														{g.openItems.length.toLocaleString()}
													</span>
													{g.items.length > g.openItems.length && (
														<span className="text-xs text-zinc-500">
															+ {(g.items.length - g.openItems.length).toLocaleString()} dismissed
														</span>
													)}
													{subSelected > 0 && (
														<span className="ml-2 text-xs font-normal text-blue-600 dark:text-blue-400">
															{subSelected.toLocaleString()} selected
														</span>
													)}
												</button>
											</td>
											<td className="px-4 py-2 align-middle">
												{g.openItems.length > 0 && (
													<div className="flex items-center justify-end gap-2">
														{showMeAttribution && (
															<>
																<BulkAssignBeneficiaryButton
																	findingIds={subOpenIds}
																	beneficiaries={beneficiaryPicks}
																	kind="710"
																	onPendingChange={onChildPendingChange}
																/>
																<BulkAssignTrusteeButton
																	findingIds={subOpenIds}
																	trustees={trusteeOptions}
																	kind="710"
																	onPendingChange={onChildPendingChange}
																/>
															</>
														)}
														{showFoodClothingBene && foodClothingBeneKind && (
															<BulkAssignBeneficiaryButton
																findingIds={subOpenIds}
																beneficiaries={beneficiaryPicks}
																kind={foodClothingBeneKind}
																onPendingChange={onChildPendingChange}
															/>
														)}
														{showFoodClothingTrustee && (
															<BulkAssignTrusteeButton
																findingIds={subOpenIds}
																trustees={trusteeOptions}
																kind="815"
																onPendingChange={onChildPendingChange}
															/>
														)}
														{showAddReceipt && (
															<BulkRerouteNoReceiptButton
																findingIds={subOpenIds}
																beneficiaries={beneficiaryPicks}
																onPendingChange={onChildPendingChange}
															/>
														)}
														{showRecategorizeTaxes && (
															<BulkRecategorizeTaxesButton
																findingIds={subOpenIds}
																onPendingChange={onChildPendingChange}
															/>
														)}
														{showReclassifyAsset && (
															<BulkReclassifyAssetButton
																findingIds={subOpenIds}
																expenseAccounts={expenseAccounts}
																onPendingChange={onChildPendingChange}
															/>
														)}
														{showRecategorizeNonTrust && (
															<BulkRecategorizeNonTrustButton
																findingIds={subOpenIds}
																accounts={allAccounts}
																onPendingChange={onChildPendingChange}
															/>
														)}
														{isLoanPayment && contactIdForActions && (
															<LoanPaymentContactActions
																contactId={contactIdForActions}
																contactName={g.contactName}
																findingIds={subOpenIds}
																allLoans={loans}
																contactLoans={contactCls?.loans ?? []}
																creditCardAccounts={creditCardAccounts ?? []}
																leaseAccounts={leaseAccounts ?? []}
																allAccounts={allAccounts}
																onPendingChange={onChildPendingChange}
															/>
														)}
														{showVehicleExpense && contactIdForActions && (
															<VehicleExpenseContactActions
																contactId={contactIdForActions}
																contactName={g.contactName}
																findingIds={subOpenIds}
																vehicles={vehicles ?? []}
																allAccounts={allAccounts}
																onPendingChange={onChildPendingChange}
															/>
														)}
														{showCharitable && contactIdForActions && (
															<CharitableExpenseContactActions
																contactId={contactIdForActions}
																contactName={g.contactName}
																findingIds={subOpenIds}
																charities={charities ?? []}
																allAccounts={allAccounts}
																onPendingChange={onChildPendingChange}
															/>
														)}
														{showBeneLinkage && contactIdForActions && (
															<BeneficiaryLinkageContactActions
																contactId={contactIdForActions}
																contactName={g.contactName}
																findingIds={subOpenIds}
																beneficiaries={beneficiaryOptions}
																allAccounts={allAccounts}
																onPendingChange={onChildPendingChange}
															/>
														)}
														{showTaxesActions && contactIdForActions && (
															<TaxesContactActions
																contactId={contactIdForActions}
																contactName={g.contactName}
																findingIds={subOpenIds}
																allAccounts={allAccounts}
																onPendingChange={onChildPendingChange}
															/>
														)}
														{showBusinessIncome && contactIdForActions && (
															<BusinessIncomeContactActions
																contactId={contactIdForActions}
																contactName={g.contactName}
																findingIds={subOpenIds}
																allAccounts={allAccounts}
																onPendingChange={onChildPendingChange}
															/>
														)}
														{show310K1 && contactIdForActions && (
															<Distribution310K1ContactActions
																contactName={g.contactName}
																findingIds={subOpenIds}
																allAccounts={allAccounts}
																onPendingChange={onChildPendingChange}
															/>
														)}
														{show310DemandNote && contactIdForActions && (
															<Distribution310DemandNoteContactActions
																contactName={g.contactName}
																findingIds={subOpenIds}
																allAccounts={allAccounts}
																onPendingChange={onChildPendingChange}
															/>
														)}
														{show455K1 && contactIdForActions && (
															<K1Income455ContactActions
																contactName={g.contactName}
																findingIds={subOpenIds}
																allAccounts={allAccounts}
																onPendingChange={onChildPendingChange}
															/>
														)}
														{show510_1099 && contactIdForActions && (
															<Trustee1099ContactActions
																contactName={g.contactName}
																findingIds={subOpenIds}
																trustees={trusteeOptions}
																allAccounts={allAccounts}
																onPendingChange={onChildPendingChange}
															/>
														)}
														{showAssetRepost && contactIdForActions && (
															<AssetRepostContactActions
																contactName={g.contactName}
																findingIds={subOpenIds}
																expenseAccounts={expenseAccounts}
																allAccounts={allAccounts}
																onPendingChange={onChildPendingChange}
															/>
														)}
														{showDisposalLoan && contactIdForActions && (
															<DisposalLoanContactActions
																contactName={g.contactName}
																findingIds={subOpenIds}
																onPendingChange={onChildPendingChange}
															/>
														)}
														{showNoReceiptActions && contactIdForActions && (
															<NoReceiptContactActions
																contactName={g.contactName}
																findingIds={subOpenIds}
																beneficiaries={beneficiaryPicks}
																allAccounts={allAccounts}
																onPendingChange={onChildPendingChange}
															/>
														)}
														{showNonTrustActions && contactIdForActions && (
															<NonTrustContactActions
																contactName={g.contactName}
																findingIds={subOpenIds}
																allAccounts={allAccounts}
																onPendingChange={onChildPendingChange}
															/>
														)}
														{showDemandNoteMissing && contactIdForActions && (
															<DemandNoteMissingContactActions
																contactName={g.contactName}
																findingIds={subOpenIds}
																allAccounts={allAccounts}
																onPendingChange={onChildPendingChange}
															/>
														)}
														{showRentalProperty && contactIdForActions && (
															<RentalPropertyContactActions
																contactName={g.contactName}
																findingIds={subOpenIds}
																rentalProperties={rentalProperties}
																allAccounts={allAccounts}
																onPendingChange={onChildPendingChange}
															/>
														)}
														{showPersonalUseLease && contactIdForActions && (
															<PersonalUseLeaseContactActions
																contactName={g.contactName}
																findingIds={subOpenIds}
																allAccounts={allAccounts}
																onPendingChange={onChildPendingChange}
															/>
														)}
														<SubGroupDismissIconButton
															findingIds={subOpenIds}
															contactName={g.contactName}
															onPendingChange={onChildPendingChange}
														/>
													</div>
												)}
											</td>
										</tr>
										{expanded && g.items.map((r) => renderRow(r))}
									</Fragment>
								);
							};

						if (isLoanPayment) {
							return vendorBuckets.map((bucket) => {
								const bucketExpanded = expandedVendorBuckets.has(bucket.key);
								const contactCount = bucket.subGroups.length;
								const totalOpen = bucket.subGroups.reduce(
									(acc, g) => acc + g.openItems.length,
									0,
								);
								return (
									<Fragment key={bucket.key}>
										<tr className="border-t-2 border-zinc-300 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900">
											<td colSpan={7} className="px-4 py-2">
												<button
													type="button"
													onClick={() => toggleVendorBucket(bucket.key)}
													aria-expanded={bucketExpanded}
													className="flex w-full items-center gap-2 text-left text-sm font-semibold uppercase tracking-wide text-zinc-700 hover:opacity-80 dark:text-zinc-200"
													disabled={contactCount === 0}
												>
													<svg
														viewBox="0 0 20 20"
														width="12"
														height="12"
														fill="currentColor"
														className={`shrink-0 text-zinc-400 transition-transform ${bucketExpanded && contactCount > 0 ? 'rotate-90' : ''}`}
														aria-hidden="true"
													>
														<path
															fillRule="evenodd"
															d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
															clipRule="evenodd"
														/>
													</svg>
													{bucket.label}
													<span className="rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-medium tabular-nums text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
														{contactCount === 0
															? 'none'
															: `${contactCount} contact${contactCount === 1 ? '' : 's'} · ${totalOpen.toLocaleString()} open`}
													</span>
												</button>
											</td>
										</tr>
										{bucketExpanded && bucket.subGroups.map((g) => renderSubGroupTr(g))}
									</Fragment>
								);
							});
						}
						if (subGroupByContact) {
							return subGroups.map((g) => renderSubGroupTr(g));
						}
						return cappedItems.map((r) => renderRow(r));
					})()}
				</tbody>
			</table>
			{(isCapped || showAllRows) && items.length > ROW_RENDER_CAP && (
				<div className="flex items-center justify-between border-t border-zinc-200 bg-zinc-50 px-4 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
					<span>
						Showing {cappedItems.length.toLocaleString()} of{' '}
						{items.length.toLocaleString()} rows.{' '}
						{!showAllRows && (
							<span>
								Bulk actions still target all{' '}
								<strong>{openItems.length.toLocaleString()}</strong> open rows.
							</span>
						)}
					</span>
					<button
						type="button"
						onClick={() => setShowAllRows((v) => !v)}
						className="rounded-md border border-zinc-300 px-2 py-1 hover:bg-white dark:border-zinc-700 dark:hover:bg-zinc-800"
					>
						{showAllRows
							? `Show first ${ROW_RENDER_CAP.toLocaleString()}`
							: `Show all ${items.length.toLocaleString()}`}
					</button>
				</div>
			)}
		</div>
	);
}

/**
 * Icon-style bulk dismiss for the sub-group header — mirrors the rose-X
 * visual of per-row DismissButton so the three header actions
 * (assign-beneficiary / assign-trustee / dismiss) share the same pill
 * vocabulary as the row actions immediately below. One click dismisses
 * every open finding in that contact's group.
 */
function SubGroupDismissIconButton({
	findingIds,
	contactName,
	onPendingChange,
}: {
	findingIds: string[];
	contactName: string;
	onPendingChange?: (pending: boolean) => void;
}) {
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		onPendingChange?.(pending);
	}, [pending, onPendingChange]);

	const disabled = pending || findingIds.length === 0;
	const title = `Dismiss all ${findingIds.length} open finding${findingIds.length === 1 ? '' : 's'} for ${contactName}`;

	const onClick = () => {
		if (disabled) return;
		setError(null);
		startTransition(async () => {
			const r = await bulkDismissFindings({ findingIds });
			if (!r.ok) setError(r.error ?? 'Failed');
		});
	};

	return (
		<div className="flex flex-col items-end gap-1">
			<button
				type="button"
				onClick={onClick}
				disabled={disabled}
				title={title}
				aria-label={title}
				className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-rose-300 bg-rose-50 text-rose-700 transition-colors hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-800 dark:bg-rose-900/30 dark:text-rose-300 dark:hover:bg-rose-900/50"
			>
				{pending ? (
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin" aria-hidden="true">
						<path d="M21 12a9 9 0 11-6.219-8.56" />
					</svg>
				) : (
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<line x1="18" y1="6" x2="6" y2="18" />
						<line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				)}
			</button>
			{error && <span className="text-xs text-red-600">{error}</span>}
		</div>
	);
}
