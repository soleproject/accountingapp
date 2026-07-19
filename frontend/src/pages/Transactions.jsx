import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, fmtMoney, fmtDate } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { useAiFocus } from "@/lib/aiFocus";
import { TID } from "@/constants/testIds";
import { toast } from "sonner";
import {
  Check, Wand2, Split, Link as LinkIcon, RotateCw, Plus, X, Trash2, AlertTriangle, ShieldCheck,
  ChevronLeft, ChevronRight, Search, Calendar, XCircle, Tag, Sparkles, MoreHorizontal,
  List as ListIcon, LayoutGrid,
} from "lucide-react";
import ReclassifyPicker from "@/components/ReclassifyPicker";
import { emitAction, useActionListener } from "@/lib/createBus";

const PAGE_SIZE_OPTIONS = [25, 50, 100, 250, 500];

// Per-row "More" dropdown for the actions we don't want cluttering the row:
// AI re-categorize, Split, and Link-to-invoice/bill. Opens on click, closes
// on outside click or Escape. Positioned above the button so the menu never
// clips off the bottom of the viewport on the last few rows.
function RowMoreMenu({ t, onRecategorize, onSplit, onLink, onDelete }) {
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

function ConfidenceChip({ conf, needs_review }) {
  const v = Number(conf || 0);
  // Needs-review always renders in an attention color regardless of the raw
  // confidence value. Some rows (transfers auto-routed to Uncategorized) have
  // conf=0.95 by design — the chip must not go green on them because the row
  // still requires an accountant to reclassify.
  let cls, label;
  if (needs_review) {
    cls = v < 0.70 ? "confidence-low" : "confidence-med";  // rose vs amber
    label = "Needs review";
  } else {
    cls = v >= 0.85 ? "confidence-high" : v >= 0.70 ? "confidence-med" : "confidence-low";
    label = v >= 0.85 ? "High" : v >= 0.70 ? "Medium" : "Low";
  }
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${cls}`}>
      {needs_review ? <AlertTriangle size={10} /> : <ShieldCheck size={10} />}
      {label} · {(v * 100).toFixed(0)}%
    </span>
  );
}

export default function Transactions() {
  const { currentId } = useCompany();
  const { setFocus } = useAiFocus();
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
  const [ruleSuggestion, setRuleSuggestion] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [pagination, setPagination] = useState({ total: 0, page: 1, pages: 1, limit: 25 });
  // Toolbar filters
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // "list" (default) or "rollup" — toggled by the two icons in the toolbar.
  const [view, setView] = useState("list");
  const [rollup, setRollup] = useState(null);
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
    if (debouncedSearch) params.set("q", debouncedSearch);
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
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

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId, filter, page, pageSize, debouncedSearch, dateFrom, dateTo]);
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
      const r = await api.get(`/companies/${currentId}/transactions/contact-category-rollup?${p.toString()}`);
      setRollup(r.data);
    } finally { setRollupBusy(false); }
  };
  useEffect(() => { loadRollup(); /* eslint-disable-next-line */ }, [currentId, view, debouncedSearch, dateFrom, dateTo]);
  // Keep a live ref to `load` so the background sync poller can invoke the
  // CURRENT filter-aware load — not the stale closure from mount. Without
  // this, clicking "Needs Review" briefly shows filtered rows and then the
  // poller (5-15s later) fires the original all-rows load and overwrites
  // them, so the tab stays selected but rows revert to All.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; });
  // AI-panel actions (approve-with-suggestion / bulk-approve-rule) reload us.
  useActionListener("txns:changed", () => { loadRef.current?.(); });
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
  };
  const filtersActive = Boolean(debouncedSearch || dateFrom || dateTo || filter === "review");

  const [params] = useSearchParams();
  // Voice-command deep-link support: /accounting/transactions?q=Walmart or
  // ?date_from=2026-07-15&date_to=2026-07-15. On mount / URL change, hydrate
  // the toolbar state so the user sees a filtered view immediately.
  const paramsKey = params.toString();
  useEffect(() => {
    const q       = params.get("q") || "";
    const df      = params.get("date_from") || "";
    const dt      = params.get("date_to") || "";
    const flt     = params.get("filter") || "";
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

  const acctById = useMemo(() => Object.fromEntries(accts.map(a => [a.id, a])), [accts]);

  const toggleSel = (id) => {
    const s = new Set(selected);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelected(s);
  };
  const allChecked = txns.length > 0 && txns.every(t => selected.has(t.id));

  const bulkApprove = async () => {
    if (!selected.size) return;
    setBusy(true);
    await api.post(`/companies/${currentId}/transactions/bulk-approve`, [...selected]);
    setBusy(false); setSelected(new Set()); toast.success(`Approved ${selected.size} transactions.`);
    load();
  };

  const bulkCreateRules = async () => {
    if (!selected.size) return;
    const grouped = {};
    for (const id of selected) {
      const t = txns.find(x => x.id === id);
      if (!t || !t.merchant || !t.category_account_code) continue;
      grouped[`${t.merchant}::${t.category_account_code}`] = t;
    }
    const items = Object.values(grouped);
    setBusy(true);
    for (const t of items) {
      await api.post(`/companies/${currentId}/rules`, {
        match_type: "merchant_contains",
        match_value: t.merchant,
        account_code: t.category_account_code,
        apply_to_existing: true,
      });
    }
    setBusy(false); setSelected(new Set());
    toast.success(`Created ${items.length} rule${items.length === 1 ? "" : "s"} and applied to existing transactions.`);
    load();
  };

  const bulkReclassify = async (categoryAccountId) => {
    if (!selected.size) return;
    setBusy(true);
    try {
      const r = await api.post(`/companies/${currentId}/transactions/bulk-reclassify`, {
        transaction_ids: [...selected],
        category_account_id: categoryAccountId,
      });
      const acct = accts.find(a => a.id === categoryAccountId);
      toast.success(
        `Reclassified ${r.data.updated} txn(s) → ${acct?.name || "category"}`
        + (r.data.skipped_closed?.length
            ? `. Skipped ${r.data.skipped_closed.length} (closed period).`
            : "")
      );
      setReclassOpen(false);
      setSelected(new Set());
      if (r.data.rule_suggestion) setRuleSuggestion(r.data.rule_suggestion);
      load();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Reclassify failed");
    } finally {
      setBusy(false);
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

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Transactions</h1>
          <p className="text-slate-500 text-sm mt-1">
            AI has posted the confident ones. Review the flagged. Hover a row to give the assistant context.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border bg-white">
            {["all", "review"].map(f => (
              <button
                key={f}
                data-testid={f === "review" ? TID.txnFilterReview : `txn-filter-${f}`}
                onClick={() => { setFilter(f); setPage(1); }}
                className={`px-3 py-1.5 text-xs font-medium ${filter === f ? "bg-slate-900 text-white" : "text-slate-600"}`}
              >
                {f === "all" ? "All" : "Needs Review"}
                {filter === f && (
                  <span data-testid={`txn-filter-count-${f}`}
                        className="ml-1.5 px-1.5 py-0.5 rounded bg-white/20 font-mono-num">
                    {pagination.total}
                  </span>
                )}
              </button>
            ))}
          </div>
          <button
            data-testid={TID.txnAddBtn}
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs"
          >
            <Plus size={13} /> Manual Transaction
          </button>
        </div>
      </div>

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
          <button data-testid={TID.txnBulkApprove} disabled={busy} onClick={bulkApprove}
                  className="inline-flex items-center gap-1 px-3 py-1 rounded bg-white text-slate-900 text-xs font-medium">
            <Check size={12} /> Approve all
          </button>
          <button
            data-testid="txn-bulk-reclassify"
            disabled={busy}
            onClick={() => setReclassOpen(true)}
            className="inline-flex items-center gap-1 px-3 py-1 rounded bg-emerald-500 text-xs font-medium hover:bg-emerald-600"
          >
            <Tag size={12} /> Reclassify
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
        />
      )}

      <div className="rounded-xl border bg-white overflow-hidden">
        {view === "rollup" ? (
          <ContactRollup
            data={rollup}
            busy={rollupBusy}
            currentId={currentId}
          />
        ) : (
        <>
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
                <th className="px-3 py-2 text-left">Status</th>
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
                  <td className="px-3 py-2 text-slate-700 max-w-[160px] truncate" title={t.contact_name || ""}>
                    {t.contact_name || <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{t.merchant || t.description}</div>
                    {t.splits?.length > 0 && <div className="text-[10px] text-indigo-600">Split into {t.splits.length}</div>}
                    {(t.linked_invoice_id || t.linked_bill_id) && (
                      <div className="text-[10px] text-emerald-700">Linked to {t.linked_invoice_id ? "invoice" : "bill"}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <select data-testid={TID.txnEditCategory} value={t.category_account_id || ""}
                            onChange={(e) => updateCategory(t.id, e.target.value)}
                            className="text-xs border rounded px-1.5 py-1 bg-white max-w-[180px]">
                      <option value="">— Uncategorized —</option>
                      {accts.map(a => (
                        <option key={a.id} value={a.id}>{a.code} {a.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2"><ConfidenceChip conf={t.ai_confidence} needs_review={t.needs_review} /></td>
                  <td className={`px-3 py-2 text-right font-mono-num ${t.amount < 0 ? "text-slate-800" : "text-emerald-700 font-semibold"}`}>
                    {fmtMoney(t.amount)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono-num text-slate-500 text-xs">{t.bank_balance_after ? fmtMoney(t.bank_balance_after) : "—"}</td>
                  <td className="px-3 py-2">
                    {t.posted && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">Posted</span>}
                    {t.human_reviewed && <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-700">Reviewed</span>}
                  </td>
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
                          emitAction("ai-open");
                        }}
                        className="p-1 rounded hover:bg-fuchsia-100 text-fuchsia-600"
                      >
                        <Sparkles size={14} />
                      </button>
                      <RowMoreMenu
                        t={t}
                        onRecategorize={() => recategorize(t.id)}
                        onSplit={() => setSplitting(t)}
                        onLink={() => setLinking(t)}
                        onDelete={() => del(t.id)}
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
        </>
        )}
      </div>

      {creating && <ManualTxnModal accts={accts} currentId={currentId} onClose={() => { setCreating(false); load(); }} />}
      {splitting && <SplitModal txn={splitting} accts={accts} currentId={currentId} onClose={() => { setSplitting(null); load(); }} />}
      {linking && <LinkModal txn={linking} invoices={invoices} bills={bills} currentId={currentId} onClose={() => { setLinking(null); load(); }} />}
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
function ContactRollup({ data, busy, currentId }) {
  const contacts = data?.contacts || [];
  // Cache expanded rows: key = `${contactKey}||${categoryKey}` → txn list.
  const [expanded, setExpanded] = useState({});   // key → true/false
  const [cache, setCache] = useState({});          // key → txn[] (or "loading")

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

  return (
    <div data-testid="txn-rollup-grid" className="p-4 flex flex-col gap-4">
      {contacts.map((c) => {
        const multi = c.categories.length > 1;
        return (
          <div
            key={c.contact_id || c.contact_name}
            data-testid={`rollup-card-${(c.contact_name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
            className={`rounded-lg border ${multi ? "border-amber-200" : "border-slate-200"} bg-white overflow-hidden`}
          >
            <div className="px-3 py-2 flex items-center justify-between bg-slate-50 border-b">
              <div className="font-semibold text-slate-900 truncate">{c.contact_name}</div>
              <div className="flex items-center gap-2 shrink-0">
                {multi && (
                  <span className="text-[10px] uppercase tracking-wider text-amber-800 bg-amber-100 border border-amber-200 rounded px-1.5 py-0.5">
                    {c.categories.length} categories
                  </span>
                )}
                <span className="text-xs text-slate-500 font-mono-num">{c.total_count} txns</span>
              </div>
            </div>
            <div className="divide-y divide-slate-100">
              {c.categories.map((cat) => {
                const ck = c.contact_id || `_nocontact_${c.contact_name}`;
                const ak = cat.category_account_id || "_uncat_";
                const key = `${ck}||${ak}`;
                const isOpen = !!expanded[key];
                const cached = cache[key];
                const rangeStr = cat.min_amount === cat.max_amount
                  ? fmtMoney(cat.min_amount)
                  : `${fmtMoney(cat.min_amount)} – ${fmtMoney(cat.max_amount)}`;
                return (
                  <div key={cat.category_account_id || cat.category_name}>
                    <button
                      onClick={() => toggle(c, cat)}
                      className={`w-full grid grid-cols-12 gap-2 px-3 py-2 items-center text-xs text-left ${isOpen ? "bg-slate-50" : "hover:bg-slate-50"}`}
                      aria-expanded={isOpen}
                    >
                      <span className="col-span-1 flex items-center gap-1 font-mono-num text-slate-400">
                        <ChevronRight
                          size={12}
                          className={`text-slate-400 transition-transform ${isOpen ? "rotate-90" : ""}`}
                        />
                        {cat.category_code || "—"}
                      </span>
                      <span className="col-span-6 text-slate-800 truncate">{cat.category_name}</span>
                      <span className="col-span-1 text-right text-slate-500 font-mono-num">{cat.count}×</span>
                      <span className="col-span-4 text-right font-mono-num text-slate-600">{rangeStr}</span>
                    </button>
                    {isOpen && (
                      <div data-testid={`rollup-expand-${key}`} className="bg-slate-50/40 border-t border-slate-100">
                        {cached === "loading" && (
                          <div className="px-4 py-3 text-[11px] text-slate-500">Loading transactions…</div>
                        )}
                        {Array.isArray(cached) && cached.length === 0 && (
                          <div className="px-4 py-3 text-[11px] text-slate-500">No transactions matched.</div>
                        )}
                        {Array.isArray(cached) && cached.length > 0 && (
                          <div className="divide-y divide-slate-100 text-[12px]">
                            {cached.map(t => (
                              <div key={t.id} className="grid grid-cols-12 gap-2 px-4 py-1.5 items-center hover:bg-white">
                                <span className="col-span-2 font-mono-num text-slate-500">{t.date}</span>
                                <span className="col-span-7 truncate text-slate-800" title={t.merchant || t.description}>
                                  {t.merchant || t.description || <span className="italic text-slate-400">—</span>}
                                  {t.needs_review && <span className="ml-2 text-[9px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1">review</span>}
                                  {t.human_reviewed && <span className="ml-2 text-[9px] text-slate-600 bg-slate-100 rounded px-1">reviewed</span>}
                                </span>
                                <span className={`col-span-3 text-right font-mono-num ${(t.amount || 0) < 0 ? "text-slate-800" : "text-emerald-700"}`}>
                                  {fmtMoney(t.amount)}
                                </span>
                              </div>
                            ))}
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

function ManualTxnModal({ accts, currentId, onClose }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [merchant, setMerchant] = useState("");
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    await api.post(`/companies/${currentId}/transactions`, {
      date, description, merchant, amount: parseFloat(amount),
      category_account_id: categoryId || null, auto_categorize: !categoryId,
    });
    setBusy(false); toast.success("Transaction created (AI categorized)"); onClose();
  };
  return (
    <Modal title="Add manual transaction" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <div><label className="text-xs text-slate-600">Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full border rounded px-2 py-1.5" /></div>
        <div><label className="text-xs text-slate-600">Merchant</label>
          <input value={merchant} onChange={(e) => setMerchant(e.target.value)} className="w-full border rounded px-2 py-1.5" /></div>
        <div><label className="text-xs text-slate-600">Description</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className="w-full border rounded px-2 py-1.5" /></div>
        <div><label className="text-xs text-slate-600">Amount (negative = expense)</label>
          <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full border rounded px-2 py-1.5 font-mono-num" /></div>
        <div><label className="text-xs text-slate-600">Category (leave blank for AI)</label>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="w-full border rounded px-2 py-1.5">
            <option value="">Let AI decide</option>
            {accts.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
          </select></div>
        <button data-testid={TID.saveBtn} onClick={save} disabled={busy}
                className="w-full py-2 rounded-md bg-slate-900 text-white text-sm">Save</button>
      </div>
    </Modal>
  );
}

function SplitModal({ txn, accts, currentId, onClose }) {
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
