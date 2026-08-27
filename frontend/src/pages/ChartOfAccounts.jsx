import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { useAuth } from "@/lib/auth";
import { TID } from "@/constants/testIds";
import { Plus, Trash2, Sparkles, Loader2, Pencil, Check, X, GitMerge, AlertTriangle, AlertCircle, Info, GripVertical, Eye, EyeOff, Upload, Download, FileSpreadsheet, FileText, ArrowLeft, History, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { useCreateListener, useActionListener } from "@/lib/createBus";

const TYPES = ["asset", "liability", "equity", "revenue", "cogs", "expense"];

// Section labels — proper English pluralization instead of just tacking
// an "s" on the end (which produced "EQUITYS", "LIABILITYS", "COGSS").
// COGS is already plural so it stays as-is.
const TYPE_LABEL = {
  asset:     "Assets",
  liability: "Liabilities",
  equity:    "Equity",
  revenue:   "Revenue",
  cogs:      "COGS",
  expense:   "Expenses",
};

// Money formatter — matches the reports pages so the CoA feels
// consistent. Zero balances render as a subtle "—" rather than "$0.00"
// so the eye skips over empty rows and lands on actual activity.
const fmtMoney = (n) => {
  if (n == null || Math.abs(Number(n)) < 0.005) return "—";
  return Number(n).toLocaleString(undefined, {
    style: "currency", currency: "USD",
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
};

// GAAP-standard subtypes cascaded from the parent type. Picked to match
// what the AI seed / Suggest-with-AI generator already writes, so a Pro
// editing a row never sees a mismatch between the pill on the read-only
// view and the option they picked in the dropdown.
// Feb 2026 — Chart of Accounts sub-type unification.
// The edit dropdown NOW pulls from DETAIL_SECTIONS_BY_TYPE (defined
// below), the exact same keys the renderer groups by. Before this,
// SUBTYPES_BY_TYPE was a parallel list; keys like `cost_of_sales` in
// the dropdown never matched `cost_of_goods_sold` on the renderer, so
// users would change the sub-type and the account visibly wouldn't
// move. See PRD.md — subtype writes now mirror to `detail_type` too.
const SUBTYPES_BY_TYPE = {
  asset:     ["current_asset", "fixed_asset", "other_asset", "intangible_asset", "accumulated_depreciation", "clearing"],
  liability: ["current_liability", "long_term_liability", "other_liability", "credit_card"],
  equity:    ["equity", "retained_earnings", "owner_draw", "owner_contribution"],
  revenue:   ["operating_revenue", "other_revenue", "sales_revenue", "service_revenue", "interest_income"],
  cogs:      ["cogs", "materials", "labor", "manufacturing_overhead"],
  expense:   ["operating_expense", "cost_of_sales", "payroll_expense", "rent_expense", "utilities_expense", "advertising_expense", "office_expense", "professional_fees", "tax_expense", "interest_expense", "depreciation_expense", "other_expense"],
};

// `subtypesFor(t)` returns the ordered list of sub-type keys that the
// edit dropdown should offer for a given `type`. Sourced from
// DETAIL_SECTIONS_BY_TYPE (defined below) — the same keys the renderer
// groups by — so a user picking "Other Expense" writes the exact key
// the renderer needs to move the account into the "Other Expense"
// section. No more parallel-taxonomy drift.
const subtypesFor = (t) => {
  const list = DETAIL_SECTIONS_BY_TYPE[t] || DETAIL_SECTIONS_BY_TYPE.expense;
  return list.map(([k]) => k);
};

// Wave-style tabs — each tab maps to one or more `type` values so
// e.g. "Expenses" folds cogs + expense together (matching how Wave
// treats direct costs and operating expenses under one banner).
const COA_TABS = [
  { key: "all",       label: "All",        types: ["asset", "liability", "equity", "revenue", "cogs", "expense"] },
  { key: "asset",     label: "Assets",     types: ["asset"] },
  { key: "liability", label: "Liabilities & Credit Cards", types: ["liability"] },
  { key: "revenue",   label: "Income",     types: ["revenue"] },
  { key: "expense",   label: "Expenses",   types: ["cogs", "expense"] },
  { key: "equity",    label: "Equity",     types: ["equity"] },
];
// Ordered detail_type sections that show up as sub-headers within each
// type card. Sub-types not in this list fall into an "Other" catch-all.
const DETAIL_SECTIONS_BY_TYPE = {
  asset: [
    ["cash_and_bank",                 "Cash and Bank"],
    ["money_in_transit",              "Money in Transit"],
    ["expected_payments_from_customers", "Accounts Receivable"],
    ["inventory",                     "Inventory"],
    ["property_plant_equipment",      "Property, Plant & Equipment"],
    ["depreciation_and_amortization", "Depreciation and Amortization"],
    ["vendor_prepayments",            "Vendor Prepayments & Credits"],
    ["other_short_term_asset",        "Other Short-Term Asset"],
    ["other_long_term_asset",         "Other Long-Term Asset"],
  ],
  liability: [
    ["credit_card",                   "Credit Card"],
    ["loan_and_line_of_credit",       "Loan and Line of Credit"],
    ["expected_payments_to_vendors",  "Accounts Payable"],
    ["due_for_payroll",               "Due For Payroll"],
    ["due_to_owners",                 "Due to Owners"],
    ["customer_prepayments",          "Customer Prepayments & Credits"],
    ["sales_tax_payable",             "Sales Tax Payable"],
    ["other_short_term_liability",    "Other Short-Term Liability"],
    ["other_long_term_liability",     "Other Long-Term Liability"],
  ],
  equity: [
    ["owner_contribution_drawing",    "Owner Contribution & Drawing"],
    ["retained_earnings",             "Retained Earnings"],
    ["opening_balance_equity",        "Opening Balance Equity"],
    ["other_equity",                  "Other Equity"],
  ],
  revenue: [
    ["income",                        "Income"],
    ["discount",                      "Discount"],
    ["other_income",                  "Other Income"],
  ],
  expense: [
    ["operating_expense",             "Operating Expense"],
    ["cost_of_goods_sold",            "Cost of Goods Sold"],
    ["payment_processing_fee",        "Payment Processing Fee"],
    ["payroll_expense",               "Payroll Expense"],
    ["other_expense",                 "Other Expense"],
  ],
  cogs: [
    ["cost_of_goods_sold",            "Cost of Goods Sold"],
  ],
};

// Reverse lookup: detail_type key -> human label. Built once from
// DETAIL_SECTIONS_BY_TYPE so the CoA rows and the Balance Sheet can
// display the same labels the user sees in the create modal.
const DETAIL_TYPE_LABEL = (() => {
  const out = {};
  for (const list of Object.values(DETAIL_SECTIONS_BY_TYPE)) {
    for (const [k, l] of list) out[k] = l;
  }
  return out;
})();

// Turn machine-y keys ("operating_expense", "cogs", "long_term_liability")
// into human-friendly labels ("Operating Expense", "COGS", "Long Term Liability").
// The raw values stay in the DB / API payloads — this only shapes what
// the CPA sees in dropdowns and the subtype column.
const ACRONYMS = new Set(["cogs", "ap", "ar"]);
const prettyLabel = (s) => {
  if (!s) return "";
  const lower = String(s).toLowerCase();
  if (ACRONYMS.has(lower)) return lower.toUpperCase();
  return lower
    .split(/[_\s]+/)
    .filter(Boolean)
    .map(w => ACRONYMS.has(w) ? w.toUpperCase() : (w[0].toUpperCase() + w.slice(1)))
    .join(" ");
};

// Standard GAAP numbering ranges we auto-assign into when the CPA
// hides account codes. Kept aligned with the AI-seed generator so
// hand-created accounts fall into the same visual buckets:
//   1000s asset  · 2000s liability · 3000s equity ·
//   4000s revenue · 5000s cogs     · 6000s expense
const CODE_RANGE = {
  asset:     { start: 1000, end: 1999 },
  liability: { start: 2000, end: 2999 },
  equity:    { start: 3000, end: 3999 },
  revenue:   { start: 4000, end: 4999 },
  cogs:      { start: 5000, end: 5999 },
  expense:   { start: 6000, end: 9999 },
};

/**
 * Pick the next-available code for a given account type. Scans the
 * caller's current CoA, honors the standard range for the type, and
 * returns the LOWEST unused number as a string (so codes stay compact
 * even after deletes). Falls back to the range start if the CoA is
 * empty for that type.
 */
function nextCodeForType(type, accounts) {
  const range = CODE_RANGE[type] || CODE_RANGE.expense;
  const used = new Set(
    (accounts || [])
      .filter(a => a.type === type)
      .map(a => Number(a.code))
      .filter(n => Number.isFinite(n))
  );
  for (let n = range.start; n <= range.end; n += 10) {
    if (!used.has(n)) return String(n);
  }
  // Fallback: dense scan if every 10-step is taken.
  for (let n = range.start; n <= range.end; n += 1) {
    if (!used.has(n)) return String(n);
  }
  // Absurd edge case — 4,999 expense accounts already booked.
  return String(range.end);
}

export default function ChartOfAccounts() {
  const { currentId } = useCompany();
  const { user } = useAuth();
  const isSuperadmin = user?.role === "superadmin";
  const [accts, setAccts] = useState([]);
  // Per-account balance map — {aid: {balance, rollup, mode}}.
  // Fetched lazily after the accounts land so an empty CoA renders fast.
  const [balances, setBalances] = useState({});
  // Balance-column basis toggle. "smart" (default) uses YTD for
  // rev/exp and cumulative for asset/liab/equity; other values force
  // a single lens across every account.
  const [basis, setBasis] = useState("smart");
  // Wave-style top tabs. `all` (default) preserves the classic
  // one-page-many-sections view; the specific tabs filter down to one
  // section at a time. Persisted in localStorage so the pro's last
  // vantage point sticks across visits.
  const [activeTab, setActiveTab] = useState(() => {
    try { return localStorage.getItem("coa_active_tab") || "all"; }
    catch { return "all"; }
  });
  const setTabPersist = (v) => {
    setActiveTab(v);
    try { localStorage.setItem("coa_active_tab", v); } catch {}
  };
  // Duplicate detection — groups of same-type accounts with near-
  // identical names that the Pro likely wants to merge.
  const [dupeGroups, setDupeGroups] = useState([]);
  const [dupePanelOpen, setDupePanelOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [creatingPrefill, setCreatingPrefill] = useState(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  // Merge dialog — {source, options} when set.
  const [mergeState, setMergeState] = useState(null);
  // Import modal open/close.
  const [importOpen, setImportOpen] = useState(false);
  // Drag-drop reparent state — set on dragstart of a child row, cleared
  // once the drop lands (or is canceled). Just the source id, kept in
  // component state so hover targets can style themselves.
  const [dragSourceId, setDragSourceId] = useState(null);
  // Sub-type drift audit — surfaces amber/red banners so operators can
  // spot legacy accounts that need reclassification. Fetched alongside
  // the accounts list. Advisory only — never blocks CoA render.
  const [driftAudit, setDriftAudit] = useState(null);
  const [driftDetailsOpen, setDriftDetailsOpen] = useState(false);
  const load = async () => {
    if (!currentId) return;
    const r = await api.get(`/companies/${currentId}/accounts`);
    setAccts(r.data.accounts || []);
    // Refresh balances alongside — silently fails so a slow/erroring
    // balance calc never blocks the CoA from rendering.
    try {
      const q = basis === "smart" ? "" : `?basis=${basis}`;
      const b = await api.get(`/companies/${currentId}/accounts/balances${q}`);
      setBalances(b.data?.balances || {});
    } catch (_) { /* balances are advisory */ }
    // Duplicates run once per reload (also advisory).
    try {
      const d = await api.get(`/companies/${currentId}/accounts/duplicates`);
      setDupeGroups(d.data?.groups || []);
    } catch (_) { /* duplicates are advisory */ }
    // Sub-type drift audit — advisory banner data.
    try {
      const s = await api.get(`/companies/${currentId}/accounts/subtype-audit`);
      setDriftAudit(s.data || null);
    } catch (_) { setDriftAudit(null); }
  };
  useEffect(() => { load(); }, [currentId, basis]);

  // Export the current Chart of Accounts to a CSV file the user can
  // open in Excel/Numbers/Sheets or hand to another bookkeeper. Uses
  // the accounts already in state (no extra API call) plus the loaded
  // balances. RFC-4180 quoting: any field containing a quote/comma/
  // newline gets wrapped in quotes with internal quotes doubled.
  const exportCsv = () => {
    if (!accts.length) { toast.error("No accounts to export"); return; }
    const byId = Object.fromEntries(accts.map(a => [a.id, a]));
    const q = (v) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["Code", "Name", "Type", "Subtype", "Parent Code",
                    "Parent Name", "Source", "Active", "Description", "Balance"];
    const rows = accts.map(a => {
      const parent = a.parent_account_id ? byId[a.parent_account_id] : null;
      return [
        a.code || "",
        a.name || "",
        a.type || "",
        a.subtype || a.detail_type || "",
        parent?.code || "",
        parent?.name || "",
        a.source || "seeded",
        a.active === false ? "false" : "true",
        a.description || "",
        balances?.[a.id] ?? "",
      ].map(q).join(",");
    });
    const csv = [header.join(","), ...rows].join("\r\n");
    // Excel opens UTF-8 correctly only with a BOM prefix.
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chart-of-accounts-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`Exported ${accts.length} accounts`);
  };

  // Show/hide account code toggle. Persisted in localStorage so the
  // Pro's preference sticks across sessions. When codes are hidden we
  // sort each type's list alphabetically by name (the user's mental
  // model shifts from "1000 → 6999" to "A → Z" the moment codes
  // disappear from the row).
  const [showCodes, setShowCodes] = useState(() => {
    try { const v = localStorage.getItem("axiom_coa_show_codes"); return v === null ? true : v === "true"; }
    catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("axiom_coa_show_codes", String(showCodes)); } catch {}
  }, [showCodes]);

  // Include-inactive toggle — deactivated accounts (from the QBO
  // dedup cleanup) are hidden from the CoA by default so the list
  // matches what shows up in reports and account pickers. Flip on to
  // review/reactivate them.
  const [showInactive, setShowInactive] = useState(() => {
    try { return localStorage.getItem("axiom_coa_show_inactive") === "true"; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("axiom_coa_show_inactive", String(showInactive)); } catch {}
  }, [showInactive]);

  // Total inactive count so the toggle can show "(N hidden)".
  const inactiveCount = accts.filter(a => a.active === false).length;
  // The list the rest of the page renders off of. Filtered before
  // grouping so parent/child counts, tab counters, and duplicate
  // detection stay consistent with what the user actually sees.
  const visibleAccts = showInactive ? accts : accts.filter(a => a.active !== false);

  // Fires the same PATCH the edit form uses, then reloads.
  const reparent = async (childId, newParentId) => {
    if (!childId || childId === newParentId) return;
    try {
      await api.patch(`/companies/${currentId}/accounts/${childId}`, {
        parent_account_id: newParentId || null,
      });
      toast.success(newParentId ? "Moved sub-account." : "Promoted to top-level.");
      await load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Move failed");
    } finally {
      setDragSourceId(null);
    }
  };
  useCreateListener("account", (prefill) => {
    setCreatingPrefill(prefill || {});
    setCreating(true);
  });
  useActionListener("close-current-modal", () => {
    setCreating(false);
    setCreatingPrefill(null);
    setSuggestOpen(false);
    load();
  });

  // Group by type AND respect parent/child hierarchy: parents render first,
  // then their children indented right below. Orphans (no parent) still show.
  // Sort keys flip when the CPA hides account codes — code becomes
  // meaningless without the column, so alphabetical by name wins.
  const cmpBy = showCodes
    ? (x, y) => String(x.code).localeCompare(String(y.code))
    : (x, y) => String(x.name).localeCompare(String(y.name), undefined, { sensitivity: "base" });
  const grouped = TYPES.map(t => {
    const items = visibleAccts.filter(a => a.type === t);
    const byId = Object.fromEntries(items.map(a => [a.id, a]));
    const topLevel = items.filter(a => !a.parent_account_id || !byId[a.parent_account_id]);
    topLevel.sort(cmpBy);
    const ordered = [];
    for (const p of topLevel) {
      ordered.push({ ...p, _depth: 0 });
      const kids = items.filter(a => a.parent_account_id === p.id);
      kids.sort(cmpBy);
      for (const k of kids) ordered.push({ ...k, _depth: 1 });
    }
    return { type: t, items: ordered };
  });

  // Extracted so the tab-based renderer can call it inside sub-type
  // section blocks without duplicating the huge <AccountRow/> prop list.
  const renderRow = (a, g) => {
    const b = balances[a.id];
    const val = !b ? null : (a._depth ? b.balance : b.rollup);
    return (
      <AccountRow
        key={a.id}
        a={a}
        allAccounts={accts}
        currentId={currentId}
        balance={val}
        showCodes={showCodes}
        onSaved={load}
        onDeleted={load}
        onMerge={(source) => setMergeState({ source })}
        dragSourceId={dragSourceId}
        onDragStart={(id) => setDragSourceId(id)}
        onDragEnd={() => setDragSourceId(null)}
        onReparent={reparent}
      />
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Chart of Accounts</h1>
          <p className="text-slate-500 text-sm mt-1">GAAP-organized accounts. Add or edit anything.</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Show/hide account code toggle — codes make sense to seasoned
              CPAs but new firm-owners often just want alphabetical
              lists. When hidden, each type is re-sorted A→Z by name. */}
          <button
            onClick={() => setShowCodes(v => !v)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] ${showCodes ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50" : "border-indigo-300 bg-indigo-50 text-indigo-800 hover:bg-indigo-100"}`}
            title={showCodes ? "Hide account numbers and sort A→Z" : "Show account numbers"}
            data-testid="coa-toggle-codes"
          >
            {showCodes ? <><EyeOff size={12} /> Hide codes</> : <><Eye size={12} /> Show codes</>}
          </button>
          {/* Show/hide inactive accounts — deactivated seeded accounts
              hide by default so the CoA matches what reports and
              account pickers see. Badge shows the hidden count. */}
          <button
            onClick={() => setShowInactive(v => !v)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] ${showInactive ? "border-indigo-300 bg-indigo-50 text-indigo-800 hover:bg-indigo-100" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}
            title={showInactive ? "Hiding inactive accounts matches reports and pickers" : "Reveal deactivated accounts (useful for reactivation)"}
            data-testid="coa-toggle-inactive"
          >
            {showInactive ? <><EyeOff size={12} /> Hide inactive</> : <><Eye size={12} /> Show inactive{inactiveCount ? ` (${inactiveCount})` : ""}</>}
          </button>
          {/* Backfill sub-types — assign Wave-style detail_type to any
              legacy accounts that don't have one yet. Idempotent. */}
          <button
            onClick={async () => {
              const force = confirm(
                "Backfill Wave-style sub-types for every account?\n\n" +
                "• Click OK to only fill in accounts missing a sub-type (safe).\n" +
                "• Click Cancel then Shift+Click this button to force re-classify EVERY account (fixes mislabeled ones)."
              );
              if (!force) return;
              try {
                const r = await api.post(`/companies/${currentId}/accounts/backfill-detail-type`, {});
                const d = r.data;
                if (d.updated) toast.success(`Backfilled ${d.updated} account${d.updated === 1 ? "" : "s"} (${d.skipped_already_set} already had a sub-type)`);
                else toast.info(`All ${d.skipped_already_set} accounts already carry a sub-type.`);
                load();
              } catch (e) {
                toast.error(e.response?.data?.detail || "Backfill failed");
              }
            }}
            onKeyDown={() => {}}
            onMouseDown={async (e) => {
              // Shift+Click = force re-classify EVERY account, even
              // ones that already carry a detail_type (fixes mislabeled).
              if (!e.shiftKey) return;
              e.preventDefault();
              if (!confirm("Force re-classify every account? Existing sub-types will be overwritten with the best guess based on the account name.")) return;
              try {
                const r = await api.post(`/companies/${currentId}/accounts/backfill-detail-type?force=1`, {});
                const d = r.data;
                toast.success(`Re-classified ${d.updated} account${d.updated === 1 ? "" : "s"} (${d.skipped_already_set} unchanged)`);
                load();
              } catch (err) {
                toast.error(err.response?.data?.detail || "Re-classify failed");
              }
            }}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            title="One-shot: guess Wave-style sub-types for legacy accounts (idempotent)."
            data-testid="coa-backfill-detail-type"
          >
            <Sparkles size={12} /> Backfill sub-types
          </button>
          {/* Balance-column basis toggle — Smart auto-picks the right
              lens per account; the other three force a single view.  */}
          <select
            value={basis}
            onChange={(e) => setBasis(e.target.value)}
            className="px-2 py-1 rounded-md border border-slate-300 bg-white text-slate-800 text-[11px] focus:outline-none focus:border-slate-500 cursor-pointer"
            data-testid="coa-basis-toggle"
            title={
              basis === "smart"
                ? "Smart — YTD for revenue/expense, cumulative for asset/liability/equity"
                : basis === "month" ? "Month-to-date across every account"
                : basis === "ytd" ? "Year-to-date across every account"
                : "All-time cumulative across every account"
            }
          >
            <option value="smart">Smart</option>
            <option value="month">MTD</option>
            <option value="ytd">YTD</option>
            <option value="cumulative">All-time</option>
          </select>
          <button
            onClick={exportCsv}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-300 bg-white text-slate-800 text-xs hover:bg-slate-50"
            data-testid="coa-export-btn"
            title="Download Chart of Accounts as CSV"
          >
            <Download size={13} /> Export
          </button>
          <button
            onClick={() => setImportOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-indigo-300 bg-indigo-50 text-indigo-800 text-xs hover:bg-indigo-100"
            data-testid="coa-import-btn"
          >
            <Upload size={13} /> Import
          </button>
          <button
            onClick={() => setSuggestOpen(true)}
            data-testid="coa-suggest-btn"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-indigo-300 bg-indigo-50 text-indigo-800 text-xs hover:bg-indigo-100"
          >
            <Sparkles size={13} /> Suggest with AI
          </button>
          <button data-testid={TID.addBtn} onClick={() => setCreating(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs">
            <Plus size={13} /> New Account
          </button>
        </div>
      </div>

      {/* Sub-type drift audit — amber/red banner so operators can spot
          legacy accounts that need reclassification. Hidden entirely
          when there's nothing to warn about (severity computed on the
          client so we don't need a separate call for regular users).
          Superadmins also see a diagnostic pill exposing every count. */}
      {driftAudit && (driftAudit.drifted > 0 || driftAudit.missing_detail_type > 0) && (
        <div
          className={`rounded-xl border-2 p-3 ${
            driftAudit.drifted > 0
              ? "border-rose-200 bg-rose-50/60"
              : "border-amber-200 bg-amber-50/60"
          }`}
          data-testid="coa-drift-banner"
        >
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
              driftAudit.drifted > 0 ? "bg-rose-100" : "bg-amber-100"
            }`}>
              {driftAudit.drifted > 0
                ? <AlertCircle size={16} className="text-rose-700" />
                : <AlertTriangle size={16} className="text-amber-700" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className={`text-sm font-semibold ${
                driftAudit.drifted > 0 ? "text-rose-900" : "text-amber-900"
              }`}>
                {driftAudit.drifted > 0
                  ? `${driftAudit.drifted} account${driftAudit.drifted === 1 ? "" : "s"} with sub-type drift`
                  : `${driftAudit.missing_detail_type} account${driftAudit.missing_detail_type === 1 ? "" : "s"} missing a sub-type`}
              </div>
              <div className={`text-xs ${driftAudit.drifted > 0 ? "text-rose-800/80" : "text-amber-800/80"}`}>
                {driftAudit.drifted > 0
                  ? "Sub-type and detail-type disagree — the account may render in the wrong section on reports. Use Backfill sub-types (Shift+Click to force re-classify) or edit each account to pick the correct sub-type."
                  : "These accounts are missing a Wave-style sub-type and will land in an unclassified bucket. Click Backfill sub-types above for a one-shot guess."}
              </div>
              {/* Inline list of drifted accounts — visible to every user
                  (not just superadmin) so Pros can see WHICH account is
                  the problem without opening a diagnostics panel. Caps
                  at 3 in the summary; full list still lives in the
                  Superadmin diagnostics chip below. */}
              {driftAudit.drifted > 0 && driftAudit.sample_drift?.length > 0 && (
                <ul className="mt-2 space-y-1" data-testid="coa-drift-list">
                  {driftAudit.sample_drift.slice(0, 3).map((s) => (
                    <li key={s.id} className="flex items-center gap-1.5 text-[11px] text-rose-900" data-testid={`coa-drift-row-${s.id}`}>
                      <span className="w-1 h-1 rounded-full bg-rose-500 shrink-0" />
                      <span className="font-medium truncate max-w-[220px]">{s.name}</span>
                      <span className="text-rose-500/70">·</span>
                      <span className="text-rose-700/70">{s.type}</span>
                      <span className="text-rose-500/70">·</span>
                      <span className="px-1 py-px rounded bg-white/70 text-rose-700 font-mono-num">{s.subtype || "—"}</span>
                      <span className="text-rose-500/70">→</span>
                      <span className="px-1 py-px rounded bg-white/70 text-rose-700 font-mono-num">{s.detail_type || "—"}</span>
                    </li>
                  ))}
                  {driftAudit.sample_drift.length > 3 && (
                    <li className="text-[10px] text-rose-700/70 pl-2.5">
                      +{driftAudit.sample_drift.length - 3} more
                    </li>
                  )}
                </ul>
              )}
            </div>
            {isSuperadmin && (
              <button
                onClick={() => setDriftDetailsOpen(o => !o)}
                className={`shrink-0 text-xs px-3 py-1.5 rounded-md border font-medium bg-white ${
                  driftAudit.drifted > 0
                    ? "border-rose-300 text-rose-800 hover:bg-rose-50"
                    : "border-amber-300 text-amber-800 hover:bg-amber-50"
                }`}
                data-testid="coa-drift-toggle"
              >
                {driftDetailsOpen ? "Hide details" : "Diagnostics"}
              </button>
            )}
          </div>
          {isSuperadmin && driftDetailsOpen && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3 text-xs" data-testid="coa-drift-diagnostics">
              <div className="flex items-center gap-2 mb-2 text-slate-600">
                <Info size={12} />
                <span className="font-semibold uppercase tracking-widest text-[10px]">Superadmin diagnostics</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-slate-700">
                <div><div className="text-[10px] uppercase text-slate-500">Total</div><div className="font-mono-num">{driftAudit.total}</div></div>
                <div><div className="text-[10px] uppercase text-slate-500">Canonical</div><div className="font-mono-num text-emerald-700">{driftAudit.canonical}</div></div>
                <div><div className="text-[10px] uppercase text-slate-500">Legacy only</div><div className="font-mono-num text-slate-600">{driftAudit.legacy_only_subtype}</div></div>
                <div><div className="text-[10px] uppercase text-slate-500">Missing detail</div><div className="font-mono-num text-amber-700">{driftAudit.missing_detail_type}</div></div>
                <div><div className="text-[10px] uppercase text-slate-500">Drifted</div><div className="font-mono-num text-rose-700">{driftAudit.drifted}</div></div>
              </div>
              {driftAudit.sample_drift && driftAudit.sample_drift.length > 0 && (
                <div className="mt-3 pt-3 border-t border-slate-100">
                  <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5">Sample drifted accounts</div>
                  <ul className="space-y-1">
                    {driftAudit.sample_drift.map((s) => (
                      <li key={s.id} className="flex items-center gap-2 text-[11px]" data-testid={`coa-drift-sample-${s.id}`}>
                        <span className="font-medium truncate">{s.name}</span>
                        <span className="text-slate-400">·</span>
                        <span className="text-slate-500">{s.type}</span>
                        <span className="ml-auto flex items-center gap-1.5">
                          <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-mono-num">{s.subtype || "—"}</span>
                          <span className="text-slate-400">→</span>
                          <span className="px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 font-mono-num">{s.detail_type || "—"}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Duplicate-detector banner — only rendered when the backend
          found 1+ likely dup groups. Expands into a per-group list with
          a one-click Merge button per row. */}
      {dupeGroups.length > 0 && (
        <div
          className="rounded-xl border-2 border-amber-200 bg-amber-50/60 p-3"
          data-testid="coa-dupe-banner"
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
              <AlertTriangle size={16} className="text-amber-700" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-amber-900">
                {dupeGroups.length} likely duplicate group{dupeGroups.length > 1 ? "s" : ""} detected
              </div>
              <div className="text-xs text-amber-800/80">
                Accounts of the same type with near-identical names — merge them so reports
                aggregate cleanly.
              </div>
            </div>
            <button
              onClick={() => setDupePanelOpen(o => !o)}
              className="shrink-0 text-xs px-3 py-1.5 rounded-md border border-amber-300 bg-white hover:bg-amber-50 text-amber-800 font-medium"
              data-testid="coa-dupe-toggle"
            >
              {dupePanelOpen ? "Hide" : "Review duplicates"}
            </button>
          </div>
          {dupePanelOpen && (
            <div className="mt-3 space-y-3">
              {dupeGroups.map((g) => (
                <div key={`${g.type}-${g.key}`} className="rounded-lg border border-amber-200 bg-white p-3">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1.5">
                    {g.type} · {g.accounts.length} matches
                  </div>
                  <div className="space-y-1">
                    {g.accounts.map((a) => (
                      <div key={a.id} className="flex items-center justify-between text-sm py-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-mono-num text-slate-500 text-xs w-12 shrink-0">{a.code}</span>
                          <span className="truncate">{a.name}</span>
                          {a.subtype && (
                            <span className="text-[10px] text-slate-400 hidden sm:inline">· {prettyLabel(a.subtype)}</span>
                          )}
                        </div>
                        <button
                          onClick={() => {
                            const src = accts.find(x => x.id === a.id);
                            if (src) setMergeState({ source: src });
                          }}
                          className="shrink-0 inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-indigo-200 text-indigo-700 hover:bg-indigo-50"
                          data-testid={`coa-dupe-merge-${a.id}`}
                          title="Merge this one into another account"
                        >
                          <GitMerge size={11} /> Merge…
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="space-y-4">
        {/* Wave-style tab bar */}
        <div className="border-b border-slate-200 flex items-end gap-1 overflow-x-auto" data-testid="coa-tab-bar">
          {COA_TABS.map(t => {
            // Count matching accounts for the pill badge.
            const count = visibleAccts.filter(a => t.types.includes(a.type)).length;
            const active = activeTab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTabPersist(t.key)}
                className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm border-b-2 -mb-px transition whitespace-nowrap ${
                  active
                    ? "border-slate-900 text-slate-900 font-medium"
                    : "border-transparent text-slate-500 hover:text-slate-800"
                }`}
                data-testid={`coa-tab-${t.key}`}
              >
                {t.label}
                <span className={`inline-flex items-center justify-center min-w-[20px] h-[18px] px-1.5 rounded-full text-[10px] font-mono-num ${
                  active ? "bg-slate-900 text-white" : "bg-slate-200 text-slate-700"
                }`}>{count}</span>
              </button>
            );
          })}
        </div>

        {grouped
          .filter(g => COA_TABS.find(t => t.key === activeTab)?.types.includes(g.type))
          // Hide the COGS section when there are no COGS accounts. The
          // empty "COGS · 0" header on the All tab was confusing users
          // ("what's this doing here?") — many businesses (SaaS,
          // service, condo assocs) never post to COGS. When a company
          // does have COGS accounts (restaurant/inventory/retail),
          // the section reappears automatically.
          .filter(g => g.type !== "cogs" || g.items.length > 0)
          .map(g => (
          <div key={g.type} className="rounded-xl border bg-white overflow-hidden">
            <div className="px-4 py-2 bg-slate-50 border-b text-xs uppercase tracking-widest text-slate-600 font-semibold flex items-center justify-between">
              <span>{TYPE_LABEL[g.type] || g.type} · {g.items.length}</span>
              <span className="text-[10px] normal-case tracking-normal font-normal text-slate-500">
                {basis === "month" ? "MTD"
                  : basis === "cumulative" ? "All-time"
                  : basis === "ytd" ? "YTD"
                  : (["revenue", "expense", "cogs"].includes(g.type) ? "YTD" : "Balance")}
              </span>
            </div>
            <div>
              {(() => {
                // Group items by detail_type for Wave-style sub-headers.
                // Only render sub-type headers when the section is
                // mostly classified (≥50% carry detail_type) — otherwise
                // legacy books look like an "OTHER" dumping ground.
                const sections = DETAIL_SECTIONS_BY_TYPE[g.type] || [];
                const classified = g.items.filter(a => (a.detail_type || "").trim()).length;
                const classifiedShare = g.items.length ? classified / g.items.length : 0;
                if (classifiedShare < 0.5 || sections.length === 0) {
                  return g.items.map(a => renderRow(a, g));
                }
                const byDetail = new Map();
                for (const a of g.items) {
                  const dt = (a.detail_type || "").trim();
                  const key = dt || "__unset__";
                  if (!byDetail.has(key)) byDetail.set(key, []);
                  byDetail.get(key).push(a);
                }
                const blocks = [];
                for (const [key, label] of sections) {
                  const rows = byDetail.get(key);
                  if (!rows || rows.length === 0) continue;
                  blocks.push({ key, label, rows });
                }
                // Un-classified accounts render inline AFTER the known
                // sections without their own banner — mirrors how Wave
                // handles accounts that were imported without metadata.
                const unset = byDetail.get("__unset__") || [];
                return (
                  <>
                    {blocks.map(b => (
                      <div key={b.key} data-testid={`coa-detail-${g.type}-${b.key}`}>
                        <div className="px-4 py-1.5 bg-slate-50/50 border-b border-slate-100 text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
                          {b.label}
                        </div>
                        {b.rows.map(a => renderRow(a, g))}
                      </div>
                    ))}
                    {unset.map(a => renderRow(a, g))}
                  </>
                );
              })()}
            </div>
          </div>
        ))}
      </div>
      {creating && <CreateAccount currentId={currentId} prefill={creatingPrefill} allAccounts={accts} showCodes={showCodes}
                                    onClose={() => { setCreating(false); setCreatingPrefill(null); load(); }} />}
      {suggestOpen && (
        <SuggestCoAModal
          currentId={currentId}
          onClose={(reload) => { setSuggestOpen(false); if (reload) load(); }}
        />
      )}
      {mergeState && (
        <MergeAccountDialog
          currentId={currentId}
          source={mergeState.source}
          allAccounts={accts}
          balances={balances}
          onClose={(reload) => { setMergeState(null); if (reload) load(); }}
        />
      )}
      {importOpen && (
        <ImportAccountsModal
          currentId={currentId}
          onClose={(reload) => { setImportOpen(false); if (reload) load(); }}
        />
      )}
    </div>
  );
}

function AccountRow({ a, allAccounts, currentId, balance, showCodes = true, onSaved, onDeleted, onMerge,
                     dragSourceId, onDragStart, onDragEnd, onReparent }) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState(a.code);
  const [name, setName] = useState(a.name);
  const [type, setType] = useState(a.type);
  const [subtype, setSubtype] = useState(a.subtype || "");
  // Parent account (sub-account support): pick any top-level account of
  // the SAME type. Nesting more than one level deep is intentionally
  // blocked so the hierarchy stays a clean 2-level tree Pros can reason
  // about (e.g. Utilities > Electric, not Utilities > Electric > Sub-electric).
  const [parentId, setParentId] = useState(a.parent_account_id || "");

  // Re-sync the local edit buffer if the row's props change under us
  // (e.g. after a bulk reload). Doesn't trip while the user is editing.
  useEffect(() => {
    if (!editing) {
      setCode(a.code);
      setName(a.name);
      setType(a.type);
      setSubtype(a.subtype || "");
      setParentId(a.parent_account_id || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.code, a.name, a.type, a.subtype, a.parent_account_id]);

  const startEdit = () => setEditing(true);
  const cancel = () => {
    setCode(a.code);
    setName(a.name);
    setType(a.type);
    setSubtype(a.subtype || "");
    setParentId(a.parent_account_id || "");
    setEditing(false);
  };

  // Candidate parents: same type, not the row itself, and top-level
  // (parent has no parent) so we don't build 3-level trees. Filtered
  // client-side because the CoA is small (≤200 rows typical).
  const eligibleParents = (allAccounts || [])
    .filter((p) =>
      p.id !== a.id
      && p.type === type
      && !p.parent_account_id
    )
    .sort((x, y) => String(x.code).localeCompare(String(y.code)));

  const save = async () => {
    // Auto-generate a code when the CPA has codes hidden and left the
    // field blank — the whole point of the toggle is to not care about
    // numbering. Existing rows keep their code unless the user cleared
    // it deliberately, in which case we still auto-fill.
    let effectiveCode = String(code).trim();
    if (!effectiveCode) {
      if (!showCodes) {
        effectiveCode = nextCodeForType(type, allAccounts || []);
        setCode(effectiveCode);
      } else {
        toast.error("Code is required."); return;
      }
    }
    const trimmedName = name.trim();
    if (!trimmedName) { toast.error("Name is required."); return; }
    if (!TYPES.includes(type)) { toast.error("Invalid type."); return; }
    // If a parent is set, guard against self-parenting and mismatched types
    // (the eligibleParents filter already excludes both but a stale prop
    // update could theoretically slip a bad value through).
    if (parentId) {
      const p = (allAccounts || []).find(x => x.id === parentId);
      if (!p) { toast.error("Parent account not found."); return; }
      if (p.id === a.id) { toast.error("An account can't be its own parent."); return; }
      if (p.type !== type) { toast.error("Parent must be the same type."); return; }
      if (p.parent_account_id) { toast.error("Parent must be a top-level account."); return; }
    }
    const nextParentId = parentId || null;
    // No-op guard — nothing changed.
    if (
      effectiveCode === String(a.code) &&
      trimmedName === a.name &&
      type === a.type &&
      subtype.trim() === (a.subtype || "") &&
      nextParentId === (a.parent_account_id || null)
    ) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await api.patch(`/companies/${currentId}/accounts/${a.id}`, {
        code: effectiveCode,
        name: trimmedName,
        type,
        // Sub-type unification (Feb 2026) — the dropdown now offers the
        // exact DETAIL_SECTIONS_BY_TYPE keys the renderer groups by, so
        // we mirror the pick to BOTH `subtype` and `detail_type`. This
        // makes reclassifying (esp. Operating Expense ↔ Other Expense ↔
        // COGS) WYSIWYG. `subtype` stays populated for legacy consumers
        // (reports.py's fixed_asset check).
        subtype: subtype.trim(),
        detail_type: subtype.trim(),
        parent_account_id: nextParentId,
      });
      toast.success("Account updated.");
      setEditing(false);
      onSaved?.();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally { setBusy(false); }
  };

  const del = async () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete account "${a.name}"? This can't be undone.`)) return;
    setBusy(true);
    try {
      await api.delete(`/companies/${currentId}/accounts/${a.id}`);
      toast.success("Account deleted.");
      onDeleted?.();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Delete failed");
      setBusy(false);
    }
  };

  const onKey = (e) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") cancel();
  };

  // ------------------------------------------------------------------
  // Drag & drop reparent — HTML5 native events (no library). The
  // rules mirror the backend PATCH validation to give the CPA
  // instant "not allowed" feedback:
  //   • child dragged onto a same-type TOP-LEVEL row  → new parent
  //   • child dragged onto a section header / empty area → promote to top-level
  //   • same-type only, never onto self, only children can be dragged
  // Top-level rows with kids of their own can't be nested either.
  // ------------------------------------------------------------------
  const canDrag = !!a.parent_account_id;    // only children are draggable
  const dragSource = allAccounts?.find(x => x.id === dragSourceId);
  const isValidDropTarget =
    dragSource
    && dragSource.id !== a.id
    && !a.parent_account_id                  // must be top-level to accept
    && dragSource.type === a.type
    && dragSource.parent_account_id !== a.id; // already parented here → noop
  const [dropHover, setDropHover] = useState(false);

  const onDragStartInternal = (e) => {
    if (!canDrag) return;
    e.dataTransfer.setData("text/account-id", a.id);
    e.dataTransfer.effectAllowed = "move";
    onDragStart?.(a.id);
  };
  const onDragEndInternal = () => {
    setDropHover(false);
    onDragEnd?.();
  };
  const onDragOverInternal = (e) => {
    if (!isValidDropTarget) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropHover(true);
  };
  const onDragLeaveInternal = () => setDropHover(false);
  const onDropInternal = (e) => {
    setDropHover(false);
    if (!isValidDropTarget) return;
    e.preventDefault();
    const srcId = e.dataTransfer.getData("text/account-id") || dragSourceId;
    if (srcId && srcId !== a.id) onReparent?.(srcId, a.id);
  };

  return editing ? (
    <div
      className="px-4 py-3 border-b border-slate-100 bg-indigo-50/40 ring-1 ring-inset ring-indigo-200 space-y-2"
      data-testid={a.parent_account_id ? "coa-child-row" : "coa-parent-row"}
    >
      {/* Main edit row — code / name / type / subtype / save·cancel */}
      <div className="grid grid-cols-12 gap-3 items-center">
        {showCodes && (
          <div className="col-span-2">
            <label className="block text-[9px] uppercase tracking-wide text-slate-500 mb-0.5">Code</label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={onKey}
              className="w-full border rounded px-2 py-1 text-sm font-mono-num focus:outline-none focus:border-slate-500"
              data-testid={`coa-edit-code-${a.id}`}
              placeholder="Code"
              autoFocus
            />
          </div>
        )}
        <div className={showCodes ? "col-span-5" : "col-span-7"}>
          <label className="block text-[9px] uppercase tracking-wide text-slate-500 mb-0.5">Account name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onKey}
            className="w-full border rounded px-2 py-1 text-sm focus:outline-none focus:border-slate-500"
            data-testid={`coa-edit-name-${a.id}`}
            placeholder="Account name"
            autoFocus={!showCodes}
          />
        </div>
        <div className="col-span-2">
          <label className="block text-[9px] uppercase tracking-wide text-slate-500 mb-0.5">Type</label>
          <select
            value={type}
            onChange={(e) => {
              const nextType = e.target.value;
              setType(nextType);
              // Keep the existing subtype only if it's still valid under the
              // new parent type; otherwise snap to the first option.
              if (!subtypesFor(nextType).includes(subtype)) {
                setSubtype(subtypesFor(nextType)[0]);
              }
              // Parent-account restriction: must match the new type, so
              // drop the parent if the type change broke the relationship.
              if (parentId) {
                const p = (allAccounts || []).find(x => x.id === parentId);
                if (!p || p.type !== nextType) setParentId("");
              }
            }}
            className="w-full border rounded px-2 py-1 text-sm focus:outline-none focus:border-slate-500"
            data-testid={`coa-edit-type-${a.id}`}
          >
            {TYPES.map(t => <option key={t} value={t}>{prettyLabel(t)}</option>)}
          </select>
        </div>
        <div className="col-span-2">
          <label className="block text-[9px] uppercase tracking-wide text-slate-500 mb-0.5">Subtype</label>
          <select
            value={subtypesFor(type).includes(subtype) ? subtype : ""}
            onChange={(e) => setSubtype(e.target.value)}
            className="w-full border rounded px-2 py-1 text-xs focus:outline-none focus:border-slate-500"
            data-testid={`coa-edit-subtype-${a.id}`}
          >
            {!subtypesFor(type).includes(subtype) && subtype && (
              <option value={subtype}>{prettyLabel(subtype)} (legacy)</option>
            )}
            {subtypesFor(type).map(s => (
              <option key={s} value={s}>{prettyLabel(s)}</option>
            ))}
          </select>
        </div>
        <div className="col-span-1 flex items-end justify-end gap-1 pb-0.5">
          <button
            onClick={save}
            disabled={busy}
            className="text-emerald-600 hover:bg-emerald-50 rounded p-1 disabled:opacity-50"
            title="Save (Enter)"
            data-testid={`coa-save-${a.id}`}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
          </button>
          <button
            onClick={cancel}
            disabled={busy}
            className="text-slate-500 hover:bg-slate-100 rounded p-1 disabled:opacity-50"
            title="Cancel (Esc)"
            data-testid={`coa-cancel-${a.id}`}
          >
            <X size={13} />
          </button>
        </div>
      </div>
      {/* Sub-account row — pick a parent of the same type to nest this
          account under (Utilities > Electric, etc). Only shown when a
          same-type top-level candidate exists to keep the UI clean for
          new / first-of-type accounts. */}
      <div className="grid grid-cols-12 gap-3 items-center">
        <div className="col-span-2 text-[10px] uppercase tracking-wide text-slate-500 self-center">
          Sub-account of
        </div>
        <div className="col-span-9">
          <select
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            className="w-full border rounded px-2 py-1 text-sm bg-white focus:outline-none focus:border-slate-500"
            data-testid={`coa-edit-parent-${a.id}`}
          >
            <option value="">— None (top-level account) —</option>
            {eligibleParents.map(p => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name}
              </option>
            ))}
          </select>
          {eligibleParents.length === 0 && (
            <div className="text-[10px] text-slate-500 mt-1">
              No other top-level {type} accounts exist yet — create one first to nest under it.
            </div>
          )}
        </div>
      </div>
    </div>
  ) : (
    <div
      className={`grid grid-cols-12 gap-3 px-4 py-2 border-b border-slate-100 items-center transition-colors ${a._depth ? "bg-slate-50/40" : ""} ${dropHover ? "ring-2 ring-inset ring-indigo-400 bg-indigo-50" : "hover:bg-slate-50"} ${canDrag && dragSourceId === a.id ? "opacity-50" : ""}`}
      data-testid={a.parent_account_id ? "coa-child-row" : "coa-parent-row"}
      draggable={canDrag}
      onDragStart={onDragStartInternal}
      onDragEnd={onDragEndInternal}
      onDragOver={onDragOverInternal}
      onDragLeave={onDragLeaveInternal}
      onDrop={onDropInternal}
    >
      <div className={`${showCodes ? "col-span-2" : "col-span-1"} font-mono-num text-slate-500 text-sm flex items-center gap-1`}>
        {canDrag ? (
          <span
            className="text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing -ml-1"
            title="Drag onto another parent to re-nest"
            data-testid={`coa-drag-${a.id}`}
          >
            <GripVertical size={12} />
          </span>
        ) : <span className="w-3 shrink-0" />}
        {a._depth ? <span className="opacity-40">↳</span> : null}
        {showCodes ? a.code : null}
      </div>
      <button
        type="button"
        onClick={() => navigate(`/reports/account-detail?account=${a.id}&from=coa`)}
        className={`${a._depth ? "pl-4 text-slate-700" : "font-medium"} ${showCodes ? "col-span-4" : "col-span-5"} text-sm text-left hover:underline hover:text-indigo-700 transition-colors`}
        data-testid={`coa-name-link-${a.id}`}
        title="View transactions & journal entries for this account"
      >
        {a.name}
        {a.created_by_ai && a.parent_account_id && (
          <span className="ml-2 text-[10px] uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
            auto
          </span>
        )}
      </button>
      <div
        className="col-span-3 text-xs text-slate-500"
        data-testid={`coa-subtype-${a.id}`}
        title={a.detail_type ? `Sub-type: ${DETAIL_TYPE_LABEL[a.detail_type] || a.detail_type}` : "No sub-type set — edit this row to classify."}
      >
        {a.detail_type ? (
          <span className="inline-flex items-center rounded bg-slate-100 text-slate-700 px-1.5 py-0.5 text-[10px] font-medium">
            {DETAIL_TYPE_LABEL[a.detail_type] || prettyLabel(a.detail_type)}
          </span>
        ) : a.subtype ? (
          <span className="text-slate-400 italic">{prettyLabel(a.subtype)}</span>
        ) : (
          <span className="text-amber-600 italic">unclassified</span>
        )}
      </div>
      <button
        type="button"
        onClick={() => navigate(`/reports/account-detail?account=${a.id}&from=coa`)}
        className={`col-span-2 text-right font-mono-num text-[13px] hover:underline hover:text-indigo-700 transition-colors ${balance == null || Math.abs(Number(balance)) < 0.005 ? "text-slate-300" : "text-slate-800"}`}
        data-testid={`coa-balance-${a.id}`}
        title={
          ["revenue", "expense", "cogs"].includes(a.type)
            ? "Year-to-date balance — click to see the transactions that add up to this"
            : "Current cumulative balance — click to see the transactions that add up to this"
        }
      >
        {fmtMoney(balance)}
      </button>
      <div className="col-span-1 flex items-center justify-end gap-1">
        <button
          onClick={startEdit}
          className="text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded p-1"
          title="Edit account"
          data-testid={`coa-edit-${a.id}`}
        >
          <Pencil size={13} />
        </button>
        <button
          onClick={() => onMerge?.(a)}
          className="text-indigo-500 hover:text-indigo-900 hover:bg-indigo-50 rounded p-1"
          title="Merge into another account"
          data-testid={`coa-merge-${a.id}`}
        >
          <GitMerge size={13} />
        </button>
        <button
          onClick={del}
          className="text-red-500 hover:bg-red-50 rounded p-1"
          title="Delete account"
          data-testid={TID.deleteBtn}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}



