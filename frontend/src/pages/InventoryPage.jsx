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
import { api, fmtMoney } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { Boxes, Loader2, X, ArrowUpDown, Sliders, BarChart3, Download } from "lucide-react";
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

  return (
    <div className="rounded-xl border bg-white overflow-hidden" data-testid="inventory-valuation">
      <div className="flex items-center justify-between px-4 py-2 border-b bg-slate-50">
        <div className="text-slate-500 text-xs">
          {rows.length} tracked {rows.length === 1 ? "item" : "items"} · total value{" "}
          <b className="text-slate-800 font-mono-num" data-testid="inventory-total-value">{fmtMoney(total)}</b>
        </div>
        <button onClick={exportCsv}
                data-testid="inventory-export-csv"
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border bg-white hover:bg-slate-50">
          <Download size={12} /> Export CSV
        </button>
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
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [itemId, setItemId] = useState("");
  const [items, setItems] = useState([]);

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
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan={8} className="text-center py-8 text-slate-400"><Loader2 className="inline animate-spin" size={16} /></td></tr>}
          {!loading && rows.map(r => {
            const nm = items.find(i => i.id === r.item_id)?.name || r.item_id;
            const badge = {
              purchase: "bg-emerald-100 text-emerald-800",
              sale: "bg-rose-100 text-rose-800",
              adjustment: "bg-amber-100 text-amber-800",
              opening: "bg-slate-200 text-slate-700",
              reversal: "bg-slate-100 text-slate-500",
            }[r.kind] || "bg-slate-100 text-slate-600";
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
              </tr>
            );
          })}
          {!loading && !rows.length && (
            <tr><td colSpan={8} className="text-center py-10 text-slate-500 text-sm">
              No movements yet — inventory activity from bills, invoices, and adjustments will appear here.
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}


function AdjustmentsView({ currentId }) {
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
            <th className="px-3 py-2 text-right"></th>
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
                <AdjustQuickButton it={it} onSaved={load} currentId={currentId} />
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

function AdjustmentModal({ items, preselect, currentId, onClose }) {
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
