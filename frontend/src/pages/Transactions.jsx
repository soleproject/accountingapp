import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useMoneyFmt, useDateFmt } from "@/lib/company";
import { useCompany } from "@/lib/company";
import { useAiFocus } from "@/lib/aiFocus";
import { useIsMobile } from "@/lib/useIsMobile";
import MobileTxnCards from "@/components/MobileTxnCards";
import { TID } from "@/constants/testIds";
import { toast } from "sonner";
import {
  Check, Wand2, Split, Link as LinkIcon, RotateCw, Plus, X, Trash2, AlertTriangle, ShieldCheck,
  ChevronLeft, ChevronRight, Search, Calendar, XCircle, Tag, Sparkles, MoreHorizontal,
  List as ListIcon, LayoutGrid, ArrowLeftRight, HelpCircle, Pencil, User as UserIcon,
  SlidersHorizontal,
} from "lucide-react";
import ReclassifyPicker from "@/components/ReclassifyPicker";
import ContactPickerModal from "@/components/ContactPickerModal";
import BulkConfirmModal from "@/components/BulkConfirmModal";
import BulkUpdateModal from "@/components/BulkUpdateModal";
import { CreateRuleModal } from "@/pages/Rules";
import CleanupCopilot, { NextStepCard } from "@/components/CleanupCopilot";
import AccountPicker from "@/components/AccountPicker";
import { MatchDot } from "@/components/MatchDot";
import MonthCloseBreadcrumb from "@/components/MonthCloseBreadcrumb";
import AskClientButton from "@/components/AskClientButton";
import { AccountInfoTooltip } from "@/components/AccountInfoTooltip";
import { ProvenanceDot } from "@/components/ProvenanceDot";
import { ContactBadge } from "@/components/ContactBadge";
import { emitAction, useActionListener } from "@/lib/createBus";
import { useLetsReviewNav } from "@/pages/LetsReview";
import { useNoContactReviewNav, NoContactReviewListToggle, ListModeView } from "@/pages/NoContactReview";
import Step2Tour, { hasSeenStep2Tour } from "@/components/Step2Tour";
import Step3BTour, { hasSeenStep3BTour } from "@/components/Step3BTour";
import { useAuth } from "@/lib/auth";

const PAGE_SIZE_OPTIONS = [25, 50, 100, 250, 500];

/** "New" dropdown that surfaces both the quick-modal manual entry
 * (kept for one-off Plaid-style categorization) and the five full-
 * page editors (Expense, Sales Receipt, Deposit, Credit Memo, Refund
 * Receipt). In Simple accounting mode, only the Quick manual entry
 * is shown — regular business owners don't need the QBO-shaped
 * editors and a shorter menu is less overwhelming. */