/**
 * MergeAccountDialog — combine two duplicate accounts. The SOURCE
 * account's transactions, journal-entry lines, splits, rules, and any
 * child accounts are all reassigned to the TARGET before the source is
 * deleted. Both accounts must be the same type (the backend enforces
 * this too — merging an asset into an expense would silently invert
 * every balance).
 */
function MergeAccountDialog({ currentId, source, allAccounts, balances, onClose }) {
  const [targetId, setTargetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const candidates = (allAccounts || [])
    .filter(a => a.id !== source.id && a.type === source.type)
    .sort((x, y) => String(x.code).localeCompare(String(y.code)));

  const target = candidates.find(c => c.id === targetId);
  const srcBal = balances?.[source.id]?.rollup;
  const tgtBal = target ? balances?.[target.id]?.rollup : null;

  const doMerge = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const r = await api.post(
        `/companies/${currentId}/accounts/${source.id}/merge-into`,
        { target_account_id: target.id },
      );
      const m = r.data?.moved || {};
      const parts = [];
      if (m.journal_lines) parts.push(`${m.journal_lines} journal line${m.journal_lines > 1 ? "s" : ""}`);
      if (m.transactions) parts.push(`${m.transactions} transaction${m.transactions > 1 ? "s" : ""}`);
      if (m.splits) parts.push(`${m.splits} split${m.splits > 1 ? "s" : ""}`);
      if (m.rules) parts.push(`${m.rules} rule${m.rules > 1 ? "s" : ""}`);
      if (m.reparented_children) parts.push(`${m.reparented_children} sub-account${m.reparented_children > 1 ? "s" : ""}`);
      toast.success(
        parts.length
          ? `Merged into ${target.code} · ${target.name} — moved ${parts.join(", ")}.`
          : `Merged into ${target.code} · ${target.name}.`
      );
      onClose(true);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Merge failed");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-5 space-y-4" data-testid="coa-merge-dialog">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-indigo-100 flex items-center justify-center shrink-0">
            <GitMerge size={16} className="text-indigo-700" />
          </div>
          <div>
            <h3 className="font-heading font-semibold text-base">Merge account</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Combine two duplicate accounts. Every journal line, transaction,
              split, rule, and sub-account under the source moves to the target.
              The source account is then deleted.
            </p>
          </div>
        </div>

        <div className="rounded-lg border bg-slate-50 p-3 text-xs space-y-1">
          <div className="flex items-center justify-between">
            <span className="uppercase tracking-wide text-slate-500 text-[10px]">Source (will be deleted)</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="font-mono-num text-slate-700">{source.code}</span>
            <span className="flex-1 mx-2 text-slate-900 font-medium truncate">{source.name}</span>
            <span className="font-mono-num text-slate-600">
              {srcBal == null || Math.abs(srcBal) < 0.005
                ? "—"
                : Number(srcBal).toLocaleString(undefined, { style: "currency", currency: "USD" })}
            </span>
          </div>
        </div>

        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">
            Merge into…
          </label>
          <select
            value={targetId}
            onChange={(e) => { setTargetId(e.target.value); setConfirm(false); }}
            className="w-full border rounded-md px-3 py-2 text-sm bg-white"
            data-testid="coa-merge-target-select"
          >
            <option value="">— Pick the account to keep —</option>
            {candidates.map(c => (
              <option key={c.id} value={c.id}>
                {c.code} · {c.name}
                {balances?.[c.id]?.rollup != null && Math.abs(balances[c.id].rollup) >= 0.005
                  ? ` — ${Number(balances[c.id].rollup).toLocaleString(undefined, { style: "currency", currency: "USD" })}`
                  : ""}
              </option>
            ))}
          </select>
          {!candidates.length && (
            <div className="mt-1 text-[11px] text-slate-500">
              No other <b>{source.type}</b> accounts exist to merge into — create one first, or edit this row instead.
            </div>
          )}
        </div>

        {target && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 text-xs space-y-1">
            <div className="uppercase tracking-wide text-emerald-800 text-[10px]">After merge · target balance</div>
            <div className="flex items-center justify-between">
              <span className="font-mono-num text-slate-700">{target.code}</span>
              <span className="flex-1 mx-2 text-slate-900 font-medium truncate">{target.name}</span>
              <span className="font-mono-num font-semibold text-emerald-800">
                {(() => {
                  const combined = (srcBal || 0) + (tgtBal || 0);
                  return Math.abs(combined) < 0.005
                    ? "$0.00"
                    : Number(combined).toLocaleString(undefined, { style: "currency", currency: "USD" });
                })()}
              </span>
            </div>
          </div>
        )}

        {target && (
          <label className="flex items-start gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={confirm}
              onChange={(e) => setConfirm(e.target.checked)}
              className="mt-0.5"
              data-testid="coa-merge-confirm"
            />
            <span>
              I understand this can't be undone. All history from{" "}
              <b>{source.code} · {source.name}</b> will appear under{" "}
              <b>{target.code} · {target.name}</b>.
            </span>
          </label>
        )}

        <div className="flex gap-2 pt-1">
          <button
            onClick={doMerge}
            disabled={!target || !confirm || busy}
            className="flex-1 py-2 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
            data-testid="coa-merge-confirm-btn"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <GitMerge size={13} />}
            Merge accounts
          </button>
          <button
            onClick={() => onClose(false)}
            disabled={busy}
            className="flex-1 py-2 rounded-md border text-sm"
            data-testid="coa-merge-cancel-btn"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}



