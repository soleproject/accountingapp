import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus, Trash2, Sparkles, Loader2, Pencil, Check, X, GitMerge, AlertTriangle, GripVertical, Eye, EyeOff } from "lucide-react";
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
const SUBTYPES_BY_TYPE = {
  asset:     ["current_asset", "fixed_asset", "other_asset", "intangible_asset", "accumulated_depreciation", "clearing"],
  liability: ["current_liability", "long_term_liability", "other_liability", "credit_card"],
  equity:    ["equity", "retained_earnings", "owner_draw", "owner_contribution"],
  revenue:   ["operating_revenue", "other_revenue", "sales_revenue", "service_revenue", "interest_income"],
  cogs:      ["cogs", "materials", "labor", "manufacturing_overhead"],
  expense:   ["operating_expense", "cost_of_sales", "payroll_expense", "rent_expense", "utilities_expense", "advertising_expense", "office_expense", "professional_fees", "tax_expense", "interest_expense", "depreciation_expense", "other_expense"],
};

const subtypesFor = (t) => SUBTYPES_BY_TYPE[t] || SUBTYPES_BY_TYPE.expense;

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
  const [accts, setAccts] = useState([]);
  // Per-account balance map — {aid: {balance, rollup, mode}}.
  // Fetched lazily after the accounts land so an empty CoA renders fast.
  const [balances, setBalances] = useState({});
  // Balance-column basis toggle. "smart" (default) uses YTD for
  // rev/exp and cumulative for asset/liab/equity; other values force
  // a single lens across every account.
  const [basis, setBasis] = useState("smart");
  // Duplicate detection — groups of same-type accounts with near-
  // identical names that the Pro likely wants to merge.
  const [dupeGroups, setDupeGroups] = useState([]);
  const [dupePanelOpen, setDupePanelOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [creatingPrefill, setCreatingPrefill] = useState(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  // Merge dialog — {source, options} when set.
  const [mergeState, setMergeState] = useState(null);
  // Drag-drop reparent state — set on dragstart of a child row, cleared
  // once the drop lands (or is canceled). Just the source id, kept in
  // component state so hover targets can style themselves.
  const [dragSourceId, setDragSourceId] = useState(null);
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
  };
  useEffect(() => { load(); }, [currentId, basis]);

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
    const items = accts.filter(a => a.type === t);
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
          {/* Balance-column basis toggle — Smart auto-picks the right
              lens per account; the other three force a single view.  */}
          <div className="inline-flex text-[11px] rounded-md border overflow-hidden" data-testid="coa-basis-toggle">
            {[
              ["smart", "Smart"],
              ["month", "MTD"],
              ["ytd", "YTD"],
              ["cumulative", "All-time"],
            ].map(([k, label]) => (
              <button
                key={k}
                onClick={() => setBasis(k)}
                className={`px-2 py-1 ${basis === k ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
                data-testid={`coa-basis-${k}`}
                title={
                  k === "smart"
                    ? "YTD for revenue/expense, cumulative for asset/liability/equity"
                    : k === "month" ? "Month-to-date across every account"
                    : k === "ytd" ? "Year-to-date across every account"
                    : "All-time cumulative across every account"
                }
              >
                {label}
              </button>
            ))}
          </div>
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
                            <span className="text-[10px] text-slate-400 hidden sm:inline">· {a.subtype}</span>
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
        {grouped.map(g => (
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
              {g.items.map(a => {
                // Parents show the rolled-up balance (own + children).
                // Children show only their direct balance so the eye can
                // add them and see they equal the parent.
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
              })}
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
    </div>
  );
}

function AccountRow({ a, allAccounts, currentId, balance, showCodes = true, onSaved, onDeleted, onMerge,
                     dragSourceId, onDragStart, onDragEnd, onReparent }) {
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
        subtype: subtype.trim(),
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
            {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
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
              <option value={subtype}>{subtype} (legacy)</option>
            )}
            {subtypesFor(type).map(s => (
              <option key={s} value={s}>{s}</option>
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
      <div className={`${showCodes ? "col-span-5" : "col-span-6"} text-sm ${a._depth ? "pl-4 text-slate-700" : "font-medium"}`}>
        {a.name}
        {a.created_by_ai && a.parent_account_id && (
          <span className="ml-2 text-[10px] uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
            auto
          </span>
        )}
      </div>
      <div className="col-span-2 text-xs text-slate-500">{a.subtype}</div>
      <div
        className={`col-span-2 text-right font-mono-num text-[13px] ${balance == null || Math.abs(Number(balance)) < 0.005 ? "text-slate-300" : "text-slate-800"}`}
        data-testid={`coa-balance-${a.id}`}
        title={
          ["revenue", "expense", "cogs"].includes(a.type)
            ? "Year-to-date balance"
            : "Current cumulative balance"
        }
      >
        {fmtMoney(balance)}
      </div>
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

function CreateAccount({ currentId, prefill, allAccounts, showCodes = true, onClose }) {
  const p = prefill || {};
  const [code, setCode] = useState(p.code || "");
  const [name, setName] = useState(p.name || "");
  const [type, setType] = useState(TYPES.includes(p.type) ? p.type : "expense");
  const [subtype, setSubtype] = useState(
    p.subtype && subtypesFor(TYPES.includes(p.type) ? p.type : "expense").includes(p.subtype)
      ? p.subtype
      : subtypesFor(TYPES.includes(p.type) ? p.type : "expense")[0]
  );
  // Sub-account parent — prefilled if the caller passed one (used by
  // some AI actions that spawn nested accounts directly).
  const [parentId, setParentId] = useState(p.parent_account_id || "");

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
    await api.post(`/companies/${currentId}/accounts`, {
      code: effectiveCode, name: name.trim(), type, subtype,
      parent_account_id: parentId || null,
    });
    toast.success("Account created"); onClose();
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-3">
        <h3 className="font-heading font-semibold">New Account</h3>
        {showCodes && (
          <input placeholder="Code (e.g. 6250)" value={code} onChange={(e) => setCode(e.target.value)}
                 className="w-full border rounded px-3 py-2 text-sm font-mono-num" />
        )}
        <input placeholder="Account name" value={name} onChange={(e) => setName(e.target.value)}
               className="w-full border rounded px-3 py-2 text-sm" />
        <select
          value={type}
          onChange={(e) => {
            const nextType = e.target.value;
            setType(nextType);
            if (!subtypesFor(nextType).includes(subtype)) {
              setSubtype(subtypesFor(nextType)[0]);
            }
            // Drop the parent if the new type invalidates it — sub-accounts
            // must live under a parent of the same type.
            if (parentId) {
              const par = (allAccounts || []).find(r => r.id === parentId);
              if (!par || par.type !== nextType) setParentId("");
            }
          }}
          className="w-full border rounded px-3 py-2 text-sm"
        >
          {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select
          value={subtype}
          onChange={(e) => setSubtype(e.target.value)}
          className="w-full border rounded px-3 py-2 text-sm"
        >
          {subtypesFor(type).map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
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
          <button data-testid={TID.saveBtn} onClick={save} className="flex-1 py-2 rounded-md bg-slate-900 text-white text-sm">Save</button>
          <button data-testid={TID.cancelBtn} onClick={onClose} className="flex-1 py-2 rounded-md border text-sm">Cancel</button>
        </div>
      </div>
    </div>
  );
}
