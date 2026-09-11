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
import { AlertTriangle, PackageMinus, ShoppingCart, Loader2, PackagePlus, Sliders } from "lucide-react";
import { toast } from "sonner";

import { useMoneyFmt } from "@/lib/company";
import { ReceiveStockModal, AdjustmentModal } from "@/pages/InventoryPage";
export default function ReorderAlertsTile({ currentId, variant = "amber" }) {
  const fmtMoney = useMoneyFmt();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [drafting, setDrafting] = useState(null);
  const [receiveFor, setReceiveFor] = useState(null);   // full item shape
  const [adjustFor, setAdjustFor] = useState(null);
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

  // Reorder rows are a thin projection over the item — the modals need
  // the full shape (id, name, quantity_on_hand, cost_basis, inventory
  // account labels). Map here so we don't force the caller to know.
  const asItem = (row) => ({
    id: row.item_id,
    name: row.name,
    sku: row.sku || "",
    quantity_on_hand: row.qoh,
    cost_basis: row.cost_basis,
    inventory_account_id: row.expense_account_id || null,
    inventory_account_name: row.expense_account_name || "",
  });

  // Hide the tile entirely when there's nothing to reorder — keeps the
  // dashboard uncluttered for non-inventory clients.
  if (loading || !rows.length) return null;

  const slate = variant === "slate";
  const shellCls = slate
    ? "rounded-lg border border-slate-200 bg-white overflow-hidden scroll-mt-24"
    : "rounded-xl border border-amber-200 bg-amber-50/60 overflow-hidden shadow-sm scroll-mt-24";
  const headerCls = slate
    ? "px-3 py-2 border-b border-slate-200 bg-slate-50 flex items-center gap-2"
    : "px-4 py-2.5 border-b border-amber-200 bg-amber-100/70 flex items-center gap-2";
  const iconCls = slate ? "text-slate-600" : "text-amber-700";
  const titleCls = slate ? "font-semibold text-slate-800 text-sm" : "font-heading font-semibold text-amber-900 text-sm";
  const pillCls = slate
    ? "text-[11px] font-mono-num text-slate-700 bg-slate-200 px-1.5 py-0.5 rounded"
    : "text-[11px] font-mono-num text-amber-800 bg-amber-200/60 px-1.5 py-0.5 rounded";
  const hintCls = slate ? "ml-auto text-[11px] text-slate-500" : "ml-auto text-[11px] text-amber-800/80";
  const divideCls = slate ? "divide-y divide-slate-100" : "divide-y divide-amber-100";
  const rowIconCls = slate ? "text-slate-500 shrink-0" : "text-amber-700 shrink-0";
  const qohHighlight = slate ? "text-slate-800" : "text-amber-700";

  return (
    <div id="reorder-alerts" className={shellCls} data-testid="reorder-alerts-tile">
      <div className={headerCls}>
        <AlertTriangle size={16} className={iconCls} />
        <div className={titleCls}>
          Reorder alerts
        </div>
        <span className={pillCls}>
          {rows.length}
        </span>
        <div className={hintCls}>
          {rows.length === 1 ? "1 item is at or below its low-stock threshold" : `${rows.length} items are at or below their low-stock threshold`}
        </div>
      </div>
      <div className={divideCls}>
        {rows.slice(0, 6).map(r => (
          <div key={r.item_id} className="flex items-center gap-3 px-4 py-2 text-sm" data-testid={`reorder-row-${r.item_id}`}>
            <PackageMinus size={14} className={rowIconCls} />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-slate-800 truncate">{r.name}</div>
              <div className="text-[11px] text-slate-500 font-mono-num">
                On hand <b className={r.qoh <= 0 ? "text-rose-600" : qohHighlight}>{r.qoh}</b>
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
              onClick={() => setReceiveFor(asItem(r))}
              data-testid={`reorder-receive-${r.item_id}`}
              title="Add additional inventory — optionally link to a transaction"
              className="inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded-md border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
            >
              <PackagePlus size={12} /> Receive
            </button>
            <button
              onClick={() => setAdjustFor(asItem(r))}
              data-testid={`reorder-adjust-${r.item_id}`}
              title="Post a manual write-up / write-down / recount"
              className="inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded-md border bg-white hover:bg-slate-50 text-slate-700"
            >
              <Sliders size={12} /> Adjust
            </button>
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
             className={slate ? "block px-4 py-2 text-[11px] text-slate-600 hover:bg-slate-50 text-center" : "block px-4 py-2 text-[11px] text-amber-800 hover:bg-amber-100/60 text-center"}>
            +{rows.length - 6} more · view all in Inventory →
          </a>
        )}
      </div>
      {receiveFor && (
        <ReceiveStockModal
          item={receiveFor}
          currentId={currentId}
          onClose={() => { setReceiveFor(null); load(); }}
        />
      )}
      {adjustFor && (
        <AdjustmentModal
          items={[adjustFor]}
          preselect={adjustFor.id}
          currentId={currentId}
          onClose={() => { setAdjustFor(null); load(); }}
        />
      )}
    </div>
  );
}