function SuggestCoAModal({ currentId, onClose }) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [businessType, setBusinessType] = useState("");
  const [selected, setSelected] = useState(new Set());

  useEffect(() => {
    (async () => {
      try {
        const r = await api.post(`/companies/${currentId}/onboarding/coa/suggest`);
        const list = (r.data.suggestions || []).filter(s => !s.already_exists);
        setSuggestions(list);
        setSelected(new Set(list.map(s => s.code)));
        setBusinessType(r.data.business_type || "");
      } catch {
        toast.error("AI could not generate suggestions.");
      } finally {
        setLoading(false);
      }
    })();
  }, [currentId]);

  const apply = async () => {
    if (!selected.size) return;
    setBusy(true);
    try {
      const r = await api.post(`/companies/${currentId}/onboarding/generate-coa`, {
        codes: [...selected],
      });
      toast.success(`Added ${r.data.added} account${r.data.added === 1 ? "" : "s"}`);
      onClose(true);
    } catch {
      toast.error("Failed to add accounts.");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (code) => setSelected(prev => {
    const n = new Set(prev);
    n.has(code) ? n.delete(code) : n.add(code);
    return n;
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[85vh]">
        <div className="px-5 py-4 border-b">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-indigo-600" />
            <h3 className="font-heading font-semibold">AI-tailored Chart of Accounts</h3>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Claude Sonnet analyzed your business{businessType ? ` (${businessType})` : ""} and
            proposes industry-specific accounts. Review, then add what you want.
          </p>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="py-12 flex items-center justify-center gap-2 text-sm text-slate-500">
              <Loader2 size={16} className="animate-spin" /> Analyzing your business…
            </div>
          ) : suggestions.length === 0 ? (
            <div className="py-12 text-center text-sm text-slate-500 px-6">
              Your chart of accounts is already well-tailored — no new suggestions.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 px-5 py-2 bg-slate-50 border-b sticky top-0 z-10">
                <input
                  type="checkbox"
                  checked={selected.size === suggestions.length}
                  onChange={() => setSelected(
                    selected.size === suggestions.length
                      ? new Set()
                      : new Set(suggestions.map(s => s.code))
                  )}
                  data-testid="coa-suggest-select-all"
                />
                <div className="text-xs text-slate-600">
                  <b>{selected.size}</b> of {suggestions.length} selected
                </div>
              </div>
              <div className="divide-y">
                {suggestions.map(s => (
                  <label
                    key={s.code}
                    data-testid={`coa-suggest-option-${s.code}`}
                    className={`flex items-start gap-3 px-5 py-2.5 cursor-pointer ${
                      selected.has(s.code) ? "bg-indigo-50/40" : "hover:bg-slate-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(s.code)}
                      onChange={() => toggle(s.code)}
                      className="mt-1"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm flex items-baseline gap-2 flex-wrap">
                        <span className="font-mono-num text-slate-500 tabular-nums">{s.code}</span>
                        <span className="font-medium">{s.name}</span>
                        <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                          {s.type}
                        </span>
                      </div>
                      {s.rationale && (
                        <div className="text-[11px] text-slate-500 mt-0.5">{s.rationale}</div>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="px-5 py-3 border-t bg-slate-50/50 flex justify-end gap-2">
          <button
            onClick={() => onClose(false)}
            className="px-3 py-1.5 rounded-md text-sm border border-slate-300 hover:bg-slate-50"
            data-testid="coa-suggest-cancel"
          >
            Cancel
          </button>
          <button
            onClick={apply}
            disabled={busy || selected.size === 0}
            data-testid="coa-suggest-apply"
            className="px-3 py-1.5 rounded-md text-sm bg-slate-900 text-white disabled:opacity-50 inline-flex items-center gap-1"
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            Add {selected.size} account{selected.size === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Wave-style granular sub-types grouped by parent Type. The `key` is
// stored in the account's `detail_type` field; the modal reveals extra
// fields when a Fixed Asset or Loan sub-type is picked.
const DETAIL_TYPES = {
  asset: [
    { key: "cash_and_bank",                 label: "Cash and Bank" },
    { key: "money_in_transit",              label: "Money in Transit" },
    { key: "expected_payments_from_customers", label: "Accounts Receivable" },
    { key: "inventory",                     label: "Inventory" },
    { key: "property_plant_equipment",      label: "Property, Plant & Equipment" },
    { key: "depreciation_and_amortization", label: "Depreciation and Amortization" },
    { key: "vendor_prepayments",            label: "Vendor Prepayments & Credits" },
    { key: "other_short_term_asset",        label: "Other Short-Term Asset" },
    { key: "other_long_term_asset",         label: "Other Long-Term Asset" },
  ],
  liability: [
    { key: "credit_card",                   label: "Credit Card" },
    { key: "loan_and_line_of_credit",       label: "Loan and Line of Credit" },
    { key: "expected_payments_to_vendors",  label: "Accounts Payable" },
    { key: "due_for_payroll",               label: "Due For Payroll" },
    { key: "due_to_owners",                 label: "Due to Owners" },
    { key: "customer_prepayments",          label: "Customer Prepayments & Credits" },
    { key: "sales_tax_payable",             label: "Sales Tax Payable" },
    { key: "other_short_term_liability",    label: "Other Short-Term Liability" },
    { key: "other_long_term_liability",     label: "Other Long-Term Liability" },
  ],
  equity: [
    { key: "owner_contribution_drawing",    label: "Owner Contribution & Drawing" },
    { key: "retained_earnings",             label: "Retained Earnings" },
    { key: "opening_balance_equity",        label: "Opening Balance Equity" },
    { key: "other_equity",                  label: "Other Equity" },
  ],
  revenue: [
    { key: "income",                        label: "Income" },
    { key: "discount",                      label: "Discount" },
    { key: "other_income",                  label: "Other Income" },
  ],
  expense: [
    { key: "operating_expense",             label: "Operating Expense" },
    { key: "cost_of_goods_sold",            label: "Cost of Goods Sold" },
    { key: "payment_processing_fee",        label: "Payment Processing Fee" },
    { key: "payroll_expense",               label: "Payroll Expense" },
    { key: "other_expense",                 label: "Other Expense" },
  ],
  cogs: [
    { key: "cost_of_goods_sold",            label: "Cost of Goods Sold" },
  ],
};

const ASSET_TYPE_OPTIONS = [
  { key: "equipment",  label: "Equipment (5 yr life)" },
  { key: "furniture",  label: "Furniture & Fixtures (7 yr)" },
  { key: "vehicle",    label: "Vehicle (5 yr)" },
  { key: "computer",   label: "Computer Hardware (5 yr)" },
  { key: "building",   label: "Building (39 yr)" },
  { key: "land",       label: "Land (non-depreciable)" },
  { key: "leasehold",  label: "Leasehold Improvement (15 yr)" },
  { key: "other",      label: "Other" },
];

function CreateAccount({ currentId, prefill, allAccounts, showCodes = true, onClose }) {
  const p = prefill || {};
  const [code, setCode] = useState(p.code || "");
  const [name, setName] = useState(p.name || "");
  const [type, setType] = useState(TYPES.includes(p.type) ? p.type : "expense");
  const detailsForType = (t) => DETAIL_TYPES[t === "revenue" ? "revenue" : t] || [];
  const [detailType, setDetailType] = useState(p.detail_type || "");
  const [subtype, setSubtype] = useState(
    p.subtype && subtypesFor(TYPES.includes(p.type) ? p.type : "expense").includes(p.subtype)
      ? p.subtype
      : subtypesFor(TYPES.includes(p.type) ? p.type : "expense")[0]
  );
  // Sub-account parent — prefilled if the caller passed one (used by
  // some AI actions that spawn nested accounts directly).
  const [parentId, setParentId] = useState(p.parent_account_id || "");

  // Fixed asset extras — only sent when detailType === property_plant_equipment
  const [cost, setCost] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [assetTypeKey, setAssetTypeKey] = useState("equipment");
  const [lifeYears, setLifeYears] = useState("");
  const [salvage, setSalvage] = useState("");

  // Loan extras — only sent when detailType === loan_and_line_of_credit
  const [lender, setLender] = useState("");
  const [principal, setPrincipal] = useState("");
  const [rate, setRate] = useState("");
  const [termMonths, setTermMonths] = useState("");
  const [startDate, setStartDate] = useState("");

  const isFixedAsset = type === "asset" && detailType === "property_plant_equipment";
  const isLoan = type === "liability" && detailType === "loan_and_line_of_credit";

  const eligibleParents = (allAccounts || [])
    .filter((row) => row.type === type && !row.parent_account_id)
    .sort((x, y) => String(x.code).localeCompare(String(y.code)));

  const save = async () => {
    // Same auto-code rule as the inline row editor: when codes are
    // hidden, fill in the next-available number in the type's range.
    let effectiveCode = String(code).trim();
    if (!effectiveCode) {
      if (!showCodes) {
        effectiveCode = nextCodeForType(type, allAccounts || []);
      } else {
        toast.error("Code is required."); return;
      }
    }
    if (!name.trim()) { toast.error("Name is required."); return; }
    if (!detailType) { toast.error("Pick a sub-type — required for correct reporting."); return; }
    if (isFixedAsset) {
      if (!cost || Number(cost) <= 0) { toast.error("Cost is required."); return; }
      if (!purchaseDate) { toast.error("Purchase date is required."); return; }
    }
    if (isLoan) {
      if (!principal || Number(principal) <= 0) { toast.error("Principal is required."); return; }
    }
    const payload = {
      code: effectiveCode, name: name.trim(), type, subtype,
      detail_type: detailType,
      parent_account_id: parentId || null,
    };
    if (isFixedAsset) {
      Object.assign(payload, {
        cost: Number(cost),
        purchase_date: purchaseDate,
        asset_type: assetTypeKey,
        useful_life_years: lifeYears ? Number(lifeYears) : null,
        salvage_value: salvage ? Number(salvage) : 0,
      });
    }
    if (isLoan) {
      Object.assign(payload, {
        lender: (lender || name).trim(),
        principal: Number(principal),
        rate: rate ? Number(rate) : null,
        term_months: termMonths ? Number(termMonths) : null,
        start_date: startDate || null,
      });
    }
    const r = await api.post(`/companies/${currentId}/accounts`, payload);
    const se = r.data?.side_effect;
    if (se?.kind === "fixed_asset" && se.error) toast.warning(`Account saved. Fixed Asset skipped: ${se.error}`);
    else if (se?.kind === "fixed_asset") toast.success("Account + Fixed Asset created");
    else if (se?.kind === "loan") toast.success("Account + Loan created");
    else toast.success("Account created");
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-3 max-h-[92vh] overflow-y-auto">
        <h3 className="font-heading font-semibold">New Account</h3>
        {showCodes && (
          <input placeholder="Code (e.g. 6250)" value={code} onChange={(e) => setCode(e.target.value)}
                 className="w-full border rounded px-3 py-2 text-sm font-mono-num" data-testid="coa-create-code" />
        )}
        <input placeholder="Account name" value={name} onChange={(e) => setName(e.target.value)}
               className="w-full border rounded px-3 py-2 text-sm" data-testid="coa-create-name" />
        <select
          value={type}
          data-testid="coa-create-type"
          onChange={(e) => {
            const nextType = e.target.value;
            setType(nextType);
            if (!subtypesFor(nextType).includes(subtype)) {
              setSubtype(subtypesFor(nextType)[0]);
            }
            const list = detailsForType(nextType);
            // On type switch, blank the sub-type if it's no longer
            // valid for the new type — user must re-pick.
            const stillValid = list.some(d => d.key === detailType);
            if (!stillValid) setDetailType("");
            // Drop the parent if the new type invalidates it — sub-accounts
            // must live under a parent of the same type.
            if (parentId) {
              const par = (allAccounts || []).find(r => r.id === parentId);
              if (!par || par.type !== nextType) setParentId("");
            }
          }}
          className="w-full border rounded px-3 py-2 text-sm"
        >
          {TYPES.map(t => <option key={t} value={t}>{prettyLabel(t)}</option>)}
        </select>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">
            Sub-type <span className="text-rose-500">*</span>
          </label>
          <select
            value={detailType}
            onChange={(e) => setDetailType(e.target.value)}
            className={`w-full border rounded px-3 py-2 text-sm bg-white ${detailType ? "" : "text-slate-400"} ${detailType ? "border-slate-300" : "border-slate-300"}`}
            data-testid="coa-create-detail-type"
            required
          >
            <option value="" disabled>Select a sub-type…</option>
            {detailsForType(type).map(dt => (
              <option key={dt.key} value={dt.key} className="text-slate-900">{dt.label}</option>
            ))}
          </select>
        </div>

        {/* Conditional fields — Fixed Asset flow */}
        {isFixedAsset && (
          <div className="rounded-lg bg-indigo-50/60 border border-indigo-100 px-3 py-3 space-y-2" data-testid="coa-fixed-asset-fields">
            <div className="text-[11px] text-indigo-800 font-semibold uppercase tracking-wide">Fixed Asset details</div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-slate-600 mb-0.5">Cost</label>
                <input type="number" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)}
                       placeholder="0.00"
                       className="w-full border rounded px-2 py-1.5 text-sm font-mono-num"
                       data-testid="coa-fa-cost" />
              </div>
              <div>
                <label className="block text-[10px] text-slate-600 mb-0.5">Purchase date</label>
                <input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)}
                       className="w-full border rounded px-2 py-1.5 text-sm font-mono-num"
                       data-testid="coa-fa-date" />
              </div>
            </div>
            <div>
              <label className="block text-[10px] text-slate-600 mb-0.5">Asset type</label>
              <select value={assetTypeKey} onChange={(e) => setAssetTypeKey(e.target.value)}
                      className="w-full border rounded px-2 py-1.5 text-sm bg-white"
                      data-testid="coa-fa-type">
                {ASSET_TYPE_OPTIONS.map(at => (
                  <option key={at.key} value={at.key}>{at.label}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-slate-600 mb-0.5">Life (yrs) — override</label>
                <input type="number" value={lifeYears} onChange={(e) => setLifeYears(e.target.value)}
                       placeholder="auto"
                       className="w-full border rounded px-2 py-1.5 text-sm font-mono-num"
                       data-testid="coa-fa-life" />
              </div>
              <div>
                <label className="block text-[10px] text-slate-600 mb-0.5">Salvage value</label>
                <input type="number" step="0.01" value={salvage} onChange={(e) => setSalvage(e.target.value)}
                       placeholder="0.00"
                       className="w-full border rounded px-2 py-1.5 text-sm font-mono-num"
                       data-testid="coa-fa-salvage" />
              </div>
            </div>
            <div className="text-[10px] text-slate-500">
              We'll auto-post the acquisition entry and build the depreciation schedule. Funding can be allocated later on the Assets page.
            </div>
          </div>
        )}

        {/* Conditional fields — Loan flow */}
        {isLoan && (
          <div className="rounded-lg bg-indigo-50/60 border border-indigo-100 px-3 py-3 space-y-2" data-testid="coa-loan-fields">
            <div className="text-[11px] text-indigo-800 font-semibold uppercase tracking-wide">Loan details</div>
            <input placeholder="Lender (e.g. Wells Fargo)" value={lender} onChange={(e) => setLender(e.target.value)}
                   className="w-full border rounded px-2 py-1.5 text-sm"
                   data-testid="coa-loan-lender" />
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-slate-600 mb-0.5">Principal</label>
                <input type="number" step="0.01" value={principal} onChange={(e) => setPrincipal(e.target.value)}
                       placeholder="0.00"
                       className="w-full border rounded px-2 py-1.5 text-sm font-mono-num"
                       data-testid="coa-loan-principal" />
              </div>
              <div>
                <label className="block text-[10px] text-slate-600 mb-0.5">Rate %</label>
                <input type="number" step="0.001" value={rate} onChange={(e) => setRate(e.target.value)}
                       placeholder="0.000"
                       className="w-full border rounded px-2 py-1.5 text-sm font-mono-num"
                       data-testid="coa-loan-rate" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-slate-600 mb-0.5">Term (months)</label>
                <input type="number" value={termMonths} onChange={(e) => setTermMonths(e.target.value)}
                       placeholder="60"
                       className="w-full border rounded px-2 py-1.5 text-sm font-mono-num"
                       data-testid="coa-loan-term" />
              </div>
              <div>
                <label className="block text-[10px] text-slate-600 mb-0.5">Start date</label>
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                       className="w-full border rounded px-2 py-1.5 text-sm font-mono-num"
                       data-testid="coa-loan-start" />
              </div>
            </div>
            <div className="text-[10px] text-slate-500">
              We'll add this to the Loans register so the amortization schedule tracks alongside the CoA balance.
            </div>
          </div>
        )}

        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">
            Sub-account of (optional)
          </label>
          <select
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            className="w-full border rounded px-3 py-2 text-sm bg-white"
            data-testid="coa-create-parent"
          >
            <option value="">— None (top-level account) —</option>
            {eligibleParents.map(par => (
              <option key={par.id} value={par.id}>
                {par.code} · {par.name}
              </option>
            ))}
          </select>
          {eligibleParents.length === 0 && (
            <div className="text-[10px] text-slate-500 mt-1">
              No top-level {type} accounts yet — this will be a top-level account.
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <button
            data-testid={TID.saveBtn}
            onClick={save}
            disabled={!name.trim() || !detailType}
            className="flex-1 py-2 rounded-md bg-slate-900 text-white text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >Save</button>
          <button data-testid={TID.cancelBtn} onClick={onClose} className="flex-1 py-2 rounded-md border text-sm">Cancel</button>
        </div>
      </div>
    </div>
  );
}


/**
 * ImportAccountsModal — bulk-import chart-of-accounts rows from Excel,
 * CSV, or PDF. Same 3-step flow (upload → review → done) as the
 * Contacts importer with a column-mapping bar and undo-able history.
 */
function ImportAccountsModal({ currentId, onClose }) {
  const [step, setStep] = useState("upload");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState({});
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [result, setResult] = useState(null);
  const [batches, setBatches] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [groupBySection, setGroupBySection] = useState(false);
  const inputRef = React.useRef(null);
  const lastFileRef = React.useRef(null);

  // Where each row will land in the Chart of Accounts after commit.
  // Returns `{key, label}` OR null if we can't confidently classify —
  // in which case the row will end up in the type's default "Other"
  // bucket and we surface an amber warning so the user can fix it now
  // instead of hunting for the misplaced account later.
  const sectionFor = React.useCallback((row) => {
    const t = (row?.type || "expense").toLowerCase();
    const sections = DETAIL_SECTIONS_BY_TYPE[t] || DETAIL_SECTIONS_BY_TYPE.expense;
    if (!sections.length) return null;
    const wanted = (row?.detail_type || row?.subtype || "").trim().toLowerCase();
    if (wanted) {
      const hit = sections.find(([k]) => k === wanted);
      if (hit) return { key: hit[0], label: hit[1] };
    }
    // Fall back to first section (renderer's default bucket).
    return { key: sections[0][0], label: sections[0][1], fallback: true };
  }, []);

  // Rollup for the "Group by section" mode + summary banner: how many
  // rows will end up in each section, so a user importing 200 accounts
  // can spot at a glance that 47 are landing in "Other" and something
  // is wrong with their sheet.
  const sectionRollup = React.useMemo(() => {
    const bucket = {};
    rows.forEach((row, i) => {
      const s = sectionFor(row);
      if (!s) return;
      const key = `${row.type}::${s.key}`;
      if (!bucket[key]) {
        bucket[key] = {
          type: row.type, sectionKey: s.key,
          sectionLabel: s.label, fallback: !!s.fallback,
          indices: [],
        };
      }
      bucket[key].indices.push(i);
    });
    return Object.values(bucket).sort((a, b) => {
      if (a.type !== b.type) return TYPES.indexOf(a.type) - TYPES.indexOf(b.type);
      return a.sectionLabel.localeCompare(b.sectionLabel);
    });
  }, [rows, sectionFor]);

  const fallbackCount = React.useMemo(() =>
    rows.filter(r => (sectionFor(r) || {}).fallback).length,
    [rows, sectionFor]);

  const loadHistory = async () => {
    try {
      const r = await api.get(`/companies/${currentId}/accounts/imports?limit=10`);
      setBatches(r.data?.batches || []);
    } catch { /* advisory */ }
  };
  useEffect(() => { loadHistory(); }, [currentId]);

  const upload = async (file, opts = {}) => {
    if (!file) return;
    lastFileRef.current = file;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (opts.ai) fd.append("ai", "true");
      const r = await api.post(`/companies/${currentId}/accounts/import/preview`, fd,
        { headers: { "Content-Type": "multipart/form-data" } });
      const d = r.data;
      setPreview(d);
      setMapping(d.auto_mapping || {});
      setRows(d.accounts || []);
      setSelected(new Set((d.accounts || []).map((_, i) => i)));
      setStep("review");
      if (opts.ai) toast.success(`AI parsed ${d.accounts?.length || 0} account${d.accounts?.length === 1 ? "" : "s"}.`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't parse the file");
    } finally { setBusy(false); }
  };

  const remap = async (nextMapping) => {
    if (!preview) return;
    setMapping(nextMapping);
    setBusy(true);
    try {
      const r = await api.post(`/companies/${currentId}/accounts/import/remap`, {
        headers: preview.detected_headers,
        raw_rows: preview.raw_rows,
        mapping: nextMapping,
      });
      setRows(r.data?.accounts || []);
      setSelected(new Set((r.data?.accounts || []).map((_, i) => i)));
    } catch (e) {
      toast.error(e.response?.data?.detail || "Remap failed");
    } finally { setBusy(false); }
  };

  const editRow = (i, field, value) => setRows(rs => rs.map((r, idx) => idx === i ? { ...r, [field]: value } : r));
  const toggleRow = (i) => setSelected(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });
  const toggleAll = () => setSelected(prev => prev.size === rows.length ? new Set() : new Set(rows.map((_, i) => i)));

  const commit = async () => {
    const payload = rows.filter((_, i) => selected.has(i));
    if (!payload.length) { toast.error("Nothing selected."); return; }
    setBusy(true);
    try {
      const r = await api.post(`/companies/${currentId}/accounts/import/commit`, {
        accounts: payload, filename: preview?.filename, source: preview?.source,
      });
      setResult(r.data);
      setStep("done");
      loadHistory();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Import failed");
    } finally { setBusy(false); }
  };

  const undoBatch = async (batchId) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm("Undo this import? Accounts it created will be deleted (unless they already have journal-entry activity) and any updated rows will be restored.")) return;
    try {
      const r = await api.post(`/companies/${currentId}/accounts/imports/${batchId}/undo`);
      toast.success(`Undo complete — deleted ${r.data?.deleted || 0}, restored ${r.data?.restored || 0}.`);
      loadHistory();
      onClose(true);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Undo failed");
    }
  };

  // Detect whether the CPA's file lacks a real Type column — either
  // the mapping never included one, or every row defaulted to
  // "expense" (a strong signal the column is missing / miscategorized).
  const typeColMapped = Object.values(mapping).includes("type");
  const allDefaulted = rows.length > 0 && rows.every(r => r.type === "expense");
  const showAiClassify = rows.length > 0 && (!typeColMapped || allDefaulted);
  // Track which rows just got AI-classified so we can flash a badge.
  const [aiTouched, setAiTouched] = useState(new Set());

  const runAiClassify = async () => {
    const names = rows.map(r => r.name).filter(Boolean);
    if (!names.length) return;
    setBusy(true);
    try {
      const r = await api.post(
        `/companies/${currentId}/accounts/import/ai-classify-types`,
        { names },
      );
      const map = r.data?.classified || {};
      const touched = new Set();
      setRows(rs => rs.map((row, idx) => {
        const hit = map[row.name];
        if (!hit) return row;
        touched.add(idx);
        return { ...row, type: hit.type, subtype: hit.subtype || row.subtype };
      }));
      setAiTouched(touched);
      toast.success(`AI classified ${r.data?.returned || 0} of ${r.data?.requested || 0} accounts.`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "AI classify failed");
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col" data-testid="coa-import-modal">
        <div className="px-5 py-3 border-b flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-indigo-100 flex items-center justify-center shrink-0">
            <Upload size={16} className="text-indigo-700" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-heading font-semibold">Import chart of accounts</h3>
            <p className="text-xs text-slate-500">Bulk-add or update accounts from Excel, CSV, or PDF. Codes, types, subtypes, and parent links supported.</p>
          </div>
          <button onClick={() => onClose(false)} className="p-1 rounded hover:bg-slate-100"><X size={16} /></button>
        </div>

        {step === "upload" && (
          <div className="p-5 space-y-4">
            <ImportDropZone busy={busy} onFile={(f) => upload(f)} inputRef={inputRef} label="Drop an Excel / CSV / PDF here" hint="Auto-detects Code, Name, Type, Subtype, Parent Code." />
            <div className="text-[11px] text-slate-500 bg-slate-50 border rounded p-3">
              <b>Columns we recognize:</b> Code · Name · Type (Asset / Liability / Equity / Revenue / COGS / Expense — plurals auto-collapse) · Subtype (Current Asset, Long-Term Liability, Operating Expense, …) · Parent Code (links to another row by its code — same-type only). Rows with a blank code get the next available number in the GAAP range for their type.
            </div>
            {batches.length > 0 && (
              <div className="rounded-lg border bg-white">
                <button onClick={() => setHistoryOpen(o => !o)} className="w-full px-4 py-2 flex items-center gap-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
                  <History size={13} className="text-slate-500" />
                  Import history ({batches.length})
                  <span className="ml-auto text-slate-400">{historyOpen ? "▼" : "▶"}</span>
                </button>
                {historyOpen && (
                  <ul className="divide-y">
                    {batches.map(b => (
                      <li key={b.id} className="px-4 py-2.5 flex items-center gap-3 text-xs">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate text-slate-800">
                            {b.filename}
                            <span className="text-[10px] ml-2 text-slate-400 uppercase">{b.source}</span>
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {new Date(b.at).toLocaleString()} · {b.user_name} · created <b>{b.created_count}</b>, updated <b>{b.updated_count}</b>
                            {b.skipped_count ? <>, skipped <b>{b.skipped_count}</b></> : ""}
                          </div>
                        </div>
                        {b.undone ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 border border-slate-200 uppercase tracking-wide">Undone</span>
                        ) : (
                          <button onClick={() => undoBatch(b.id)} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-rose-200 text-rose-700 hover:bg-rose-50">
                            <Undo2 size={11} /> Undo
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        {step === "review" && preview && (
          <>
            <div className="px-5 py-2 border-b bg-slate-50/40 flex items-center gap-3 text-xs">
              <span className="text-slate-700">
                <b>{preview.filename}</b> · {rows.length} account{rows.length !== 1 ? "s" : ""} parsed
                {preview.source === "pdf-ai" && (
                  <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-fuchsia-50 text-fuchsia-700 border border-fuchsia-200 uppercase tracking-wide">AI parsed</span>
                )}
              </span>
              {preview.source === "pdf" && lastFileRef.current && (
                <button onClick={() => upload(lastFileRef.current, { ai: true })} disabled={busy}
                        className="text-fuchsia-700 hover:bg-fuchsia-50 border border-fuchsia-200 rounded px-2 py-1 text-[11px] inline-flex items-center gap-1 disabled:opacity-50">
                  {busy ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                  Try AI parsing
                </button>
              )}
              {showAiClassify && (
                <button
                  onClick={runAiClassify}
                  disabled={busy}
                  className="text-fuchsia-700 hover:bg-fuchsia-50 border border-fuchsia-200 rounded px-2 py-1 text-[11px] inline-flex items-center gap-1 disabled:opacity-50"
                  data-testid="coa-import-ai-classify"
                  title="Ask GPT to classify every row's type + subtype from its name"
                >
                  {busy ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                  Detect types with AI
                </button>
              )}
              <button onClick={() => { setStep("upload"); setPreview(null); setRows([]); }} className="ml-auto text-slate-500 hover:text-slate-900 inline-flex items-center gap-1">
                <ArrowLeft size={12} /> Choose different file
              </button>
            </div>

            {preview.detected_headers?.length > 0 && (
              <div className="px-5 py-3 border-b bg-white">
                <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-2">Column mapping · edit if any field auto-detected wrong</div>
                <div className="flex flex-wrap gap-2">
                  {preview.detected_headers.map((h, colIdx) => {
                    const current = mapping[String(colIdx)] || "";
                    const known = preview.known_fields || ["code", "name", "type", "subtype", "parent_code"];
                    const claimed = new Set(Object.entries(mapping).filter(([k]) => Number(k) !== colIdx).map(([, v]) => v).filter(Boolean));
                    return (
                      <div key={colIdx} className="flex flex-col gap-0.5">
                        <div className="text-[10px] text-slate-500 uppercase tracking-wide truncate max-w-[140px]" title={h}>{h || `Column ${colIdx + 1}`}</div>
                        <select
                          value={current}
                          onChange={(e) => { const next = { ...mapping }; next[String(colIdx)] = e.target.value; remap(next); }}
                          className={`border rounded px-2 py-1 text-xs bg-white ${current ? "" : "text-slate-400"}`}
                        >
                          <option value="">— Skip —</option>
                          {known.map(f => (
                            <option key={f} value={f} disabled={claimed.has(f) && current !== f}>
                              {f === "parent_code" ? "Parent code" : f.charAt(0).toUpperCase() + f.slice(1)}
                              {claimed.has(f) && current !== f ? " (used)" : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex-1 overflow-auto">
              {rows.length > 0 && (
                <div
                  className="sticky top-0 z-10 bg-white/95 backdrop-blur px-5 py-2 border-b border-slate-100 flex items-center gap-3 flex-wrap"
                  data-testid="import-section-summary"
                >
                  <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">
                    Section preview
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {sectionRollup.map((s) => (
                      <span
                        key={`${s.type}-${s.sectionKey}`}
                        className={`text-[10px] px-2 py-0.5 rounded-full border ${
                          s.fallback
                            ? "bg-amber-50 text-amber-800 border-amber-200"
                            : "bg-slate-100 text-slate-700 border-slate-200"
                        }`}
                        title={s.fallback
                          ? "No matching sub-type — accounts will land in this default bucket. Fix the sub-type below to move them."
                          : `${s.indices.length} account${s.indices.length === 1 ? "" : "s"} will land under ${s.sectionLabel}`}
                      >
                        {s.sectionLabel} · {s.indices.length}
                      </span>
                    ))}
                  </div>
                  {fallbackCount > 0 && (
                    <span
                      className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-0.5 inline-flex items-center gap-1"
                      data-testid="import-fallback-warning"
                    >
                      ⚠ {fallbackCount} row{fallbackCount === 1 ? "" : "s"} in a default bucket — fix sub-type to reclassify
                    </span>
                  )}
                  <label className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-slate-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={groupBySection}
                      onChange={(e) => setGroupBySection(e.target.checked)}
                      data-testid="import-group-by-section"
                    />
                    Group by section
                  </label>
                </div>
              )}
              {!rows.length ? (
                <div className="p-8 text-center text-slate-500 text-sm">No accounts extracted.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500 border-b sticky top-0">
                    <tr>
                      <th className="w-8 px-3 py-2">
                        <input type="checkbox" checked={selected.size === rows.length && rows.length > 0} onChange={toggleAll} />
                      </th>
                      <th className="px-3 py-2 text-left w-20">Code</th>
                      <th className="px-3 py-2 text-left">Name</th>
                      <th className="px-3 py-2 text-left">Type</th>
                      <th className="px-3 py-2 text-left">Subtype</th>
                      <th className="px-3 py-2 text-left w-20">Parent</th>
                      <th className="px-3 py-2 text-left">Will land under</th>
                      <th className="px-3 py-2 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(groupBySection ? sectionRollup.flatMap(s => [
                      { __header: true, section: s },
                      ...s.indices.map(i => ({ __row: true, i })),
                    ]) : rows.map((_, i) => ({ __row: true, i }))).map((entry, k) => {
                      if (entry.__header) {
                        const s = entry.section;
                        return (
                          <tr key={`h-${s.type}-${s.sectionKey}`} className="bg-slate-50/70">
                            <td colSpan={8} className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-600">
                              {prettyLabel(s.type)} · {s.sectionLabel}
                              {s.fallback && <span className="ml-2 text-amber-700 normal-case font-normal">(default bucket — set sub-type to move)</span>}
                              <span className="ml-1 text-slate-400 normal-case font-normal">· {s.indices.length}</span>
                            </td>
                          </tr>
                        );
                      }
                      const i = entry.i;
                      const a = rows[i];
                      const sec = sectionFor(a);
                      return (
                      <tr key={i} className={`border-b border-slate-100 ${selected.has(i) ? "" : "opacity-40"}`}>
                        <td className="px-3 py-1.5">
                          <input type="checkbox" checked={selected.has(i)} onChange={() => toggleRow(i)} />
                        </td>
                        <td className="px-3 py-1.5">
                          <input value={a.code || ""} onChange={(e) => editRow(i, "code", e.target.value)} className="w-full bg-transparent border-0 focus:outline-none focus:border-b focus:border-slate-400 px-0 font-mono-num text-[13px]" placeholder="auto" />
                        </td>
                        <td className="px-3 py-1.5">
                          <input value={a.name} onChange={(e) => editRow(i, "name", e.target.value)} className="w-full bg-transparent border-0 focus:outline-none focus:border-b focus:border-slate-400 px-0" />
                        </td>
                        <td className="px-3 py-1.5">
                          <div className="flex items-center gap-1">
                            <select value={a.type} onChange={(e) => editRow(i, "type", e.target.value)} className="border rounded px-1.5 py-0.5 text-xs bg-white">
                              {TYPES.map(t => <option key={t} value={t}>{prettyLabel(t)}</option>)}
                            </select>
                            {aiTouched.has(i) && (
                              <span
                                className="text-[9px] px-1 py-0.5 rounded bg-fuchsia-50 text-fuchsia-700 border border-fuchsia-200 uppercase tracking-wide inline-flex items-center gap-0.5"
                                title="Classified by AI — review before importing"
                              >
                                <Sparkles size={8} /> AI
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-1.5">
                          <select
                            value={(a.subtype || "").trim()}
                            onChange={(e) => {
                              // Mirror sub-type → detail_type so the CoA
                              // preview + eventual save both use the
                              // same key — one taxonomy, one truth.
                              editRow(i, "subtype", e.target.value);
                              editRow(i, "detail_type", e.target.value);
                            }}
                            className="border rounded px-1.5 py-0.5 text-xs bg-white text-slate-700 w-full"
                            data-testid={`import-subtype-${i}`}
                          >
                            <option value="">— unset —</option>
                            {(DETAIL_SECTIONS_BY_TYPE[a.type] || DETAIL_SECTIONS_BY_TYPE.expense).map(([k, label]) => (
                              <option key={k} value={k}>{label}</option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-1.5">
                          <input value={a.parent_code || ""} onChange={(e) => editRow(i, "parent_code", e.target.value)} className="w-full bg-transparent border-0 focus:outline-none focus:border-b focus:border-slate-400 px-0 font-mono-num text-[13px]" placeholder="—" />
                        </td>
                        <td className="px-3 py-1.5">
                          {sec ? (
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded border ${
                                sec.fallback
                                  ? "bg-amber-50 text-amber-800 border-amber-200"
                                  : "bg-slate-50 text-slate-700 border-slate-200"
                              }`}
                              title={sec.fallback ? "Default bucket — pick a sub-type to move this account." : `Section: ${sec.label}`}
                              data-testid={`import-landing-${i}`}
                            >
                              {sec.label}
                            </span>
                          ) : <span className="text-slate-400 text-xs">—</span>}
                        </td>
                        <td className="px-3 py-1.5">
                          {a.existing ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 uppercase tracking-wide">Will update</span>
                          ) : (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 uppercase tracking-wide">New</span>
                          )}
                        </td>
                      </tr>
                    );})}
                  </tbody>
                </table>
              )}
            </div>

            <div className="px-5 py-3 border-t bg-slate-50/60 flex items-center gap-3">
              <span className="text-xs text-slate-600">{selected.size} of {rows.length} selected</span>
              <button onClick={() => onClose(false)} disabled={busy} className="ml-auto px-3 py-1.5 rounded-md border text-sm">Cancel</button>
              <button onClick={commit} disabled={busy || !selected.size} className="px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm inline-flex items-center gap-1.5 disabled:opacity-50">
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                Import {selected.size} account{selected.size !== 1 ? "s" : ""}
              </button>
            </div>
          </>
        )}

        {step === "done" && result && (
          <div className="p-8 text-center space-y-4">
            <div className="w-14 h-14 mx-auto rounded-full bg-emerald-100 flex items-center justify-center">
              <Check size={28} className="text-emerald-700" />
            </div>
            <div>
              <h4 className="text-lg font-semibold">Import complete</h4>
              <p className="text-sm text-slate-600 mt-1">
                Added <b>{result.created}</b>, updated <b>{result.updated}</b>
                {result.skipped ? <>, skipped <b>{result.skipped}</b></> : ""}.
              </p>
            </div>
            <button onClick={() => onClose(true)} className="px-4 py-2 rounded-md bg-slate-900 text-white text-sm">Done</button>
          </div>
        )}
      </div>
    </div>
  );
}

