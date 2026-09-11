/**
 * Inventory management centre — Valuation, Movements, Adjustments.
 *
 * Sibling of the Items catalog (which stays focused on the product
 * list itself). This page is the single lens for everything AFTER an
 * item is flipped to `track_inventory=true`: current stock value,
 * chronological movements, and manual write-ups / write-downs.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useRegisterChart } from "@/hooks/useRegisterChart";
import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";
import { Boxes, Loader2, X, ArrowUpDown, Sliders, BarChart3, Download, Printer, PackagePlus, Search, Link2, Undo2 } from "lucide-react";
import { toast } from "sonner";

const REASONS = [
  { value: "recount",   label: "Recount" },
  { value: "shrinkage", label: "Shrinkage / theft" },
  { value: "damage",    label: "Damage / spoilage" },
  { value: "opening",   label: "Opening balance" },
  { value: "other",     label: "Other" },
];

export default function InventoryPage() {
  const { currentId } = useCompany();
  const [sp, setSp] = useSearchParams();
  const initialTab = ["valuation", "movements", "adjustments"].includes(sp.get("tab"))
    ? sp.get("tab") : "valuation";
  const [tab, setTab] = useState(initialTab);
  // Advertise both inventory charts to the Insights widget so
  // "tell me about my inventory" / "what needs reordering" get top-of-
  // list treatment from the LLM's chart picker.
  useRegisterChart({ id: "inventory_valuation", title: "Inventory Valuation" });
  useRegisterChart({ id: "reorder_alerts", title: "Reorder Alerts" });
  useEffect(() => { setSp({ tab }, { replace: true }); }, [tab]);  // eslint-disable-line
  return (
    <div className="space-y-4" data-testid="inventory-page">
      <div>
        <h1 className="font-heading text-3xl font-bold tracking-tight inline-flex items-center gap-2">
          <Boxes size={22} /> Inventory
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Valuation, movement history, and manual adjustments for every item
          you have marked <b>Track inventory</b>. Toggle tracking on individual
          items from the <a href="/items?usage=purchases" className="text-indigo-600 hover:underline">Items catalog</a>.
        </p>
      </div>

      <div className="inline-flex rounded-lg border bg-white p-1 text-xs" data-testid="inventory-tabs">
        {[
          { key: "valuation",   label: "Valuation",   icon: BarChart3 },
          { key: "movements",   label: "Movements",   icon: ArrowUpDown },
          { key: "adjustments", label: "Adjustments", icon: Sliders },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            data-testid={`inventory-tab-${t.key}`}
            className={`px-3 py-1.5 rounded-md inline-flex items-center gap-1.5 ${
              tab === t.key ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"
            }`}
          >
            <t.icon size={13} /> {t.label}
          </button>
        ))}
      </div>

      {tab === "valuation"   && <ValuationView   currentId={currentId} />}
      {tab === "movements"   && <MovementsView   currentId={currentId} />}
      {tab === "adjustments" && <AdjustmentsView currentId={currentId} />}
    </div>
  );
}


function ValuationView({ currentId }) {


  const fmtMoney = useMoneyFmt();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const r = await api.get(`/companies/${currentId}/inventory-management/valuation`);
      setRows(r.data.rows || []);
      setTotal(r.data.total_value || 0);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [currentId]);

  const exportCsv = () => {
    const head = ["Item", "SKU", "QOH", "Avg cost", "Value", "Inventory account"];
    const csv = [head.join(",")]
      .concat(rows.map(r => [
        JSON.stringify(r.name || ""),
        JSON.stringify(r.sku || ""),
        r.qoh, r.cost_basis, r.value,
        JSON.stringify(r.inventory_account_name || ""),
      ].join(",")))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `inventory-valuation-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  const openPdf = async () => {
    try {
      const r = await api.get(`/companies/${currentId}/inventory-management/valuation/pdf`,
                              { responseType: "blob" });
      const url = URL.createObjectURL(r.data);
      window.open(url, "_blank");
      // Give the browser a moment to hand off before revoking.
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not open PDF");
    }
  };

  return (
    <div className="rounded-xl border bg-white overflow-hidden" data-testid="inventory-valuation">
      <div className="flex items-center justify-between px-4 py-2 border-b bg-slate-50">
        <div className="text-slate-500 text-xs">
          {rows.length} tracked {rows.length === 1 ? "item" : "items"} · total value{" "}
          <b className="text-slate-800 font-mono-num" data-testid="inventory-total-value">{fmtMoney(total)}</b>
        </div>
        <div className="inline-flex items-center gap-2">
          <button onClick={openPdf}
                  data-testid="inventory-export-pdf"
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border bg-white hover:bg-slate-50">
            <Printer size={12} /> Print / PDF
          </button>
          <button onClick={exportCsv}
                  data-testid="inventory-export-csv"
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border bg-white hover:bg-slate-50">
            <Download size={12} /> Export CSV
          </button>
        </div>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
          <tr>
            <th className="px-3 py-2 text-left">Item</th>
            <th className="px-3 py-2 text-left">SKU</th>
            <th className="px-3 py-2 text-right">Qty on hand</th>
            <th className="px-3 py-2 text-right">Avg cost</th>
            <th className="px-3 py-2 text-right">Value</th>
            <th className="px-3 py-2 text-left">Inventory account</th>
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan={6} className="text-center py-8 text-slate-400"><Loader2 className="inline animate-spin" size={16} /></td></tr>}
          {!loading && rows.map(r => (
            <tr key={r.item_id} className="border-b hover:bg-slate-50" data-testid={`valuation-row-${r.item_id}`}>
              <td className="px-3 py-2 font-medium text-slate-800">
                {r.name}
                {r.low_stock && (
                  <span className="ml-2 uppercase text-[9px] tracking-wider px-1 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">Low</span>
                )}
              </td>
              <td className="px-3 py-2 text-slate-500 text-xs">{r.sku || "—"}</td>
              <td className="px-3 py-2 text-right font-mono-num">{r.qoh}</td>
              <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(r.cost_basis)}</td>
              <td className="px-3 py-2 text-right font-mono-num font-semibold">{fmtMoney(r.value)}</td>
              <td className="px-3 py-2 text-slate-500 text-xs">{r.inventory_account_name || "—"}</td>
            </tr>
          ))}
          {!loading && !rows.length && (
            <tr><td colSpan={6} className="text-center py-10 text-slate-500 text-sm">
              No items are tracking inventory yet. Toggle <b>Track inventory</b> on a product in the Items catalog to see it here.
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}


function MovementsView({ currentId }) {


  const fmtMoney = useMoneyFmt();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [itemId, setItemId] = useState("");
  const [items, setItems] = useState([]);
  const [undoing, setUndoing] = useState(null);

  const load = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const [mv, it] = await Promise.all([
        api.get(`/companies/${currentId}/inventory-management/movements`,
                { params: { item_id: itemId || undefined } }),
        api.get(`/companies/${currentId}/items`),
      ]);
      setRows(mv.data.rows || []);
      setItems((it.data.items || []).filter(x => x.track_inventory));
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [currentId, itemId]);

  const undoReceipt = async (r) => {
    const nm = items.find(i => i.id === r.item_id)?.name || "this item";
    if (!window.confirm(
      `Undo the receipt of ${r.qty_delta} × ${nm}?\n\n` +
      `• Quantity on hand rolls back by ${r.qty_delta}\n` +
      `• Weighted-average cost is recomputed\n` +
      (r.ref_kind === "transaction"
        ? "• Linked transaction is unlinked and its original category is restored\n"
        : "• Balancing journal entry is deleted\n") +
      `\nA reversal row will be recorded in the audit trail. Continue?`
    )) return;
    setUndoing(r.id);
    try {
      await api.delete(`/companies/${currentId}/inventory-management/movements/${r.id}`);
      toast.success(`Receipt undone — ${r.qty_delta} × ${nm} rolled back`);
      await load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Undo failed");
    } finally { setUndoing(null); }
  };

  return (
    <div className="rounded-xl border bg-white overflow-hidden" data-testid="inventory-movements">
      <div className="px-4 py-2 border-b bg-slate-50 flex items-center gap-3 text-xs">
        <label className="text-slate-500">Filter:</label>
        <select value={itemId} onChange={(e) => setItemId(e.target.value)}
                data-testid="movements-item-filter"
                className="border rounded px-2 py-1 bg-white text-xs">
          <option value="">All items</option>
          {items.map(it => <option key={it.id} value={it.id}>{it.name}</option>)}
        </select>
        <div className="ml-auto text-slate-500">{rows.length} movements</div>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
          <tr>
            <th className="px-3 py-2 text-left">When</th>
            <th className="px-3 py-2 text-left">Item</th>
            <th className="px-3 py-2 text-left">Kind</th>
            <th className="px-3 py-2 text-right">Qty Δ</th>
            <th className="px-3 py-2 text-right">Unit cost</th>
            <th className="px-3 py-2 text-right">Value Δ</th>
            <th className="px-3 py-2 text-left">Ref</th>
            <th className="px-3 py-2 text-left">Memo</th>
            <th className="px-3 py-2 text-right w-[90px]"></th>
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan={9} className="text-center py-8 text-slate-400"><Loader2 className="inline animate-spin" size={16} /></td></tr>}
          {!loading && rows.map(r => {
            const nm = items.find(i => i.id === r.item_id)?.name || r.item_id;
            const badge = {
              purchase: "bg-emerald-100 text-emerald-800",
              sale: "bg-rose-100 text-rose-800",
              adjustment: "bg-amber-100 text-amber-800",
              opening: "bg-slate-200 text-slate-700",
              reversal: "bg-slate-100 text-slate-500",
            }[r.kind] || "bg-slate-100 text-slate-600";
            const isManualReceipt = r.kind === "purchase" && (r.ref_kind === "receipt" || r.ref_kind === "transaction");
            return (
              <tr key={r.id} className="border-b hover:bg-slate-50" data-testid={`movement-row-${r.id}`}>
                <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">{(r.created_at || "").replace("T", " ").slice(0, 16)}</td>
                <td className="px-3 py-2 text-slate-800">{nm}</td>
                <td className="px-3 py-2"><span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${badge}`}>{r.kind}</span></td>
                <td className={`px-3 py-2 text-right font-mono-num ${r.qty_delta < 0 ? "text-rose-600" : "text-emerald-700"}`}>{r.qty_delta > 0 ? "+" : ""}{r.qty_delta}</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(r.unit_cost)}</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(r.total)}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{r.ref_kind ? `${r.ref_kind}${r.ref_number ? " " + r.ref_number : ""}` : "—"}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{r.memo || "—"}</td>
                <td className="px-3 py-2 text-right">
                  {isManualReceipt && (
                    <button
                      onClick={() => undoReceipt(r)}
                      disabled={undoing === r.id}
                      title={r.ref_kind === "transaction"
                        ? "Undo this receipt and restore the linked transaction's original category"
                        : "Undo this receipt and delete its balancing journal entry"}
                      className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100 disabled:opacity-40"
                      data-testid={`movement-undo-${r.id}`}
                    >
                      {undoing === r.id
                        ? <Loader2 size={11} className="animate-spin" />
                        : <Undo2 size={11} />}
                      Undo
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {!loading && !rows.length && (
            <tr><td colSpan={9} className="text-center py-10 text-slate-500 text-sm">
              No movements yet — inventory activity from bills, invoices, and adjustments will appear here.
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}


function AdjustmentsView({ currentId }) {


  const fmtMoney = useMoneyFmt();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const load = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const r = await api.get(`/companies/${currentId}/items`);
      setItems((r.data.items || []).filter(x => x.track_inventory));
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [currentId]);

  return (
    <div className="rounded-xl border bg-white overflow-hidden" data-testid="inventory-adjustments">
      <div className="px-4 py-2 border-b bg-slate-50 flex items-center justify-between">
        <div className="text-slate-500 text-xs">
          Manual write-ups, write-downs, and recounts. Each adjustment posts a
          balancing journal entry against the Inventory Adjustments expense account.
        </div>
        <button onClick={() => setOpen(true)}
                data-testid="adjustments-new"
                disabled={!items.length}
                className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-slate-900 text-white disabled:opacity-50">
          <Sliders size={13} /> New adjustment
        </button>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
          <tr>
            <th className="px-3 py-2 text-left">Item</th>
            <th className="px-3 py-2 text-left">SKU</th>
            <th className="px-3 py-2 text-right">Current QOH</th>
            <th className="px-3 py-2 text-right">Avg cost</th>
            <th className="px-3 py-2 text-right">Value</th>
            <th className="px-3 py-2 text-right w-[200px]"></th>
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan={6} className="text-center py-8 text-slate-400"><Loader2 className="inline animate-spin" size={16} /></td></tr>}
          {!loading && items.map(it => (
            <tr key={it.id} className="border-b hover:bg-slate-50" data-testid={`adj-item-${it.id}`}>
              <td className="px-3 py-2 font-medium text-slate-800">{it.name}</td>
              <td className="px-3 py-2 text-slate-500 text-xs">{it.sku || "—"}</td>
              <td className="px-3 py-2 text-right font-mono-num">{it.quantity_on_hand ?? 0}</td>
              <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(it.cost_basis)}</td>
              <td className="px-3 py-2 text-right font-mono-num font-semibold">{fmtMoney((it.quantity_on_hand || 0) * (it.cost_basis || 0))}</td>
              <td className="px-3 py-2 text-right">
                <div className="inline-flex items-center gap-1.5">
                  <ReceiveStockButton it={it} onSaved={load} currentId={currentId} />
                  <AdjustQuickButton it={it} onSaved={load} currentId={currentId} />
                </div>
              </td>
            </tr>
          ))}
          {!loading && !items.length && (
            <tr><td colSpan={6} className="text-center py-10 text-slate-500 text-sm">
              No inventory-tracked items yet — enable <b>Track inventory</b> on an item first.
            </td></tr>
          )}
        </tbody>
      </table>
      {open && <AdjustmentModal items={items} currentId={currentId} onClose={() => { setOpen(false); load(); }} />}
    </div>
  );
}

function AdjustQuickButton({ it, onSaved, currentId }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}
              data-testid={`adj-quick-${it.id}`}
              className="text-xs px-2 py-1 rounded border hover:bg-slate-100">
        Adjust
      </button>
      {open && (
        <AdjustmentModal items={[it]} preselect={it.id} currentId={currentId}
                         onClose={() => { setOpen(false); onSaved(); }} />
      )}
    </>
  );
}

function ReceiveStockButton({ it, onSaved, currentId }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}
              data-testid={`receive-quick-${it.id}`}
              title="Add additional inventory to this item — optionally link to a transaction"
              className="text-xs px-2 py-1 rounded border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 inline-flex items-center gap-1">
        <PackagePlus size={12} /> Receive
      </button>
      {open && (
        <ReceiveStockModal
          item={it}
          currentId={currentId}
          onClose={() => { setOpen(false); onSaved(); }}
        />
      )}
    </>
  );
}

export function AdjustmentModal({ items, preselect, currentId, onClose }) {

  const fmtMoney = useMoneyFmt();
  const [itemId, setItemId] = useState(preselect || items[0]?.id || "");
  const [mode, setMode] = useState("delta");  // delta | absolute
  const [qtyDelta, setQtyDelta] = useState(0);
  const [newQoh, setNewQoh] = useState("");
  const [newCost, setNewCost] = useState("");
  const [reason, setReason] = useState("recount");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = useMemo(() => items.find(i => i.id === itemId), [items, itemId]);

  const save = async () => {
    if (!itemId) { toast.error("Pick an item first."); return; }
    if (mode === "delta" && !Number(qtyDelta)) { toast.error("Enter a non-zero delta."); return; }
    if (mode === "absolute" && newQoh === "") { toast.error("Enter the new quantity on hand."); return; }
    setBusy(true);
    try {
      await api.post(`/companies/${currentId}/inventory-management/adjustments`, {
        item_id: itemId,
        reason,
        qty_delta:   mode === "delta"    ? Number(qtyDelta) : null,
        new_qoh:     mode === "absolute" ? Number(newQoh)   : null,
        new_cost_basis: newCost !== "" ? Number(newCost) : null,
        memo,
      });
      toast.success("Adjustment posted");
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-3" data-testid="adjustment-modal">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold inline-flex items-center gap-2"><Sliders size={16} /> New adjustment</h3>
          <button onClick={onClose}><X size={16} /></button>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Item</label>
          <select value={itemId} onChange={(e) => setItemId(e.target.value)}
                  disabled={!!preselect}
                  data-testid="adj-item-select"
                  className="w-full border rounded px-2 py-1.5 text-sm bg-white">
            <option value="">— Pick item —</option>
            {items.map(it => <option key={it.id} value={it.id}>{it.name} (QOH {it.quantity_on_hand ?? 0})</option>)}
          </select>
        </div>
        <div className="inline-flex rounded-lg border bg-slate-50 p-1 text-xs w-full" data-testid="adj-mode">
          <button type="button" onClick={() => setMode("delta")}
                  data-testid="adj-mode-delta"
                  className={`flex-1 px-3 py-1.5 rounded-md ${mode === "delta" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-white"}`}>Change by (+/−)</button>
          <button type="button" onClick={() => setMode("absolute")}
                  data-testid="adj-mode-absolute"
                  className={`flex-1 px-3 py-1.5 rounded-md ${mode === "absolute" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-white"}`}>Set QOH to</button>
        </div>
        {mode === "delta" ? (
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Quantity change</label>
            <input type="number" step="1" value={qtyDelta} onChange={(e) => setQtyDelta(e.target.value)}
                   className="w-full border rounded px-2 py-1.5 text-sm font-mono-num"
                   data-testid="adj-qty-delta" />
            {selected && <p className="text-[10px] text-slate-500 mt-1">Result QOH: {(Number(selected.quantity_on_hand || 0) + Number(qtyDelta || 0))}</p>}
          </div>
        ) : (
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">New quantity on hand</label>
            <input type="number" step="1" value={newQoh} onChange={(e) => setNewQoh(e.target.value)}
                   className="w-full border rounded px-2 py-1.5 text-sm font-mono-num"
                   data-testid="adj-new-qoh" />
          </div>
        )}
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">New avg cost (optional)</label>
          <input type="number" step="0.01" value={newCost} onChange={(e) => setNewCost(e.target.value)}
                 placeholder={selected ? `Current ${fmtMoney(selected.cost_basis)}` : ""}
                 className="w-full border rounded px-2 py-1.5 text-sm font-mono-num"
                 data-testid="adj-new-cost" />
          <p className="text-[10px] text-slate-400 mt-1">Leave blank to keep the current weighted-avg cost.</p>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Reason</label>
          <select value={reason} onChange={(e) => setReason(e.target.value)}
                  data-testid="adj-reason"
                  className="w-full border rounded px-2 py-1.5 text-sm bg-white">
            {REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Memo (optional)</label>
          <input value={memo} onChange={(e) => setMemo(e.target.value)}
                 className="w-full border rounded px-2 py-1.5 text-sm"
                 data-testid="adj-memo" />
        </div>
        <button onClick={save} disabled={busy}
                data-testid="adj-save"
                className="w-full py-2 rounded-md bg-slate-900 text-white text-sm inline-flex items-center justify-center gap-1.5 disabled:opacity-60">
          {busy && <Loader2 size={13} className="animate-spin" />}
          Post adjustment
        </button>
      </div>
    </div>
  );
}


/**
 * ReceiveStockModal — add additional inventory to an existing tracked
 * item. Positive quantity + unit cost recompute the weighted-average
 * cost. Users can optionally link the receipt to an existing bank
 * transaction; the linked txn is re-categorized onto the item's
 * inventory account so cash-out and stock-in stay tied together.
 *
 * If nothing is linked, the backend posts a balancing JE against
 * Opening Balance Equity so the Balance Sheet stays in step.
 */
