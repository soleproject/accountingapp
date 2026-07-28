import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus, Trash2, X, Loader2, Pencil } from "lucide-react";
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
 * Editing a financial field (cost/life/date/offset/type) tears down the
 * schedule and re-generates from scratch — id stable across the swap.
 * Non-financial edits (rename) are cheap.
 */
export default function FixedAssetsPage() {
  const { currentId } = useCompany();
  const [items, setItems] = useState([]);
  const [modalMode, setModalMode] = useState(null); // null | "create" | {edit: row}
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
          onClick={() => setModalMode("create")}
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
              <th className="px-3 py-2 text-left">Type</th>
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
                <td className="px-3 py-2 text-xs text-slate-500">
                  {formatAssetType(x.asset_type)}
                </td>
                <td className="px-3 py-2 text-xs text-slate-500 font-mono-num">
                  {x.ledger_account_code || "—"}
                </td>
                <td className="px-3 py-2">{x.purchase_date}</td>
                <td className="px-3 py-2 text-right font-mono-num">
                  ${Number(x.cost || 0).toLocaleString(undefined,
                    { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td className="px-3 py-2 text-right font-mono-num">
                  {x.depreciable === false ? "—" : x.useful_life_years}
                </td>
                <td className="px-3 py-2 text-right font-mono-num text-slate-500">
                  {x.depreciable === false ? "—" : `$${Number(x.monthly_depreciation || 0).toLocaleString(undefined,
                    { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button
                    data-testid={`edit-asset-${x.id}`}
                    onClick={() => setModalMode({ edit: x })}
                    className="text-slate-500 p-1 hover:text-slate-900 mr-1"
                  >
                    <Pencil size={13} />
                  </button>
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
                <td colSpan={8} className="text-center py-8 text-slate-500">
                  No fixed assets yet. Click <b>Add Fixed Asset</b> to get started —
                  we'll auto-post the acquisition entry and generate the full
                  depreciation schedule.
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={8} className="text-center py-8 text-slate-400">
                  <Loader2 size={16} className="inline animate-spin mr-2" /> Loading…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modalMode && (
        <FixedAssetModal
          currentId={currentId}
          editRow={modalMode?.edit || null}
          onClose={() => { setModalMode(null); load(); }}
        />
      )}
    </div>
  );
}


function formatAssetType(key) {
  if (!key || key === "other") return "Other";
  return key.split("_").map(s => s[0].toUpperCase() + s.slice(1)).join(" ");
}


function FixedAssetModal({ currentId, editRow, onClose }) {
  const isEdit = !!editRow;
  const [name, setName] = useState(editRow?.name || "");
  const [purchaseDate, setPurchaseDate] = useState(
    editRow?.purchase_date || new Date().toISOString().slice(0, 10),
  );
  const [cost, setCost] = useState(editRow?.cost ? String(editRow.cost) : "");
  const [lifeYears, setLifeYears] = useState(
    editRow?.useful_life_years ? String(editRow.useful_life_years) : "",
  );
  const [salvage, setSalvage] = useState(
    editRow?.salvage_value ? String(editRow.salvage_value) : "",
  );
  const [assetType, setAssetType] = useState(editRow?.asset_type || "");
  const [offsetKind, setOffsetKind] = useState("cash");
  const [offsetAccountId, setOffsetAccountId] = useState(
    editRow?.offset_account_id || "",
  );
  const [accounts, setAccounts] = useState([]);
  const [assetTypes, setAssetTypes] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [ra, rt] = await Promise.all([
          api.get(`/companies/${currentId}/accounts`),
          api.get(`/assets/types`),
        ]);
        if (cancelled) return;
        setAccounts(ra.data.accounts || []);
        setAssetTypes(rt.data.asset_types || []);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [currentId]);

  // When user picks an asset type, auto-fill the useful-life field
  // unless they've already typed a custom value (skip on edit re-open).
  const setAssetTypeAndLife = (key) => {
    setAssetType(key);
    const t = assetTypes.find(x => x.key === key);
    if (!t) return;
    if (t.depreciable === false) {
      setLifeYears("0");
    } else if (t.years !== null && t.years !== undefined) {
      setLifeYears(String(t.years));
    }
  };

  const selectedType = assetTypes.find(t => t.key === assetType);
  const isDepreciable = selectedType ? selectedType.depreciable !== false : true;

  // Filter accounts by offset kind.
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
    // Skip pre-selection when editing (respect existing offset_account_id).
    if (isEdit && editRow?.offset_account_id) return;
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
  }, [eligibleAccounts, offsetKind, isEdit, editRow]);

  const save = async () => {
    if (!name.trim()) { toast.error("Asset name is required"); return; }
    if (!(Number(cost) > 0)) { toast.error("Cost must be positive"); return; }
    if (isDepreciable && !(Number(lifeYears) > 0)) {
      toast.error("Useful life must be positive"); return;
    }
    if (!offsetAccountId) { toast.error("Select an offset account"); return; }

    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        purchase_date: purchaseDate,
        cost: Number(cost),
        useful_life_years: Number(lifeYears) || 0,
        salvage_value: Number(salvage) || 0,
        offset_account_id: offsetAccountId,
        asset_type: assetType || "other",
      };
      let r;
      if (isEdit) {
        r = await api.patch(`/companies/${currentId}/assets/${editRow.id}`, payload);
      } else {
        r = await api.post(`/companies/${currentId}/assets`, payload);
      }
      const monthly = r.data?.monthly_depreciation;
      const posted = r.data?.depreciation_jes_posted;
      const action = r.data?.action;
      if (action === "renamed") {
        toast.success("Fixed asset renamed.");
      } else if (isDepreciable) {
        toast.success(
          `Fixed asset ${isEdit ? (action === "regenerated" ? "regenerated" : "saved") : "created"} — acquisition JE posted, ` +
          `${posted} depreciation entries scheduled ($${Number(monthly).toLocaleString(undefined,
            { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / month).`,
          { duration: 8000 },
        );
      } else {
        toast.success(
          `Fixed asset ${isEdit ? "regenerated" : "created"} — acquisition JE posted. ` +
          `Non-depreciable (land) — no depreciation schedule.`,
          { duration: 8000 },
        );
      }
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-5 space-y-3 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold">
            {isEdit ? "Edit Fixed Asset" : "New Fixed Asset"}
          </h3>
          <button onClick={onClose}><X size={16} /></button>
        </div>

        {isEdit && (
          <div className="text-[11px] bg-amber-50 border border-amber-200 text-amber-900 rounded px-2 py-1.5">
            Changing <b>cost</b>, <b>life</b>, <b>type</b>, <b>date</b>, or <b>offset account</b> will re-generate every journal entry for this asset. Renames are cheap.
          </div>
        )}

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

        <div>
          <label className="text-xs uppercase text-slate-500">Asset Type</label>
          <select
            data-testid="fa-asset-type"
            value={assetType}
            onChange={(e) => setAssetTypeAndLife(e.target.value)}
            className="w-full mt-1 border rounded px-2 py-1.5 text-sm bg-white"
          >
            <option value="">— select type (auto-fills life) —</option>
            {assetTypes.map(t => (
              <option key={t.key} value={t.key}>
                {t.label}{t.years !== null && t.years !== undefined ? ` — ${t.years} yrs` : ""}
              </option>
            ))}
          </select>
          {selectedType?.depreciable === false && (
            <p className="mt-1 text-[11px] text-blue-700">
              Land is non-depreciable. We'll post the acquisition entry only — no monthly schedule.
            </p>
          )}
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
              disabled={!isDepreciable}
              placeholder={isDepreciable ? "auto-filled from type" : "n/a"}
              className="w-full mt-1 border rounded px-2 py-1.5 text-sm font-mono-num disabled:bg-slate-100"
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
              disabled={!isDepreciable}
              placeholder={isDepreciable ? "0" : "n/a"}
              className="w-full mt-1 border rounded px-2 py-1.5 text-sm font-mono-num disabled:bg-slate-100"
            />
          </div>
        </div>

        <div>
          <label className="text-xs uppercase text-slate-500">
            How was this paid for?
          </label>
          <div className="mt-1 grid grid-cols-4 gap-1">
            {[
              {
                k: "cash", l: "Cash",
                tip: "Paid for out of a business bank or cash account. We'll DEBIT the fixed asset and CREDIT the bank/cash account you pick below — cash goes out, asset comes in.",
              },
              {
                k: "loan", l: "Loan",
                tip: "Financed the purchase — mortgage, auto loan, equipment loan, line of credit, etc. We'll DEBIT the fixed asset and CREDIT the loan liability. Later principal payments reduce the loan balance without touching the asset.",
              },
              {
                k: "owner_equity", l: "Owner",
                tip: "The owner personally contributed the asset — or paid for it out of pocket without going through a business bank account. We'll DEBIT the fixed asset and CREDIT an owner contribution / equity account.",
              },
              {
                k: "obe", l: "Opening",
                tip: "The business already owned this asset when you started keeping books here. We'll DEBIT the fixed asset and CREDIT 3050 Opening Balance Equity — representing pre-existing net worth so retained earnings aren't distorted.",
              },
            ].map(({ k, l, tip }) => (
              <button
                key={k}
                type="button"
                title={tip}
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
          {saving
            ? (isEdit ? "Saving…" : "Posting entries…")
            : (isEdit ? "Save changes" : "Save & post journal entries")}
        </button>
      </div>
    </div>
  );
}
