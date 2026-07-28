import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus, Trash2, X, Loader2 } from "lucide-react";
import { toast } from "sonner";

/**
 * Fixed Assets page — replaces the GenericList wiring.
 *
 * Adding a fixed asset here now does the full accounting lifecycle:
 *   1. Creates two CoA sub-accounts under `1500 Fixed Assets`
 *      (fixed-asset ledger row + accumulated-depreciation contra).
 *   2. Posts the acquisition JE (DR fixed asset · CR user-selected offset).
 *   3. Generates the full straight-line depreciation schedule (one JE
 *      per month-end for the entire useful life). Balance Sheet
 *      respects `as_of` so future entries stay invisible until due.
 *
 * Deleting cascades the JEs + sub-accounts before removing the row.
 */
export default function FixedAssetsPage() {
  const { currentId } = useCompany();
  const [items, setItems] = useState([]);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const r = await api.get(`/companies/${currentId}/assets`);
      setItems(r.data.items || []);
    } finally {
      setLoading(false);
    }
  }, [currentId]);

  useEffect(() => { load(); }, [load]);

  const del = async (row) => {
    if (!confirm(
      `Delete "${row.name}"? This will also remove the CoA sub-accounts, ` +
      `the acquisition journal entry, and every depreciation entry ` +
      `(${(row.depreciation_je_ids || []).length} scheduled). This cannot be undone.`
    )) return;
    try {
      const r = await api.delete(`/companies/${currentId}/assets/${row.id}`);
      toast.success(
        `Deleted — removed ${r.data?.journal_entries_deleted ?? 0} JEs · ` +
        `${r.data?.accounts_deleted ?? 0} CoA rows.`,
      );
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Delete failed");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-3xl font-bold tracking-tight">
          Fixed Assets
        </h1>
        <button
          data-testid={TID.addBtn}
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs"
        >
          <Plus size={13} /> Add Fixed Asset
        </button>
      </div>

      <div className="rounded-xl border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
            <tr>
              <th className="px-3 py-2 text-left">Asset</th>
              <th className="px-3 py-2 text-left">Ledger</th>
              <th className="px-3 py-2 text-left">Purchased</th>
              <th className="px-3 py-2 text-right">Cost</th>
              <th className="px-3 py-2 text-right">Life (yrs)</th>
              <th className="px-3 py-2 text-right">Monthly Depr.</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((x) => (
              <tr key={x.id} className="border-b hover:bg-slate-50">
                <td className="px-3 py-2 font-medium">{x.name}</td>
                <td className="px-3 py-2 text-xs text-slate-500 font-mono-num">
                  {x.ledger_account_code || "—"}
                </td>
                <td className="px-3 py-2">{x.purchase_date}</td>
                <td className="px-3 py-2 text-right font-mono-num">
                  ${Number(x.cost || 0).toLocaleString(undefined,
                    { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td className="px-3 py-2 text-right font-mono-num">
                  {x.useful_life_years}
                </td>
                <td className="px-3 py-2 text-right font-mono-num text-slate-500">
                  ${Number(x.monthly_depreciation || 0).toLocaleString(undefined,
                    { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    data-testid={`delete-asset-${x.id}`}
                    onClick={() => del(x)}
                    className="text-red-500 p-1 hover:text-red-700"
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
            {!items.length && !loading && (
              <tr>
                <td colSpan={7} className="text-center py-8 text-slate-500">
                  No fixed assets yet. Click <b>Add Fixed Asset</b> to get started —
                  we'll auto-post the acquisition entry and generate the full
                  depreciation schedule.
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={7} className="text-center py-8 text-slate-400">
                  <Loader2 size={16} className="inline animate-spin mr-2" /> Loading…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {creating && (
        <FixedAssetModal
          currentId={currentId}
          onClose={() => { setCreating(false); load(); }}
        />
      )}
    </div>
  );
}


function FixedAssetModal({ currentId, onClose }) {
  const [name, setName] = useState("");
  const [purchaseDate, setPurchaseDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [cost, setCost] = useState("");
  const [lifeYears, setLifeYears] = useState("");
  const [salvage, setSalvage] = useState("");
  const [offsetKind, setOffsetKind] = useState("cash");
  const [offsetAccountId, setOffsetAccountId] = useState("");
  const [accounts, setAccounts] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get(`/companies/${currentId}/accounts`);
        if (!cancelled) setAccounts(r.data.accounts || []);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [currentId]);

  // Filter accounts by offset kind. `cash` → asset type & no fixed_asset
  // subtype. `loan` → liability. `owner_equity` / `obe` → equity.
  const eligibleAccounts = useMemo(() => {
    if (offsetKind === "cash") {
      return accounts.filter(a =>
        a.type === "asset" &&
        a.subtype !== "fixed_asset" &&
        a.subtype !== "accumulated_depreciation" &&
        a.active !== false
      );
    }
    if (offsetKind === "loan") {
      return accounts.filter(a => a.type === "liability" && a.active !== false);
    }
    if (offsetKind === "owner_equity" || offsetKind === "obe") {
      return accounts.filter(a => a.type === "equity" && a.active !== false);
    }
    return accounts;
  }, [accounts, offsetKind]);

  useEffect(() => {
    // Pre-select the most-common default per offset kind.
    if (!eligibleAccounts.length) {
      setOffsetAccountId("");
      return;
    }
    if (offsetKind === "obe") {
      const obe = eligibleAccounts.find(a => a.code === "3050"
        || /opening balance equity/i.test(a.name));
      setOffsetAccountId((obe || eligibleAccounts[0]).id);
    } else {
      setOffsetAccountId(eligibleAccounts[0].id);
    }
  }, [eligibleAccounts, offsetKind]);

  const save = async () => {
    if (!name.trim()) { toast.error("Asset name is required"); return; }
    if (!(Number(cost) > 0)) { toast.error("Cost must be positive"); return; }
    if (!(Number(lifeYears) > 0)) { toast.error("Useful life must be positive"); return; }
    if (!offsetAccountId) { toast.error("Select an offset account"); return; }

    setSaving(true);
    try {
      const r = await api.post(`/companies/${currentId}/assets`, {
        name: name.trim(),
        purchase_date: purchaseDate,
        cost: Number(cost),
        useful_life_years: Number(lifeYears),
        salvage_value: Number(salvage) || 0,
        offset_account_id: offsetAccountId,
      });
      const monthly = r.data?.monthly_depreciation;
      const posted = r.data?.depreciation_jes_posted;
      toast.success(
        `Fixed asset created — acquisition JE posted, ${posted} depreciation ` +
        `entries scheduled ($${Number(monthly).toLocaleString(undefined,
          { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / month).`,
        { duration: 8000 },
      );
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold">New Fixed Asset</h3>
          <button onClick={onClose}><X size={16} /></button>
        </div>

        <div>
          <label className="text-xs uppercase text-slate-500">Asset Name</label>
          <input
            data-testid="fa-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. 123 Main St. · Ford F-150 · Espresso Machine"
            className="w-full mt-1 border rounded px-2 py-1.5 text-sm"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs uppercase text-slate-500">Purchase Date</label>
            <input
              data-testid="fa-date"
              type="date"
              value={purchaseDate}
              onChange={(e) => setPurchaseDate(e.target.value)}
              className="w-full mt-1 border rounded px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="text-xs uppercase text-slate-500">Useful Life (yrs)</label>
            <input
              data-testid="fa-life"
              type="number"
              step="0.5"
              min="0"
              value={lifeYears}
              onChange={(e) => setLifeYears(e.target.value)}
              placeholder="e.g. 5 · 7 · 27.5 (real estate)"
              className="w-full mt-1 border rounded px-2 py-1.5 text-sm font-mono-num"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs uppercase text-slate-500">Cost</label>
            <input
              data-testid="fa-cost"
              type="number"
              step="0.01"
              min="0"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              className="w-full mt-1 border rounded px-2 py-1.5 text-sm font-mono-num"
            />
          </div>
          <div>
            <label className="text-xs uppercase text-slate-500">Salvage Value</label>
            <input
              data-testid="fa-salvage"
              type="number"
              step="0.01"
              min="0"
              value={salvage}
              onChange={(e) => setSalvage(e.target.value)}
              placeholder="0"
              className="w-full mt-1 border rounded px-2 py-1.5 text-sm font-mono-num"
            />
          </div>
        </div>

        <div>
          <label className="text-xs uppercase text-slate-500">
            How was this paid for?
          </label>
          <div className="mt-1 grid grid-cols-4 gap-1">
            {[
              { k: "cash", l: "Cash" },
              { k: "loan", l: "Loan" },
              { k: "owner_equity", l: "Owner" },
              { k: "obe", l: "Opening" },
            ].map(({ k, l }) => (
              <button
                key={k}
                type="button"
                data-testid={`fa-offset-kind-${k}`}
                onClick={() => setOffsetKind(k)}
                className={`px-2 py-1.5 rounded text-xs border ${
                  offsetKind === k
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            {offsetKind === "cash" && "We'll credit the bank/cash account you pick below."}
            {offsetKind === "loan" && "We'll credit the liability (loan) account you pick below."}
            {offsetKind === "owner_equity" && "We'll credit an owner contribution / equity account."}
            {offsetKind === "obe" && "Best for assets already owned when starting the books — credits Opening Balance Equity."}
          </p>
        </div>

        <div>
          <label className="text-xs uppercase text-slate-500">Offset Account</label>
          <select
            data-testid="fa-offset-account"
            value={offsetAccountId}
            onChange={(e) => setOffsetAccountId(e.target.value)}
            className="w-full mt-1 border rounded px-2 py-1.5 text-sm bg-white"
          >
            <option value="">— select —</option>
            {eligibleAccounts.map(a => (
              <option key={a.id} value={a.id}>
                {a.code} · {a.name}
              </option>
            ))}
          </select>
          {!eligibleAccounts.length && (
            <p className="mt-1 text-[11px] text-amber-700">
              No matching account found. Add one under Chart of Accounts first, or pick a different offset type.
            </p>
          )}
        </div>

        <button
          data-testid={TID.saveBtn}
          onClick={save}
          disabled={saving}
          className="w-full py-2 rounded-md bg-slate-900 text-white text-sm disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          {saving ? "Posting entries…" : "Save & post journal entries"}
        </button>
      </div>
    </div>
  );
}
