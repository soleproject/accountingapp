import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";
import { Plus, Trash2, X, Loader2, Pencil, Package, Check, UploadCloud } from "lucide-react";
import { toast } from "sonner";
import ItemImportModal from "@/components/ItemImportModal";
import SearchableAccountPicker from "@/components/SearchableAccountPicker";

export default function Items() {

  const fmtMoney = useMoneyFmt();
  const { currentId } = useCompany();
  const [sp] = useSearchParams();
  const initialUsage = (["all", "sales", "purchases", "both"].includes(sp.get("usage")) ? sp.get("usage") : "all");
  const [items, setItems] = useState([]);
  const [allAccounts, setAllAccounts] = useState([]);
  const [revenueAccts, setRevenueAccts] = useState([]);
  const [expenseAccts, setExpenseAccts] = useState([]);
  // Filtered asset accounts eligible for the Inventory dropdown (Wave
  // sub-type = inventory) and expense accounts eligible for the COGS
  // dropdown (sub-type = cost_of_goods_sold).
  const [inventoryAccts, setInventoryAccts] = useState([]);
  const [cogsAccts, setCogsAccts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [usageFilter, setUsageFilter] = useState(initialUsage);
  // Re-apply URL filter whenever the query param changes (e.g. Sales
  // link → clicking Purchases link in the sidebar without a full reload).
  useEffect(() => {
    const u = sp.get("usage");
    if (["all", "sales", "purchases", "both"].includes(u)) setUsageFilter(u);
  }, [sp]);

  const load = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const [it, ac] = await Promise.all([
        api.get(`/companies/${currentId}/items`),
        api.get(`/companies/${currentId}/accounts`),
      ]);
      setItems(it.data.items || []);
      const all = ac.data.accounts || [];
      setAllAccounts(all);
      // The codebase uses "revenue" (some legacy seeds use "income").
      setRevenueAccts(all.filter(a => a.type === "revenue" || a.type === "income"));
      setExpenseAccts(all.filter(a => a.type === "expense" || a.type === "cogs"));
      setInventoryAccts(all.filter(a => a.type === "asset" && a.detail_type === "inventory"));
      setCogsAccts(all.filter(a => (a.type === "cogs" || a.type === "expense") && a.detail_type === "cost_of_goods_sold"));
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [currentId]);

  const toggleActive = async (it) => {
    await api.patch(`/companies/${currentId}/items/${it.id}`, { active: !it.active });
    load();
  };
  const del = async (it) => {
    if (!confirm(`Delete "${it.name}"?`)) return;
    await api.delete(`/companies/${currentId}/items/${it.id}`);
    toast.success("Deleted");
    load();
  };

  const visible = items.filter(i => {
    if (!showInactive && i.active === false) return false;
    if (usageFilter === "all") return true;
    // "sales" filter shows items usable on invoices — that's sales OR both.
    // "purchases" filter shows items usable on bills — purchases OR both.
    if (usageFilter === "sales") return i.usage === "sales" || i.usage === "both";
    if (usageFilter === "purchases") return i.usage === "purchases" || i.usage === "both";
    if (usageFilter === "both") return i.usage === "both";
    return true;
  });

  const countsBy = items.reduce((acc, i) => {
    if (i.active === false) return acc;
    const u = i.usage || "sales";
    acc.all += 1;
    if (u === "sales" || u === "both") acc.sales += 1;
    if (u === "purchases" || u === "both") acc.purchases += 1;
    if (u === "both") acc.both += 1;
    return acc;
  }, { all: 0, sales: 0, purchases: 0, both: 0 });

  return (
    <div className="space-y-4" data-testid="items-page">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight inline-flex items-center gap-2">
            <Package size={22} /> Items
          </h1>
          <p className="text-slate-500 text-sm mt-1">Products &amp; services you sell <b>and</b> buy. Pick from this list on invoice or bill lines to auto-fill description, price, and category.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setImporting(true)}
            data-testid="items-import-btn"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border bg-white text-slate-700 text-xs hover:bg-slate-50"
          >
            <UploadCloud size={13} /> Import CSV/Excel
          </button>
          <button
            onClick={() => setCreating(true)}
            data-testid="items-add-btn"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs"
          >
            <Plus size={13} /> New item
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="inline-flex rounded-lg border bg-white p-1 text-xs" data-testid="items-usage-filter">
          {[
            { key: "all",       label: "All",           count: countsBy.all,       testId: "items-filter-all" },
            { key: "sales",     label: "For Invoices",  count: countsBy.sales,     testId: "items-filter-sales" },
            { key: "purchases", label: "For Bills",     count: countsBy.purchases, testId: "items-filter-purchases" },
            { key: "both",      label: "Both",          count: countsBy.both,      testId: "items-filter-both" },
          ].map(t => (
            <button
              key={t.key}
              onClick={() => setUsageFilter(t.key)}
              data-testid={t.testId}
              className={`px-3 py-1.5 rounded-md inline-flex items-center gap-1.5 ${usageFilter === t.key ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}
            >
              {t.label}
              <span className={`text-[10px] font-mono-num rounded-full px-1.5 ${usageFilter === t.key ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500"}`}>{t.count}</span>
            </button>
          ))}
        </div>
        <label className="inline-flex items-center gap-1.5 text-slate-500 text-xs">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
      </div>

      <div className="rounded-xl border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
            <tr>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-left">Description</th>
              <th className="px-3 py-2 text-left">Type</th>
              <th className="px-3 py-2 text-left">Used on</th>
              <th className="px-3 py-2 text-left">Accounts</th>
              <th className="px-3 py-2 text-right">Inventory</th>
              <th className="px-3 py-2 text-right">Price</th>
              <th className="px-3 py-2 text-center">Active</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={9} className="text-center py-8 text-slate-400"><Loader2 className="inline animate-spin" size={16} /></td></tr>
            )}
            {!loading && visible.map(it => {
              const u = it.usage || "sales";
              const usageMeta = u === "sales"
                ? { label: "Invoices", cls: "bg-emerald-100 text-emerald-800" }
                : u === "purchases"
                  ? { label: "Bills", cls: "bg-rose-100 text-rose-800" }
                  : { label: "Both", cls: "bg-indigo-100 text-indigo-800" };
              return (
              <tr key={it.id} className="border-b hover:bg-slate-50" data-testid={`item-row-${it.id}`}>
                <td className="px-3 py-2 font-medium text-slate-800">{it.name}{it.sku ? <span className="text-xs text-slate-400 ml-1">· {it.sku}</span> : null}</td>
                <td className="px-3 py-2 text-slate-500 text-xs max-w-md truncate">{it.description}</td>
                <td className="px-3 py-2 text-xs">
                  <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${it.type === "product" ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"}`}>
                    {it.type || "service"}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs">
                  <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${usageMeta.cls}`} data-testid={`item-usage-${it.id}`}>
                    {usageMeta.label}
                  </span>
                </td>
                <td className="px-3 py-2 text-slate-500 text-xs">
                  {it.income_account_name && (
                    <div><span className="text-emerald-600">↑</span> {it.income_account_name}</div>
                  )}
                  {it.expense_account_name && (
                    <div><span className="text-rose-600">↓</span> {it.expense_account_name}</div>
                  )}
                  {!it.income_account_name && !it.expense_account_name && <span className="text-slate-400">—</span>}
                </td>
                <td className="px-3 py-2 text-right text-xs" data-testid={`item-inventory-${it.id}`}>
                  {it.track_inventory ? (() => {
                    const qoh = Number(it.quantity_on_hand || 0);
                    const cost = Number(it.cost_basis || 0);
                    const value = qoh * cost;
                    const low = it.low_stock_threshold != null && qoh <= Number(it.low_stock_threshold);
                    return (
                      <div className={low ? "text-amber-800" : "text-slate-700"}>
                        <div className="font-mono-num">
                          <span className="font-semibold">{qoh}</span>
                          <span className="text-slate-400 mx-1">·</span>
                          <span className="text-slate-500">{fmtMoney(cost)}</span>
                        </div>
                        <div className="text-[10px] text-slate-500 font-mono-num">
                          Value {fmtMoney(value)}
                          {low && (
                            <span className="ml-1 uppercase text-[9px] tracking-wider px-1 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200" data-testid={`item-lowstock-${it.id}`}>
                              Low
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })() : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(it.price)}</td>
                <td className="px-3 py-2 text-center">
                  <button
                    onClick={() => toggleActive(it)}
                    className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${it.active !== false ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-500"}`}
                  >{it.active !== false ? "Active" : "Inactive"}</button>
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="inline-flex items-center gap-1">
                    <button data-testid={`item-edit-${it.id}`} onClick={() => setEditing(it)}
                            className="p-1 rounded hover:bg-indigo-100 text-indigo-600"><Pencil size={13} /></button>
                    <button onClick={() => del(it)} className="p-1 rounded hover:bg-red-100 text-red-500"><Trash2 size={13} /></button>
                  </div>
                </td>
              </tr>
            );})}
            {!loading && !visible.length && (
              <tr><td colSpan={9} className="text-center py-10 text-slate-500 text-sm">
                {usageFilter === "all"
                  ? <>No items yet. Click <b>New item</b> to add your first product or service.</>
                  : <>No items in this view — try switching to <b>All</b>.</>}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {(creating || editing) && (
        <ItemModal
          currentId={currentId}
          item={editing}
          allAccounts={allAccounts}
          revenueAccts={revenueAccts}
          expenseAccts={expenseAccts}
          inventoryAccts={inventoryAccts}
          cogsAccts={cogsAccts}
          reloadAccounts={load}
          onClose={() => { setCreating(false); setEditing(null); load(); }}
        />
      )}
      {importing && (
        <ItemImportModal
          currentId={currentId}
          onClose={() => { setImporting(false); load(); }}
        />
      )}
    </div>
  );
}

function ItemModal({ currentId, item, allAccounts = [], revenueAccts, expenseAccts, inventoryAccts = [], cogsAccts = [], reloadAccounts, onClose }) {
  const edit = !!item;
  const [name, setName] = useState(item?.name || "");
  const [description, setDescription] = useState(item?.description || "");
  const [type, setType] = useState(item?.type || "service");
  const [usage, setUsage] = useState(item?.usage || "sales");
  const [accountId, setAccountId] = useState(item?.income_account_id || "");
  const [expenseAccountId, setExpenseAccountId] = useState(item?.expense_account_id || "");
  const [price, setPrice] = useState(item?.price ?? 0);
  const [sku, setSku] = useState(item?.sku || "");
  const [active, setActive] = useState(item?.active !== false);
  const [busy, setBusy] = useState(false);
  // ── Inventory tracking state ──────────────────────────────────────
  const [trackInventory, setTrackInventory] = useState(!!item?.track_inventory);
  const [qoh, setQoh] = useState(item?.quantity_on_hand ?? 0);
  const [costBasis, setCostBasis] = useState(item?.cost_basis ?? 0);
  const [inventoryAccountId, setInventoryAccountId] = useState(item?.inventory_account_id || "");
  const [cogsAccountId, setCogsAccountId] = useState(item?.cogs_account_id || "");
  const [lowStockThreshold, setLowStockThreshold] = useState(
    item?.low_stock_threshold != null ? item.low_stock_threshold : ""
  );
  // Default sales-tax rate for invoice lines seeded from this item.
  // Loaded once on mount from /taxes; falls back to empty list if the
  // company hasn't set any tax rates yet. Feb 2026.
  const [taxRateId, setTaxRateId] = useState(item?.tax_rate_id || "");
  const [taxRates, setTaxRates]   = useState([]);
  useEffect(() => {
    if (!currentId) return;
    api.get(`/companies/${currentId}/taxes`)
      .then(r => setTaxRates(r.data?.taxes || []))
      .catch(() => setTaxRates([]));
  }, [currentId]);
  // Auto-pick the default Inventory / COGS accounts when the user
  // enables tracking for the first time and only one option exists.
  useEffect(() => {
    if (trackInventory && !inventoryAccountId && inventoryAccts.length === 1) {
      setInventoryAccountId(inventoryAccts[0].id);
    }
    if (trackInventory && !cogsAccountId && cogsAccts.length === 1) {
      setCogsAccountId(cogsAccts[0].id);
    }
  }, [trackInventory, inventoryAccts, cogsAccts, inventoryAccountId, cogsAccountId]);
  const save = async () => {
    if (!name.trim()) { toast.error("Name is required"); return; }
    if (trackInventory) {
      if (!inventoryAccountId) { toast.error("Pick an Inventory asset account."); return; }
      if (!cogsAccountId) { toast.error("Pick a Cost of Goods Sold account."); return; }
    }
    setBusy(true);
    try {
      const inc = revenueAccts.find(a => a.id === accountId);
      const exp = expenseAccts.find(a => a.id === expenseAccountId);
      const invA = inventoryAccts.find(a => a.id === inventoryAccountId);
      const cogsA = cogsAccts.find(a => a.id === cogsAccountId);
      const body = {
        name: name.trim(),
        description,
        type,
        usage,
        income_account_id: accountId || null,
        income_account_name: inc?.name || "",
        expense_account_id: expenseAccountId || null,
        expense_account_name: exp?.name || "",
        price: Number(price) || 0,
        sku: sku || null,
        active,
        tax_rate_id: taxRateId || null,
        tax_rate_name: taxRates.find(t => t.id === taxRateId)?.name || "",
        // Inventory bundle — only meaningful when track_inventory is on.
        track_inventory: !!trackInventory,
        quantity_on_hand: trackInventory ? (Number(qoh) || 0) : (item?.quantity_on_hand ?? 0),
        cost_basis: trackInventory ? (Number(costBasis) || 0) : (item?.cost_basis ?? 0),
        inventory_account_id: trackInventory ? (inventoryAccountId || null) : null,
        inventory_account_name: trackInventory ? (invA?.name || "") : "",
        cogs_account_id: trackInventory ? (cogsAccountId || null) : null,
        cogs_account_name: trackInventory ? (cogsA?.name || "") : "",
        low_stock_threshold: trackInventory && lowStockThreshold !== "" ? Number(lowStockThreshold) : null,
      };
      if (edit) {
        await api.patch(`/companies/${currentId}/items/${item.id}`, body);
        toast.success("Item updated");
      } else {
        await api.post(`/companies/${currentId}/items`, body);
        toast.success("Item created");
      }
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-5 space-y-3 max-h-[92vh] overflow-y-auto" data-testid="item-modal">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold inline-flex items-center gap-2"><Package size={16} /> {edit ? "Edit item" : "New item"}</h3>
          <button onClick={onClose}><X size={16} /></button>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)}
                 placeholder="e.g. Monthly Retainer"
                 className="w-full border rounded px-2 py-1.5 text-sm"
                 data-testid="item-name" />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Description</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)}
                 placeholder="Long-form description shown on invoices"
                 className="w-full border rounded px-2 py-1.5 text-sm"
                 data-testid="item-description" />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Used on</label>
          <div className="inline-flex rounded-lg border bg-slate-50 p-1 text-xs w-full" data-testid="item-usage-picker">
            {[
              { key: "sales",     label: "Invoices", cls: "bg-emerald-600" },
              { key: "purchases", label: "Bills",    cls: "bg-rose-600" },
              { key: "both",      label: "Both",     cls: "bg-indigo-600" },
            ].map(opt => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setUsage(opt.key)}
                data-testid={`item-usage-${opt.key}`}
                className={`flex-1 px-3 py-1.5 rounded-md transition ${usage === opt.key ? `${opt.cls} text-white` : "text-slate-600 hover:bg-white"}`}
              >{opt.label}</button>
            ))}
          </div>
          <p className="text-[10px] text-slate-400 mt-1">
            {usage === "sales" && "Shows up on invoice-line pickers only."}
            {usage === "purchases" && "Shows up on bill-line pickers only."}
            {usage === "both" && "Shows up on both invoice and bill line pickers."}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)}
                    className="w-full border rounded px-2 py-1.5 text-sm bg-white"
                    data-testid="item-type">
              <option value="service">Service</option>
              <option value="product">Product</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Price (default rate)</label>
            <input type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)}
                   className="w-full border rounded px-2 py-1.5 text-sm font-mono-num"
                   data-testid="item-price" />
          </div>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Income account · sales</label>
          <SearchableAccountPicker
            value={accountId}
            onChange={setAccountId}
            accounts={revenueAccts}
            allAccounts={allAccounts}
            placeholder="— Pick income account —"
            kindLabel="income"
            newDefaults={{ type: "revenue", detail_type: "operating_revenue", subtype: "Operating Revenue" }}
            currentId={currentId}
            onCreated={() => reloadAccounts && reloadAccounts()}
            testId="item-account"
          />
          <p className="text-[10px] text-slate-400 mt-1">Used on invoice lines — rolls up on Sales by Category and the Income Statement.</p>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Expense account · purchases <span className="text-slate-400 normal-case">(optional)</span></label>
          <SearchableAccountPicker
            value={expenseAccountId}
            onChange={setExpenseAccountId}
            accounts={expenseAccts}
            allAccounts={allAccounts}
            placeholder="— Pick expense account —"
            kindLabel="expense"
            newDefaults={{ type: "expense", detail_type: "operating_expense", subtype: "Operating Expense" }}
            currentId={currentId}
            onCreated={() => reloadAccounts && reloadAccounts()}
            testId="item-expense-account"
          />
          <p className="text-[10px] text-slate-400 mt-1">Used on bill lines when you buy this product/service.</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">SKU (optional)</label>
            <input value={sku} onChange={(e) => setSku(e.target.value)}
                   className="w-full border rounded px-2 py-1.5 text-sm"
                   data-testid="item-sku" />
          </div>
          <div className="flex items-end">
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-600">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)}
                     data-testid="item-active" />
              Active
            </label>
          </div>
        </div>
        {/* Default sales-tax linkage — Feb 2026. Only shown when the
            product is used on invoices (sales) or both. Auto-populates
            the tax_rate on any invoice line seeded from this item. */}
        {(usage === "sales" || usage === "both") && (
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">
              Sales tax <span className="text-slate-400 normal-case">(optional)</span>
            </label>
            <select
              value={taxRateId}
              onChange={(e) => setTaxRateId(e.target.value)}
              data-testid="item-tax-rate"
              className="w-full border rounded px-2 py-1.5 text-sm"
            >
              <option value="">— None (taxable at line level) —</option>
              {taxRates.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name} · {Number(t.rate || 0).toFixed(3)}%
                </option>
              ))}
            </select>
            <p className="text-[10px] text-slate-400 mt-1">
              Auto-fills the tax rate on invoice lines. Overridable per line.
            </p>
          </div>
        )}
        {/* ── Inventory tracking (Tier 2, Weighted Average) ─────────────────── */}
        <div className="rounded-lg border bg-slate-50/60 px-3 py-2.5 space-y-2">
          <label className="inline-flex items-center gap-2 text-xs text-slate-700 select-none">
            <input type="checkbox" checked={trackInventory}
                   onChange={(e) => setTrackInventory(e.target.checked)}
                   data-testid="item-track-inventory" />
            <span className="font-medium">Track inventory (weighted average)</span>
          </label>
          <p className="text-[10px] text-slate-500 -mt-1">
            When enabled, buying this on a bill will DR your Inventory asset and selling it on
            an invoice will auto-post COGS at the current average cost. Starts from today —
            historical bills/invoices are not backfilled.
          </p>
          {trackInventory && (
            <div className="space-y-2 pt-1">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Opening quantity on hand</label>
                  <input type="number" step="1" value={qoh}
                         onChange={(e) => setQoh(e.target.value)}
                         disabled={edit && !!item?.track_inventory}
                         className="w-full border rounded px-2 py-1.5 text-sm font-mono-num disabled:bg-slate-100 disabled:text-slate-500"
                         data-testid="item-qoh" />
                  {edit && !!item?.track_inventory && (
                    <p className="text-[10px] text-slate-400 mt-1">Locked once tracking is on — use an Adjustment to change.</p>
                  )}
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Opening avg cost / unit</label>
                  <input type="number" step="0.01" value={costBasis}
                         onChange={(e) => setCostBasis(e.target.value)}
                         disabled={edit && !!item?.track_inventory}
                         className="w-full border rounded px-2 py-1.5 text-sm font-mono-num disabled:bg-slate-100 disabled:text-slate-500"
                         data-testid="item-cost-basis" />
                </div>
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Inventory asset account</label>
                <SearchableAccountPicker
                  value={inventoryAccountId}
                  onChange={setInventoryAccountId}
                  accounts={inventoryAccts}
                  allAccounts={allAccounts}
                  placeholder="— Pick inventory asset account —"
                  kindLabel="inventory"
                  newDefaults={{ type: "asset", detail_type: "inventory", subtype: "Current Asset" }}
                  currentId={currentId}
                  onCreated={() => reloadAccounts && reloadAccounts()}
                  testId="item-inventory-account"
                />
                {!inventoryAccts.length && (
                  <p className="text-[10px] text-amber-700 mt-1">
                    No account with sub-type “Inventory” yet — use <b>Add new inventory account</b> above.
                  </p>
                )}
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">COGS account</label>
                <SearchableAccountPicker
                  value={cogsAccountId}
                  onChange={setCogsAccountId}
                  accounts={cogsAccts}
                  allAccounts={allAccounts}
                  placeholder="— Pick COGS account —"
                  kindLabel="COGS"
                  newDefaults={{ type: "expense", detail_type: "cost_of_goods_sold", subtype: "Cost of Goods Sold" }}
                  currentId={currentId}
                  onCreated={() => reloadAccounts && reloadAccounts()}
                  testId="item-cogs-account"
                />
                {!cogsAccts.length && (
                  <p className="text-[10px] text-amber-700 mt-1">
                    No account with sub-type “Cost of goods sold” yet — use <b>Add new COGS account</b> above.
                  </p>
                )}
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Low-stock threshold (optional)</label>
                <input type="number" step="1" value={lowStockThreshold}
                       onChange={(e) => setLowStockThreshold(e.target.value)}
                       placeholder="Warn when QOH falls to this level"
                       className="w-full border rounded px-2 py-1.5 text-sm font-mono-num"
                       data-testid="item-low-stock" />
              </div>
            </div>
          )}
        </div>
        <button onClick={save} disabled={busy}
                data-testid="item-save"
                className="w-full py-2 rounded-md bg-slate-900 text-white text-sm inline-flex items-center justify-center gap-1.5 disabled:opacity-60">
          {busy && <Loader2 size={13} className="animate-spin" />}
          {edit ? "Save changes" : "Create item"}
        </button>
      </div>
    </div>
  );
}
