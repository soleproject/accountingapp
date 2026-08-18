/**
 * ReorderAlertsTile — Dashboard tile listing every inventory-tracked
 * item at or below its low-stock threshold. Renders **nothing** when
 * no alerts are open, so the dashboard stays clean for anyone who
 * isn't running inventory yet.
 *
 * One-click **Draft PO** button spawns a new Bill pre-populated with
 * the item + suggested reorder quantity and takes the user straight
 * to the Bill editor.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { AlertTriangle, PackageMinus, ShoppingCart, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { useMoneyFmt } from "@/lib/company";
export default function ReorderAlertsTile({ currentId }) {
  const fmtMoney = useMoneyFmt();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [drafting, setDrafting] = useState(null);
  const navigate = useNavigate();

  const load = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const r = await api.get(`/companies/${currentId}/inventory-management/reorder-alerts`);
      setRows(r.data.rows || []);
    } catch {
      // Silent — reorder alerts are informational; a stale tile is OK.
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [currentId]);

  const draftPo = async (row) => {
    setDrafting(row.item_id);
    try {
      const issue = new Date().toISOString().slice(0, 10);
      const due = new Date(Date.now() + 15 * 86400 * 1000).toISOString().slice(0, 10);
      const qty = Math.max(1, Number(row.suggested_reorder) || 1);
      const rate = Number(row.cost_basis) || 0;
      const r = await api.post(`/companies/${currentId}/bills`, {
        issue_date: issue,
        due_date: due,
        status: "draft",
        line_items: [{
          item_id: row.item_id,
          item_name: row.name,
          description: row.name,
          quantity: qty,
          rate,
          amount: Number((qty * rate).toFixed(2)),
          expense_account_id: row.expense_account_id || null,
          expense_account_name: row.expense_account_name || "",
        }],
      });
      toast.success(`Draft PO created for ${row.name}`);
      navigate(`/bills/${r.data.id}/edit`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not draft PO");
    } finally { setDrafting(null); }
  };

  // Hide the tile entirely when there's nothing to reorder — keeps the
  // dashboard uncluttered for non-inventory clients.
  if (loading || !rows.length) return null;

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 overflow-hidden shadow-sm" data-testid="reorder-alerts-tile">
      <div className="px-4 py-2.5 border-b border-amber-200 bg-amber-100/70 flex items-center gap-2">
        <AlertTriangle size={16} className="text-amber-700" />
        <div className="font-heading font-semibold text-amber-900 text-sm">
          Reorder alerts
        </div>
        <span className="text-[11px] font-mono-num text-amber-800 bg-amber-200/60 px-1.5 py-0.5 rounded">
          {rows.length}
        </span>
        <div className="ml-auto text-[11px] text-amber-800/80">
          {rows.length === 1 ? "1 item is at or below its low-stock threshold" : `${rows.length} items are at or below their low-stock threshold`}
        </div>
      </div>
      <div className="divide-y divide-amber-100">
        {rows.slice(0, 6).map(r => (
          <div key={r.item_id} className="flex items-center gap-3 px-4 py-2 text-sm" data-testid={`reorder-row-${r.item_id}`}>
            <PackageMinus size={14} className="text-amber-700 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-slate-800 truncate">{r.name}</div>
              <div className="text-[11px] text-slate-500 font-mono-num">
                On hand <b className={r.qoh <= 0 ? "text-rose-600" : "text-amber-700"}>{r.qoh}</b>
                <span className="mx-1.5 text-slate-300">·</span>
                Threshold {r.threshold}
                {r.cost_basis > 0 && (
                  <>
                    <span className="mx-1.5 text-slate-300">·</span>
                    Avg cost {fmtMoney(r.cost_basis)}
                  </>
                )}
              </div>
            </div>
            <div className="text-[11px] text-slate-500 text-right whitespace-nowrap">
              Suggested reorder
              <div className="font-mono-num font-semibold text-slate-800">{r.suggested_reorder}</div>
            </div>
            <button
              onClick={() => draftPo(r)}
              disabled={drafting === r.item_id}
              data-testid={`reorder-draft-po-${r.item_id}`}
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-60"
            >
              {drafting === r.item_id
                ? <Loader2 size={12} className="animate-spin" />
                : <ShoppingCart size={12} />}
              Draft PO
            </button>
          </div>
        ))}
        {rows.length > 6 && (
          <a href="/inventory-management"
             className="block px-4 py-2 text-[11px] text-amber-800 hover:bg-amber-100/60 text-center">
            +{rows.length - 6} more · view all in Inventory →
          </a>
        )}
      </div>
    </div>
  );
}