function NewTransactionMenu({ onQuick, advanced }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const items = [
    { label: "Quick manual entry",  desc: "Single-line categorization",
      onClick: onQuick,
      testId: TID.txnAddBtn },
    ...(advanced ? [
      { divider: true, label: "QBO-shaped entries" },
      { label: "Expense",         desc: "Pay a vendor from a bank account",
        onClick: () => navigate("/purchases/new"),
        testId: "txn-new-purchase" },
      { label: "Sales Receipt",   desc: "Customer paid at time of sale",
        onClick: () => navigate("/sales-receipts/new"),
        testId: "txn-new-sales-receipt" },
      { label: "Bank Deposit",    desc: "Inflow with no customer (interest, rebates, owner)",
        onClick: () => navigate("/deposits/new"),
        testId: "txn-new-deposit" },
      { label: "Credit Memo",     desc: "Reduce A/R without a cash refund",
        onClick: () => navigate("/credit-memos/new"),
        testId: "txn-new-credit-memo" },
      { label: "Refund Receipt",  desc: "Cash refund back to a customer",
        onClick: () => navigate("/refund-receipts/new"),
        testId: "txn-new-refund-receipt" },
    ] : []),
  ];
  // Simple mode: single item, no dropdown needed.
  if (!advanced) {
    return (
      <button
        data-testid={TID.txnAddBtn}
        onClick={onQuick}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs"
      >
        <Plus size={13} /> Manual Transaction
      </button>
    );
  }
  return (
    <div ref={rootRef} className="relative">
      <button
        data-testid="txn-new-menu-btn"
        onClick={() => setOpen(v => !v)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs"
      >
        <Plus size={13} /> New transaction
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 w-72 bg-white border border-slate-200 rounded-lg shadow-lg z-30 py-1"
          data-testid="txn-new-menu"
        >
          {items.map((it, i) => it.divider ? (
            <div key={i} className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-slate-400 border-t border-slate-100 mt-1 first:border-t-0 first:mt-0">
              {it.label}
            </div>
          ) : (
            <button
              key={i}
              onClick={() => { setOpen(false); it.onClick && it.onClick(); }}
              className="w-full text-left px-3 py-2 hover:bg-slate-50 flex flex-col gap-0.5"
              data-testid={it.testId}
            >
              <span className="text-sm font-medium text-slate-800">{it.label}</span>
              <span className="text-[11px] text-slate-500">{it.desc}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


// Per-row "More" dropdown for the actions we don't want cluttering the row:
// AI re-categorize, Split, and Link-to-invoice/bill. Opens on click, closes
// on outside click or Escape. Positioned above the button so the menu never
// clips off the bottom of the viewport on the last few rows.
function RowMoreMenu({ t, onEdit, onRecategorize, onSplit, onLink, onDelete, onAskClient }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (menuRef.current?.contains(e.target)) return;
      if (btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const item = "flex items-center justify-between gap-3 w-full px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50";
  const handle = (fn) => () => { setOpen(false); fn(); };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        title="More actions"
        data-testid={`txn-more-${t.id}`}
        onClick={() => setOpen(v => !v)}
        className={`p-1 rounded hover:bg-slate-100 ${open ? "bg-slate-100 text-slate-900" : "text-slate-500"}`}
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div
          ref={menuRef}
          data-testid={`txn-more-menu-${t.id}`}
          className="absolute right-0 z-30 mt-1 w-52 rounded-md border border-slate-200 bg-white shadow-lg py-1"
        >
          <button data-testid={`txn-edit-${t.id}`} onClick={handle(onEdit)} className={item}>
            <span>Edit transaction</span>
            <Pencil size={13} className="text-slate-700" />
          </button>
          <button data-testid={TID.txnRecategorize} onClick={handle(onRecategorize)} className={item}>
            <span>AI re-categorize</span>
            <RotateCw size={13} className="text-indigo-600" />
          </button>
          <button data-testid={TID.txnSplit} onClick={handle(onSplit)} className={item}>
            <span>Split</span>
            <Split size={13} className="text-violet-600" />
          </button>
          <button data-testid={TID.txnLink} onClick={handle(onLink)} className={item}>
            <span>Link to invoice / bill</span>
            <LinkIcon size={13} className="text-blue-600" />
          </button>
          <button
            data-testid={`txn-ask-client-${t.id}`}
            onClick={handle(onAskClient)}
            className={item}
          >
            <span>Ask client about this</span>
            <HelpCircle size={13} className="text-cyan-600" />
          </button>
          <div className="my-1 border-t border-slate-100" />
          <button data-testid={TID.deleteBtn} onClick={handle(onDelete)} className={`${item} text-red-600 hover:bg-red-50`}>
            <span>Delete</span>
            <Trash2 size={13} className="text-red-500" />
          </button>
        </div>
      )}
    </div>
  );
}

// Single modal instance shared across all rows. The row menu calls
// `registerRef.current(txn)` to pop it open with that transaction — cheaper
// than mounting one AskClientButton per row for large lists.
function AskClientLauncher({ registerRef, onAsked }) {
  const [txn, setTxn] = useState(null);
  useEffect(() => {
    registerRef.current = (t) => setTxn(t);
    return () => { registerRef.current = null; };
  }, [registerRef]);
  return (
    <AskClientButton
      txn={txn}
      open={Boolean(txn)}
      onClose={() => setTxn(null)}
      onAsked={() => { onAsked?.(); setTxn(null); }}
    />
  );
}

// A tiny "client answered → AI proposes X" pill that renders below the
// confidence chip when a client's magic-link reply produced a categorization
// proposal. Accept applies the category with one click; dismiss drops the
// proposal but keeps the answer text on the row.
function ProposalPill({ proposal, onAccept, onDismiss }) {
  const conf = Number(proposal?.confidence || 0);
  const confColor = conf >= 0.8 ? "bg-emerald-50 text-emerald-800 border-emerald-200"
    : conf >= 0.5 ? "bg-amber-50 text-amber-800 border-amber-200"
    : "bg-slate-50 text-slate-700 border-slate-200";
  return (
    <div
      className={`mt-1 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border ${confColor}`}
      title={proposal.reasoning}
      data-testid="proposal-pill"
    >
      <Sparkles size={9} />
      <span>Client → <b>{proposal.account_name || proposal.account_code}</b></span>
      <button
        onClick={(e) => { e.stopPropagation(); onAccept(); }}
        data-testid="proposal-accept"
        title="Accept — apply this category"
        className="ml-1 inline-flex items-center px-1 rounded hover:bg-white/60"
      >
        <Check size={10} />
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDismiss(); }}
        data-testid="proposal-dismiss"
        title="Dismiss proposal"
        className="inline-flex items-center px-1 rounded hover:bg-white/60"
      >
        <X size={10} />
      </button>
    </div>
  );
}

function ConfidenceChip({ conf, needs_review, human_reviewed }) {
  const v = Number(conf || 0);
  // Needs-review always renders in an attention color regardless of the raw
  // confidence value. Some rows (transfers auto-routed to Uncategorized) have
  // conf=0.95 by design — the chip must not go green on them because the row
  // still requires an accountant to reclassify.
  let cls, label;
  if (human_reviewed) {
    // Green "Reviewed" chip — human (or QBO books-close ratchet) has
    // signed off. Confidence is display-only at this point. Feb 28 2026.
    cls = "confidence-high";
    label = "Reviewed";
  } else if (needs_review) {
    cls = v < 0.70 ? "confidence-low" : "confidence-med";  // rose vs amber
    label = "Needs review";
  } else {
    cls = v >= 0.85 ? "confidence-high" : v >= 0.70 ? "confidence-med" : "confidence-low";
    label = v >= 0.85 ? "High" : v >= 0.70 ? "Medium" : "Low";
  }
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${cls}`}>
      {(human_reviewed || !needs_review) ? <ShieldCheck size={10} /> : <AlertTriangle size={10} />}
      {label} · {(v * 100).toFixed(0)}%
    </span>
  );
}

export default function Transactions() {
  const { currentId, isAdvancedMode } = useCompany();
  const fmtMoney = useMoneyFmt();
  const fmtDate = useDateFmt();
  const { setFocus } = useAiFocus();
  const isMobile = useIsMobile();
  // Company-level opt-in flag for provenance dots (Settings toggle).
  // Fetched on mount; when true, each txn row shows a colored dot
  // next to its category indicating which tier decided it.
  const [showProvenance, setShowProvenance] = useState(false);
  useEffect(() => {
    if (!currentId) return;
    api.get(`/companies/${currentId}`).then(r => {
      setShowProvenance(!!r.data?.show_categorization_source_badges);
    }).catch(() => {});
  }, [currentId]);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  // Read the "Let's Review" URL params up-front so `load()` (defined
  // below) can reference them without hitting a TDZ error.
  const isLetsReview = params.get("letsReview") === "1";
  const isReviewDone = params.get("done") === "1";
  const lrContactId = params.get("contact_id") || "";
  const lrContactName = params.get("contact_name") || "";
  const lrIdx = parseInt(params.get("idx") || "1", 10);
  const lrTotal = parseInt(params.get("total") || "1", 10);
  const lrCount = parseInt(params.get("count") || "0", 10);
  const lrTotalAmount = parseFloat(params.get("total_amount") || "0");
  const letsReviewNav = useLetsReviewNav();
  // Declare No-Contact Review mode flags up here (they were previously
  // defined further down) so the bulk-categorize useEffect below can
  // reference them without hitting a Temporal Dead Zone error.
  const isNoContactReview = params.get("noContactReview") === "1";
  const ncrGroupKey = params.get("group_key") || "";
  const ncrLabel = params.get("label") || "";
  const noContactReviewNav = useNoContactReviewNav();
  // In-place list-mode toggle for No-Contact Review. When set, the
  // transactions table is replaced by <ListModeView embedded /> and
  // the "Group X of Y" pill drops its category picker + Prev/Next
  // controls (but keeps its footprint so the surrounding layout
  // doesn't reflow). Powered by ?view=list on the same URL.
  const ncrIsListMode = isNoContactReview && params.get("view") === "list";
  const isReviewMode = isLetsReview || isNoContactReview;

  // Step 2 first-time tour. Fires when the URL carries `?tour=1` AND
  // the client hasn't already seen it for this company. Auto-plays once
  // the contact info box is on-screen. See `firm_glance.py` step2
  // cta_link which appends `&tour=1` to trigger this.
  const { user } = useAuth();
  const { currentId: currentCompanyId } = useCompany();
  const [step2TourOpen, setStep2TourOpen] = useState(false);
  const tourParam = params.get("tour") === "1";
  const replayParam = params.get("replay") === "1";
  useEffect(() => {
    if (!tourParam) return;
    if (!isLetsReview || !lrContactId || !lrContactName) return;
    if (!user?.id || !currentCompanyId) return;
    // `replay=1` bypasses the seen check so the Settings "Replay Step 2
    // tour" button always re-fires the walkthrough.
    if (!replayParam && hasSeenStep2Tour(user.id, currentCompanyId)) return;
    // Wait for the info box + AI panel to mount, then fire.
    const t = setTimeout(() => setStep2TourOpen(true), 900);
    return () => clearTimeout(t);
  }, [tourParam, replayParam, isLetsReview, lrContactId, lrContactName, user?.id, currentCompanyId]);
  const closeStep2Tour = () => setStep2TourOpen(false);
  // Support "Re-play tour" CTA click from the AI panel — restarts the
  // Step 2 tour regardless of the seen flag.
  useActionListener("chat-cta:restart-step2-tour", () => setStep2TourOpen(true));

  // Step 3B first-time tour — same shape as Step 2 but fires when the
  // page is in No-Contact Review mode (`noContactReview=1`). Piggybacks
  // on the same `?tour=1` / `?replay=1` params.
  const [step3bTourOpen, setStep3bTourOpen] = useState(false);
  useEffect(() => {
    if (!tourParam) return;
    if (!isNoContactReview) return;
    if (!user?.id || !currentCompanyId) return;
    if (!replayParam && hasSeenStep3BTour(user.id, currentCompanyId)) return;
    const t = setTimeout(() => setStep3bTourOpen(true), 900);
    return () => clearTimeout(t);
  }, [tourParam, replayParam, isNoContactReview, user?.id, currentCompanyId]);
  const closeStep3BTour = () => setStep3bTourOpen(false);
  // Inline bulk-categorize dropdown in the Let's-Review info card — lets
  // the CPA one-click categorize every currently-visible row for the
  // contact into a chosen GAAP account, bypassing the AI chat entirely.
  // The dropdown now runs in PREVIEW mode — picking a category only
  // updates the on-screen category column for every visible row (via
  // local `txns` state) so the CPA can eyeball the change before
  // committing. Clicking the Approve button next to the header fires
  // the actual bulk-save API call.
  const [bulkCatBusy, setBulkCatBusy] = useState(false);
  const [bulkPreviewAcctId, setBulkPreviewAcctId] = useState("");
  // Snapshot the original category_account_id per row when a preview
  // starts, so we can restore visuals if the user changes their mind
  // (picks a different account or clears the dropdown).
  const bulkPreviewOriginalRef = useRef(null);
  // Reset the preview whenever the current Let's Review contact / No-
  // Contact Review group changes — new stepper page, fresh choice.
  useEffect(() => {
    setBulkPreviewAcctId("");
    bulkPreviewOriginalRef.current = null;
  }, [lrContactId, isLetsReview, ncrGroupKey, isNoContactReview]);
  const previewBulkCategory = (accountId) => {
    // Snapshot originals the first time the CPA touches the dropdown
    // for this contact so we can revert cleanly on re-pick / clear.
    if (bulkPreviewOriginalRef.current === null) {
      bulkPreviewOriginalRef.current = Object.fromEntries(
        (txns || []).map((t) => [t.id, t.category_account_id || ""])
      );
    }
    setBulkPreviewAcctId(accountId || "");
    setTxns((prev) =>
      (prev || []).map((t) => {
        if (!accountId) {
          // Revert to original when cleared.
          const orig = bulkPreviewOriginalRef.current?.[t.id] ?? "";
          return { ...t, category_account_id: orig || null };
        }
        return { ...t, category_account_id: accountId };
      })
    );
  };
  const applyBulkCategoryPreview = async () => {
    const accountId = bulkPreviewAcctId;
    if (!accountId || bulkCatBusy || !currentId) return;
    const acct = accts.find((a) => a.id === accountId);
    // Use the snapshotted row IDs so a mid-flight refresh doesn't shrink
    // the batch. Fall back to the currently-visible rows.
    const ids = bulkPreviewOriginalRef.current
      ? Object.keys(bulkPreviewOriginalRef.current)
      : (txns || []).map((t) => t.id);
    if (ids.length === 0) {
      toast.info("No visible rows to categorize.");
      return;
    }
    setBulkCatBusy(true);
    try {
      const res = await api.post(
        `/companies/${currentId}/transactions/apply-multi-bulk-approve-rule`,
        {
          contact_id: lrContactId || null,
          contact_name: lrContactName || "",
          groups: [{
            txn_ids: ids,
            category_account_id: accountId,
            rule_label: acct ? `${acct.code || ""} ${acct.name || ""}`.trim() : "",
          }],
          // Skip rule creation from the dropdown — it's a one-shot
          // decision the CPA is making without the AI's help; they can
          // always create a persistent rule from Contacts later.
          create_rules: false,
        }
      );
      const updated = res.data?.updated || 0;
      toast.success(
        `Categorized ${updated} ${lrContactName || "row"}${updated === 1 || lrContactName ? "" : "s"} to ${acct?.name || "the selected account"}.`
      );
      // Clear the preview snapshot — the stepper will auto-advance and
      // the freshly-loaded rows should reflect the persisted state.
      bulkPreviewOriginalRef.current = null;
      setBulkPreviewAcctId("");
      // Emit the same cleanup-completed event AiPanel emits after
      // bulk-approve so the Transactions page's stepper listener knows
      // to auto-advance. For Let's Review it fires `contact_in_uncat`
      // (routes back to /accounting/lets-review); for No-Contact Review
      // it fires `no_contact_group` with the group_key so the listener
      // routes to /accounting/no-contact-review instead.
      if (isNoContactReview) {
        emitAction("cleanup-completed", {
          group_key: ncrGroupKey,
          kind: "no_contact_group",
          count: updated,
        });
      } else {
        emitAction("cleanup-completed", {
          contact_id: lrContactId,
          kind: "contact_in_uncat",
          count: updated,
        });
      }
    } catch (e) {
      toast.error("Bulk-categorize failed — try again?");
    } finally {
      setBulkCatBusy(false);
    }
  };
  // No-Contact Review (Step 3) mode flags moved to top of component
  // (see the group above `bulkPreviewAcctId`) so the bulk-categorize
  // useEffect can safely reference them.
  const [txns, setTxns] = useState([]);
  const [accts, setAccts] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [bills, setBills] = useState([]);
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(new Set());
  const [editing, setEditing] = useState(null);
  const [splitting, setSplitting] = useState(null);
  const [linking, setLinking] = useState(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reclassOpen, setReclassOpen] = useState(false);
  const [contactPickerOpen, setContactPickerOpen] = useState(false);
  const [bulkUpdateOpen, setBulkUpdateOpen] = useState(false);
  const [ruleQueue, setRuleQueue] = useState(null);   // guided-rules flow
  // { title, body, confirmLabel, variant, exec } — set by any bulk
  // action that needs a second confirm before writing to Mongo.
  const [pendingConfirm, setPendingConfirm] = useState(null);
  const [ruleSuggestion, setRuleSuggestion] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [pagination, setPagination] = useState({ total: 0, page: 1, pages: 1, limit: 25 });
  // Toolbar filters
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // Advanced filter panel — hidden by default, toggled via the
  // "Advanced filter" link next to the date picker.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [filterBankAccountId, setFilterBankAccountId] = useState("");
  const [filterCategoryId, setFilterCategoryId] = useState("");
  const [filterContactId, setFilterContactId] = useState("");
  const [filterAmountMin, setFilterAmountMin] = useState("");
  const [filterAmountMax, setFilterAmountMax] = useState("");
  // Withdrawal / Deposit pills — mutually exclusive quick filter.
  // "" (none) | "out" (withdrawal / money out) | "in" (deposit / money in)
  const [directionFilter, setDirectionFilter] = useState("");
  // Entity-type chip strip — orthogonal filter to the status buckets
  // above. Kept separate because the two dimensions are orthogonal:
  // a Purchase can be either "ai" or "reviewed", etc.
  const [txnTypeFilter, setTxnTypeFilter] = useState("");
  // Bank-match pending counts by txn_type. Powers the small amber
  // badge on each entity chip so CPAs know at a glance which types
  // have unreviewed silent matches waiting. Fetched once per mode
  // switch — the counts are stable enough that a few seconds of
  // staleness is acceptable.
  const [pendingByType, setPendingByType] = useState({});
  // "list" (default) or "rollup" — toggled by the two icons in the toolbar.
  const [view, setView] = useState("list");
  const [rollup, setRollup] = useState(null);
  // Imperative handle so the row-menu action can pop the AskClient modal
  // for any transaction without mounting one modal per row.
  const askClientRef = useRef(null);
  const [rollupBusy, setRollupBusy] = useState(false);

  // Debounce free-text search so a fast typist doesn't hammer the API.
  // Single-char searches are almost never useful (returns 20K+ matches) and
  // scan the whole corpus, so we require ≥2 chars before firing.
  useEffect(() => {
    const h = setTimeout(() => {
      const s = search.trim();
      setDebouncedSearch(s.length >= 2 ? s : "");
    }, 300);
    return () => clearTimeout(h);
  }, [search]);

  const load = async () => {
    if (!currentId) return;
    const params = new URLSearchParams();
    if (filter === "review") params.set("needs_review", "true");
    else if (filter === "ai" || filter === "uncategorized" || filter === "unapproved" || filter === "reviewed") {
      params.set("status", filter);
    }
    if (debouncedSearch) params.set("q", debouncedSearch);
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
    // Advanced filter params — only include when set so the URL stays
    // clean for the common "no advanced filters" case.
    if (filterBankAccountId) params.set("bank_account_id", filterBankAccountId);
    if (filterCategoryId) params.set("category_account_id", filterCategoryId);
    if (filterContactId) params.set("contact_id", filterContactId);
    if (filterAmountMin) params.set("amount_min", filterAmountMin);
    if (filterAmountMax) params.set("amount_max", filterAmountMax);
    if (directionFilter) params.set("direction", directionFilter);
    if (txnTypeFilter) {
      params.set("txn_type", txnTypeFilter);
      // When explicitly filtering by an editor-authored entity type,
      // surface the matched rows too — the CPA is asking "show me my
      // Sales Receipts" and would be confused if the matched ones
      // vanished. Only the default (unfiltered) ledger hides them.
      params.set("include_matched", "true");
    }
    // "Let's Review" mode pins the list to a single contact so the
    // stepper walks vendor-by-vendor without the user re-typing filters.
    if (isLetsReview && lrContactId) params.set("contact_id", lrContactId);
    // "No-Contact Review" (Step 3) pins the list to a description-signature
    // group so the CPA walks bank-feed noise one bucket at a time. Also
    // hard-force `status=unapproved` so rows already decisioned (e.g.
    // AI-categorized to 3200 Inter-Account Transfer) drop off the view —
    // the CPA should only see rows still waiting for a call.
    if (isNoContactReview) {
      params.set("no_contact", "1");
      params.set("status", "unapproved");
      if (ncrGroupKey && ncrGroupKey !== "__misc__") {
        params.set("desc_group", ncrGroupKey);
      }
    }
    // Same rule for Let's Review — hide anything already human-reviewed so
    // the vendor stepper only shows work that's still open.
    if (isLetsReview) {
      params.set("status", "unapproved");
    }
    params.set("page", String(page));
    params.set("limit", String(pageSize));
    const qs = `?${params.toString()}`;
    const [t, a, i, b] = await Promise.all([
      api.get(`/companies/${currentId}/transactions${qs}`),
      api.get(`/companies/${currentId}/accounts`),
      api.get(`/companies/${currentId}/invoices`),
      api.get(`/companies/${currentId}/bills`),
    ]);
    setTxns(t.data.transactions || []);
    setPagination(t.data.pagination || { total: (t.data.transactions || []).length, page: 1, pages: 1, limit: pageSize });
    setAccts(a.data.accounts || []);
    setInvoices(i.data.invoices || []);
    setBills(b.data.bills || []);
    setSelected(new Set());
  };

  // Contact options for the advanced-filter panel. Fetched once per
  // company since contacts change infrequently relative to txns. The
  // Bank account filter is sourced from `accts` (chart of accounts) so
  // it doesn't need its own fetch — all Asset + Liability rows appear
  // in the dropdown, banks, credit cards, loans and A/R/A/P alike.
  const [filterContactOptions, setFilterContactOptions] = useState([]);
  useEffect(() => {
    if (!currentId) return;
    api.get(`/companies/${currentId}/contacts?limit=500`)
      .catch(() => ({ data: {} }))
      .then((contactsRes) => {
        setFilterContactOptions((contactsRes.data?.contacts || []).map((c) => ({
          id: c.id, name: c.name || c.display_name || "—",
        })));
      });
  }, [currentId]);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId, filter, page, pageSize, debouncedSearch, dateFrom, dateTo, isLetsReview, lrContactId, isNoContactReview, ncrGroupKey, filterBankAccountId, filterCategoryId, filterContactId, filterAmountMin, filterAmountMax, directionFilter, txnTypeFilter]);

  // Fetch unreviewed silent-match counts by txn_type — only in
  // Advanced mode where the chip strip actually renders. Cheap: one
  // API call, then group client-side. Re-runs when the company
  // switches so counts follow the active tenant.
  useEffect(() => {
    if (!currentId || !isAdvancedMode) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get(
          `/companies/${currentId}/bank-matches`,
          { params: { status: "unconfirmed" } });
        if (cancelled) return;
        const by = {};
        for (const p of (r.data.pairs || [])) {
          const t = p.editor?.txn_type;
          if (t) by[t] = (by[t] || 0) + 1;
        }
        setPendingByType(by);
      } catch {
        if (!cancelled) setPendingByType({});
      }
    })();
    return () => { cancelled = true; };
  }, [currentId, isAdvancedMode]);
  // Reset page when filters narrow/widen.
  useEffect(() => { setPage(p => (p === 1 ? p : 1)); }, [debouncedSearch, dateFrom, dateTo]);

  // Rollup fetch — mirrors the list filters so the two views stay in sync.
  const loadRollup = async () => {
    if (!currentId || view !== "rollup") return;
    setRollupBusy(true);
    try {
      const p = new URLSearchParams();
      if (debouncedSearch) p.set("q", debouncedSearch);
      if (dateFrom) p.set("date_from", dateFrom);
      if (dateTo) p.set("date_to", dateTo);
      // Mirror the current status tab so the rollup shows the same slice
      // as the list (esp. important for the AI Categorized tab, which
      // should show ONLY AI-categorized rows grouped by contact).
      if (filter && filter !== "all") p.set("status", filter);
      const r = await api.get(`/companies/${currentId}/transactions/contact-category-rollup?${p.toString()}`);
      setRollup(r.data);
    } finally { setRollupBusy(false); }
  };
  useEffect(() => { loadRollup(); /* eslint-disable-next-line */ }, [currentId, view, filter, debouncedSearch, dateFrom, dateTo]);
  // Any time the user clicks the AI Categorized tab, snap the view to the
  // rollup by default — that's the "contacts + categories" lens the user
  // reaches for on that tab. Clicking any other tab returns to the list.
  useEffect(() => {
    if (filter === "ai") setView("rollup");
    else setView("list");
  }, [filter]);
  // Keep a live ref to `load` so the background sync poller can invoke the
  // CURRENT filter-aware load — not the stale closure from mount. Without
  // this, clicking "Needs Review" briefly shows filtered rows and then the
  // poller (5-15s later) fires the original all-rows load and overwrites
  // them, so the tab stays selected but rows revert to All.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; });
  // AI-panel actions (approve-with-suggestion / bulk-approve-rule) reload us.
  useActionListener("txns:changed", () => { loadRef.current?.(); });

  // Auto-advance the Let's-Review / No-Contact-Review stepper. When the AI
  // Panel finishes bulk-categorizing the current contact/group it emits a
  // `cleanup-completed` event — but our stepper URL params still point at
  // the just-cleared contact, so the info card and the (now-empty) txn list
  // stay stuck. Kick the user forward by re-routing to the parent stepper
  // page, which re-fetches fresh groups and picks up the next uncleared
  // one. Live state ferried through a ref because `useActionListener`
  // binds once (its `[]` deps), so a naive closure would see stale values.
  const reviewCtxRef = useRef({});
  useEffect(() => {
    reviewCtxRef.current = {
      isLetsReview, isNoContactReview, lrContactId, ncrGroupKey, navigate,
      // Ferry the Let's Review navigator so the auto-advance can jump
      // to the NEXT contact (idx+1) after Approve, instead of dropping
      // back to the first uncleared group at idx=0. Aug 24 2026 — the
      // "Contact 4 of 48 → 1 of 48" jump-back bug.
      letsReviewNav,
    };
  }, [isLetsReview, isNoContactReview, lrContactId, ncrGroupKey, navigate, letsReviewNav]);
  useActionListener("cleanup-completed", (payload) => {
    const ctx = reviewCtxRef.current;
    if (!ctx.isLetsReview && !ctx.isNoContactReview) return;
    const completedCid = payload?.contact_id || payload?.contactId;
    if (ctx.isLetsReview && completedCid && completedCid === ctx.lrContactId) {
      // Delay slightly so the toast + "Done" chat message land before the
      // page jumps — matches the 1.2s auto-advance timer in CleanupCopilot.
      setTimeout(() => {
        // Advance to the NEXT contact in the stepper if one exists,
        // otherwise fall back to the base URL (which surfaces "queue
        // complete" state). Fixes the user-reported "Contact 4 of 48 →
        // 1 of 48" regression on Approve. Aug 24 2026.
        if (ctx.letsReviewNav?.next) {
          ctx.letsReviewNav.next();
        } else {
          ctx.navigate("/accounting/lets-review", { replace: true });
        }
      }, 900);
    } else if (ctx.isNoContactReview && (payload?.kind === "no_contact_group" || payload?.group_key)) {
      setTimeout(() => ctx.navigate("/accounting/no-contact-review", { replace: true }), 900);
    }
  });

  // Refs used by the "apply-categorize-proposal" listener below — the
  // useActionListener hook binds its handler once, so we ferry live state
  // (selection, CoA, focused txn) through refs to avoid a stale closure.
  const selectedRef = useRef(selected);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  const acctsRef = useRef(accts);
  useEffect(() => { acctsRef.current = accts; }, [accts]);
  const txnsRef = useRef(txns);
  useEffect(() => { txnsRef.current = txns; }, [txns]);

  // AI proposal follow-through — the AI proposed a category via
  // [[PROPOSAL:action=categorize|category=<Name>|scope=<...>]] and the user
  // just said "yes". Match the category to the local CoA and apply it.
  useActionListener("apply-categorize-proposal", async (payload) => {
    if (!payload?.category) return;
    const acctList = acctsRef.current || [];
    const needle = String(payload.category).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    // Prefer exact-name match; fall back to "name contains" then "needle
    // contains name". Skip retired / uncategorized accounts.
    const active = acctList.filter(a => !a.retired_at);
    let match = active.find(a => norm(a.name) === needle);
    if (!match) match = active.find(a => norm(a.name).includes(needle));
    if (!match) match = active.find(a => needle.includes(norm(a.name)) && norm(a.name).length >= 3);
    if (!match) {
      toast.error(`Couldn't find "${payload.category}" in the chart of accounts.`);
      return;
    }
    const sel = selectedRef.current;
    if (sel && sel.size > 0) {
      // Route through the existing bulk path.
      try {
        setBusy(true);
        const r = await api.post(`/companies/${currentId}/transactions/bulk-reclassify`, {
          transaction_ids: [...sel],
          category_account_id: match.id,
        });
        toast.success(`Reclassified ${r.data.updated} to ${match.name}.`);
        setSelected(new Set());
        if (r.data.rule_suggestion) setRuleSuggestion(r.data.rule_suggestion);
        loadRef.current?.();
      } catch (err) {
        toast.error(err?.response?.data?.detail || "Reclassify failed");
      } finally {
        setBusy(false);
      }
      return;
    }
    // No multi-selection — fall back to the focused row (hover-set).
    const focusedId = payload.focusedTxnId;
    if (focusedId) {
      try {
        await api.patch(`/companies/${currentId}/transactions/${focusedId}`, {
          category_account_id: match.id,
        });
        toast.success(`Recategorized to ${match.name}.`);
        loadRef.current?.();
      } catch (err) {
        toast.error(err?.response?.data?.detail || "Recategorize failed");
      }
      return;
    }
    toast.error("Select rows or hover a transaction first.");
  });
  // Reset ALL filter state on company switch — otherwise sticky filters from
  // the previous company (e.g. a date range) hide most rows on the new one
  // and users think the sync failed. (Real bug: 400 LLC had 1871 rows but a
  // sticky "last month" date filter from a prior company was masking them.)
  useEffect(() => {
    setSearch(""); setDebouncedSearch("");
    setDateFrom(""); setDateTo("");
    setFilter("all"); setPage(1);
  }, [currentId]);
  // Auto-refresh when webhooks silently backfill new rows in the background:
  //   • poll sync-status every 5s while syncing, 15s while idle, and
  //   • whenever pagination.total ≠ status.total_txns (i.e. new rows landed),
  //     re-fetch the current view so counts + rows update without a manual reload.
  //   • also refetch on tab visibility / focus (mirrors Dashboard behavior).
  const paginationTotalRef = useRef(0);
  useEffect(() => { paginationTotalRef.current = pagination.total || 0; }, [pagination.total]);
  useEffect(() => {
    if (!currentId) return;
    let cancelled = false, timer;
    let lastSyncStatus = null;
    // Track the last observed *company-wide* txn total from /sync-status so
    // "did new rows land?" is a whole-company delta — not a filtered-view
    // delta. Comparing against `paginationTotalRef` broke when a filter
    // was active (filtered total ≠ company total → poller thought rows had
    // changed every tick and clobbered the current view).
    let lastCompanyTotal = null;
    const poll = async () => {
      try {
        const r = await api.get(`/companies/${currentId}/sync-status`);
        if (cancelled) return;
        const s = r.data;
        const companyTotal = s.total_txns || 0;
        const rowsChanged = lastCompanyTotal !== null && companyTotal !== lastCompanyTotal;
        const flippedIdle = lastSyncStatus === "syncing" && s.status !== "syncing";
        if (rowsChanged || flippedIdle) loadRef.current();
        lastCompanyTotal = companyTotal;
        lastSyncStatus = s.status;
      } catch { /* ignore */ }
      const delay = lastSyncStatus === "syncing" ? 5_000 : 15_000;
      timer = setTimeout(poll, delay);
    };
    timer = setTimeout(poll, 5_000);
    const onFocus = () => { if (document.visibilityState === "visible") loadRef.current(); };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  const clearFilters = () => {
    setSearch(""); setDateFrom(""); setDateTo(""); setFilter("all");
    setFilterBankAccountId(""); setFilterCategoryId(""); setFilterContactId("");
    setFilterAmountMin(""); setFilterAmountMax(""); setDirectionFilter("");
  };
  const advancedActive = Boolean(
    filterBankAccountId || filterCategoryId || filterContactId ||
    filterAmountMin || filterAmountMax
  );
  const filtersActive = Boolean(debouncedSearch || dateFrom || dateTo || (filter !== "all") || advancedActive || directionFilter);

  // Voice-command deep-link support: /accounting/transactions?q=Walmart or
  // ?date_from=2026-07-15&date_to=2026-07-15. On mount / URL change, hydrate
  // the toolbar state so the user sees a filtered view immediately.
  const paramsKey = params.toString();
  useEffect(() => {
    const q       = params.get("q") || "";
    const df      = params.get("date_from") || "";
    const dt      = params.get("date_to") || "";
    // Accept either `filter` (voice deep-link convention) OR `status` (what
    // Month Close and other outbound links emit — see load() below which
    // writes `status=` back to the URL). Keeping both keeps every entrypoint
    // working without a rename cascade.
    const flt     = params.get("filter") || params.get("status") || "";
    if (q)   setSearch(q);
    if (df)  setDateFrom(df);
    if (dt)  setDateTo(dt);
    if (flt) setFilter(flt);
    // No else-branch: URL params ADD filters; they don't clear existing ones.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey]);

  useEffect(() => {
    const hl = params.get("highlight");
    const opn = params.get("open");
    if (!txns.length) return;
    // If the URL only has a search filter (no highlight id), auto-highlight
    // the top row when exactly one transaction matches — a nice UX for
    // "open the July 15th McDonald's transaction".
    if (!hl) {
      const wasVoiceLookup = params.get("q") || params.get("date_from");
      if (wasVoiceLookup && txns.length === 1) {
        const only = txns[0];
        setTimeout(() => {
          const row = document.querySelector(`[data-txn-id="${only.id}"]`);
          row?.scrollIntoView({ behavior: "smooth", block: "center" });
          row?.classList.add("bg-amber-50");
          setTimeout(() => row?.classList.remove("bg-amber-50"), 3000);
        }, 200);
      }
      return;
    }
    const target = txns.find(t => t.id === hl);
    if (target) {
      // Scroll to the row
      setTimeout(() => {
        const row = document.querySelector(`[data-txn-id="${hl}"]`);
        row?.scrollIntoView({ behavior: "smooth", block: "center" });
        row?.classList.add("bg-amber-50");
        setTimeout(() => row?.classList.remove("bg-amber-50"), 3000);
      }, 200);
      if (opn === "split") setSplitting(target);
    }
  }, [params, txns]);

  // Deep-link `?open=<txn_id>` from the Payments page — auto-opens
  // the Edit Transaction modal so pros can review the source txn
  // behind an auto-created payment in one click.
  useEffect(() => {
    const openId = params.get("open");
    if (!openId || openId === "split") return;
    if (!txns.length) return;
    const t = txns.find(x => x.id === openId);
    if (t && !editing) setEditing(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, txns]);

  const acctById = useMemo(() => Object.fromEntries(accts.map(a => [a.id, a])), [accts]);

  const toggleSel = (id) => {
    const s = new Set(selected);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelected(s);
  };
  const allChecked = txns.length > 0 && txns.every(t => selected.has(t.id));

  const bulkApprove = () => {
    if (!selected.size) return;
    setPendingConfirm({
      title: `Approve ${selected.size} transaction${selected.size === 1 ? "" : "s"}?`,
      body: "Marks the selected rows as human-reviewed. You can still edit individual rows afterwards.",
      confirmLabel: `Approve ${selected.size}`,
      variant: "primary",
      exec: async () => {
        setBusy(true);
        try {
          await api.post(`/companies/${currentId}/transactions/bulk-approve`, [...selected]);
          toast.success(`Approved ${selected.size} transactions.`);
          setSelected(new Set());
          load();
        } catch (err) {
          toast.error(err?.response?.data?.detail || "Approve failed");
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const bulkCreateRules = async () => {
    if (!selected.size) return;
    setBusy(true);
    try {
      const r = await api.post(
        `/companies/${currentId}/rules/suggest-from-txns`,
        { transaction_ids: [...selected] },
      );
      const proposals = r.data?.proposals || [];
      if (proposals.length === 0) {
        const dup = r.data?.duplicates_skipped || 0;
        const unc = r.data?.uncategorized_skipped || 0;
        toast.info(
          dup > 0
            ? `Nothing new to propose — ${dup} row${dup === 1 ? "" : "s"} already covered by existing rules${unc > 0 ? `, ${unc} still uncategorized` : ""}.`
            : "Nothing to propose — categorize the selected rows first."
        );
        return;
      }
      // Fetch supporting lists once so the modal has classes / tags / etc.
      const [cls, tg] = await Promise.all([
        api.get(`/companies/${currentId}/classes`).catch(() => ({ data: {} })),
        api.get(`/companies/${currentId}/tags`).catch(() => ({ data: {} })),
      ]);
      setRuleQueue({
        proposals,
        index: 0,
        classes: (cls.data?.classes || cls.data?.items || []).map(
          (x) => ({ id: x.id, name: x.name })),
        tags:    (tg.data?.tags    || tg.data?.items    || []).map(
          (x) => ({ id: x.id, name: x.name })),
      });
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Suggestion failed");
    } finally {
      setBusy(false);
    }
  };

  // Called by ReclassifyPicker when the user chooses a target. We close
  // the picker and route through a confirm modal — the actual API write
  // fires only after the second explicit tap.
  const bulkReclassify = (categoryAccountId, contactId = null) => {
    if (!selected.size) return;
    const acct = accts.find(a => a.id === categoryAccountId);
    const contact = contactId
      ? filterContactOptions.find(c => c.id === contactId) : null;
    const count = selected.size;
    setReclassOpen(false);
    setPendingConfirm({
      title: `Reclassify ${count} transaction${count === 1 ? "" : "s"}?`,
      body: `Category → ${acct?.name || "target"}`
            + (contact ? ` · Contact → ${contact.name}` : ""),
      confirmLabel: `Reclassify ${count}`,
      variant: "primary",
      exec: () => runBulkReclassify(categoryAccountId, contactId),
    });
  };

  const runBulkReclassify = async (categoryAccountId, contactId) => {
    setBusy(true);
    try {
      const r = await api.post(`/companies/${currentId}/transactions/bulk-reclassify`, {
        transaction_ids: [...selected],
        category_account_id: categoryAccountId,
        contact_id: contactId || null,
      });
      const acct = accts.find(a => a.id === categoryAccountId);
      const contactTag = r.data.contact_applied
        ? ` and contact → ${r.data.contact_applied}`
        : "";
      showUndoToast(
        `Reclassified ${r.data.updated} txn(s) → ${acct?.name || "category"}${contactTag}`
        + (r.data.skipped_closed?.length
            ? `. Skipped ${r.data.skipped_closed.length} (closed period).`
            : ""),
        r.data.undo_token,
      );
      setSelected(new Set());
      if (r.data.rule_suggestion) setRuleSuggestion(r.data.rule_suggestion);
      load();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Reclassify failed");
    } finally {
      setBusy(false);
    }
  };

  // Called by ContactPickerModal on selection. Route through a confirm.
  const bulkSetContact = (contactId) => {
    if (!selected.size) return;
    const contact = contactId
      ? filterContactOptions.find(c => c.id === contactId) : null;
    const label = contact?.name || "no contact (cleared)";
    const count = selected.size;
    setContactPickerOpen(false);
    setPendingConfirm({
      title: `Set contact on ${count} transaction${count === 1 ? "" : "s"}?`,
      body: contact
        ? `Contact → ${label}`
        : "This will clear the contact on all selected rows.",
      confirmLabel: contact ? `Set → ${label}` : `Clear on ${count}`,
      variant: contact ? "primary" : "danger",
      exec: () => runBulkSetContact(contactId),
    });
  };

  const runBulkSetContact = async (contactId) => {
    setBusy(true);
    try {
      const r = await api.post(`/companies/${currentId}/transactions/bulk-set-contact`, {
        transaction_ids: [...selected],
        contact_id: contactId || null,
      });
      const contact = filterContactOptions.find(c => c.id === contactId);
      const label = contact?.name || (contactId ? "contact" : "no contact");
      showUndoToast(
        `Updated ${r.data.updated} txn(s) → ${label}`
        + (r.data.skipped_closed?.length
            ? `. Skipped ${r.data.skipped_closed.length} (closed period).`
            : ""),
        r.data.undo_token,
      );
      setSelected(new Set());
      load();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Set contact failed");
    } finally {
      setBusy(false);
    }
  };

  // Consolidated "Bulk Update" flow — routes through the same confirm
  // gate as Reclassify/Set-Contact and lets the user change Contact +
  // Category + Approve in one round-trip. Empty fields are skipped so
  // an "approve only" or "contact only" pass still works. After the
  // write, the existing `rule_suggestion` banner (from bulk-reclassify)
  // auto-prompts "Make a rule?" if a category was applied.
  const bulkUpdateApply = (patch /* { contact_id?, category_account_id?, approve? } */) => {
    if (!selected.size) return;
    const acct    = patch.category_account_id
      ? accts.find(a => a.id === patch.category_account_id) : null;
    const contact = patch.contact_id
      ? filterContactOptions.find(c => c.id === patch.contact_id) : null;
    const count = selected.size;
    setBulkUpdateOpen(false);
    const bodyLines = [];
    if (acct)              bodyLines.push(`Category → ${acct.name}`);
    if (contact)           bodyLines.push(`Contact → ${contact.name}`);
    if (patch.approve)     bodyLines.push("Mark as human-reviewed");
    setPendingConfirm({
      title: `Bulk update ${count} transaction${count === 1 ? "" : "s"}?`,
      body: bodyLines.join(" · ") || "No changes selected.",
      confirmLabel: `Update ${count}`,
      variant: "primary",
      exec: () => runBulkUpdate(patch),
    });
  };

  const runBulkUpdate = async (patch) => {
    const ids = [...selected];
    setBusy(true);
    try {
      let updated = 0;
      let ruleSug = null;
      let undoToken = null;
      // Category + optional contact go through bulk-reclassify — it
      // handles both in a single write and returns the rule-suggestion
      // banner if applicable.
      if (patch.category_account_id) {
        const r = await api.post(`/companies/${currentId}/transactions/bulk-reclassify`, {
          transaction_ids: ids,
          category_account_id: patch.category_account_id,
          contact_id: patch.contact_id || null,
        });
        updated  = r.data?.updated ?? ids.length;
        ruleSug  = r.data?.rule_suggestion || null;
        undoToken = r.data?.undo_token;
      } else if (patch.contact_id) {
        // Contact-only path.
        const r = await api.post(`/companies/${currentId}/transactions/bulk-set-contact`, {
          transaction_ids: ids,
          contact_id: patch.contact_id,
        });
        updated  = r.data?.updated ?? ids.length;
        undoToken = r.data?.undo_token;
      }
      // Approve as a separate call — order is intentional: categorize
      // first (so approve doesn't post an uncategorized row), then flip
      // the reviewed flag.
      if (patch.approve) {
        await api.post(`/companies/${currentId}/transactions/bulk-approve`, ids);
        updated = updated || ids.length;
      }
      const parts = [];
      if (patch.category_account_id) {
        const a = accts.find(x => x.id === patch.category_account_id);
        parts.push(`category → ${a?.name || "target"}`);
      }
      if (patch.contact_id) {
        const c = filterContactOptions.find(x => x.id === patch.contact_id);
        parts.push(`contact → ${c?.name || "contact"}`);
      }
      if (patch.approve) parts.push("approved");
      const msg = `Updated ${updated} txn(s)${parts.length ? ` — ${parts.join(", ")}` : ""}`;
      if (undoToken) showUndoToast(msg, undoToken);
      else           toast.success(msg);
      setSelected(new Set());
      if (ruleSug) setRuleSuggestion(ruleSug);
      load();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Bulk update failed");
    } finally {
      setBusy(false);
    }
  };

  // Shared undo-toast helper used by every bulk endpoint that
  // returns an `undo_token`. Reads the backend `POST /bulk-actions/
  // {undo_id}/undo` route to restore the pre-image.
  const showUndoToast = (message, undoToken) => {
    if (!undoToken) {
      toast.success(message);
      return;
    }
    toast.success(message, {
      duration: 15000,
      action: {
        label: "Undo",
        onClick: async () => {
          try {
            const u = await api.post(
              `/companies/${currentId}/bulk-actions/${undoToken}/undo`
            );
            toast.success(`Undone · restored ${u.data.restored} txn(s)`);
            load();
          } catch (err) {
            toast.error(err?.response?.data?.detail || "Undo failed");
          }
        },
      },
    });
  };

  // Inline "create new contact" hook used by the ContactPickerModal.
  // Returns {id, name} on success so the modal can immediately apply the
  // fresh contact to the current bulk-selection. We also splice the new
  // row into `filterContactOptions` so subsequent picker opens (in the
  // same tab, before the next debounced reload) still see it.
  const createContactInline = async (name) => {
    try {
      const r = await api.post(`/companies/${currentId}/contacts`, {
        name,
        type: "vendor",       // sensible default for txn-tagging flows
      });
      const created = r?.data;
      if (created?.id) {
        setFilterContactOptions((prev) => {
          if (prev.some((c) => c.id === created.id)) return prev;
          return [...prev, { id: created.id, name: created.name || name }];
        });
        return { id: created.id, name: created.name || name };
      }
      toast.error("Failed to create contact");
      return null;
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to create contact");
      return null;
    }
  };

  const acceptRuleSuggestion = async () => {
    if (!ruleSuggestion) return;
    try {
      const r = await api.post(`/companies/${currentId}/rules`, {
        match_type: "merchant_contains",
        match_value: ruleSuggestion.merchant,
        account_code: ruleSuggestion.account_code,
        apply_to_existing: true,
      });
      toast.success(
        `Rule created: "${ruleSuggestion.merchant}" → ${ruleSuggestion.account_name}`
        + (r.data.applied ? ` (applied to ${r.data.applied} existing txns)` : "")
      );
      setRuleSuggestion(null);
      load();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to create rule");
    }
  };

  const approve = async (id) => {
    await api.post(`/companies/${currentId}/transactions/${id}/approve`);
    load();
  };
  const unapprove = async (id) => {
    await api.post(`/companies/${currentId}/transactions/${id}/unapprove`);
    load();
  };
  const toggleApprove = (t) => (t.human_reviewed ? unapprove(t.id) : approve(t.id));
  const recategorize = async (id) => {
    setBusy(true);
    await api.post(`/companies/${currentId}/ai/recategorize/${id}`);
    setBusy(false); toast.success("Re-categorized by AI"); load();
  };
  const updateCategory = async (id, acctId) => {
    await api.patch(`/companies/${currentId}/transactions/${id}`, { category_account_id: acctId });
    load();
  };
  const del = async (id) => {
    if (!confirm("Delete this transaction?")) return;
    await api.delete(`/companies/${currentId}/transactions/${id}`);
    load();
  };

  const [xferBusy, setXferBusy] = useState(false);
  const [xferPreview, setXferPreview] = useState(null);
  const detectTransfers = async () => {
    if (xferBusy || !currentId) return;
    setXferBusy(true);
    try {
      const r = await api.post(
        `/companies/${currentId}/transactions/detect-transfers`,
        { dry_run: true }
      );
      const pairs = r.data?.pairs || [];
      if (pairs.length === 0) {
        toast.success("No unresolved internal transfers found — you're clean.");
        return;
      }
      setXferPreview(pairs);
    } catch (e) {
      toast.error("Couldn't scan for transfers.");
    } finally { setXferBusy(false); }
  };
  const applyTransfers = async () => {
    if (xferBusy || !currentId) return;
    setXferBusy(true);
    try {
      const r = await api.post(
        `/companies/${currentId}/transactions/detect-transfers`,
        { dry_run: false }
      );
      const n = r.data?.updated || 0;
      const pairs = (r.data?.pairs || []).length;
      toast.success(`Booked ${pairs} internal transfer${pairs === 1 ? "" : "s"} (${n} rows moved to the transfer clearing account).`);
      setXferPreview(null);
      load(); loadRollup();
    } catch (e) {
      toast.error("Couldn't apply transfers.");
    } finally { setXferBusy(false); }
  };

  return (
    <div className="space-y-4">
      <Step2Tour open={step2TourOpen} onDone={closeStep2Tour} />
      <Step3BTour open={step3bTourOpen} onDone={closeStep3BTour} />
      <MonthCloseBreadcrumb />
      {(params.get("from") === "gl" || params.get("from") === "payments") && (
        <nav
          aria-label="Breadcrumb"
          data-testid="transactions-source-breadcrumb"
          className="text-sm text-slate-500 flex items-center gap-2"
        >
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="hover:text-slate-900 hover:underline"
            data-testid="transactions-source-back-link"
          >
            ← {params.get("from") === "payments" ? "Payments" : "General Ledger"}
          </button>
          <span aria-hidden="true">/</span>
          <span className="text-slate-900 font-medium">Transaction</span>
        </nav>
      )}
      <CleanupCopilot
        currentId={currentId}
        autoTrigger={params.get("auto") === "1"}
        hideChips={true}
        forceStep={isLetsReview ? 2 : (isNoContactReview ? 3 : null)}
        onApplyAction={(a) => {
          // Filter the list first so the user sees exactly what the AI is about
          // to touch, then kick off a conversational inquiry in the AI panel.
          if (a.kind === "contact_in_uncat") {
            // Uncategorized tab removed — route to "Unapproved" (the closest
            // visible tab that shows AI-categorized-and-uncategorized alike),
            // then narrow via search.
            setFilter("unapproved");
            setSearch(a.contact_name || "");
          } else if (a.kind === "contact_split") {
            setFilter("all");
            setSearch(a.contact_name || "");
            setView("rollup");
          } else if (a.kind === "flagged_batch") {
            setFilter("review");
          } else if (a.kind === "filter_uncat") {
            // Fallback: no per-contact cluster, but uncategorized rows exist —
            // filter the table and let the CPA pick them off manually.
            setFilter("unapproved");
            setSearch("");
            setPage(1);
            return;
          } else if (a.kind === "filter_flagged") {
            // Fallback: no per-contact cluster, but flagged rows exist —
            // filter the table without starting the one-at-a-time chat.
            setFilter("review");
            setSearch("");
            setPage(1);
            return;
          }
          setPage(1);
          emitAction("cleanup-inquiry", { action: a });
        }}
        onStartSession={(flaggedCount) => {
          setFilter("review");
          setPage(1);
          emitAction("cleanup-inquiry", { action: { kind: "flagged_batch", count: flaggedCount || 0, label: "Flagged for review" } });
        }}
      />
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className={isReviewMode ? "flex-1 min-w-0" : ""}>
          <h1 className="font-heading text-3xl font-bold tracking-tight">
            {isLetsReview
              ? "AI Transaction Questions"
              : isNoContactReview
                ? "No-Contact Review"
                : "Transactions"}
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            {isLetsReview
              ? "One vendor at a time. Answer the AI's questions and post them in bulk."
              : isNoContactReview
                ? "One group at a time. Bank-feed rows without a contact, grouped by description."
                : "AI has posted the confident ones. Review the flagged. Hover a row to give the assistant context."}
          </p>
        </div>
        {isLetsReview && lrContactName && (
          <div
            className="w-[420px] shrink-0 rounded-lg bg-white border border-cyan-400 ring-1 ring-cyan-100 shadow-sm px-4 py-3"
            data-testid="lets-review-info-box"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
                Contact {lrIdx} of {lrTotal}
              </span>
              {(lrCount > 0 || lrTotalAmount) ? (
                <span
                  className="text-[10px] text-slate-500 tabular-nums"
                  data-testid="lets-review-contact-totals"
                >
                  <span data-testid="lets-review-contact-count">
                    {lrCount.toLocaleString()} txn{lrCount === 1 ? "" : "s"}
                  </span>
                  <span className="mx-1">·</span>
                  <span data-testid="lets-review-contact-total-amount">
                    {fmtMoney(lrTotalAmount)}
                  </span>
                </span>
              ) : null}
            </div>
            <div
              className="mt-0.5 font-heading font-semibold text-base text-slate-900 truncate"
              title={lrContactName}
            >
              {lrContactName}
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <label className="text-[9px] uppercase tracking-wider text-slate-500 font-semibold">
                Bulk-categorize all {(txns || []).length} row{(txns || []).length === 1 ? "" : "s"}
              </label>
              <button
                data-testid="lets-review-bulk-approve"
                onClick={applyBulkCategoryPreview}
                disabled={!bulkPreviewAcctId || bulkCatBusy || (txns || []).length === 0}
                title={bulkPreviewAcctId ? "Save this category to every visible row for this contact." : "Pick a category below to enable Approve."}
                className="text-[11px] font-semibold rounded-md border border-emerald-500 bg-emerald-500 text-white hover:bg-emerald-600 hover:border-emerald-600 px-2.5 py-1 disabled:opacity-40 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:border-slate-300"
              >
                {bulkCatBusy ? "Saving…" : "Approve"}
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <div className="flex-1 min-w-0" data-testid="lets-review-bulk-category">
                <AccountPicker
                  value={bulkPreviewAcctId}
                  accounts={(accts || []).filter((a) =>
                    // Full chart-of-accounts access — CPAs asked to be
                    // able to bulk-code to any account type (revenue,
                    // equity, liability, etc.) not just expenses. Only
                    // the system Uncategorized sinks (9999/6999/4999)
                    // are excluded so bulk actions can't loop rows
                    // back into the review queue they came from.
                    !["9999", "6999", "4999"].includes(a.code)
                  )}
                  onChange={(id) => previewBulkCategory(id)}
                  companyId={currentId}
                  testId="lets-review-bulk-category-picker"
                />
              </div>
              <button
                onClick={() => letsReviewNav.prev && letsReviewNav.prev()}
                disabled={!letsReviewNav.prev}
                data-testid="lets-review-prev"
                className="text-[11px] rounded-md border border-slate-300 bg-white hover:bg-slate-50 px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
              >
                ← Prev
              </button>
              <button
                onClick={() => letsReviewNav.next && letsReviewNav.next()}
                disabled={!letsReviewNav.next}
                data-testid="lets-review-next"
                className="text-[11px] rounded-md border border-slate-300 bg-white hover:bg-slate-50 px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
              >
                Next →
              </button>
            </div>
          </div>
        )}
        {isNoContactReview && ncrLabel && (
          <div
            className="w-[420px] shrink-0 rounded-lg bg-white border border-cyan-400 ring-1 ring-cyan-100 shadow-sm px-4 py-3"
            data-testid="no-contact-review-info-box"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
                {ncrIsListMode ? "All Groups View" : `Group ${lrIdx} of ${lrTotal}`}
              </span>
              {ncrIsListMode ? (
                <span
                  className="text-[10px] text-slate-500 tabular-nums"
                  data-testid="no-contact-review-all-groups-count"
                >
                  {lrTotal.toLocaleString()} group{lrTotal === 1 ? "" : "s"}
                </span>
              ) : (lrCount > 0 || lrTotalAmount) ? (
                <span
                  className="text-[10px] text-slate-500 tabular-nums"
                  data-testid="no-contact-review-group-totals"
                >
                  <span data-testid="no-contact-review-group-count">
                    {lrCount.toLocaleString()} txn{lrCount === 1 ? "" : "s"}
                  </span>
                  <span className="mx-1">·</span>
                  <span data-testid="no-contact-review-group-total-amount">
                    {fmtMoney(lrTotalAmount)}
                  </span>
                </span>
              ) : null}
            </div>
            <div
              className="mt-0.5 font-heading font-semibold text-base text-slate-900 truncate"
              title={ncrIsListMode ? "All no-contact groups" : ncrLabel}
            >
              {ncrIsListMode ? `All Groups View (${lrTotal})` : ncrLabel}
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <label className="text-[9px] uppercase tracking-wider text-slate-500 font-semibold">
                {ncrIsListMode
                  ? "Editing all groups in list view"
                  : `Bulk-categorize all ${(txns || []).length} row${(txns || []).length === 1 ? "" : "s"}`}
              </label>
              {!ncrIsListMode && (
                <button
                  data-testid="no-contact-review-bulk-approve"
                  onClick={applyBulkCategoryPreview}
                  disabled={!bulkPreviewAcctId || bulkCatBusy || (txns || []).length === 0}
                  title={bulkPreviewAcctId ? "Save this category to every visible row in this group." : "Pick a category below to enable Approve."}
                  className="text-[11px] font-semibold rounded-md border border-emerald-500 bg-emerald-500 text-white hover:bg-emerald-600 hover:border-emerald-600 px-2.5 py-1 disabled:opacity-40 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:border-slate-300"
                >
                  {bulkCatBusy ? "Saving…" : "Approve"}
                </button>
              )}
            </div>
            <div className="mt-2 flex items-center gap-2">
              {ncrIsListMode ? (
                // In list mode the picker + Prev/Next are hidden but we
                // keep a flex spacer of the same height so the box's
                // total footprint (2 lines under the label) stays
                // identical to stepper mode — the surrounding layout
                // doesn't reflow when toggling.
                <div className="flex-1 min-w-0 h-[26px]" aria-hidden="true" />
              ) : (
                <>
                  <div className="flex-1 min-w-0" data-testid="no-contact-review-bulk-category">
                    <AccountPicker
                      value={bulkPreviewAcctId}
                      accounts={(accts || []).filter((a) =>
                        !["9999", "6999", "4999"].includes(a.code)
                      )}
                      onChange={(id) => previewBulkCategory(id)}
                      companyId={currentId}
                      testId="no-contact-review-bulk-category-picker"
                    />
                  </div>
                  <button
                    onClick={() => noContactReviewNav.prev && noContactReviewNav.prev()}
                    disabled={!noContactReviewNav.prev}
                    data-testid="no-contact-review-prev"
                    className="text-[11px] rounded-md border border-slate-300 bg-white hover:bg-slate-50 px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                  >
                    ← Prev
                  </button>
                  <button
                    onClick={() => noContactReviewNav.next && noContactReviewNav.next()}
                    disabled={!noContactReviewNav.next}
                    data-testid="no-contact-review-next"
                    className="text-[11px] rounded-md border border-slate-300 bg-white hover:bg-slate-50 px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                  >
                    Next →
                  </button>
                </>
              )}
              <NoContactReviewListToggle />
            </div>
          </div>
        )}
        <div className="flex items-center gap-2">
          {!isReviewMode && (
            <div className="inline-flex rounded-md border bg-white overflow-hidden">
              {[
                { k: "all",           label: "All" },
                { k: "unapproved",    label: "To do" },
                { k: "reviewed",      label: "Approved" },
              ].map(({ k, label }) => (
                <button
                  key={k}
                  data-testid={k === "review" ? TID.txnFilterReview : `txn-filter-${k}`}
                  onClick={() => { setFilter(k); setPage(1); }}
                  className={`px-3 py-1.5 text-xs font-medium border-r border-slate-200 last:border-r-0 ${filter === k ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}
                >
                  {label}
                  {filter === k && (
                    <span data-testid={`txn-filter-count-${k}`}
                          className="ml-1.5 px-1.5 py-0.5 rounded bg-white/20 font-mono-num">
                      {pagination.total}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          {!isReviewMode && (
            <NewTransactionMenu
              onQuick={() => setCreating(true)}
              advanced={isAdvancedMode}
            />
          )}
        </div>
      </div>
      {/* Entity-type chip strip — orthogonal filter to the status
          tabs above. Lets the CPA slice the ledger by QBO entity
          without leaving the page. Uses the same `txn_type` field
          that the /sales-receipts and /credit-memos pages filter on.
          Only shown in Advanced accounting mode — regular business
          owners never need to slice by QBO entity. */}
      {!isReviewMode && isAdvancedMode && (
        <div
          className="flex items-center gap-1.5 flex-wrap"
          data-testid="txn-type-chip-strip"
        >
          <span className="text-[11px] uppercase tracking-wide text-slate-400 mr-1">
            Entity
          </span>
          {[
            { k: "",              label: "All types" },
            { k: "Purchase",      label: "Expenses" },
            { k: "SalesReceipt",  label: "Sales Receipts" },
            { k: "Deposit",       label: "Deposits" },
            { k: "CreditMemo",    label: "Credit Memos" },
            { k: "RefundReceipt", label: "Refund Receipts" },
            { k: "Transfer",      label: "Transfers" },
          ].map(({ k, label }) => {
            const active = txnTypeFilter === k;
            const pending = k ? (pendingByType[k] || 0) : 0;
            return (
              <button
                key={k || "all"}
                onClick={() => { setTxnTypeFilter(k); setPage(1); }}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-full border transition-colors inline-flex items-center gap-1.5 ${
                  active
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                }`}
                data-testid={`txn-type-chip-${k || "all"}`}
              >
                {label}
                {/* Amber pending-review counter — only shown when
                    silent-matched pairs of this txn_type are still
                    awaiting the CPA's confirm-or-unlink decision. */}
                {pending > 0 && (
                  <span
                    className={`min-w-[16px] h-4 px-1 rounded-full text-[10px] font-semibold tabular-nums grid place-items-center ${
                      active
                        ? "bg-amber-300/90 text-amber-950"
                        : "bg-amber-100 text-amber-800"
                    }`}
                    title={`${pending} pair${pending === 1 ? "" : "s"} awaiting bank match review`}
                    data-testid={`txn-type-chip-pending-${k}`}
                  >
                    {pending}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Filter toolbar: search + date range */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            data-testid={TID.txnSearch}
            type="text"
            placeholder="Search merchant, description, or contact…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-8 py-1.5 text-sm border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-slate-900/10"
          />
          {search && (
            <button
              data-testid={TID.txnSearchClear}
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
              aria-label="Clear search"
            >
              <XCircle size={14} />
            </button>
          )}
        </div>
        <div className="inline-flex items-center rounded-md border border-slate-200 bg-white overflow-hidden" role="tablist" aria-label="Transactions view">
          <button
            data-testid="txn-view-list"
            title="List view"
            role="tab"
            aria-selected={view === "list"}
            onClick={() => setView("list")}
            className={`px-2 py-1.5 flex items-center ${view === "list" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}
          >
            <ListIcon size={14} />
          </button>
          <button
            data-testid="txn-view-rollup"
            title="Group by contact & category"
            role="tab"
            aria-selected={view === "rollup"}
            onClick={() => setView("rollup")}
            className={`px-2 py-1.5 flex items-center border-l border-slate-200 ${view === "rollup" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}
          >
            <LayoutGrid size={14} />
          </button>
        </div>
        <div className="inline-flex items-center gap-1 border rounded-md bg-white px-2 py-1">
          <Calendar size={13} className="text-slate-400" />
          <input
            data-testid={TID.txnDateFrom}
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="text-xs bg-transparent focus:outline-none font-mono-num text-slate-700"
            aria-label="From date"
          />
          <span className="text-slate-400 text-xs">–</span>
          <input
            data-testid={TID.txnDateTo}
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="text-xs bg-transparent focus:outline-none font-mono-num text-slate-700"
            aria-label="To date"
          />
        </div>
        <button
          data-testid="txn-filter-withdrawal"
          onClick={() => setDirectionFilter((d) => d === "out" ? "" : "out")}
          className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border ${
            directionFilter === "out"
              ? "border-rose-600 bg-rose-600 text-white"
              : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
          }`}
          title="Toggle to show only withdrawals (money out)"
        >
          Withdrawal
        </button>
        <button
          data-testid="txn-filter-deposit"
          onClick={() => setDirectionFilter((d) => d === "in" ? "" : "in")}
          className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border ${
            directionFilter === "in"
              ? "border-emerald-600 bg-emerald-600 text-white"
              : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
          }`}
          title="Toggle to show only deposits (money in)"
        >
          Deposit
        </button>
        <button
          data-testid="txn-advanced-toggle"
          onClick={() => setAdvancedOpen((v) => !v)}
          className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border ${
            advancedOpen || advancedActive
              ? "border-slate-900 bg-slate-900 text-white"
              : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
          }`}
          title="Toggle advanced filters (accounts, categories, contacts, amount range)"
        >
          {advancedOpen ? "Hide advanced" : "Advanced filter"}
          {advancedActive && !advancedOpen && (
            <span className="ml-0.5 inline-block w-1.5 h-1.5 rounded-full bg-cyan-400" />
          )}
        </button>
        {filtersActive && (
          <button
            data-testid={TID.txnFiltersClear}
            onClick={clearFilters}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs text-slate-600 hover:text-slate-900 border border-transparent hover:border-slate-200 rounded"
          >
            <X size={12} /> Clear filters
          </button>
        )}
      </div>

      {advancedOpen && (
        <div
          data-testid="txn-advanced-panel"
          className="rounded-lg border border-slate-200 bg-white px-4 py-3"
        >
          <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-2">
            Advanced filters
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
                Bank account
              </label>
              <select
                data-testid="txn-filter-bank"
                value={filterBankAccountId}
                onChange={(e) => setFilterBankAccountId(e.target.value)}
                className="w-full px-2 py-1.5 rounded-md border border-slate-300 bg-white text-xs text-slate-800"
              >
                <option value="">All accounts</option>
                {/* All Asset + Liability accounts from the COA — banks,
                    credit cards, loans, A/R, A/P, fixed assets, etc. —
                    grouped by type so the CPA can see which side of the
                    ledger each row belongs to. Backend's bank_account_id
                    filter already ORs on plaid_account_id so a single
                    COA id catches both Plaid-fed and manual entries. */}
                {(() => {
                  const list = (accts || []).filter(
                    (a) => ["asset", "liability"].includes(a.type),
                  );
                  const assets = list.filter((a) => a.type === "asset")
                    .sort((x, y) => String(x.code).localeCompare(String(y.code)));
                  const liabs = list.filter((a) => a.type === "liability")
                    .sort((x, y) => String(x.code).localeCompare(String(y.code)));
                  return (
                    <>
                      {assets.length > 0 && (
                        <optgroup label="Assets">
                          {assets.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.code} · {a.name}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {liabs.length > 0 && (
                        <optgroup label="Liabilities">
                          {liabs.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.code} · {a.name}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </>
                  );
                })()}
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
                Category
              </label>
              <select
                data-testid="txn-filter-category"
                value={filterCategoryId}
                onChange={(e) => setFilterCategoryId(e.target.value)}
                className="w-full px-2 py-1.5 rounded-md border border-slate-300 bg-white text-xs text-slate-800"
              >
                <option value="">All categories</option>
                {(accts || [])
                  .filter((a) =>
                    ["expense", "income", "cost_of_goods_sold",
                     "other_income", "other_expense", "equity", "asset", "liability"].includes(a.type)
                  )
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
                Contact
              </label>
              <select
                data-testid="txn-filter-contact"
                value={filterContactId}
                onChange={(e) => setFilterContactId(e.target.value)}
                className="w-full px-2 py-1.5 rounded-md border border-slate-300 bg-white text-xs text-slate-800"
              >
                <option value="">All contacts</option>
                {filterContactOptions.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
                Amount range
              </label>
              <div className="flex items-center gap-1">
                <input
                  data-testid="txn-filter-amount-min"
                  type="number"
                  step="0.01"
                  placeholder="Min"
                  value={filterAmountMin}
                  onChange={(e) => setFilterAmountMin(e.target.value)}
                  className="w-full px-2 py-1.5 rounded-md border border-slate-300 bg-white text-xs text-slate-800 font-mono-num"
                />
                <span className="text-slate-400 text-xs">–</span>
                <input
                  data-testid="txn-filter-amount-max"
                  type="number"
                  step="0.01"
                  placeholder="Max"
                  value={filterAmountMax}
                  onChange={(e) => setFilterAmountMax(e.target.value)}
                  className="w-full px-2 py-1.5 rounded-md border border-slate-300 bg-white text-xs text-slate-800 font-mono-num"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {ruleSuggestion && (
        <div
          className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2.5 flex items-center gap-3"
          data-testid="txn-rule-suggestion-banner"
        >
          <Sparkles size={16} className="text-amber-700 flex-shrink-0" />
          <div className="flex-1 text-xs text-amber-900">
            You've reclassified <b>{ruleSuggestion.merchant}</b> to{" "}
            <b>{ruleSuggestion.account_name}</b> {ruleSuggestion.approvals} times.{" "}
            Turn this into an automatic rule?
          </div>
          <button
            onClick={acceptRuleSuggestion}
            data-testid="txn-rule-suggestion-accept"
            className="px-2.5 py-1 text-xs rounded-md bg-amber-700 text-white hover:bg-amber-800"
          >
            Create rule
          </button>
          <button
            onClick={() => setRuleSuggestion(null)}
            data-testid="txn-rule-suggestion-dismiss"
            className="px-2.5 py-1 text-xs rounded-md hover:bg-amber-100 text-amber-900"
          >
            Dismiss
          </button>
        </div>
      )}

      {selected.size > 0 && (
        <div className="rounded-md border bg-slate-900 text-white px-4 py-2.5 flex items-center gap-3 flex-wrap">          <span className="text-sm font-medium">{selected.size} selected</span>
          <button
            data-testid="txn-bulk-update"
            disabled={busy}
            onClick={() => setBulkUpdateOpen(true)}
            className="inline-flex items-center gap-1 px-3 py-1 rounded bg-sky-400 text-slate-900 text-xs font-medium hover:bg-sky-300"
          >
            <SlidersHorizontal size={12} /> Bulk update
          </button>
          <button data-testid={TID.txnBulkApprove} disabled={busy} onClick={bulkApprove}
                  className="inline-flex items-center gap-1 px-3 py-1 rounded bg-white text-slate-900 text-xs font-medium">
            <Check size={12} /> Approve all
          </button>
          <button data-testid={TID.txnBulkCreateRules} disabled={busy} onClick={bulkCreateRules}
                  className="inline-flex items-center gap-1 px-3 py-1 rounded bg-indigo-500 text-xs font-medium">
            <Wand2 size={12} /> Make these rules
          </button>
          <button onClick={() => setSelected(new Set())} className="ml-auto text-xs opacity-70 hover:opacity-100">Clear</button>
        </div>
      )}

      {reclassOpen && (
        <ReclassifyPicker
          accounts={accts}
          count={selected.size}
          onCancel={() => setReclassOpen(false)}
          onApply={bulkReclassify}
          contacts={filterContactOptions}
        />
      )}

      {contactPickerOpen && (
        <ContactPickerModal
          contacts={filterContactOptions}
          count={selected.size}
          onCancel={() => setContactPickerOpen(false)}
          onApply={bulkSetContact}
          onCreateContact={createContactInline}
        />
      )}

      {bulkUpdateOpen && (
        <BulkUpdateModal
          currentId={currentId}
          count={selected.size}
          contacts={filterContactOptions}
          accounts={accts}
          onCancel={() => setBulkUpdateOpen(false)}
          onApply={bulkUpdateApply}
          onContactCreated={(c) => {
            setFilterContactOptions((prev) =>
              prev.some(x => x.id === c.id) ? prev : [...prev, { id: c.id, name: c.name }]);
          }}
          onAccountCreated={(a) => {
            setAccts((prev) => prev.some(x => x.id === a.id) ? prev : [...prev, a]);
          }}
        />
      )}

      {ruleQueue && (
        <CreateRuleModal
          key={`rq-${ruleQueue.index}`}         /* remount → fresh state per proposal */
          currentId={currentId}
          accts={accts}
          contacts={filterContactOptions}
          classes={ruleQueue.classes}
          tags={ruleQueue.tags}
          setClasses={(fn) => setRuleQueue(q =>
            q ? { ...q, classes: typeof fn === "function" ? fn(q.classes) : fn } : q)}
          setTags={(fn) => setRuleQueue(q =>
            q ? { ...q, tags:    typeof fn === "function" ? fn(q.tags)    : fn } : q)}
          initialProposal={ruleQueue.proposals[ruleQueue.index]}
          queue={{
            current: ruleQueue.index + 1,
            total:   ruleQueue.proposals.length,
            onNext: (saved) => {
              const nextIdx = ruleQueue.index + 1;
              if (nextIdx >= ruleQueue.proposals.length) {
                setRuleQueue(null);
                setSelected(new Set());
                if (saved) load();
                toast.success("Done — all suggested rules processed.");
              } else {
                setRuleQueue({ ...ruleQueue, index: nextIdx });
              }
            },
            onSkip: () => {
              const nextIdx = ruleQueue.index + 1;
              if (nextIdx >= ruleQueue.proposals.length) {
                setRuleQueue(null);
              } else {
                setRuleQueue({ ...ruleQueue, index: nextIdx });
              }
            },
            onPrev: () => {
              const prevIdx = ruleQueue.index - 1;
              if (prevIdx >= 0) {
                setRuleQueue({ ...ruleQueue, index: prevIdx });
              }
            },
          }}
          onClose={() => {
            const remaining = ruleQueue.proposals.length - ruleQueue.index - 1;
            setRuleQueue(null);
            if (remaining > 0) {
              toast.info(`Skipped ${remaining} remaining suggestion${remaining === 1 ? "" : "s"}.`);
            }
          }}
        />
      )}

      {pendingConfirm && (
        <BulkConfirmModal
          title={pendingConfirm.title}
          body={pendingConfirm.body}
          confirmLabel={pendingConfirm.confirmLabel}
          variant={pendingConfirm.variant}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={async () => {
            const fn = pendingConfirm.exec;
            setPendingConfirm(null);
            if (fn) await fn();
          }}
        />
      )}

      {isReviewMode && isReviewDone ? (
        // Step 2 / Step 3 fully cleared — replace the table area with the
        // NextStepCard so the copilot header + blue "Step N" card at the
        // top stay visible, and the CPA gets a clear handoff to the next
        // step (or Dashboard when the whole checklist is done). Matches
        // the Step 1 AI Cleanup Review empty-state UX.
        <div className="rounded-xl border bg-white p-6" data-testid="review-mode-done-card">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="text-emerald-500" size={18} />
            <div className="font-heading font-semibold text-slate-900">
              {isLetsReview ? "Nice — Step 2 is clean" : "Nice — Step 3 is clean"}
            </div>
          </div>
          <div className="text-sm text-slate-500 mb-4">
            {isLetsReview
              ? "No uncategorized vendor groups left for this company."
              : "No uncategorized no-contact transactions left for this company."}
          </div>
          <NextStepCard currentId={currentId} />
        </div>
      ) : (
      <div className="rounded-xl border bg-white overflow-hidden">
        {ncrIsListMode ? (
          // In-place list view — renders the same all-groups table the
          // dedicated /accounting/no-contact-review?view=list page uses,
          // but without the outer page chrome (title/breadcrumb/back-
          // to-dashboard) so it slots cleanly into this container.
          <ListModeView embedded />
        ) : view === "rollup" ? (
          <ContactRollup
            data={rollup}
            busy={rollupBusy}
            currentId={currentId}
            accts={accts}
            contactOptions={filterContactOptions}
            reload={() => loadRef.current?.()}
          />
        ) : (
        <>
        {isMobile ? (
          <MobileTxnCards
            txns={txns}
            accts={accts}
            updateCategory={updateCategory}
            currentId={currentId}
            onReload={() => loadRef.current?.()}
          />
        ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500 border-b bg-slate-50">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input type="checkbox" data-testid={TID.txnBulkCheckbox}
                    checked={allChecked}
                    onChange={(e) => setSelected(e.target.checked ? new Set(txns.map(t => t.id)) : new Set())} />
                </th>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Contact</th>
                <th className="px-3 py-2 text-left">Merchant / Description</th>
                <th className="px-3 py-2 text-left">Category</th>
                <th className="px-3 py-2 text-left">AI</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2 text-right">Bank Balance</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {txns.map(t => (
                <tr key={t.id} data-testid={TID.txnRow} data-txn-id={t.id}
                    onMouseEnter={() => setFocus({ id: t.id, merchant: t.merchant, amount: t.amount, date: t.date })}
                    onMouseLeave={() => setFocus(null)}
                    className="border-b hover:bg-slate-50 transition-colors">
                  <td className="px-3 py-2">
                    <input type="checkbox" data-testid={TID.txnRowCheckbox}
                      checked={selected.has(t.id)} onChange={() => toggleSel(t.id)} />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-slate-600 font-mono-num">{fmtDate(t.date)}</td>
                  <td className="px-3 py-2 text-slate-700 max-w-[200px]" title={t.contact_name || ""}>
                    <div className="flex items-center gap-2 min-w-0">
                      <ContactBadge
                        contact={{ name: t.contact_name, logo_url: t.contact_logo_url }}
                        size={22}
                      />
                      <span className="truncate">
                        {t.contact_name || <span className="text-slate-300">—</span>}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2 align-top max-w-[420px]">
                    {/* Merchant + description. Cap the column at ~420px
                        and wrap onto multiple lines with `break-words`
                        + `whitespace-normal` for long bank-feed strings
                        (e.g. "NV ENERGY NORTH DES:SPPC PYMT ID:…") so
                        the table never forces a horizontal scrollbar.
                        Long single tokens (no spaces) still break via
                        `break-all` so they can't overflow the cell. */}
                    <div className="flex items-start gap-2 min-w-0">
                      <div className="font-medium break-words break-all whitespace-normal leading-snug flex-1 min-w-0">
                        {t.merchant || t.description}
                      </div>
                      {/* Reconciliation indicator — only shown on rows
                          that were authored via a full-page editor
                          (Sales Receipt, Deposit, etc.) since bank-
                          feed rows are their own source of truth. */}
                      {["SalesReceipt", "Deposit", "Purchase",
                          "CreditMemo", "RefundReceipt"].includes(t.txn_type) && (
                        <MatchDot row={t} mode="compact" />
                      )}
                    </div>
                    {t.splits?.length > 0 && <div className="text-[10px] text-indigo-600 mt-0.5">Split into {t.splits.length}</div>}
                    {(t.linked_invoice_id || t.linked_bill_id) && (
                      <div className="text-[10px] text-emerald-700 mt-0.5">Linked to {t.linked_invoice_id ? "invoice" : "bill"}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="inline-flex items-center gap-1 max-w-[220px]">
                      {showProvenance && (
                        <ProvenanceDot
                          source={t.categorization_source || t.ai_source}
                          matched={t.rule_matched}
                          semantic={t.rule_semantic}
                          confidence={t.rule_confidence ?? t.ai_confidence}
                          bucket={t.bucket}
                        />
                      )}
                      <div className="min-w-0 flex-1" data-testid={TID.txnEditCategory}>
                        <AccountPicker
                          value={t.category_account_id || ""}
                          accounts={accts}
                          onChange={(id) => updateCategory(t.id, id)}
                          companyId={currentId}
                          testId={`txn-cat-picker-${t.id}`}
                        />
                      </div>
                      <AccountInfoTooltip
                        account={accts.find(a => a.id === t.category_account_id)}
                      />
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <ConfidenceChip conf={t.ai_confidence} needs_review={t.needs_review} human_reviewed={t.human_reviewed} />
                    {t.ai_proposal_from_answer && (
                      <ProposalPill
                        proposal={t.ai_proposal_from_answer}
                        onAccept={async () => {
                          try {
                            await api.post(`/companies/${currentId}/transactions/${t.id}/accept-proposal`);
                            toast.success(`Applied → ${t.ai_proposal_from_answer.account_name}`);
                            load();
                          } catch (e) { toast.error(e.response?.data?.detail || "Accept failed"); }
                        }}
                        onDismiss={async () => {
                          try {
                            await api.post(`/companies/${currentId}/transactions/${t.id}/dismiss-proposal`);
                            toast.success("Proposal dismissed");
                            load();
                          } catch (e) { toast.error(e.response?.data?.detail || "Dismiss failed"); }
                        }}
                      />
                    )}
                  </td>
                  <td className={`px-3 py-2 text-right font-mono-num ${t.amount < 0 ? "text-slate-800" : "text-emerald-700 font-semibold"}`}>
                    {fmtMoney(t.amount)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono-num text-slate-500 text-xs">{t.bank_balance_after ? fmtMoney(t.bank_balance_after) : "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1 justify-end">
                      <button
                        title={t.human_reviewed ? "Unapprove" : "Approve"}
                        data-testid={TID.txnApprove}
                        onClick={() => toggleApprove(t)}
                        className={
                          t.human_reviewed
                            ? "p-1 rounded bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                            : "p-1 rounded hover:bg-emerald-100 text-emerald-600"
                        }
                      >
                        <Check size={14} />
                      </button>
                      <button
                        title="Ask AI about this transaction"
                        data-testid={`txn-ai-${t.id}`}
                        onClick={() => {
                          setFocus(
                            { id: t.id, merchant: t.merchant, amount: t.amount, date: t.date },
                            { pin: true }
                          );
                          // Open the panel and let it prompt "tell me about
                          // this" + auto-open the mic so the CPA can just
                          // start talking.
                          emitAction("ai-open");
                          emitAction("ai-tell-me-about", {
                            txn: {
                              id: t.id,
                              merchant: t.merchant,
                              description: t.description,
                              contact_name: t.contact_name,
                              amount: t.amount,
                              date: t.date,
                            },
                          });
                        }}
                        className="p-1 rounded hover:bg-fuchsia-100 text-fuchsia-600"
                      >
                        <Sparkles size={14} />
                      </button>
                      <RowMoreMenu
                        t={t}
                        onEdit={() => setEditing(t)}
                        onRecategorize={() => recategorize(t.id)}
                        onSplit={() => setSplitting(t)}
                        onLink={() => setLinking(t)}
                        onDelete={() => del(t.id)}
                        onAskClient={() => askClientRef.current?.(t)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
              {!txns.length && (
                <tr><td colSpan={10} className="px-3 py-8 text-center text-slate-500">No transactions.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        )}
        <PaginationBar
          pagination={pagination}
          pageSize={pageSize}
          setPageSize={setPageSize}
          page={page}
          setPage={setPage}
          visibleCount={txns.length}
          filtersActive={filtersActive}
          onClearFilters={clearFilters}
        />
        <AskClientLauncher registerRef={askClientRef} onAsked={load} />
        </>
        )}
      </div>
      )}

      {creating && <ManualTxnModal accts={accts} currentId={currentId} contactOptions={filterContactOptions} invoices={invoices} bills={bills} onClose={() => { setCreating(false); load(); }} />}
      {editing && <ManualTxnModal accts={accts} currentId={currentId} contactOptions={filterContactOptions} invoices={invoices} bills={bills} initialTxn={editing} onClose={() => { setEditing(null); load(); }} />}
      {splitting && <SplitModal txn={splitting} accts={accts} currentId={currentId} onClose={() => { setSplitting(null); load(); }} />}
      {linking && <LinkModal txn={linking} invoices={invoices} bills={bills} currentId={currentId} onClose={() => { setLinking(null); load(); }} />}
      {xferPreview && (
        <Modal title={`Found ${xferPreview.length} internal-transfer pair${xferPreview.length === 1 ? "" : "s"}`}
               onClose={() => setXferPreview(null)}>
          <div className="text-xs text-slate-600 mb-3">
            Both legs of each pair will be booked to the <b>Inter-Account Transfer</b> equity account so neither leg hits your P&amp;L.
          </div>
          <div className="max-h-80 overflow-y-auto space-y-2 mb-4" data-testid="detect-transfers-preview">
            {xferPreview.map((p, i) => (
              <div key={i} className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                <div className="flex justify-between items-center text-rose-700 font-medium">
                  <span>{fmtDate(p.debit_leg.date)} · {p.debit_leg.bank_account_name}</span>
                  <span className="font-mono-num">{fmtMoney(p.debit_leg.amount)}</span>
                </div>
                <div className="text-slate-500 truncate italic">{p.debit_leg.description}</div>
                <div className="flex justify-between items-center text-emerald-700 font-medium mt-1">
                  <span>{fmtDate(p.credit_leg.date)} · {p.credit_leg.bank_account_name}</span>
                  <span className="font-mono-num">+{fmtMoney(p.credit_leg.amount)}</span>
                </div>
                <div className="text-slate-500 truncate italic">{p.credit_leg.description}</div>
                {p.date_delta_days > 0 && (
                  <div className="text-[10px] text-slate-400 mt-1">Δ{p.date_delta_days} day{p.date_delta_days === 1 ? "" : "s"}</div>
                )}
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              data-testid="detect-transfers-apply"
              disabled={xferBusy}
              onClick={applyTransfers}
              className="flex-1 py-2 rounded-md bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
            >
              {xferBusy ? "Applying…" : `Book all ${xferPreview.length} pair${xferPreview.length === 1 ? "" : "s"}`}
            </button>
            <button
              onClick={() => setXferPreview(null)}
              disabled={xferBusy}
              className="px-4 py-2 rounded-md border border-slate-300 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function PaginationBar({ pagination, pageSize, setPageSize, page, setPage, visibleCount, filtersActive, onClearFilters }) {
  const total = pagination?.total || 0;
  const pages = Math.max(1, pagination?.pages || 1);
  const currentPage = Math.min(pages, Math.max(1, pagination?.page || page));
  const startIdx = total === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const endIdx = total === 0 ? 0 : (currentPage - 1) * pageSize + visibleCount;

  const canPrev = currentPage > 1;
  const canNext = currentPage < pages;

  return (
    <div className="flex items-center justify-between gap-3 flex-wrap border-t bg-slate-50/60 px-4 py-2.5">
      <div className="flex items-center gap-2 text-xs text-slate-600 flex-wrap">
        <span data-testid={TID.txnPageIndicator}>
          {total === 0
            ? (filtersActive ? "No transactions match these filters" : "No transactions")
            : <>Showing <span className="font-mono-num font-medium text-slate-900">{startIdx.toLocaleString()}</span>–<span className="font-mono-num font-medium text-slate-900">{endIdx.toLocaleString()}</span> of <span className="font-mono-num font-medium text-slate-900">{total.toLocaleString()}</span></>
          }
        </span>
        {filtersActive && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-medium">
            filtered
            {onClearFilters && total === 0 && (
              <button onClick={onClearFilters} className="ml-1 underline">clear</button>
            )}
          </span>
        )}
        <span className="text-slate-300">·</span>
        <label className="inline-flex items-center gap-1.5">
          <span className="text-slate-500">Rows</span>
          <select
            data-testid={TID.txnPageSize}
            value={pageSize}
            onChange={(e) => { setPageSize(parseInt(e.target.value, 10)); setPage(1); }}
            className="border rounded px-1.5 py-0.5 bg-white text-xs font-mono-num"
          >
            {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      <div className="flex items-center gap-1">
        <button
          data-testid={TID.txnPagePrev}
          disabled={!canPrev}
          onClick={() => setPage(currentPage - 1)}
          className="inline-flex items-center gap-1 px-2 py-1 rounded border bg-white text-xs disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-100"
        >
          <ChevronLeft size={14} /> Prev
        </button>
        <span className="px-2 text-xs text-slate-600 font-mono-num">
          Page {currentPage} of {pages}
        </span>
        <button
          data-testid={TID.txnPageNext}
          disabled={!canNext}
          onClick={() => setPage(currentPage + 1)}
          className="inline-flex items-center gap-1 px-2 py-1 rounded border bg-white text-xs disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-100"
        >
          Next <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

function Modal({ title, children, onClose, wide }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className={`rounded-xl bg-white shadow-2xl w-full ${wide ? "max-w-2xl" : "max-w-md"}`}>
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h3 className="font-heading font-semibold">{title}</h3>
          <button data-testid={TID.cancelBtn} onClick={onClose} className="p-1 rounded hover:bg-slate-100"><X size={16} /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

// Contact-rollup: alphabetized cards, one per contact, listing every category
// their transactions fall under with count + amount range. Perfect for
// spotting split categorizations (e.g. AT&T mostly in Utilities but 1 stray
// row in Inter-Account Transfer). Clicking a category row expands inline
// to show the underlying transactions — no navigation, no page change.
function ContactRollup({ data, busy, currentId, accts = [], contactOptions = [], reload }) {
  const fmtMoney = useMoneyFmt();
  const { classesEnabled, projectsEnabled } = useCompany();
  const contacts = data?.contacts || [];
  // Cache expanded rows: key = `${contactKey}||${categoryKey}` → txn list.
  const [expanded, setExpanded] = useState({});   // key → true/false
  const [cache, setCache] = useState({});          // key → txn[] (or "loading")
  // Classes list — only fetched when the flag is on so a company that
  // doesn't use Classes pays nothing.
  const [classOptions, setClassOptions] = useState([]);
  useEffect(() => {
    if (!classesEnabled || !currentId) return;
    api.get(`/companies/${currentId}/classes`)
      .then(r => setClassOptions(r.data?.classes || []))
      .catch(() => setClassOptions([]));
  }, [classesEnabled, currentId]);
  // Projects list — same lazy-fetch pattern.
  const [projectOptions, setProjectOptions] = useState([]);
  useEffect(() => {
    if (!projectsEnabled || !currentId) return;
    api.get(`/companies/${currentId}/projects`)
      .then(r => setProjectOptions(r.data?.projects || []))
      .catch(() => setProjectOptions([]));
  }, [projectsEnabled, currentId]);
  // Per-project phase cache — keyed by project_id. Loaded lazily
  // the first time we render a txn whose project has phases so the
  // dropdown feels instant on subsequent rows.
  const [phasesByProject, setPhasesByProject] = useState({});
  const ensurePhases = async (projectId) => {
    if (!projectId || phasesByProject[projectId] !== undefined) return;
    // Mark loading (empty array) so we don't re-fetch on every render.
    setPhasesByProject(p => ({ ...p, [projectId]: [] }));
    try {
      const r = await api.get(
        `/companies/${currentId}/projects/${projectId}/phases`);
      setPhasesByProject(p => ({ ...p, [projectId]: r.data?.phases || [] }));
    } catch { /* leave empty — will retry on next render */ }
  };
  // Track which (contact, category) cells and which contacts as a whole
  // have been approved this session. Purely visual state — the actual
  // approval lives on the txn's human_reviewed field via bulk-approve.
  const [approved, setApproved] = useState({});    // key → true
  const [approvingBusy, setApprovingBusy] = useState({});  // key → true
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkDone, setBulkDone] = useState(false);
  // Per-txn state — busy flags for the individual approve/save buttons
  // in the expanded drawer.
  const [txnBusy, setTxnBusy] = useState({}); // txnId → true
  // Category options for the dropdown — all revenue/expense/cogs
  // accounts on the CoA. Same shape as the Transactions list-mode
  // category picker uses.
  const categoryOptions = (accts || [])
    .filter(a => ["revenue", "expense", "cogs", "income"].includes((a.type || "").toLowerCase()))
    .sort((a, b) => (a.code || "").localeCompare(b.code || ""));

  // Update a single txn's cached copy after an API mutation so the UI
  // reflects the new state without a full rollup refetch.
  const patchTxnInCache = (txnId, patch) => {
    setCache(c => {
      const next = { ...c };
      for (const k of Object.keys(next)) {
        if (Array.isArray(next[k])) {
          next[k] = next[k].map(t => (t.id === txnId ? { ...t, ...patch } : t));
        }
      }
      return next;
    });
  };

  const setTxnCategory = async (t, newAccountId) => {
    if (!newAccountId || newAccountId === (t.category_account_id || "")) return;
    setTxnBusy(b => ({ ...b, [t.id]: true }));
    try {
      const acct = categoryOptions.find(a => a.id === newAccountId);
      await api.patch(`/companies/${currentId}/transactions/${t.id}`, {
        category_account_id: newAccountId,
      });
      patchTxnInCache(t.id, {
        category_account_id: newAccountId,
        category_account_code: acct?.code,
        category_account_name: acct?.name,
      });
      toast.success(`Moved to ${acct?.name || "new category"}`);
      // Rollup counts / groupings need a full refresh since the txn
      // just moved to a different (contact, category) bucket.
      reload?.();
    } catch (err) {
      toast.error(`Failed: ${err.response?.data?.detail || err.message}`);
    } finally {
      setTxnBusy(b => ({ ...b, [t.id]: false }));
    }
  };

  const toggleTxnApprove = async (t) => {
    setTxnBusy(b => ({ ...b, [t.id]: true }));
    try {
      const endpoint = t.human_reviewed ? "bulk-unapprove" : "bulk-approve";
      await api.post(`/companies/${currentId}/transactions/${endpoint}`, [t.id]);
      patchTxnInCache(t.id, { human_reviewed: !t.human_reviewed, needs_review: false });
      toast.success(t.human_reviewed ? "Unapproved" : "Approved");
    } catch (err) {
      toast.error(`Failed: ${err.response?.data?.detail || err.message}`);
    } finally {
      setTxnBusy(b => ({ ...b, [t.id]: false }));
    }
  };

  // Change the contact on ONE transaction. Pass `""` to clear (No contact).
  const setTxnContact = async (t, newContactId) => {
    if ((newContactId || "") === (t.contact_id || "")) return;
    setTxnBusy(b => ({ ...b, [t.id]: true }));
    try {
      const contact = contactOptions.find(c => c.id === newContactId);
      await api.patch(`/companies/${currentId}/transactions/${t.id}`, {
        contact_id: newContactId || null,
      });
      patchTxnInCache(t.id, {
        contact_id: newContactId || null,
        contact_name: contact?.name || null,
      });
      toast.success(newContactId ? `Moved to ${contact?.name || "new contact"}` : "Contact cleared");
      reload?.();  // rollup groups by contact — refresh so the row jumps
    } catch (err) {
      toast.error(`Failed: ${err.response?.data?.detail || err.message}`);
    } finally {
      setTxnBusy(b => ({ ...b, [t.id]: false }));
    }
  };

  // Per-txn class assignment (Phase 2 advanced features). Rollup
  // doesn't currently group by class, so no reload is needed —
  // patch the cache in place and let the class filter/chip (Phase 3
  // work) pick it up on the next query.
  const setTxnClassId = async (t, newClassId) => {
    if ((newClassId || "") === (t.class_id || "")) return;
    setTxnBusy(b => ({ ...b, [t.id]: true }));
    try {
      const cls = classOptions.find(c => c.id === newClassId);
      // Empty string clears (backend maps "" → null on FK fields).
      await api.patch(`/companies/${currentId}/transactions/${t.id}`, {
        class_id: newClassId === "" ? "" : newClassId,
      });
      patchTxnInCache(t.id, {
        class_id: newClassId || null,
        class_name: cls?.name || null,
      });
      toast.success(newClassId ? `Class set to ${cls?.name || "new class"}` : "Class cleared");
    } catch (err) {
      toast.error(`Failed: ${err.response?.data?.detail || err.message}`);
    } finally {
      setTxnBusy(b => ({ ...b, [t.id]: false }));
    }
  };

  // Per-txn project assignment. Same shape as class assignment —
  // just patch the txn and update the cache in place. Rollup doesn't
  // currently regroup by project so no reload needed here.
  const setTxnProjectId = async (t, newProjectId) => {
    if ((newProjectId || "") === (t.project_id || "")) return;
    setTxnBusy(b => ({ ...b, [t.id]: true }));
    try {
      const proj = projectOptions.find(p => p.id === newProjectId);
      await api.patch(`/companies/${currentId}/transactions/${t.id}`, {
        project_id: newProjectId === "" ? "" : newProjectId,
        // Changing project also clears any phase — a phase belongs
        // to exactly one project, so a stale phase_id on the new
        // project would violate that invariant.
        phase_id: "",
      });
      patchTxnInCache(t.id, {
        project_id: newProjectId || null,
        project_name: proj?.name || null,
        phase_id: null,
      });
      toast.success(newProjectId ? `Project set to ${proj?.name || "new project"}` : "Project cleared");
      // Pre-warm the phase list for the new project so the phase
      // dropdown renders instantly on the next paint.
      if (newProjectId) ensurePhases(newProjectId);
    } catch (err) {
      toast.error(`Failed: ${err.response?.data?.detail || err.message}`);
    } finally {
      setTxnBusy(b => ({ ...b, [t.id]: false }));
    }
  };

  // Per-txn phase assignment. Only meaningful when the txn already
  // carries a project_id — phase belongs to a project.
  const setTxnPhaseId = async (t, newPhaseId) => {
    if ((newPhaseId || "") === (t.phase_id || "")) return;
    setTxnBusy(b => ({ ...b, [t.id]: true }));
    try {
      const phList = phasesByProject[t.project_id] || [];
      const ph = phList.find(p => p.id === newPhaseId);
      await api.patch(`/companies/${currentId}/transactions/${t.id}`, {
        phase_id: newPhaseId === "" ? "" : newPhaseId,
      });
      patchTxnInCache(t.id, {
        phase_id: newPhaseId || null,
        phase_name: ph?.name || null,
      });
      toast.success(newPhaseId ? `Phase set to ${ph?.name || "new phase"}` : "Phase cleared");
    } catch (err) {
      toast.error(`Failed: ${err.response?.data?.detail || err.message}`);
    } finally {
      setTxnBusy(b => ({ ...b, [t.id]: false }));
    }
  };

  // Bulk-move every transaction under a whole rollup contact to a new
  // contact — one PATCH per row (kept simple; the txn list per contact
  // is small in practice). Fires reload once at the end so the rollup
  // regroups.
  const [reassigningContact, setReassigningContact] = useState({}); // ck → true
  const bulkReassignContact = async (contact, newContactId) => {
    const ck = contact.contact_id || `_nocontact_${contact.contact_name}`;
    if ((newContactId || "") === (contact.contact_id || "")) return;
    setReassigningContact(b => ({ ...b, [ck]: true }));
    try {
      // Fetch every txn id under this contact via the same query the
      // expand handler uses. Cheaper than pre-loading them all.
      const perCat = await Promise.all(
        contact.categories.map(cat => {
          const ak = cat.category_account_id || "_uncat_";
          const cellKey = `${ck}||${ak}`;
          return idsForCell(contact, cat, cellKey);
        }),
      );
      const allIds = Array.from(new Set(perCat.flat()));
      if (!allIds.length) {
        toast.info("No transactions to move");
        return;
      }
      // Sequential PATCH — keeps the backend gentle and lets us report
      // partial failures cleanly. In practice each contact rollup is
      // < 50 rows so latency stays reasonable.
      let ok = 0;
      for (const id of allIds) {
        try {
          await api.patch(`/companies/${currentId}/transactions/${id}`, {
            contact_id: newContactId || null,
          });
          ok += 1;
        } catch { /* per-row failure — keep going */ }
      }
      const dest = contactOptions.find(c => c.id === newContactId);
      toast.success(
        newContactId
          ? `Moved ${ok} transactions to ${dest?.name || "new contact"}`
          : `Cleared contact on ${ok} transactions`,
      );
      reload?.();
    } catch (err) {
      toast.error(`Failed: ${err.response?.data?.detail || err.message}`);
    } finally {
      setReassigningContact(b => ({ ...b, [ck]: false }));
    }
  };

  if (busy && contacts.length === 0) {
    return <div className="p-8 text-center text-slate-500 text-sm">Grouping transactions…</div>;
  }
  if (contacts.length === 0) {
    return <div className="p-8 text-center text-slate-500 text-sm">No transactions to group.</div>;
  }

  const toggle = async (contact, category) => {
    const ck = contact.contact_id || `_nocontact_${contact.contact_name}`;
    const ak = category.category_account_id || "_uncat_";
    const key = `${ck}||${ak}`;
    const nextOpen = !expanded[key];
    setExpanded(e => ({ ...e, [key]: nextOpen }));
    if (nextOpen && !cache[key]) {
      setCache(c => ({ ...c, [key]: "loading" }));
      try {
        const p = new URLSearchParams({ limit: "500" });
        if (contact.contact_id) p.set("contact_id", contact.contact_id);
        if (category.category_account_id) p.set("category_account_id", category.category_account_id);
        const r = await api.get(`/companies/${currentId}/transactions?${p.toString()}`);
        // Post-filter for (No contact) and Uncategorized cells since those
        // aren't representable as query params.
        let rows = r.data.transactions || [];
        if (!contact.contact_id) rows = rows.filter(t => !t.contact_id);
        if (!category.category_account_id) rows = rows.filter(t => !t.category_account_id);
        // Also match by name for the (No contact) fallback bucket.
        if (!contact.contact_id) rows = rows.filter(t => (t.contact_name || "") === contact.contact_name || !t.contact_name);
        setCache(c => ({ ...c, [key]: rows }));
      } catch {
        setCache(c => ({ ...c, [key]: [] }));
      }
    }
  };

  // Fetch the txn ids underlying a (contact, category) cell. Reuses the
  // expand cache when available; otherwise fires the same query the
  // expand handler does. Returns array of ids (may be empty).
  const idsForCell = async (contact, category, cellKey) => {
    const cached = cache[cellKey];
    if (Array.isArray(cached)) return cached.map(t => t.id);
    const p = new URLSearchParams({ limit: "500" });
    if (contact.contact_id) p.set("contact_id", contact.contact_id);
    if (category.category_account_id) p.set("category_account_id", category.category_account_id);
    const r = await api.get(`/companies/${currentId}/transactions?${p.toString()}`);
    let rows = r.data.transactions || [];
    if (!contact.contact_id) rows = rows.filter(t => !t.contact_id);
    if (!category.category_account_id) rows = rows.filter(t => !t.category_account_id);
    if (!contact.contact_id) rows = rows.filter(t => (t.contact_name || "") === contact.contact_name || !t.contact_name);
    // Warm the cache so a later expand doesn't re-fetch.
    setCache(c => ({ ...c, [cellKey]: rows }));
    return rows.map(t => t.id);
  };

  const approveCategory = async (contact, category, e) => {
    e?.stopPropagation();  // don't toggle the row's expand/collapse
    const ck = contact.contact_id || `_nocontact_${contact.contact_name}`;
    const ak = category.category_account_id || "_uncat_";
    const key = `${ck}||${ak}`;
    if (approvingBusy[key]) return;
    const isCurrentlyApproved = !!approved[key];
    setApprovingBusy(b => ({ ...b, [key]: true }));
    try {
      const ids = await idsForCell(contact, category, key);
      if (ids.length) {
        const endpoint = isCurrentlyApproved ? "bulk-unapprove" : "bulk-approve";
        await api.post(`/companies/${currentId}/transactions/${endpoint}`, ids);
      }
      setApproved(a => ({ ...a, [key]: !isCurrentlyApproved }));
      toast.success(
        isCurrentlyApproved
          ? `Unapproved ${ids.length} txns in "${category.category_name}"`
          : `Approved ${ids.length} txns in "${category.category_name}"`,
      );
    } catch (err) {
      toast.error(`Failed: ${err.response?.data?.detail || err.message}`);
    } finally {
      setApprovingBusy(b => ({ ...b, [key]: false }));
    }
  };

  const approveContact = async (contact, e) => {
    e?.stopPropagation();
    const ck = contact.contact_id || `_nocontact_${contact.contact_name}`;
    if (approvingBusy[ck]) return;
    const isCurrentlyApproved = !!approved[ck];
    setApprovingBusy(b => ({ ...b, [ck]: true }));
    try {
      // Gather ids across every category on this contact in parallel.
      const perCat = await Promise.all(
        contact.categories.map(cat => {
          const ak = cat.category_account_id || "_uncat_";
          const key = `${ck}||${ak}`;
          return idsForCell(contact, cat, key).then(ids => ({ key, ids }));
        }),
      );
      const allIds = perCat.flatMap(x => x.ids);
      if (allIds.length) {
        const endpoint = isCurrentlyApproved ? "bulk-unapprove" : "bulk-approve";
        await api.post(`/companies/${currentId}/transactions/${endpoint}`, allIds);
      }
      // Cascade the visual state across the contact + all categories.
      setApproved(a => {
        const next = { ...a, [ck]: !isCurrentlyApproved };
        for (const { key } of perCat) next[key] = !isCurrentlyApproved;
        return next;
      });
      toast.success(
        isCurrentlyApproved
          ? `Unapproved ${allIds.length} txns for ${contact.contact_name}`
          : `Approved ${allIds.length} txns for ${contact.contact_name}`,
      );
    } catch (err) {
      toast.error(`Failed: ${err.response?.data?.detail || err.message}`);
    } finally {
      setApprovingBusy(b => ({ ...b, [ck]: false }));
    }
  };

  // One-click bulk approve of every AI-confident row on the company —
  // reuses the existing `bulk-approve-ai-ready` endpoint which flips
  // AI-categorized-unreviewed rows (needs_review=false, posted, categorized,
  // not yet human_reviewed) into human_reviewed. Marks every visible
  // rollup card as approved in one sweep.
  const bulkApproveAiReady = async () => {
    if (bulkBusy || bulkDone) return;
    setBulkBusy(true);
    try {
      const r = await api.post(
        `/companies/${currentId}/transactions/bulk-approve-ai-ready`, {},
      );
      const count = r.data?.approved || r.data?.count || 0;
      toast.success(`Approved ${count} AI-confident transactions`, { duration: 6000 });
      setBulkDone(true);
      // Mark every contact + category currently on-screen as approved
      // so the buttons visually reflect the bulk action. The next data
      // refresh from the server will confirm.
      const stamp = {};
      for (const c of contacts) {
        const ck = c.contact_id || `_nocontact_${c.contact_name}`;
        stamp[ck] = true;
        for (const cat of c.categories) {
          const ak = cat.category_account_id || "_uncat_";
          stamp[`${ck}||${ak}`] = true;
        }
      }
      setApproved(a => ({ ...a, ...stamp }));
    } catch (err) {
      toast.error(`Bulk approve failed: ${err.response?.data?.detail || err.message}`);
    } finally {
      setBulkBusy(false);
    }
  };

  // Shared styling — filled green when actionable, outlined green once done.
  const approveBtnClasses = (isApproved, size = "sm") => {
    const base = size === "sm"
      ? "text-[11px] px-2 py-0.5"
      : "text-xs px-2.5 py-1";
    if (isApproved) {
      return `${base} rounded-md border border-emerald-600 bg-white text-emerald-700 font-medium hover:bg-emerald-50`;
    }
    return `${base} rounded-md bg-emerald-600 text-white font-medium hover:bg-emerald-700`;
  };

  return (
    <div data-testid="txn-rollup-grid" className="p-4 flex flex-col gap-4">
      {/* Header bulk-action bar — one-tap approve every AI-confident row.
          Kept above the cards so it's discoverable but doesn't fight for
          screen with the toolbar. */}
      <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-emerald-200 bg-emerald-50/40">
        <div className="text-xs text-slate-700">
          <span className="font-semibold text-slate-900">Bulk approve.</span>{" "}
          Approve every transaction the AI got confident on across all contacts.
          Skips rows still flagged for review, keeps your custom rules and manual overrides intact.
        </div>
        <button
          type="button"
          onClick={bulkApproveAiReady}
          disabled={bulkBusy || bulkDone}
          data-testid="rollup-bulk-approve-ai-ready"
          className={`text-xs px-3 py-1.5 rounded-md font-medium shrink-0 ${
            bulkDone
              ? "border border-emerald-600 bg-white text-emerald-700 cursor-default"
              : "bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-70"
          }`}
        >
          {bulkBusy ? "Approving all…" : bulkDone ? "Approved all confident" : "Approve all AI-confident"}
        </button>
      </div>

      {contacts.map((c) => {
        const multi = c.categories.length > 1;
        const ck = c.contact_id || `_nocontact_${c.contact_name}`;
        const contactApproved = !!approved[ck];
        const contactBusy = !!approvingBusy[ck];
        return (
          <div
            key={c.contact_id || c.contact_name}
            data-testid={`rollup-card-${(c.contact_name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
            className={`rounded-lg border ${multi ? "border-amber-200" : "border-slate-200"} bg-white overflow-hidden`}
          >
            <div className="px-3 py-2 grid grid-cols-12 gap-2 items-center bg-slate-50 border-b">
              <div className="col-span-5 flex items-center gap-2 min-w-0">
                <div className="font-semibold text-slate-900 truncate">{c.contact_name}</div>
                {multi && (
                  <span className="text-[10px] uppercase tracking-wider text-amber-800 bg-amber-100 border border-amber-200 rounded px-1.5 py-0.5 shrink-0">
                    {c.categories.length} categories
                  </span>
                )}
              </div>
              {/* Bulk reassign contact — moves every txn under this
                  rollup to a different contact in one click. */}
              <div className="col-span-3 shrink-0">
                <select
                  value=""
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "__clear__") bulkReassignContact(c, "");
                    else if (v) bulkReassignContact(c, v);
                    e.target.value = "";
                  }}
                  disabled={!!reassigningContact[ck]}
                  data-testid={`rollup-bulk-reassign-contact-${ck}`}
                  className="w-full border border-slate-200 rounded px-1.5 py-1 text-[11px] bg-white text-slate-600 disabled:opacity-50"
                  title="Move every transaction on this contact to a different contact"
                >
                  <option value="">{reassigningContact[ck] ? "Moving…" : "Move all to…"}</option>
                  {c.contact_id && <option value="__clear__">— Clear contact —</option>}
                  {contactOptions
                    .filter(opt => opt.id !== c.contact_id)
                    .map(opt => (
                      <option key={opt.id} value={opt.id}>{opt.name}</option>
                    ))}
                </select>
              </div>
              <span className="col-span-3 text-right text-sm text-slate-500 font-mono-num">{c.total_count} txns</span>
              <div className="col-span-1 flex justify-end">
                <button
                  type="button"
                  onClick={(e) => approveContact(c, e)}
                  disabled={contactBusy}
                  data-testid={`rollup-approve-contact-${ck}`}
                  className={approveBtnClasses(contactApproved, "md")}
                  title={contactApproved ? "Click to unapprove" : "Approve all categories for this contact"}
                >
                  {contactBusy ? "Working…" : contactApproved ? "Approved" : "Approve"}
                </button>
              </div>
            </div>
            <div className="divide-y divide-slate-100">
              {c.categories.map((cat) => {
                const ak = cat.category_account_id || "_uncat_";
                const key = `${ck}||${ak}`;
                const isOpen = !!expanded[key];
                const cached = cache[key];
                const cellApproved = !!approved[key];
                const cellBusy = !!approvingBusy[key];
                const rangeStr = cat.min_amount === cat.max_amount
                  ? fmtMoney(cat.min_amount)
                  : `${fmtMoney(cat.min_amount)} – ${fmtMoney(cat.max_amount)}`;
                return (
                  <div key={cat.category_account_id || cat.category_name}>
                    <div className={`w-full grid grid-cols-12 gap-2 px-3 py-2 items-center text-xs ${isOpen ? "bg-slate-50" : "hover:bg-slate-50"}`}>
                      <button
                        type="button"
                        onClick={() => toggle(c, cat)}
                        aria-expanded={isOpen}
                        className="col-span-11 grid grid-cols-11 gap-2 items-center text-left"
                      >
                        <span className="col-span-1 flex items-center gap-1 font-mono-num text-slate-400">
                          <ChevronRight
                            size={12}
                            className={`text-slate-400 transition-transform ${isOpen ? "rotate-90" : ""}`}
                          />
                          {cat.category_code || "—"}
                        </span>
                        <span className="col-span-6 text-slate-800 truncate">{cat.category_name}</span>
                        <span className="col-span-1 text-right text-slate-500 font-mono-num text-sm">{cat.count}×</span>
                        <span className="col-span-3 text-right font-mono-num text-slate-700 text-sm">{rangeStr}</span>
                      </button>
                      <div className="col-span-1 flex justify-end">
                        <button
                          type="button"
                          onClick={(e) => approveCategory(c, cat, e)}
                          disabled={cellBusy}
                          data-testid={`rollup-approve-cat-${key}`}
                          className={approveBtnClasses(cellApproved, "sm")}
                          title={cellApproved ? "Click to unapprove" : "Approve this category"}
                        >
                          {cellBusy ? "…" : cellApproved ? "Approved" : "Approve"}
                        </button>
                      </div>
                    </div>
                    {isOpen && (
                      <div data-testid={`rollup-expand-${key}`} className="bg-slate-50/40 border-t border-slate-100">
                        {cached === "loading" && (
                          <div className="px-4 py-3 text-[11px] text-slate-500">Loading transactions…</div>
                        )}
                        {Array.isArray(cached) && cached.length === 0 && (
                          <div className="px-4 py-3 text-[11px] text-slate-500">No transactions matched.</div>
                        )}
                        {Array.isArray(cached) && cached.length > 0 && (
                          <div className="divide-y divide-slate-100 text-[13px]">
                            {cached.map(t => {
                              const busy = !!txnBusy[t.id];
                              const desc = (t.description || "").trim();
                              const showDesc = desc && desc !== (t.merchant || "").trim();
                              return (
                              <div key={t.id} className="grid grid-cols-12 gap-2 px-4 py-2 items-center hover:bg-white">
                                <span className="col-span-2 font-mono-num text-slate-500 text-sm">{t.date}</span>
                                <div className="col-span-3 min-w-0" title={t.description || t.merchant}>
                                  <div className="truncate text-slate-800 text-sm">
                                    {t.merchant || t.description || <span className="italic text-slate-400">—</span>}
                                    {t.needs_review && <span className="ml-2 text-[9px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1">review</span>}
                                    {t.human_reviewed && <span className="ml-2 text-[9px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1">approved</span>}
                                  </div>
                                  {showDesc && (
                                    <div className="truncate text-[11px] text-slate-500 mt-0.5" title={t.description}>
                                      {t.description}
                                    </div>
                                  )}
                                  {classesEnabled && (
                                    <select
                                      value={t.class_id || ""}
                                      onChange={(e) => setTxnClassId(t, e.target.value)}
                                      disabled={busy}
                                      data-testid={`rollup-txn-class-${t.id}`}
                                      className="mt-1 border border-slate-200 rounded px-1.5 py-0.5 text-[10px] bg-white text-slate-600 disabled:opacity-50 max-w-full truncate"
                                      title="Change class"
                                    >
                                      <option value="">— No class —</option>
                                      {classOptions.filter(c => c.active !== false).map(c => (
                                        <option key={c.id} value={c.id}>{c.name}</option>
                                      ))}
                                    </select>
                                  )}
                                  {projectsEnabled && (
                                    <select
                                      value={t.project_id || ""}
                                      onChange={(e) => setTxnProjectId(t, e.target.value)}
                                      disabled={busy}
                                      data-testid={`rollup-txn-project-${t.id}`}
                                      className="mt-1 ml-1 border border-slate-200 rounded px-1.5 py-0.5 text-[10px] bg-white text-slate-600 disabled:opacity-50 max-w-full truncate"
                                      title="Change project"
                                    >
                                      <option value="">— No project —</option>
                                      {projectOptions.filter(p => p.status !== "cancelled").map(p => (
                                        <option key={p.id} value={p.id}>{p.name}</option>
                                      ))}
                                    </select>
                                  )}
                                  {projectsEnabled && t.project_id && (() => {
                                    // Ensure phase list is loaded for this project.
                                    // Idempotent — cached after first fetch.
                                    ensurePhases(t.project_id);
                                    const phList = phasesByProject[t.project_id] || [];
                                    if (phList.length === 0) return null;
                                    return (
                                      <select
                                        value={t.phase_id || ""}
                                        onChange={(e) => setTxnPhaseId(t, e.target.value)}
                                        disabled={busy}
                                        data-testid={`rollup-txn-phase-${t.id}`}
                                        className="mt-1 ml-1 border border-slate-200 rounded px-1.5 py-0.5 text-[10px] bg-white text-slate-600 disabled:opacity-50 max-w-full truncate"
                                        title="Change phase"
                                      >
                                        <option value="">— No phase —</option>
                                        {phList
                                          .filter(p => p.status !== "cancelled")
                                          .map(p => (
                                            <option key={p.id} value={p.id}>{p.name}</option>
                                          ))}
                                      </select>
                                    );
                                  })()}
                                </div>
                                <select
                                  value={t.contact_id || ""}
                                  onChange={(e) => setTxnContact(t, e.target.value)}
                                  disabled={busy}
                                  data-testid={`rollup-txn-contact-${t.id}`}
                                  className="col-span-2 border border-slate-200 rounded px-1.5 py-1 text-[12px] bg-white text-slate-700 disabled:opacity-50 truncate min-w-0"
                                  title="Change contact"
                                >
                                  <option value="">— No contact —</option>
                                  {contactOptions.map(opt => (
                                    <option key={opt.id} value={opt.id}>{opt.name}</option>
                                  ))}
                                </select>
                                <select
                                  value={t.category_account_id || ""}
                                  onChange={(e) => setTxnCategory(t, e.target.value)}
                                  disabled={busy}
                                  data-testid={`rollup-txn-category-${t.id}`}
                                  className="col-span-2 border border-slate-200 rounded px-1.5 py-1 text-[12px] bg-white text-slate-700 disabled:opacity-50 truncate min-w-0"
                                  title="Change category"
                                >
                                  <option value="">— Uncategorized —</option>
                                  {categoryOptions.map(a => (
                                    <option key={a.id} value={a.id}>
                                      {a.code} · {a.name}
                                    </option>
                                  ))}
                                </select>
                                <span className={`col-span-2 text-right font-mono-num text-sm ${(t.amount || 0) < 0 ? "text-slate-800" : "text-emerald-700"}`}>
                                  {fmtMoney(t.amount)}
                                </span>
                                <div className="col-span-1 flex justify-end">
                                  <button
                                    type="button"
                                    onClick={() => toggleTxnApprove(t)}
                                    disabled={busy}
                                    data-testid={`rollup-txn-approve-${t.id}`}
                                    className={`text-[11px] px-2 py-1 rounded-md font-medium whitespace-nowrap ${
                                      t.human_reviewed
                                        ? "border border-emerald-600 bg-white text-emerald-700 hover:bg-emerald-50"
                                        : "bg-emerald-600 text-white hover:bg-emerald-700"
                                    } disabled:opacity-50`}
                                    title={t.human_reviewed ? "Click to unapprove" : "Approve this transaction"}
                                  >
                                    {busy ? "…" : t.human_reviewed ? "Approved" : "Approve"}
                                  </button>
                                </div>
                              </div>
                            );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ManualTxnModal({ accts, currentId, contactOptions = [], invoices = [], bills = [], initialTxn = null, onClose }) {
  const fmtMoney = useMoneyFmt();
  const isEdit = Boolean(initialTxn);
  const [date, setDate] = useState(initialTxn?.date || new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState(initialTxn?.description || "");
  const [merchant, setMerchant] = useState(initialTxn?.merchant || "");
  const [amount, setAmount] = useState(
    initialTxn?.amount != null ? String(initialTxn.amount) : ""
  );
  const [categoryId, setCategoryId] = useState(initialTxn?.category_account_id || "");
  // Source Account the transaction hit. Pulled from all Asset + Liability
  // rows on the Chart of Accounts (banks & savings live on the asset side,
  // credit cards & lines of credit on the liability side — we don't hard-
  // code type=bank/credit_card because the seed uses type=asset/liability
  // with subtype indicating current_asset / current_liability / etc).
  const [bankAccountId, setBankAccountId] = useState(initialTxn?.bank_account_id || "");
  const bankOptions = (accts || [])
    .filter((a) => ["asset", "liability"].includes(a.type))
    .sort((a, b) => (a.code || "").localeCompare(b.code || ""));
  const bankAssets = bankOptions.filter((a) => a.type === "asset");
  const bankLiabilities = bankOptions.filter((a) => a.type === "liability");
  const [busy, setBusy] = useState(false);
  // Contact link — CPA can pick an existing contact from the search
  // combo or type a brand-new name to auto-create one on save.
  const [contactId, setContactId] = useState(initialTxn?.contact_id || "");
  const [contactQuery, setContactQuery] = useState("");
  const [contactMenuOpen, setContactMenuOpen] = useState(false);
  const filteredContacts = (() => {
    const q = contactQuery.trim().toLowerCase();
    if (!q) return contactOptions.slice(0, 50);
    return contactOptions.filter((c) => (c.name || "").toLowerCase().includes(q)).slice(0, 50);
  })();
  const canCreateNewContact = contactQuery.trim().length > 1 && !contactOptions.some(
    (c) => (c.name || "").trim().toLowerCase() === contactQuery.trim().toLowerCase()
  );
  // Splits are optional — CPA toggles "Split into multiple categories"
  // to break the header amount across N lines instead of picking a
  // single category. Mirrors the SplitModal UX but lives inline in the
  // create flow so a CPA can post a proper multi-line JE without a
  // second click. Empty array = simple single-category mode.
  const initialSplits = Array.isArray(initialTxn?.splits) ? initialTxn.splits : [];
  const [splitsOn, setSplitsOn] = useState(initialSplits.length > 0);
  const [splitRows, setSplitRows] = useState(
    initialSplits.length > 0
      ? initialSplits.map((s) => ({
          amount: s.amount != null ? String(s.amount) : "",
          category_account_id: s.category_account_id || "",
          description: s.description || "",
        }))
      : [
          { amount: "", category_account_id: "", description: "" },
          { amount: "", category_account_id: "", description: "" },
        ]
  );
  const amtNum = parseFloat(amount || 0) || 0;
  const splitTotal = splitRows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const splitsBalance = Math.abs(splitTotal - amtNum) < 0.01;
  // Link to invoice / bill — the backend already exposes
  // /transactions/{id}/link (see routes/transactions.py). Positive
  // amounts default to invoice; negative default to bill. We surface
  // both dropdowns anyway so a refund-style txn can be re-linked
  // easily.
  const [linkKind, setLinkKind] = useState(
    initialTxn?.linked_bill_id ? "bill"
    : initialTxn?.linked_invoice_id ? "invoice"
    : (parseFloat(initialTxn?.amount || 0) >= 0 ? "invoice" : "bill")
  );
  const [linkId, setLinkId] = useState(
    initialTxn?.linked_invoice_id || initialTxn?.linked_bill_id || ""
  );
  const linkOptions = linkKind === "invoice" ? invoices : bills;

  // Auto-suggest a match once, on first render, if the user hasn't
  // manually picked a link yet. We look for a single OPEN doc with
  // (a) contact_name matching merchant (case-insensitive substring)
  // and (b) total within a penny of |amount|. Exactly-one match =
  // pre-select; ambiguous = leave blank and let the CPA decide.
  const [suggestedId, setSuggestedId] = useState(null);
  const [suggestApplied, setSuggestApplied] = useState(false);
  useEffect(() => {
    if (linkId || suggestApplied) return;
    const amt = Math.abs(parseFloat(amount || 0) || 0);
    if (!amt) return;
    const kind = parseFloat(amount || 0) >= 0 ? "invoice" : "bill";
    const pool = (kind === "invoice" ? invoices : bills).filter(d => {
      const st = (d.status || "").toLowerCase();
      if (st === "paid" || st === "void") return false;
      const t = parseFloat(d.total || 0);
      return Math.abs(t - amt) < 0.01;
    });
    // Prefer merchant match, but if nothing matches by merchant, don't
    // trigger — one same-amount doc isn't enough on its own. Require
    // the shorter side of the pair to be ≥ 4 chars so we don't
    // over-match generic tokens like "Inc" or "LLC".
    const m = (merchant || "").trim().toLowerCase();
    const matches = m && m.length >= 4
      ? pool.filter(d => {
          const cn = (d.contact_name || "").toLowerCase();
          if (!cn || cn.length < 4) return false;
          return cn.includes(m) || m.includes(cn);
        })
      : [];
    if (matches.length === 1) {
      setLinkKind(kind);
      setLinkId(matches[0].id);
      setSuggestedId(matches[0].id);
      setSuggestApplied(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, merchant, invoices, bills]);

  const save = async () => {
    if (splitsOn) {
      if (!amtNum) { toast.error("Enter the total amount first"); return; }
      if (!splitsBalance) { toast.error(`Split total ${splitTotal.toFixed(2)} must equal ${amtNum.toFixed(2)}`); return; }
      if (splitRows.some((r) => !r.category_account_id)) { toast.error("Every split needs a category"); return; }
    }
    setBusy(true);
    try {
      // Resolve the contact link. If the CPA typed a new name that
      // doesn't match anything in contactOptions, create the contact
      // first and use the returned id. Otherwise honor whatever
      // contactId is selected (may be empty for "no contact").
      let finalContactId = contactId;
      let finalContactName = "";
      if (finalContactId) {
        finalContactName = (contactOptions.find((c) => c.id === finalContactId) || {}).name || "";
      } else if (contactQuery.trim() && canCreateNewContact) {
        try {
          const cr = await api.post(`/companies/${currentId}/contacts`, {
            name: contactQuery.trim(),
            kind: (parseFloat(amount || 0) || 0) >= 0 ? "customer" : "vendor",
          });
          finalContactId = cr.data?.id || "";
          finalContactName = contactQuery.trim();
        } catch (e) {
          toast.error("Couldn't create the new contact — try again?");
          setBusy(false);
          return;
        }
      }
      const payload = {
        date, description, merchant, amount: amtNum,
        bank_account_id: bankAccountId || null,
        category_account_id: splitsOn ? null : (categoryId || null),
        splits: splitsOn ? splitRows.map((r) => ({
          amount: parseFloat(r.amount) || 0,
          category_account_id: r.category_account_id,
          description: r.description,
        })) : (isEdit ? [] : null),
        contact_id: finalContactId || null,
        contact_name: finalContactName || null,
      };
      if (isEdit) {
        await api.patch(`/companies/${currentId}/transactions/${initialTxn.id}`, payload);
        toast.success(splitsOn ? "Split transaction updated" : "Transaction updated");
      } else {
        const created = await api.post(`/companies/${currentId}/transactions`, {
          ...payload,
          auto_categorize: !splitsOn && !categoryId,
        });
        toast.success(splitsOn ? "Split transaction created" : "Transaction created");
        // For a brand-new manual txn we still want to honour any picked
        // link — use the returned id from the POST response.
        if (linkId) {
          const newId = created.data?.id;
          if (newId) {
            const q = linkKind === "invoice" ? `invoice_id=${linkId}` : `bill_id=${linkId}`;
            await api.post(`/companies/${currentId}/transactions/${newId}/link?${q}`);
          }
        }
      }
      // On edit, always push the current link selection so unlinking
      // (setting to empty) works too. Empty string clears both sides.
      if (isEdit) {
        const currentLinked = initialTxn?.linked_invoice_id || initialTxn?.linked_bill_id || "";
        if (linkId !== currentLinked || (initialTxn?.linked_bill_id && linkKind === "invoice") || (initialTxn?.linked_invoice_id && linkKind === "bill")) {
          const params = new URLSearchParams();
          if (linkKind === "invoice") {
            params.set("invoice_id", linkId || "");
            // Clear the other side explicitly.
            if (initialTxn?.linked_bill_id) params.set("bill_id", "");
          } else {
            params.set("bill_id", linkId || "");
            if (initialTxn?.linked_invoice_id) params.set("invoice_id", "");
          }
          await api.post(`/companies/${currentId}/transactions/${initialTxn.id}/link?${params.toString()}`);
        }
      }
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to save");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={isEdit ? "Edit transaction" : "Add manual transaction"} onClose={onClose} wide={splitsOn}>
      <div className="space-y-3 text-sm">
        <div><label className="text-xs text-slate-600">Date</label>
          <input data-testid="manual-txn-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full border rounded px-2 py-1.5" /></div>
        <div>
          <label className="text-xs text-slate-600">Account</label>
          <select
            data-testid="manual-txn-bank-account"
            value={bankAccountId}
            onChange={(e) => setBankAccountId(e.target.value)}
            className="w-full border rounded px-2 py-1.5 text-sm bg-white"
          >
            <option value="">— Default (Business Checking) —</option>
            {bankAssets.length > 0 && (
              <optgroup label="Assets (bank, cash, receivable…)">
                {bankAssets.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                ))}
              </optgroup>
            )}
            {bankLiabilities.length > 0 && (
              <optgroup label="Liabilities (credit cards, loans, payable…)">
                {bankLiabilities.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        <div className="relative" onBlur={(e) => {
          // Close the contact menu on blur unless focus went to a child.
          if (!e.currentTarget.contains(e.relatedTarget)) {
            setTimeout(() => setContactMenuOpen(false), 150);
          }
        }}>
          <label className="text-xs text-slate-600">Contact</label>
          <input
            data-testid="manual-txn-contact-input"
            type="text"
            placeholder="Search or type a new name…"
            value={contactId
              ? ((contactOptions.find((c) => c.id === contactId) || {}).name || initialTxn?.contact_name || "")
              : contactQuery}
            onFocus={() => setContactMenuOpen(true)}
            onChange={(e) => {
              setContactId("");
              setContactQuery(e.target.value);
              setContactMenuOpen(true);
            }}
            className="w-full border rounded px-2 py-1.5 text-sm"
          />
          {contactMenuOpen && (filteredContacts.length > 0 || canCreateNewContact) && (
            <div className="absolute z-30 left-0 right-0 top-[calc(100%+2px)] max-h-[240px] overflow-y-auto rounded-md border border-slate-200 bg-white shadow-xl">
              {filteredContacts.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  data-testid={`manual-txn-contact-opt-${c.id}`}
                  onClick={() => {
                    setContactId(c.id);
                    setContactQuery("");
                    setContactMenuOpen(false);
                  }}
                  className="w-full text-left px-2 py-1.5 text-xs hover:bg-slate-50 border-b border-slate-100 last:border-b-0"
                >
                  {c.name}
                </button>
              ))}
              {canCreateNewContact && (
                <button
                  type="button"
                  data-testid="manual-txn-contact-add-new"
                  onClick={() => setContactMenuOpen(false)}
                  className="w-full text-left px-2 py-1.5 text-xs text-cyan-700 font-semibold hover:bg-cyan-50 border-t border-slate-100"
                >
                  + Use new contact "{contactQuery.trim()}"
                </button>
              )}
            </div>
          )}
        </div>
        <div><label className="text-xs text-slate-600">Merchant</label>
          <input data-testid="manual-txn-merchant" value={merchant} onChange={(e) => setMerchant(e.target.value)} className="w-full border rounded px-2 py-1.5" /></div>
        <div><label className="text-xs text-slate-600">Description</label>
          <input data-testid="manual-txn-description" value={description} onChange={(e) => setDescription(e.target.value)} className="w-full border rounded px-2 py-1.5" /></div>
        <div><label className="text-xs text-slate-600">Amount (negative = expense)</label>
          <input data-testid="manual-txn-amount" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full border rounded px-2 py-1.5 font-mono-num" /></div>
        <div className="flex items-center gap-2 pt-1">
          <input
            type="checkbox"
            id="manual-txn-splits-on"
            data-testid="manual-txn-splits-toggle"
            checked={splitsOn}
            onChange={(e) => setSplitsOn(e.target.checked)}
            className="rounded"
          />
          <label htmlFor="manual-txn-splits-on" className="text-xs text-slate-700 font-medium cursor-pointer">
            Split into multiple categories
          </label>
        </div>
        {splitsOn ? (
          <div className="space-y-2 border-t pt-3" data-testid="manual-txn-splits-panel">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
              Splits — must sum to {fmtMoney(amtNum)}
            </div>
            {splitRows.map((r, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-center">
                <input
                  type="number"
                  step="0.01"
                  placeholder="Amount"
                  value={r.amount}
                  onChange={(e) => setSplitRows(splitRows.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))}
                  className="col-span-3 border rounded px-2 py-1.5 font-mono-num text-xs"
                />
                <div className="col-span-6 min-w-0">
                  <AccountPicker
                    value={r.category_account_id}
                    accounts={accts}
                    onChange={(id) => setSplitRows(splitRows.map((x, j) => j === i ? { ...x, category_account_id: id } : x))}
                    companyId={currentId}
                    testId={`manual-txn-split-cat-${i}`}
                  />
                </div>
                <input
                  placeholder="Note"
                  value={r.description}
                  onChange={(e) => setSplitRows(splitRows.map((x, j) => j === i ? { ...x, description: e.target.value } : x))}
                  className="col-span-2 border rounded px-2 py-1.5 text-xs"
                />
                <button
                  onClick={() => splitRows.length > 1 && setSplitRows(splitRows.filter((_, j) => j !== i))}
                  disabled={splitRows.length <= 1}
                  className="col-span-1 text-red-500 hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Remove split line"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <div className="flex items-center justify-between pt-1">
              <button
                onClick={() => setSplitRows([...splitRows, { amount: "", category_account_id: "", description: "" }])}
                data-testid="manual-txn-split-add"
                className="text-xs text-slate-600 border border-dashed border-slate-300 rounded px-2 py-1 hover:bg-slate-50"
              >
                + Add split line
              </button>
              <div className={`text-xs ${splitsBalance && amtNum ? "text-emerald-600" : "text-red-600"}`}>
                Total: <span className="font-mono-num font-semibold">{fmtMoney(splitTotal)}</span>
                {" · Target: "}
                <span className="font-mono-num">{fmtMoney(amtNum)}</span>
              </div>
            </div>
          </div>
        ) : (
          <div>
            <label className="text-xs text-slate-600">Category (leave blank for AI)</label>
            <div className="flex items-center gap-2 mt-1 mb-2">
              <input
                type="checkbox"
                id="manual-txn-let-ai"
                checked={!categoryId}
                onChange={(e) => { if (e.target.checked) setCategoryId(""); }}
                className="rounded"
              />
              <label htmlFor="manual-txn-let-ai" className="text-xs text-slate-600 cursor-pointer">
                Let AI decide
              </label>
            </div>
            <div className={!categoryId ? "opacity-40" : ""}>
              <AccountPicker
                value={categoryId}
                accounts={accts}
                onChange={(id) => setCategoryId(id)}
                companyId={currentId}
                testId="manual-txn-category-picker"
              />
            </div>
          </div>
        )}
        <div className="border-t pt-3 space-y-2" data-testid="txn-link-section">
          <div className="flex items-center justify-between">
            <label className="text-xs text-slate-600 font-medium inline-flex items-center gap-2">
              Link to invoice or bill
              {suggestedId && suggestedId === linkId && (
                <span
                  data-testid="txn-link-suggested"
                  className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-800"
                  title="Auto-matched by merchant + amount"
                >Auto-matched</span>
              )}
            </label>
            {linkId && (
              <button
                type="button"
                onClick={() => { setLinkId(""); setSuggestedId(null); }}
                className="text-[10px] text-rose-600 hover:underline"
                data-testid="txn-link-clear"
              >Unlink</button>
            )}
          </div>
          <div className="flex gap-2">
            <div className="inline-flex rounded-md border bg-slate-50 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => { setLinkKind("invoice"); setLinkId(""); }}
                data-testid="txn-link-kind-invoice"
                className={`px-2.5 py-1 rounded ${linkKind === "invoice" ? "bg-emerald-600 text-white" : "text-slate-600"}`}
              >Invoice</button>
              <button
                type="button"
                onClick={() => { setLinkKind("bill"); setLinkId(""); }}
                data-testid="txn-link-kind-bill"
                className={`px-2.5 py-1 rounded ${linkKind === "bill" ? "bg-rose-600 text-white" : "text-slate-600"}`}
              >Bill</button>
            </div>
            <select
              value={linkId}
              onChange={(e) => setLinkId(e.target.value)}
              className="flex-1 border rounded px-2 py-1.5 text-sm bg-white"
              data-testid="txn-link-select"
            >
              <option value="">— None (not linked) —</option>
              {linkOptions.map(x => (
                <option key={x.id} value={x.id}>
                  {x.number} · {x.contact_name || "no contact"} · {fmtMoney(x.total)}{x.status ? ` · ${x.status}` : ""}
                </option>
              ))}
            </select>
          </div>
          <p className="text-[10px] text-slate-400">
            Linking marks this transaction as the payment/receipt for the picked {linkKind}. Leave blank to un-link.
          </p>
        </div>
        <button data-testid={TID.saveBtn} onClick={save} disabled={busy}
                className="w-full py-2 rounded-md bg-slate-900 text-white text-sm disabled:opacity-50">
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}

function SplitModal({ txn, accts, currentId, onClose }) {
  const fmtMoney = useMoneyFmt();
  const [rows, setRows] = useState([
    { amount: (txn.amount / 2).toFixed(2), category_account_id: txn.category_account_id, description: "" },
    { amount: (txn.amount / 2).toFixed(2), category_account_id: "", description: "" },
  ]);
  const total = rows.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
  const save = async () => {
    if (Math.abs(total - txn.amount) > 0.01) { toast.error(`Must total ${txn.amount}`); return; }
    await api.post(`/companies/${currentId}/transactions/${txn.id}/split`, { splits: rows });
    toast.success("Transaction split"); onClose();
  };
  return (
    <Modal title={`Split ${fmtMoney(txn.amount)} · ${txn.merchant}`} onClose={onClose} wide>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 items-center">
            <input type="number" step="0.01" value={r.amount}
                   onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))}
                   className="col-span-3 border rounded px-2 py-1.5 font-mono-num text-sm" />
            <select value={r.category_account_id}
                    onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, category_account_id: e.target.value } : x))}
                    className="col-span-5 border rounded px-2 py-1.5 text-sm">
              <option value="">Category…</option>
              {accts.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
            </select>
            <input placeholder="Description" value={r.description}
                   onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, description: e.target.value } : x))}
                   className="col-span-3 border rounded px-2 py-1.5 text-sm" />
            <button onClick={() => setRows(rows.filter((_, j) => j !== i))} className="col-span-1 text-red-500"><Trash2 size={14} /></button>
          </div>
        ))}
        <button onClick={() => setRows([...rows, { amount: "0", category_account_id: "", description: "" }])}
                className="text-xs text-slate-600 border border-dashed rounded px-2 py-1">+ Add split</button>
        <div className="flex items-center justify-between border-t pt-3 mt-3">
          <div className={`text-sm ${Math.abs(total - txn.amount) < 0.01 ? "text-emerald-600" : "text-red-600"}`}>
            Split total: <span className="font-mono-num font-semibold">{fmtMoney(total)}</span> · Target: <span className="font-mono-num">{fmtMoney(txn.amount)}</span>
          </div>
          <button data-testid={TID.saveBtn} onClick={save} className="px-4 py-1.5 rounded-md bg-slate-900 text-white text-sm">Save split</button>
        </div>
      </div>
    </Modal>
  );
}

function LinkModal({ txn, invoices, bills, currentId, onClose }) {
  const fmtMoney = useMoneyFmt();
  const [kind, setKind] = useState(txn.amount > 0 ? "invoice" : "bill");
  const [selId, setSelId] = useState("");
  const save = async () => {
    const body = kind === "invoice" ? { invoice_id: selId } : { bill_id: selId };
    const q = new URLSearchParams(body).toString();
    await api.post(`/companies/${currentId}/transactions/${txn.id}/link?${q}`);
    toast.success(`Linked to ${kind}`); onClose();
  };
  const list = kind === "invoice" ? invoices : bills;
  return (
    <Modal title="Link transaction to invoice or bill" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <div className="flex gap-2">
          <button onClick={() => setKind("invoice")}
                  className={`px-3 py-1.5 rounded ${kind === "invoice" ? "bg-slate-900 text-white" : "border"}`}>Invoice</button>
          <button onClick={() => setKind("bill")}
                  className={`px-3 py-1.5 rounded ${kind === "bill" ? "bg-slate-900 text-white" : "border"}`}>Bill</button>
        </div>
        <select value={selId} onChange={(e) => setSelId(e.target.value)} className="w-full border rounded px-2 py-1.5">
          <option value="">Select {kind}…</option>
          {list.map(x => <option key={x.id} value={x.id}>{x.number} · {x.contact_name} · {fmtMoney(x.total)}</option>)}
        </select>
        <button data-testid={TID.saveBtn} disabled={!selId} onClick={save}
                className="w-full py-2 rounded-md bg-slate-900 text-white text-sm disabled:opacity-50">Link</button>
      </div>
    </Modal>
  );
}
