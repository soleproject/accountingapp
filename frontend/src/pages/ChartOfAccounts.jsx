import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus, Trash2, Sparkles, Loader2, Pencil, Check, X } from "lucide-react";
import { toast } from "sonner";
import { useCreateListener, useActionListener } from "@/lib/createBus";

const TYPES = ["asset", "liability", "equity", "revenue", "cogs", "expense"];

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

export default function ChartOfAccounts() {
  const { currentId } = useCompany();
  const [accts, setAccts] = useState([]);
  const [creating, setCreating] = useState(false);
  const [creatingPrefill, setCreatingPrefill] = useState(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const load = async () => {
    if (!currentId) return;
    const r = await api.get(`/companies/${currentId}/accounts`);
    setAccts(r.data.accounts || []);
  };
  useEffect(() => { load(); }, [currentId]);
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
  const grouped = TYPES.map(t => {
    const items = accts.filter(a => a.type === t);
    // Sort: top-level by code, then each parent's kids by code right after it.
    const byId = Object.fromEntries(items.map(a => [a.id, a]));
    const topLevel = items.filter(a => !a.parent_account_id || !byId[a.parent_account_id]);
    topLevel.sort((x, y) => String(x.code).localeCompare(String(y.code)));
    const ordered = [];
    for (const p of topLevel) {
      ordered.push({ ...p, _depth: 0 });
      const kids = items.filter(a => a.parent_account_id === p.id);
      kids.sort((x, y) => String(x.code).localeCompare(String(y.code)));
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
      <div className="space-y-4">
        {grouped.map(g => (
          <div key={g.type} className="rounded-xl border bg-white overflow-hidden">
            <div className="px-4 py-2 bg-slate-50 border-b text-xs uppercase tracking-widest text-slate-600 font-semibold">
              {g.type}s · {g.items.length}
            </div>
            <div>
              {g.items.map(a => (
                <AccountRow
                  key={a.id}
                  a={a}
                  currentId={currentId}
                  onSaved={load}
                  onDeleted={load}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      {creating && <CreateAccount currentId={currentId} prefill={creatingPrefill}
                                    onClose={() => { setCreating(false); setCreatingPrefill(null); load(); }} />}
      {suggestOpen && (
        <SuggestCoAModal
          currentId={currentId}
          onClose={(reload) => { setSuggestOpen(false); if (reload) load(); }}
        />
      )}
    </div>
  );
}

function AccountRow({ a, currentId, onSaved, onDeleted }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState(a.code);
  const [name, setName] = useState(a.name);
  const [type, setType] = useState(a.type);
  const [subtype, setSubtype] = useState(a.subtype || "");

  // Re-sync the local edit buffer if the row's props change under us
  // (e.g. after a bulk reload). Doesn't trip while the user is editing.
  useEffect(() => {
    if (!editing) {
      setCode(a.code);
      setName(a.name);
      setType(a.type);
      setSubtype(a.subtype || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.code, a.name, a.type, a.subtype]);

  const startEdit = () => setEditing(true);
  const cancel = () => {
    setCode(a.code);
    setName(a.name);
    setType(a.type);
    setSubtype(a.subtype || "");
    setEditing(false);
  };

  const save = async () => {
    const trimmedCode = String(code).trim();
    const trimmedName = name.trim();
    if (!trimmedCode) { toast.error("Code is required."); return; }
    if (!trimmedName) { toast.error("Name is required."); return; }
    if (!TYPES.includes(type)) { toast.error("Invalid type."); return; }
    // No-op guard — nothing changed.
    if (
      trimmedCode === String(a.code) &&
      trimmedName === a.name &&
      type === a.type &&
      subtype.trim() === (a.subtype || "")
    ) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await api.patch(`/companies/${currentId}/accounts/${a.id}`, {
        code: trimmedCode,
        name: trimmedName,
        type,
        subtype: subtype.trim(),
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

  return (
    <div
      className={`grid grid-cols-12 gap-3 px-4 py-2 border-b border-slate-100 items-center hover:bg-slate-50 ${a._depth ? "bg-slate-50/40" : ""} ${editing ? "bg-indigo-50/40 ring-1 ring-inset ring-indigo-200" : ""}`}
      data-testid={a.parent_account_id ? "coa-child-row" : "coa-parent-row"}
    >
      {editing ? (
        <>
          <div className="col-span-2">
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
          <div className="col-span-5">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={onKey}
              className="w-full border rounded px-2 py-1 text-sm focus:outline-none focus:border-slate-500"
              data-testid={`coa-edit-name-${a.id}`}
              placeholder="Account name"
            />
          </div>
          <div className="col-span-2">
            <select
              value={type}
              onChange={(e) => {
                const nextType = e.target.value;
                setType(nextType);
                // Keep the existing subtype only if it's still valid under the
                // new parent type; otherwise snap to the first option so we
                // never save an orphan combo like {type: "asset", subtype: "operating_expense"}.
                if (!subtypesFor(nextType).includes(subtype)) {
                  setSubtype(subtypesFor(nextType)[0]);
                }
              }}
              className="w-full border rounded px-2 py-1 text-sm focus:outline-none focus:border-slate-500"
              data-testid={`coa-edit-type-${a.id}`}
            >
              {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="col-span-2">
            <select
              value={subtypesFor(type).includes(subtype) ? subtype : ""}
              onChange={(e) => setSubtype(e.target.value)}
              className="w-full border rounded px-2 py-1 text-xs focus:outline-none focus:border-slate-500"
              data-testid={`coa-edit-subtype-${a.id}`}
            >
              {!subtypesFor(type).includes(subtype) && subtype && (
                // Legacy / hand-typed subtypes stay pickable so re-saving
                // an old row doesn't force a change the Pro didn't intend.
                <option value={subtype}>{subtype} (legacy)</option>
              )}
              {subtypesFor(type).map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="col-span-1 flex items-center justify-end gap-1">
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
        </>
      ) : (
        <>
          <div className="col-span-2 font-mono-num text-slate-500 text-sm">
            {a._depth ? <span className="opacity-40 mr-1">↳</span> : null}
            {a.code}
          </div>
          <div className={`col-span-7 text-sm ${a._depth ? "pl-4 text-slate-700" : "font-medium"}`}>
            {a.name}
            {a.created_by_ai && a.parent_account_id && (
              <span className="ml-2 text-[10px] uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
                auto
              </span>
            )}
          </div>
          <div className="col-span-2 text-xs text-slate-500">{a.subtype}</div>
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
              onClick={del}
              className="text-red-500 hover:bg-red-50 rounded p-1"
              title="Delete account"
              data-testid={TID.deleteBtn}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </>
      )}
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

function CreateAccount({ currentId, prefill, onClose }) {
  const p = prefill || {};
  const [code, setCode] = useState(p.code || "");
  const [name, setName] = useState(p.name || "");
  const [type, setType] = useState(TYPES.includes(p.type) ? p.type : "expense");
  const [subtype, setSubtype] = useState(
    p.subtype && subtypesFor(TYPES.includes(p.type) ? p.type : "expense").includes(p.subtype)
      ? p.subtype
      : subtypesFor(TYPES.includes(p.type) ? p.type : "expense")[0]
  );
  const save = async () => {
    await api.post(`/companies/${currentId}/accounts`, { code, name, type, subtype });
    toast.success("Account created"); onClose();
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-3">
        <h3 className="font-heading font-semibold">New Account</h3>
        <input placeholder="Code (e.g. 6250)" value={code} onChange={(e) => setCode(e.target.value)}
               className="w-full border rounded px-3 py-2 text-sm font-mono-num" />
        <input placeholder="Account name" value={name} onChange={(e) => setName(e.target.value)}
               className="w-full border rounded px-3 py-2 text-sm" />
        <select
          value={type}
          onChange={(e) => {
            const nextType = e.target.value;
            setType(nextType);
            // Snap subtype into the new type's valid range on every switch.
            if (!subtypesFor(nextType).includes(subtype)) {
              setSubtype(subtypesFor(nextType)[0]);
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
        <div className="flex gap-2">
          <button data-testid={TID.saveBtn} onClick={save} className="flex-1 py-2 rounded-md bg-slate-900 text-white text-sm">Save</button>
          <button data-testid={TID.cancelBtn} onClick={onClose} className="flex-1 py-2 rounded-md border text-sm">Cancel</button>
        </div>
      </div>
    </div>
  );
}