export function ReceiveStockModal({ item, currentId, onClose }) {
  const fmtMoney = useMoneyFmt();
  const [qty, setQty] = useState("");
  const [unitCost, setUnitCost] = useState(
    item.cost_basis != null ? String(item.cost_basis) : "",
  );
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  // Transaction picker state.
  const [txnQuery, setTxnQuery] = useState("");
  const [txnResults, setTxnResults] = useState([]);
  const [txnLoading, setTxnLoading] = useState(false);
  const [linkedTxn, setLinkedTxn] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const numQty = Number(qty || 0);
  const numCost = Number(unitCost || 0);
  const numValue = Math.round(numQty * numCost * 100) / 100;
  const preQoh = Number(item.quantity_on_hand || 0);
  const preCost = Number(item.cost_basis || 0);
  const postQoh = preQoh + numQty;
  const postCost = postQoh > 0
    ? Math.round(((Math.max(preQoh, 0) * preCost + numQty * numCost) / (Math.max(preQoh, 0) + numQty)) * 10000) / 10000
    : numCost;

  // Debounced transaction search — hits the standard list endpoint with a
  // text query. Filters to outflows so we surface only "money-out" rows
  // that are plausible stock receipts.
  useEffect(() => {
    if (!pickerOpen) return;
    const t = setTimeout(async () => {
      setTxnLoading(true);
      try {
        const r = await api.get(`/companies/${currentId}/transactions`, {
          params: { q: txnQuery || undefined, direction: "outflow", limit: 25 },
        });
        setTxnResults(r.data.transactions || r.data.items || r.data.rows || []);
      } catch (e) {
        setTxnResults([]);
      } finally {
        setTxnLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [txnQuery, currentId, pickerOpen]);

  const pickTxn = (t) => {
    setLinkedTxn(t);
    setPickerOpen(false);
    // Pre-fill unit cost from txn amount / qty when both known and the
    // user hasn't customised yet.
    if (numQty > 0 && !unitCost) {
      const amt = Math.abs(Number(t.amount || 0));
      if (amt) setUnitCost(String(Math.round((amt / numQty) * 10000) / 10000));
    }
  };
  const clearTxn = () => setLinkedTxn(null);

  const save = async () => {
    if (numQty <= 0) { toast.error("Enter a positive quantity."); return; }
    if (numCost < 0) { toast.error("Unit cost must be zero or positive."); return; }
    setBusy(true);
    try {
      await api.post(`/companies/${currentId}/inventory-management/receive`, {
        item_id: item.id,
        qty: numQty,
        unit_cost: numCost,
        transaction_id: linkedTxn?.id || null,
        memo,
      });
      toast.success(`Received ${numQty} × ${item.name}`);
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Receive failed");
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-5 space-y-3" data-testid="receive-stock-modal">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold inline-flex items-center gap-2">
            <PackagePlus size={16} className="text-emerald-600" />
            Receive stock · <span className="text-slate-900">{item.name}</span>
          </h3>
          <button onClick={onClose} data-testid="receive-stock-close"><X size={16} /></button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Quantity received</label>
            <input
              type="number" min="0" step="1" value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="0"
              className="w-full border rounded px-2 py-1.5 text-sm font-mono-num"
              data-testid="receive-qty"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Unit cost</label>
            <input
              type="number" min="0" step="0.01" value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              placeholder={preCost ? fmtMoney(preCost) : "0.00"}
              className="w-full border rounded px-2 py-1.5 text-sm font-mono-num"
              data-testid="receive-unit-cost"
            />
            <p className="text-[10px] text-slate-400 mt-1">Current avg: <span className="font-mono-num">{fmtMoney(preCost)}</span></p>
          </div>
        </div>

        {/* Live preview */}
        <div className="rounded-md border bg-slate-50 p-2 text-[11px] text-slate-600 grid grid-cols-3 gap-2">
          <div>
            <div className="uppercase text-[9px] tracking-wider text-slate-400">Value posted</div>
            <div className="font-mono-num text-slate-900 font-semibold">{fmtMoney(numValue)}</div>
          </div>
          <div>
            <div className="uppercase text-[9px] tracking-wider text-slate-400">New QOH</div>
            <div className="font-mono-num text-slate-900 font-semibold">{postQoh}</div>
          </div>
          <div>
            <div className="uppercase text-[9px] tracking-wider text-slate-400">New avg cost</div>
            <div className="font-mono-num text-slate-900 font-semibold">{fmtMoney(postCost)}</div>
          </div>
        </div>

        {/* Optional transaction link */}
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1 inline-flex items-center gap-1">
            <Link2 size={11} /> Link to a transaction (optional)
          </label>
          {linkedTxn ? (
            <div className="flex items-center justify-between gap-2 rounded border border-emerald-300 bg-emerald-50 p-2" data-testid="receive-linked-txn">
              <div className="min-w-0">
                <div className="text-sm text-emerald-900 font-medium truncate">
                  {linkedTxn.description || linkedTxn.memo || "Transaction"}
                </div>
                <div className="text-[11px] text-emerald-800/80 font-mono-num truncate">
                  {linkedTxn.date || ""} · {fmtMoney(Math.abs(Number(linkedTxn.amount || 0)))}
                  {linkedTxn.contact_name ? ` · ${linkedTxn.contact_name}` : ""}
                </div>
              </div>
              <button
                onClick={clearTxn}
                className="text-emerald-800 hover:text-emerald-900 p-1"
                title="Remove link"
                data-testid="receive-clear-txn"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setPickerOpen(v => !v)}
              className="w-full text-left text-xs border rounded px-2 py-1.5 hover:bg-slate-50 inline-flex items-center gap-1 text-slate-600"
              data-testid="receive-open-picker"
            >
              <Search size={12} /> Search transactions…
            </button>
          )}
          {pickerOpen && !linkedTxn && (
            <div className="mt-1 rounded-md border bg-white shadow-sm" data-testid="receive-txn-picker">
              <input
                value={txnQuery}
                onChange={(e) => setTxnQuery(e.target.value)}
                placeholder="Search by description, vendor, amount…"
                className="w-full border-b px-2 py-1.5 text-sm"
                data-testid="receive-txn-search"
                autoFocus
              />
              <div className="max-h-56 overflow-y-auto">
                {txnLoading && (
                  <div className="text-center py-3 text-slate-400"><Loader2 className="inline animate-spin" size={14} /></div>
                )}
                {!txnLoading && txnResults.length === 0 && (
                  <div className="text-center py-3 text-xs text-slate-500">No matching transactions.</div>
                )}
                {!txnLoading && txnResults.map(t => (
                  <button
                    key={t.id}
                    onClick={() => pickTxn(t)}
                    className="w-full text-left px-2 py-1.5 hover:bg-emerald-50 border-b last:border-b-0"
                    data-testid={`receive-txn-option-${t.id}`}
                  >
                    <div className="text-sm text-slate-900 truncate">{t.description || t.memo || "—"}</div>
                    <div className="text-[10px] text-slate-500 font-mono-num flex items-center gap-1.5">
                      <span>{t.date || ""}</span>
                      <span>·</span>
                      <span>{fmtMoney(Math.abs(Number(t.amount || 0)))}</span>
                      {t.contact_name && <><span>·</span><span className="truncate">{t.contact_name}</span></>}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
          <p className="text-[10px] text-slate-400 mt-1">
            Linked transactions are re-categorized onto <b>{item.inventory_account_name || "the item's inventory account"}</b>{" "}
            so the cash outflow lands as an asset. Leave blank to post an opening-balance JE instead.
          </p>
        </div>

        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Memo (optional)</label>
          <input
            value={memo} onChange={(e) => setMemo(e.target.value)}
            className="w-full border rounded px-2 py-1.5 text-sm"
            data-testid="receive-memo"
            placeholder="e.g. Purchased 25 more units from ACME on 3/12"
          />
        </div>

        <button
          onClick={save} disabled={busy || numQty <= 0}
          data-testid="receive-save"
          className="w-full py-2 rounded-md bg-emerald-600 text-white text-sm inline-flex items-center justify-center gap-1.5 hover:bg-emerald-700 disabled:opacity-50"
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          Receive stock
        </button>
      </div>
    </div>
  );
}
