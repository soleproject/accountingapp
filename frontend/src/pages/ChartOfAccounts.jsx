import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus, Trash2, Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";

const TYPES = ["asset", "liability", "equity", "revenue", "cogs", "expense"];

export default function ChartOfAccounts() {
  const { currentId } = useCompany();
  const [accts, setAccts] = useState([]);
  const [creating, setCreating] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const load = async () => {
    if (!currentId) return;
    const r = await api.get(`/companies/${currentId}/accounts`);
    setAccts(r.data.accounts || []);
  };
  useEffect(() => { load(); }, [currentId]);

  const del = async (id) => {
    if (!confirm("Delete account?")) return;
    await api.delete(`/companies/${currentId}/accounts/${id}`);
    load();
  };

  const grouped = TYPES.map(t => ({ type: t, items: accts.filter(a => a.type === t) }));

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
                <div key={a.id} className="grid grid-cols-12 gap-3 px-4 py-2 border-b border-slate-100 items-center hover:bg-slate-50">
                  <div className="col-span-2 font-mono-num text-slate-500 text-sm">{a.code}</div>
                  <div className="col-span-7 text-sm">{a.name}</div>
                  <div className="col-span-2 text-xs text-slate-500">{a.subtype}</div>
                  <div className="col-span-1 text-right">
                    <button onClick={() => del(a.id)} className="text-red-500 hover:bg-red-50 rounded p-1"
                            data-testid={TID.deleteBtn}><Trash2 size={13} /></button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {creating && <CreateAccount currentId={currentId} onClose={() => { setCreating(false); load(); }} />}
      {suggestOpen && (
        <SuggestCoAModal
          currentId={currentId}
          onClose={(reload) => { setSuggestOpen(false); if (reload) load(); }}
        />
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

function CreateAccount({ currentId, onClose }) {
  const [code, setCode] = useState(""); const [name, setName] = useState("");
  const [type, setType] = useState("expense"); const [subtype, setSubtype] = useState("operating_expense");
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
        <select value={type} onChange={(e) => setType(e.target.value)} className="w-full border rounded px-3 py-2 text-sm">
          {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <input placeholder="Subtype" value={subtype} onChange={(e) => setSubtype(e.target.value)}
               className="w-full border rounded px-3 py-2 text-sm" />
        <div className="flex gap-2">
          <button data-testid={TID.saveBtn} onClick={save} className="flex-1 py-2 rounded-md bg-slate-900 text-white text-sm">Save</button>
          <button data-testid={TID.cancelBtn} onClick={onClose} className="flex-1 py-2 rounded-md border text-sm">Cancel</button>
        </div>
      </div>
    </div>
  );
}
