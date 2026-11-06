import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";

export default function CategorySideRepairDialog({ companyId, account, fmtMoney, onClose, onDone }) {
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState([]);
  const [picked, setPicked] = useState(new Set());
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    api.get(`/companies/${companyId}/accounts/${account.id}/category-side-rows`)
      .then(r => {
        const g = r.data.groups || [];
        setGroups(g);
        setPicked(new Set(g.filter(x => !x.source_is_bank_like).map(x => x.bank_account_id)));
      })
      .catch(e => toast.error(e?.response?.data?.detail || "Could not load rows"))
      .finally(() => setLoading(false));
  }, [companyId, account.id]);

  const toggle = (id) => setPicked(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const total = groups.filter(g => picked.has(g.bank_account_id)).reduce((s, g) => s + g.count, 0);

  const apply = async () => {
    setApplying(true);
    try {
      const { data } = await api.post(`/companies/${companyId}/accounts/${account.id}/rehome-category-side`, {
        source_bank_account_ids: Array.from(picked),
      });
      toast.success(`Moved ${data.updated} transactions onto ${account.name}`
        + (data.recategorized ? ` · ${data.recategorized} need a category (sent to review)` : "")
        + (data.skipped_closed?.length ? ` · ${data.skipped_closed.length} skipped (closed period)` : ""));
      onDone();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Repair failed");
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="category-side-repair-dialog">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <div className="text-sm font-semibold text-slate-800">Fix rows categorized to {account.name}</div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="Close" data-testid="category-side-repair-close"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 text-xs text-slate-600 space-y-3">
          <p>
            These transactions live on another account but are <i>categorized</i> to {account.name}. Checked groups will be moved
            onto {account.name} as their account; their category goes back to review so it can be set properly.
            Leave unchecked any group that is genuinely a payment <i>from</i> a real bank account.
          </p>
          {loading ? (
            <div className="flex items-center gap-2 text-slate-500 py-4"><Loader2 size={14} className="animate-spin" /> Loading…</div>
          ) : groups.length === 0 ? (
            <div className="py-4 text-slate-500">Nothing to fix.</div>
          ) : (
            <ul className="divide-y border rounded-md">
              {groups.map(g => (
                <li key={g.bank_account_id || "none"} className="flex items-center gap-3 px-3 py-2" data-testid={`category-side-group-${g.bank_account_id || "none"}`}>
                  <input type="checkbox" checked={picked.has(g.bank_account_id)} onChange={() => toggle(g.bank_account_id)} />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-slate-800 truncate">
                      Currently on: {g.bank_account_name}
                      {!g.exists && <span className="ml-1 text-amber-700">(missing)</span>}
                      {g.source_is_bank_like && <span className="ml-1 text-slate-400">· real bank account — check carefully</span>}
                    </div>
                    <div className="text-[11px] text-slate-500">{g.count} rows · {g.first_date} → {g.last_date} · sums to {fmtMoney(g.sum_amount)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t bg-slate-50 rounded-b-xl">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded border border-slate-300 bg-white hover:bg-slate-100" data-testid="category-side-repair-cancel">Cancel</button>
          <button
            onClick={apply}
            disabled={applying || loading || total === 0}
            className="text-xs font-medium px-3 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 inline-flex items-center gap-1.5"
            data-testid="category-side-repair-apply"
          >
            {applying && <Loader2 size={12} className="animate-spin" />} Move {total} onto {account.name}
          </button>
        </div>
      </div>
    </div>
  );
}
