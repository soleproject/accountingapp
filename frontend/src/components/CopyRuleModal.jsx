import { useEffect, useState } from "react";
import { X, Loader2, Copy, Check, AlertTriangle } from "lucide-react";
import { api } from "@/lib/api";

/**
 * Cross-company rule copy — Tier-3 Rules feature (Mar 2026).
 * Accountants managing many clients pick target companies from a
 * checkbox list and the backend clones the rule against each target's
 * CoA. Missing accounts on a target surface as `skipped` reasons in
 * the response so the user knows why some copies didn't land.
 */
export default function CopyRuleModal({ rule, sourceCid, onClose }) {
  const [companies, setCompanies] = useState([]);
  const [picked, setPicked] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.get(`/companies`);
        const list = (r.data?.companies || r.data || [])
          .filter((c) => c.id && c.id !== sourceCid);
        if (alive) setCompanies(list);
      } catch { /* silent */ }
    })();
    return () => { alive = false; };
  }, [sourceCid]);

  const toggle = (id) => setPicked((prev) => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  const run = async () => {
    if (!picked.size || busy) return;
    setBusy(true);
    try {
      const r = await api.post(
        `/companies/${sourceCid}/rules/${rule.id}/copy-to`,
        { target_company_ids: [...picked] },
      );
      setResult(r.data);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md flex flex-col max-h-[80vh]">
        <div className="px-5 py-4 border-b flex items-start gap-3">
          <div className="rounded-full bg-indigo-100 p-1.5">
            <Copy size={14} className="text-indigo-700" />
          </div>
          <div className="flex-1">
            <h3 className="font-heading font-semibold">
              Copy rule to other companies
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              "{rule.match_value}" → {rule.account_name}
            </p>
          </div>
          <button onClick={onClose} data-testid="copy-rule-close">
            <X size={16} />
          </button>
        </div>

        {result ? (
          <div className="p-5 space-y-3 overflow-y-auto">
            <div className="text-sm font-medium text-emerald-700 flex items-center gap-2">
              <Check size={14} /> Copied to {result.copied} companies
            </div>
            {result.skipped?.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-amber-700 flex items-center gap-1 mb-1">
                  <AlertTriangle size={12} /> Skipped ({result.skipped.length})
                </div>
                <ul className="text-xs text-slate-600 space-y-1">
                  {result.skipped.map((s, i) => (
                    <li key={i} className="font-mono">
                      {companies.find(c => c.id === s.cid)?.name || s.cid}
                      <span className="text-slate-400"> · {s.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <button
              onClick={onClose}
              className="w-full py-2 rounded-md bg-slate-900 text-white text-sm"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="overflow-y-auto flex-1 divide-y">
              {companies.length === 0 ? (
                <div className="py-8 text-center text-sm text-slate-500">
                  No other companies available.
                </div>
              ) : companies.map(c => (
                <label
                  key={c.id}
                  className="flex items-center gap-2 px-5 py-2.5 hover:bg-slate-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={picked.has(c.id)}
                    onChange={() => toggle(c.id)}
                    data-testid={`copy-rule-target-${c.id}`}
                  />
                  <span className="flex-1 text-sm">{c.name}</span>
                </label>
              ))}
            </div>
            <div className="px-5 py-3 border-t flex items-center justify-end gap-2">
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-sm rounded-md border hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={run}
                disabled={busy || !picked.size}
                data-testid="copy-rule-apply"
                className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white rounded-md bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60"
              >
                {busy && <Loader2 size={13} className="animate-spin" />}
                Copy to {picked.size || 0}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