function ImportDropZone({ busy, onFile, inputRef, label, hint }) {
  const [over, setOver] = useState(false);
  const dragCount = React.useRef(0);
  const onDragEnter = (e) => { e.preventDefault(); e.stopPropagation(); dragCount.current += 1; if (e.dataTransfer?.types?.includes("Files")) setOver(true); };
  const onDragLeave = (e) => { e.preventDefault(); e.stopPropagation(); dragCount.current -= 1; if (dragCount.current <= 0) { dragCount.current = 0; setOver(false); } };
  const onDragOver = (e) => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; };
  const onDrop = (e) => { e.preventDefault(); e.stopPropagation(); dragCount.current = 0; setOver(false); const f = e.dataTransfer?.files?.[0]; if (f) onFile(f); };
  return (
    <div onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDragOver={onDragOver} onDrop={onDrop}
         className={`rounded-lg border-2 border-dashed transition-colors p-6 text-center ${over ? "border-indigo-500 bg-indigo-100/70" : "border-slate-300 hover:border-indigo-400 hover:bg-indigo-50/30"}`}>
      <input ref={inputRef} type="file" accept=".xlsx,.xls,.xlsm,.csv,.txt,.pdf" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
      <div className="flex items-center justify-center gap-2 text-slate-400 mb-3 pointer-events-none">
        <FileSpreadsheet size={22} /> <FileText size={22} />
      </div>
      <div className="text-sm font-medium text-slate-700 mb-1 pointer-events-none">
        {over ? "Drop to upload" : (label || "Drop an Excel / CSV / PDF here")}
      </div>
      <div className="text-xs text-slate-500 mb-3 pointer-events-none">{hint || "Auto-detects columns."}</div>
      <button onClick={() => inputRef.current?.click()} disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm disabled:opacity-50">
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
        Choose file
      </button>
    </div>
  );
}

