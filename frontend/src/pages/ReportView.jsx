import { useEffect, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { api, fmtMoney, BACKEND_URL } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Download, Loader2, ArrowRightCircle, ChevronLeft, Search, SlidersHorizontal, X } from "lucide-react";
import ReclassifyPicker from "@/components/ReclassifyPicker";
import { toast } from "sonner";

const startYtd = () => new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

// ------------------------- Account Detail (full report) -------------------------
// Rendered when `kind === "account-detail"`. Same visual grammar as the
// other reports (Balance Sheet, Income Statement, Trial Balance) — full
// page, PDF-exportable via the standard header — but with bulk-update
// capability (checkboxes + Move-to-account).

function AccountDetailBody({ currentId, data, onReload, searchParams, setSearchParams, navigate }) {
  const rows = data.rows || [];
  const account = data.account || {};
  const [selected, setSelected] = useState(() => new Set(rows.map(r => r.id)));
  const [moving, setMoving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [accounts, setAccounts] = useState([]);

  // Search + filter state — synced to URL params so the view is deep-linkable,
  // survives refresh, and can be voice-populated.
  const [searchDraft, setSearchDraft] = useState(searchParams.get("q") || "");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const startVal    = searchParams.get("start") || "";
  const endVal      = searchParams.get("end") || "";
  const minAmountVal = searchParams.get("min_amount") || "";
  const maxAmountVal = searchParams.get("max_amount") || "";
  const activeFilterCount =
    (startVal ? 1 : 0) + (endVal ? 1 : 0) +
    (minAmountVal ? 1 : 0) + (maxAmountVal ? 1 : 0);

  const applyFilter = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (value === "" || value == null) next.delete(key); else next.set(key, value);
    setSearchParams(next, { replace: true });
  };
  const applySearch = (val) => applyFilter("q", val);
  const clearAllFilters = () => {
    const next = new URLSearchParams(searchParams);
    ["q", "start", "end", "min_amount", "max_amount"].forEach(k => next.delete(k));
    setSearchDraft("");
    setSearchParams(next, { replace: true });
  };

  // Breadcrumb back to Balance Sheet — restores the exact scroll position
  // saved when the user clicked into this account.
  const goBackToBalanceSheet = () => {
    const returnUrl = sessionStorage.getItem("bsReturnUrl") || "/reports/balance-sheet";
    navigate(returnUrl);
  };

  // Re-seed selection when a new dataset lands (e.g. after a Move refetches).
  useEffect(() => {
    setSelected(new Set((data.rows || []).map(r => r.id)));
  }, [data]);

  useEffect(() => {
    if (!currentId) return;
    api.get(`/companies/${currentId}/accounts`).then(r => setAccounts(r.data.accounts || []));
  }, [currentId]);

  const allSelected = rows.length > 0 && selected.size === rows.length;
  const someSelected = selected.size > 0 && !allSelected;
  const toggleOne = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected(prev => prev.size === rows.length ? new Set() : new Set(rows.map(t => t.id)));
  };

  const doMove = async (targetId) => {
    if (selected.size === 0 || !targetId) return;
    setApplying(true);
    try {
      await api.post(`/companies/${currentId}/transactions/bulk-reclassify`, {
        transaction_ids: Array.from(selected),
        category_account_id: targetId,
      });
      const to = accounts.find(a => a.id === targetId);
      toast.success(`Moved ${selected.size} transaction${selected.size === 1 ? "" : "s"} to ${to?.name || "account"}`);
      setMoving(false);
      onReload?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Move failed");
    } finally {
      setApplying(false);
    }
  };

  const selectedTotal = rows
    .filter(t => selected.has(t.id))
    .reduce((s, t) => s + (t.delta || 0), 0);

  return (
    <div className="text-sm">
      {/* Breadcrumb — back to Balance Sheet, preserving scroll position. */}
      <div className="mb-3 flex items-center gap-2 text-xs text-slate-500">
        <button
          data-testid="acctdetail-breadcrumb-bs"
          onClick={goBackToBalanceSheet}
          className="inline-flex items-center gap-1 hover:text-indigo-700 hover:underline"
        >
          <ChevronLeft size={12} /> Balance Sheet
        </button>
        <span className="text-slate-300">/</span>
        <span className="text-slate-700">{account.code} · {account.name}</span>
      </div>

      {/* Search + filter row */}
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            data-testid="acctdetail-search"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") applySearch(searchDraft); }}
            onBlur={() => applySearch(searchDraft)}
            placeholder="Search merchant, description, or contact…"
            className="w-full pl-7 pr-8 py-1.5 text-xs border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400"
          />
          {searchDraft && (
            <button
              data-testid="acctdetail-search-clear"
              onClick={() => { setSearchDraft(""); applySearch(""); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
              aria-label="Clear search"
            >
              <X size={13} />
            </button>
          )}
        </div>
        <div className="relative">
          <button
            data-testid="acctdetail-filter-toggle"
            onClick={() => setFiltersOpen(v => !v)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border ${activeFilterCount > 0 ? "border-indigo-400 bg-indigo-50 text-indigo-800" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}
          >
            <SlidersHorizontal size={13} />
            Filters
            {activeFilterCount > 0 && (
              <span className="ml-1 text-[10px] rounded-full bg-indigo-600 text-white px-1.5 py-0.5">{activeFilterCount}</span>
            )}
          </button>
          {filtersOpen && (
            <div
              data-testid="acctdetail-filter-popover"
              className="absolute right-0 z-30 mt-2 w-72 rounded-lg border border-slate-200 bg-white shadow-lg p-3 text-xs"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="font-semibold text-slate-700 uppercase tracking-wider text-[10px]">Filters</div>
                <button
                  onClick={() => setFiltersOpen(false)}
                  className="text-slate-400 hover:text-slate-700"
                  aria-label="Close filters"
                >
                  <X size={13} />
                </button>
              </div>
              <label className="block mb-2">
                <span className="text-slate-500">Date from</span>
                <input
                  type="date"
                  data-testid="acctdetail-filter-start"
                  value={startVal}
                  onChange={(e) => applyFilter("start", e.target.value)}
                  className="mt-0.5 w-full border rounded px-2 py-1 text-xs"
                />
              </label>
              <label className="block mb-2">
                <span className="text-slate-500">Date to</span>
                <input
                  type="date"
                  data-testid="acctdetail-filter-end"
                  value={endVal}
                  onChange={(e) => applyFilter("end", e.target.value)}
                  className="mt-0.5 w-full border rounded px-2 py-1 text-xs"
                />
              </label>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <label className="block">
                  <span className="text-slate-500">Amount ≥</span>
                  <input
                    type="number"
                    step="0.01"
                    data-testid="acctdetail-filter-min"
                    value={minAmountVal}
                    onChange={(e) => applyFilter("min_amount", e.target.value)}
                    className="mt-0.5 w-full border rounded px-2 py-1 text-xs font-mono-num"
                    placeholder="0.00"
                  />
                </label>
                <label className="block">
                  <span className="text-slate-500">Amount ≤</span>
                  <input
                    type="number"
                    step="0.01"
                    data-testid="acctdetail-filter-max"
                    value={maxAmountVal}
                    onChange={(e) => applyFilter("max_amount", e.target.value)}
                    className="mt-0.5 w-full border rounded px-2 py-1 text-xs font-mono-num"
                    placeholder="0.00"
                  />
                </label>
              </div>
              <button
                data-testid="acctdetail-filter-clear"
                onClick={clearAllFilters}
                className="w-full mt-1 py-1 text-[11px] rounded border border-slate-200 hover:bg-slate-50 text-slate-600"
              >
                Clear all filters
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="mb-4 flex items-center gap-2 flex-wrap px-3 py-2 bg-slate-50 rounded-md border border-slate-200">
        <button
          data-testid="acctdetail-move-selected"
          onClick={() => setMoving(true)}
          disabled={applying || selected.size === 0}
          className="text-xs font-medium inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-indigo-300 bg-white text-indigo-800 hover:bg-indigo-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <ArrowRightCircle size={13} />
          Move {selected.size === rows.length ? `all ${rows.length}` : selected.size} to another account
        </button>
        <span className="text-[11px] text-slate-500">
          {selected.size === 0
            ? "Nothing selected."
            : selected.size === rows.length
              ? `All ${rows.length} rows — sums to ${fmtMoney(data.balance)}.`
              : `${selected.size} of ${rows.length} — sums to ${fmtMoney(selectedTotal)}.`}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="p-6 text-sm text-slate-500 border rounded">No transactions have posted to this account.</div>
      ) : (
        <>
          <div className="grid grid-cols-12 gap-2 px-3 py-2 bg-slate-100 border-b text-[11px] uppercase tracking-widest text-slate-600 font-semibold items-center rounded-t">
            <div className="col-span-1">
              <input
                type="checkbox"
                data-testid="acctdetail-select-all"
                checked={!!allSelected}
                ref={el => { if (el) el.indeterminate = !!someSelected; }}
                onChange={toggleAll}
                className="h-3.5 w-3.5 accent-indigo-600 cursor-pointer"
                aria-label="Select all rows"
              />
            </div>
            <div className="col-span-2">Date</div>
            <div className="col-span-3">Merchant / Description</div>
            <div className="col-span-2">Contact</div>
            <div className="col-span-2 text-right">Amount</div>
            <div className="col-span-2 text-right">Running Balance</div>
          </div>
          {rows.map(t => {
            const isChecked = selected.has(t.id);
            return (
              <label
                key={t.id}
                className={`grid grid-cols-12 gap-2 px-3 py-2 border-b border-slate-100 text-[13px] items-center cursor-pointer ${isChecked ? "bg-indigo-50/40" : "hover:bg-slate-50"}`}
              >
                <div className="col-span-1">
                  <input
                    type="checkbox"
                    data-testid={`acctdetail-row-${t.id}`}
                    checked={isChecked}
                    onChange={() => toggleOne(t.id)}
                    className="h-3.5 w-3.5 accent-indigo-600 cursor-pointer"
                  />
                </div>
                <div className="col-span-2 font-mono-num text-slate-500">{t.date}</div>
                <div className="col-span-3 truncate" title={t.merchant || t.description}>
                  {t.merchant || t.description || <span className="italic text-slate-400">—</span>}
                  {t.needs_review && <span className="ml-2 text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1">review</span>}
                </div>
                <div className="col-span-2 truncate text-slate-700" title={t.contact_name}>
                  {t.contact_name || <span className="text-slate-300">—</span>}
                </div>
                <div className={`col-span-2 text-right font-mono-num ${(t.amount || 0) < 0 ? "text-slate-800" : "text-emerald-700"}`}>
                  {fmtMoney(t.amount)}
                </div>
                <div className="col-span-2 text-right font-mono-num text-slate-600">
                  {fmtMoney(t.running)}
                </div>
              </label>
            );
          })}
          <div className="grid grid-cols-12 gap-2 px-3 py-2 border-t-2 border-slate-800 text-sm bg-slate-50 rounded-b">
            <div className="col-span-8 font-semibold uppercase text-[11px] tracking-widest text-slate-600">
              {rows.length} transaction{rows.length === 1 ? "" : "s"}
            </div>
            <div className="col-span-2 text-right font-mono-num font-bold">
              {fmtMoney(data.sum_amount)}
            </div>
            <div className="col-span-2 text-right font-mono-num font-bold">
              {fmtMoney(data.balance)}
            </div>
          </div>
        </>
      )}
      {moving && (
        <ReclassifyPicker
          accounts={accounts}
          count={selected.size}
          title={`Move ${selected.size} txn${selected.size === 1 ? "" : "s"} out of ${account.name}`}
          allowedTypes={null}
          excludeIds={[account.id]}
          onCancel={() => setMoving(false)}
          onApply={doMove}
        />
      )}
    </div>
  );
}


export default function ReportView() {
  const { kind } = useParams();
  const navigate = useNavigate();
  const { currentId, current } = useCompany();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlBasis = searchParams.get("basis");
  const urlStart = searchParams.get("start");
  const urlEnd = searchParams.get("end");
  const urlQ = searchParams.get("q");
  const urlMinAmount = searchParams.get("min_amount");
  const urlMaxAmount = searchParams.get("max_amount");
  const [basis, setBasis] = useState(urlBasis === "cash" || urlBasis === "accrual" ? urlBasis : "accrual");
  const [start, setStart] = useState(urlStart || startYtd());
  const [end, setEnd] = useState(urlEnd || today());
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  // Balance-sheet drilldown: clicking a row navigates to the full-page
  // Account Detail report so users can review, PDF-export, or bulk-move
  // transactions using the same UX as any other financial report. We stash
  // the current URL + scroll position (from the <main> scroll container in
  // the app shell) so the breadcrumb can restore both.
  const goToAccountDetail = (row) => {
    if (!row?.id) return;
    try {
      const scroller = document.querySelector("main");
      const y = scroller ? scroller.scrollTop : (window.scrollY || 0);
      sessionStorage.setItem("bsReturnUrl",
        `/reports/balance-sheet${window.location.search || ""}`);
      sessionStorage.setItem("bsScrollY", String(y));
    } catch { /* private mode / quota — fine to ignore */ }
    navigate(`/reports/account-detail?account=${row.id}`);
  };

  // Restore Balance Sheet scroll position on return from Account Detail.
  useEffect(() => {
    if (kind !== "balance-sheet" || !data) return;
    const y = sessionStorage.getItem("bsScrollY");
    if (y == null) return;
    const top = parseInt(y, 10) || 0;
    // Double rAF + a tiny fallback timeout ensures the scroll container has
    // finished sizing after the BS re-render (children rows arrive last).
    let cancelled = false;
    const apply = () => {
      if (cancelled) return;
      const scroller = document.querySelector("main");
      if (scroller) scroller.scrollTop = top;
      else window.scrollTo({ top, behavior: "instant" });
    };
    requestAnimationFrame(() => requestAnimationFrame(apply));
    const t = setTimeout(() => { apply(); sessionStorage.removeItem("bsScrollY"); }, 120);
    return () => { cancelled = true; clearTimeout(t); };
  }, [kind, data]);

  // Re-sync from URL params when the user re-triggers a voice command that
  // navigates back to the same report page with different filters.
  useEffect(() => {
    if (urlBasis === "cash" || urlBasis === "accrual") setBasis(urlBasis);
    if (urlStart) setStart(urlStart);
    if (urlEnd) setEnd(urlEnd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlBasis, urlStart, urlEnd]);

  const fetchData = async () => {
    if (!currentId) return;
    setBusy(true);
    let url;
    if (kind === "balance-sheet") {
      url = `/companies/${currentId}/reports/${kind}?as_of=${end}&basis=${basis}`;
    } else if (kind === "account-detail") {
      const aid = searchParams.get("account");
      if (!aid) { setBusy(false); return; }
      const parts = [`account_id=${aid}`];
      if (urlStart)      parts.push(`start=${encodeURIComponent(urlStart)}`);
      if (urlEnd)        parts.push(`end=${encodeURIComponent(urlEnd)}`);
      if (urlQ)          parts.push(`q=${encodeURIComponent(urlQ)}`);
      if (urlMinAmount)  parts.push(`min_amount=${encodeURIComponent(urlMinAmount)}`);
      if (urlMaxAmount)  parts.push(`max_amount=${encodeURIComponent(urlMaxAmount)}`);
      url = `/companies/${currentId}/reports/account-detail?${parts.join("&")}`;
    } else {
      url = `/companies/${currentId}/reports/${kind}?start=${start}&end=${end}&basis=${basis}`;
    }
    try {
      const r = await api.get(url);
      setData(r.data);
    } finally { setBusy(false); }
  };

  const acctParam = searchParams.get("account");
  // Reset data on kind change to avoid rendering a stale shape from a prior report.
  useEffect(() => { setData(null); }, [kind, acctParam]);
  useEffect(() => { fetchData(); /* eslint-disable-next-line */ }, [currentId, kind, basis, start, end, acctParam, urlQ, urlMinAmount, urlMaxAmount, urlStart, urlEnd]);

  const downloadPdf = async () => {
    let params;
    if (kind === "balance-sheet") params = `as_of=${end}&basis=${basis}`;
    else if (kind === "account-detail") {
      const aid = searchParams.get("account");
      if (!aid) return;
      const parts = [`account_id=${aid}`];
      if (urlStart)     parts.push(`start=${encodeURIComponent(urlStart)}`);
      if (urlEnd)       parts.push(`end=${encodeURIComponent(urlEnd)}`);
      if (urlQ)         parts.push(`q=${encodeURIComponent(urlQ)}`);
      if (urlMinAmount) parts.push(`min_amount=${encodeURIComponent(urlMinAmount)}`);
      if (urlMaxAmount) parts.push(`max_amount=${encodeURIComponent(urlMaxAmount)}`);
      params = parts.join("&");
    } else params = `start=${start}&end=${end}&basis=${basis}`;
    const token = localStorage.getItem("axiom_token");
    const r = await fetch(`${BACKEND_URL}/api/companies/${currentId}/reports/${kind}/pdf?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const suffix = kind === "account-detail" ? `-${(data?.account?.code || "acct")}` : "";
    a.download = `${kind}${suffix}.pdf`; a.click();
    URL.revokeObjectURL(url);
  };

  const title = {
    "trial-balance": "Trial Balance",
    "balance-sheet": "Balance Sheet",
    "income-statement": "Income Statement",
    "general-ledger": "General Ledger",
    "cash-flow": "Statement of Cash Flows",
    "sales-tax": "Sales Tax Liability",
    "1099-summary": "1099 Summary",
    "account-detail": "Account Detail",
  }[kind] || kind;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-heading text-3xl font-bold tracking-tight">{title}</h1>
        <div className="ml-auto flex items-center gap-2">
          {kind !== "trial-balance" && kind !== "account-detail" && (
            <div className="inline-flex rounded-md border bg-white text-xs" data-testid={TID.reportBasisToggle}>
              {["accrual", "cash"].map(b => (
                <button key={b} onClick={() => setBasis(b)}
                        data-testid={`report-basis-${b}`}
                        className={`px-3 py-1.5 ${basis === b ? "bg-slate-900 text-white" : "text-slate-600"}`}>
                  {b[0].toUpperCase() + b.slice(1)}
                </button>
              ))}
            </div>
          )}
          {kind !== "balance-sheet" && kind !== "account-detail" && (
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="border rounded px-2 py-1 text-xs" />
          )}
          {kind !== "account-detail" && (
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="border rounded px-2 py-1 text-xs" />
          )}
          <button data-testid={TID.reportApply} onClick={fetchData} className="px-3 py-1.5 rounded-md border bg-white text-xs">Apply</button>
          <button data-testid={TID.reportExportPdf} onClick={downloadPdf}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs">
            <Download size={13} /> Export PDF
          </button>
        </div>
      </div>

      {busy && <div className="flex items-center gap-2 text-slate-500 text-sm"><Loader2 size={14} className="animate-spin" /> Computing…</div>}

      {data && (
        <div className="report-page mx-auto">
          <div className="text-center border-b pb-4 mb-6">
            <div className="font-heading text-2xl font-bold">{data.company_name || current?.name}</div>
            <div className="uppercase tracking-widest text-sm mt-1">{title}</div>
            <div className="text-xs text-slate-500 mt-1">
              {kind === "balance-sheet"
                ? `As of ${data.as_of} · ${data.basis} basis`
                : kind === "1099-summary"
                ? `Tax year ${data.year}`
                : kind === "account-detail"
                ? `${data.account?.code || ""} · ${data.account?.name || ""} · ${data.count} txn${data.count === 1 ? "" : "s"} · balance ${fmtMoney(data.balance)}`
                : `${data.period_start} to ${data.period_end}${data.basis ? ` · ${data.basis} basis` : ""}`}
            </div>
          </div>

          {kind === "income-statement" && Array.isArray(data.revenue) && (
            <IncomeStatementBody data={data} />
          )}
          {kind === "balance-sheet" && Array.isArray(data.assets) && (
            <BalanceSheetBody data={data} onDrilldown={goToAccountDetail} />
          )}
          {kind === "account-detail" && Array.isArray(data.rows) && data.account !== undefined && (
            <AccountDetailBody
              currentId={currentId}
              data={data}
              onReload={fetchData}
              searchParams={searchParams}
              setSearchParams={setSearchParams}
              navigate={navigate}
            />
          )}
          {kind === "trial-balance" && Array.isArray(data.rows) && data.account === undefined && (
            <TrialBalanceBody data={data} />
          )}
          {kind === "general-ledger" && Array.isArray(data.sections) && (
            <GeneralLedgerBody data={data} />
          )}
          {kind === "cash-flow" && data.net_change !== undefined && (
            <CashFlowBody data={data} />
          )}
          {kind === "sales-tax" && Array.isArray(data.rows) && data.net_liability !== undefined && (
            <SalesTaxBody data={data} />
          )}
          {kind === "1099-summary" && data.year !== undefined && (
            <Form1099Body data={data} />
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title }) {
  return (
    <div className="mt-4 mb-1 uppercase text-xs tracking-widest font-semibold text-slate-700 bg-slate-50 px-3 py-1.5 rounded">
      {title}
    </div>
  );
}
function Row({ id, code, name, amount, bold, parent_code, onClick }) {
  const isChild = !!parent_code;
  const clickable = !!(onClick && id);
  return (
    <div
      className={`grid grid-cols-12 gap-2 px-3 py-1.5 border-b border-slate-100 ${bold ? "font-semibold border-slate-800" : ""} ${isChild ? "bg-slate-50/60" : ""} ${clickable ? "cursor-pointer hover:bg-indigo-50/60 transition-colors" : ""}`}
      onClick={clickable ? () => onClick({ id, code, name, amount }) : undefined}
      data-testid={clickable ? `bs-row-${code}` : undefined}
    >
      <div className="col-span-2 font-mono-num text-xs text-slate-500">
        {isChild ? <span className="opacity-40 mr-1">↳</span> : null}
        {code}
      </div>
      <div className={`col-span-7 ${isChild ? "pl-4 text-slate-600 text-[13px]" : ""}`}>{name}</div>
      <div className={`col-span-3 text-right font-mono-num ${isChild ? "text-slate-600 text-[13px]" : ""}`}>{fmtMoney(amount)}</div>
    </div>
  );
}

function IncomeStatementBody({ data }) {
  return (
    <div className="text-sm">
      <Section title="Revenue" />
      {data.revenue.map(r => <Row key={r.code} {...r} />)}
      <Row code="" name="Total Revenue" amount={data.total_revenue} bold />
      <Section title="Operating Expenses" />
      {data.expenses.map(r => <Row key={r.code} {...r} />)}
      <Row code="" name="Total Expenses" amount={data.total_expense} bold />
      <div className="mt-4 grid grid-cols-12 gap-2 px-3 py-2 border-t-2 border-slate-800 bg-slate-50 rounded">
        <div className="col-span-9 font-heading font-bold uppercase text-sm">Net Income</div>
        <div className="col-span-3 text-right font-mono-num font-bold">{fmtMoney(data.net_income)}</div>
      </div>
    </div>
  );
}

function BalanceSheetBody({ data, onDrilldown }) {
  return (
    <div className="text-sm">
      <Section title="Assets" />
      {data.assets.map(r => <Row key={`${r.code}-${r.parent_code || ""}`} {...r} onClick={onDrilldown} />)}
      <Row code="" name="Total Assets" amount={data.total_assets} bold />
      <Section title="Liabilities" />
      {data.liabilities.map(r => <Row key={`${r.code}-${r.parent_code || ""}`} {...r} onClick={onDrilldown} />)}
      <Row code="" name="Total Liabilities" amount={data.total_liabilities} bold />
      <Section title="Equity" />
      {data.equity.map(r => <Row key={`${r.code}-${r.parent_code || ""}`} {...r} onClick={onDrilldown} />)}
      <Row code="" name="Total Equity" amount={data.total_equity} bold />
      <div className="mt-4 grid grid-cols-12 gap-2 px-3 py-2 border-t-2 border-slate-800 bg-slate-50 rounded">
        <div className="col-span-9 font-heading font-bold uppercase text-sm">Total Liabilities &amp; Equity</div>
        <div className="col-span-3 text-right font-mono-num font-bold">{fmtMoney(data.total_liabilities_equity)}</div>
      </div>
    </div>
  );
}

function TrialBalanceBody({ data }) {
  return (
    <div className="text-sm">
      <div className="grid grid-cols-12 gap-2 px-3 py-2 bg-slate-50 rounded text-xs uppercase tracking-wider font-semibold text-slate-600">
        <div className="col-span-2">Code</div><div className="col-span-6">Account</div>
        <div className="col-span-2 text-right">Debit</div><div className="col-span-2 text-right">Credit</div>
      </div>
      {data.rows.map(r => (
        <div key={r.code} className="grid grid-cols-12 gap-2 px-3 py-1.5 border-b border-slate-100">
          <div className="col-span-2 font-mono-num text-xs text-slate-500">{r.code}</div>
          <div className="col-span-6">{r.name}</div>
          <div className="col-span-2 text-right font-mono-num">{r.debit ? fmtMoney(r.debit) : ""}</div>
          <div className="col-span-2 text-right font-mono-num">{r.credit ? fmtMoney(r.credit) : ""}</div>
        </div>
      ))}
      <div className="grid grid-cols-12 gap-2 px-3 py-2 border-t-2 border-slate-800 mt-2 font-semibold">
        <div className="col-span-8">Total</div>
        <div className="col-span-2 text-right font-mono-num">{fmtMoney(data.total_debit)}</div>
        <div className="col-span-2 text-right font-mono-num">{fmtMoney(data.total_credit)}</div>
      </div>
    </div>
  );
}

function GeneralLedgerBody({ data }) {
  const nav = useNavigate();
  const map = {
    Txn:   "bg-indigo-100 text-indigo-700 hover:bg-indigo-200",
    Split: "bg-violet-100 text-violet-700 hover:bg-violet-200",
    JE:    "bg-amber-100 text-amber-800 hover:bg-amber-200",
  };
  const goToSource = (e) => {
    if (e.source === "JE") nav(`/accounting/journal-entries?highlight=${e.je_id || ""}`);
    else nav(`/accounting/transactions?highlight=${e.txn_id || ""}${e.source === "Split" ? "&open=split" : ""}`);
  };
  return (
    <div className="text-sm space-y-4">
      {data.sections.map(sec => (
        <div key={sec.code}>
          <div className="uppercase text-xs tracking-widest font-semibold text-slate-700 bg-slate-50 px-3 py-1.5 rounded">
            {sec.code} · {sec.name}
          </div>
          <div className="grid grid-cols-12 gap-2 px-3 py-1 text-[10px] uppercase tracking-wider text-slate-500 font-semibold border-b">
            <div className="col-span-2">Date</div>
            <div className="col-span-1">Source</div>
            <div className="col-span-4">Description</div>
            <div className="col-span-2 text-right">Debit</div>
            <div className="col-span-1 text-right">Credit</div>
            <div className="col-span-2 text-right">Balance</div>
          </div>
          <div className="grid grid-cols-12 gap-2 px-3 py-1 border-b border-slate-100 text-[12px] text-slate-500 italic">
            <div className="col-span-7">Opening balance</div>
            <div className="col-span-3 text-right"></div>
            <div className="col-span-2 text-right font-mono-num">{fmtMoney(sec.opening_balance)}</div>
          </div>
          {sec.entries.map((e, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 px-3 py-1 border-b border-slate-100 text-[13px] hover:bg-slate-50">
              <div className="col-span-2 font-mono-num text-xs text-slate-500">{e.date}</div>
              <div className="col-span-1">
                <button data-testid={`gl-source-${e.source.toLowerCase()}`}
                        onClick={() => goToSource(e)}
                        className={`text-[10px] font-medium px-1.5 py-0.5 rounded transition ${map[e.source] || "bg-slate-100 text-slate-600"}`}
                        title="Open source">
                  {e.source}
                </button>
              </div>
              <div className="col-span-4 truncate" title={e.reference}>{e.description}</div>
              <div className="col-span-2 text-right font-mono-num">{e.debit ? fmtMoney(e.debit) : ""}</div>
              <div className="col-span-1 text-right font-mono-num">{e.credit ? fmtMoney(e.credit) : ""}</div>
              <div className="col-span-2 text-right font-mono-num text-slate-600">{fmtMoney(e.balance)}</div>
            </div>
          ))}
          <div className="text-right px-3 py-1.5 font-semibold border-t border-slate-800">
            Ending: <span className="font-mono-num">{fmtMoney(sec.total)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function CashFlowBody({ data }) {
  return (
    <div className="text-sm space-y-2">
      {[["Operating Activities", data.operating],
        ["Investing Activities", data.investing],
        ["Financing Activities", data.financing]].map(([k, v]) => (
        <div key={k} className="grid grid-cols-12 gap-2 px-3 py-2 border-b">
          <div className="col-span-9">{k}</div>
          <div className="col-span-3 text-right font-mono-num">{fmtMoney(v)}</div>
        </div>
      ))}
      <div className="grid grid-cols-12 gap-2 px-3 py-2 border-t-2 border-slate-800 bg-slate-50 rounded mt-3">
        <div className="col-span-9 font-heading font-bold uppercase text-sm">Net Change in Cash</div>
        <div className="col-span-3 text-right font-mono-num font-bold">{fmtMoney(data.net_change)}</div>
      </div>
    </div>
  );
}

function SalesTaxBody({ data }) {
  return (
    <div className="text-sm space-y-1">
      {data.rows.map((r, i) => (
        <div key={i} className="grid grid-cols-12 gap-2 px-3 py-2 border-b">
          <div className="col-span-9">{r.label}</div>
          <div className="col-span-3 text-right font-mono-num">{fmtMoney(r.amount)}</div>
        </div>
      ))}
      <div className="grid grid-cols-12 gap-2 px-3 py-2 border-t-2 border-slate-800 bg-slate-50 rounded mt-3">
        <div className="col-span-9 font-heading font-bold uppercase text-sm">Net sales tax liability owed</div>
        <div className="col-span-3 text-right font-mono-num font-bold">{fmtMoney(data.net_liability)}</div>
      </div>
      <div className="mt-3 text-xs text-slate-500">
        Based on {data.invoices_count} invoices and {data.bills_count} bills in the period.
      </div>
    </div>
  );
}

function Form1099Body({ data }) {
  if (!data.rows.length) {
    return (
      <div className="text-sm text-slate-500 py-6 text-center">
        No contractors met the $600 reporting threshold in {data.year}.
      </div>
    );
  }
  return (
    <div className="text-sm">
      <div className="grid grid-cols-12 gap-2 px-3 py-2 bg-slate-50 rounded text-xs uppercase tracking-wider font-semibold text-slate-600">
        <div className="col-span-5">Contractor</div>
        <div className="col-span-3">TIN / EIN</div>
        <div className="col-span-2 text-center">W-9</div>
        <div className="col-span-2 text-right">Total Paid</div>
      </div>
      {data.rows.map((r, i) => (
        <div key={i} className="grid grid-cols-12 gap-2 px-3 py-1.5 border-b border-slate-100">
          <div className="col-span-5">{r.contact_name}</div>
          <div className="col-span-3 font-mono-num text-xs text-slate-600">{r.tin || "—"}</div>
          <div className="col-span-2 text-center">
            {r.w9_on_file
              ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">Yes</span>
              : <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">Missing</span>}
          </div>
          <div className="col-span-2 text-right font-mono-num">{fmtMoney(r.total_paid)}</div>
        </div>
      ))}
      <div className="grid grid-cols-12 gap-2 px-3 py-2 border-t-2 border-slate-800 mt-2 font-semibold">
        <div className="col-span-10">Total reportable</div>
        <div className="col-span-2 text-right font-mono-num">{fmtMoney(data.total_reportable)}</div>
      </div>
    </div>
  );
}
