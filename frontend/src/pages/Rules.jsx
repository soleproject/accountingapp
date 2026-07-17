import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Wand2, Trash2, Plus, X, Sparkles, Check, ChevronDown } from "lucide-react";
import { toast } from "sonner";

export default function Rules() {
  const { currentId } = useCompany();
  const [rules, setRules] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [accts, setAccts] = useState([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(true);

  const load = async () => {
    if (!currentId) return;
    const [r, a] = await Promise.all([
      api.get(`/companies/${currentId}/rules`),
      api.get(`/companies/${currentId}/accounts`),
    ]);
    setRules(r.data.rules || []);
    setCandidates(r.data.candidates || []);
    setAccts(a.data.accounts || []);
  };
  useEffect(() => { load(); }, [currentId]);

  const del = async (id) => {
    if (!confirm("Delete rule?")) return;
    await api.delete(`/companies/${currentId}/rules/${id}`);
    load();
  };

  const promoteCandidate = async (c) => {
    try {
      const r = await api.post(`/companies/${currentId}/rules`, {
        match_type: "merchant_contains", match_value: c.merchant,
        account_code: c.account_code, apply_to_existing: true,
      });
      toast.success(
        `Rule created: "${c.merchant}" → ${c.account_name}`
        + (r.data.applied ? ` (applied to ${r.data.applied} txn${r.data.applied === 1 ? "" : "s"})` : "")
      );
      load();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to create rule");
    }
  };

  const dismissCandidate = async (c) => {
    await api.delete(`/companies/${currentId}/rule-candidates/${c.id}`);
    toast.success(`Dismissed suggestion for "${c.merchant}"`);
    load();
  };

  const acceptAll = async () => {
    if (!candidates.length) return;
    setBusy(true);
    let ok = 0, fail = 0, applied = 0;
    for (const c of candidates) {
      try {
        const r = await api.post(`/companies/${currentId}/rules`, {
          match_type: "merchant_contains", match_value: c.merchant,
          account_code: c.account_code, apply_to_existing: true,
        });
        ok += 1;
        applied += r.data.applied || 0;
      } catch {
        fail += 1;
      }
    }
    setBusy(false);
    toast.success(
      `Accepted ${ok} rule${ok === 1 ? "" : "s"}`
      + (applied ? ` · back-filled ${applied} txn${applied === 1 ? "" : "s"}` : "")
      + (fail ? ` · ${fail} failed` : "")
    );
    load();
  };

  const totalCleanup = candidates.reduce((s, c) => s + (c.applies_to_count || 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">AI Rules</h1>
          <p className="text-slate-500 text-sm mt-1">Rules automate categorization. Auto-suggested when a merchant is approved 2+ times.</p>
        </div>
        <button data-testid={TID.addBtn} onClick={() => setCreating(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs">
          <Plus size={13} /> Create Rule
        </button>
      </div>

      {candidates.length > 0 && (
        <div className="rounded-xl border bg-indigo-50 border-indigo-200" data-testid="suggested-rules">
          <button
            onClick={() => setExpanded(v => !v)}
            className="w-full px-4 py-3 flex items-center gap-2 text-left"
            data-testid="suggested-rules-toggle"
          >
            <Sparkles size={14} className="text-indigo-600" />
            <h3 className="font-heading font-semibold text-sm">
              AI suggests {candidates.length} new rule{candidates.length === 1 ? "" : "s"}
            </h3>
            {totalCleanup > 0 && (
              <span className="text-[11px] text-indigo-700 bg-indigo-100 px-1.5 py-0.5 rounded">
                would clean up {totalCleanup} un-reviewed txn{totalCleanup === 1 ? "" : "s"}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              {candidates.length > 1 && (
                <button
                  onClick={(e) => { e.stopPropagation(); acceptAll(); }}
                  disabled={busy}
                  data-testid="suggested-rules-accept-all"
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  <Check size={12} /> Accept all
                </button>
              )}
              <ChevronDown
                size={16}
                className={`text-indigo-600 transition-transform ${expanded ? "" : "-rotate-90"}`}
              />
            </div>
          </button>

          {expanded && (
            <div className="px-4 pb-4 space-y-2">
              {candidates.map(c => (
                <div
                  key={c.id}
                  className="flex items-center gap-3 bg-white rounded-md px-3 py-2 border"
                  data-testid={`suggested-rule-${c.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">
                      When merchant contains <b>{c.merchant}</b> → <b className="tabular-nums">{c.account_code}</b> {c.account_name}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      approved {c.approvals}×
                      {(c.applies_to_count ?? 0) > 0 && (
                        <> · would back-fill <b className="text-indigo-700">{c.applies_to_count}</b> un-reviewed txn{c.applies_to_count === 1 ? "" : "s"}</>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => promoteCandidate(c)}
                    data-testid={`suggested-rule-accept-${c.id}`}
                    className="text-xs px-2.5 py-1 rounded-md bg-slate-900 text-white hover:bg-slate-800"
                  >
                    Create rule
                  </button>
                  <button
                    onClick={() => dismissCandidate(c)}
                    data-testid={`suggested-rule-dismiss-${c.id}`}
                    className="text-xs p-1 text-slate-500 hover:text-rose-600"
                    title="Dismiss"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="rounded-xl border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
            <tr>
              <th className="px-3 py-2 text-left">Match</th>
              <th className="px-3 py-2 text-left">Category</th>
              <th className="px-3 py-2 text-left">Source</th>
              <th className="px-3 py-2 text-right">Applied</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rules.map(r => (
              <tr key={r.id} className="border-b hover:bg-slate-50">
                <td className="px-3 py-2">
                  <span className="text-xs text-slate-500">{r.match_type}</span> · <b>{r.match_value}</b>
                </td>
                <td className="px-3 py-2 font-mono-num">{r.account_code} <span className="text-slate-600 font-sans">{r.account_name}</span></td>
                <td className="px-3 py-2">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${r.created_by === "ai" ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-600"}`}>
                    {r.created_by === "ai" ? <><Wand2 size={9} className="inline mr-1" />AI</> : "Human"}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono-num">{r.hits}</td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => del(r.id)} className="text-red-500 p-1"><Trash2 size={13} /></button>
                </td>
              </tr>
            ))}
            {!rules.length && <tr><td colSpan={5} className="text-center py-8 text-slate-500">No rules yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {creating && <CreateRule currentId={currentId} accts={accts} onClose={() => { setCreating(false); load(); }} />}
    </div>
  );
}

function CreateRule({ currentId, accts, onClose }) {
  const [match, setMatch] = useState("");
  const [code, setCode] = useState("");
  const [applyExisting, setApplyExisting] = useState(true);
  const save = async () => {
    const r = await api.post(`/companies/${currentId}/rules`, {
      match_type: "merchant_contains", match_value: match, account_code: code, apply_to_existing: applyExisting,
    });
    toast.success(`Rule created · applied to ${r.data.applied} existing`);
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold">Create Rule</h3>
          <button onClick={onClose}><X size={16} /></button>
        </div>
        <input placeholder="Merchant contains (e.g. Uber)" value={match} onChange={(e) => setMatch(e.target.value)}
               className="w-full border rounded px-3 py-2 text-sm" />
        <select value={code} onChange={(e) => setCode(e.target.value)} className="w-full border rounded px-3 py-2 text-sm">
          <option value="">Category…</option>
          {accts.map(a => <option key={a.id} value={a.code}>{a.code} {a.name}</option>)}
        </select>
        <label className="text-xs flex items-center gap-2">
          <input type="checkbox" checked={applyExisting} onChange={(e) => setApplyExisting(e.target.checked)} />
          Apply to existing unreviewed transactions
        </label>
        <button data-testid={TID.saveBtn} onClick={save} disabled={!match || !code}
                className="w-full py-2 rounded-md bg-slate-900 text-white text-sm disabled:opacity-50">Save rule</button>
      </div>
    </div>
  );
}
