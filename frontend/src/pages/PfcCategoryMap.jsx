import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Sparkles, Loader2, RefreshCw, Search } from "lucide-react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";

/**
 * Plaid PFC → Account map settings.
 *
 * Renders one row per Plaid PFCv2 detailed code with a dropdown of
 * this company's accounts. The map is stored in `pfc_org_overrides`
 * and read by `pfc_resolver.resolve_pfc_coa` at Step 1, so any
 * override here immediately affects Plaid categorization on the next
 * transaction.
 *
 * "Build with AI" runs `POST /pfc-map/plan` (Claude proposes the map)
 * then `POST /pfc-map/apply` (writes proposals with confidence >=
 * medium to the DB). Each row's dropdown can also be edited manually
 * — that PUTs a single override with source="user".
 */
export default function PfcCategoryMap() {
  const { currentId } = useCompany();
  const [rows, setRows] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [filter, setFilter] = useState("");
  const [showOnlyUnmapped, setShowOnlyUnmapped] = useState(false);

  useEffect(() => {
    if (currentId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  const load = async () => {
    setLoading(true);
    try {
      const [mapRes, accRes] = await Promise.all([
        api.get(`/api/companies/${currentId}/pfc-map`),
        api.get(`/api/companies/${currentId}/accounts`),
      ]);
      setRows(mapRes.data.rows || []);
      // Trim bank/credit-card accounts — those are never valid PFC
      // targets (see pfc_resolver rule 3). Keeps the dropdown lean.
      const list = (accRes.data.accounts || accRes.data || []).filter(a => {
        const t = (a.type || "").toLowerCase();
        const sub = (a.subtype || "").toLowerCase();
        const code = String(a.code || "");
        if (a.active === false) return false;
        if (sub === "bank") return false;
        if (code.match(/^10\d\d$/) || code === "1100") return false;  // bank codes
        return true;
      });
      setAccounts(list);
    } catch (e) {
      toast.error(`Failed to load PFC map: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const buildWithAI = async () => {
    if (!confirm("Ask Claude to propose account matches for every Plaid category? This takes 30-60s.")) return;
    setBuilding(true);
    try {
      const planRes = await api.get(`/api/companies/${currentId}/pfc-map/plan`);
      const plan = planRes.data;
      const applyRes = await api.post(`/api/companies/${currentId}/pfc-map/apply`, {
        proposals: plan.proposals || [],
        min_confidence: "medium",
      });
      toast.success(`AI mapped ${applyRes.data.written} categories · skipped ${applyRes.data.skipped} (low confidence)`);
      await load();
    } catch (e) {
      toast.error(`AI mapping failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setBuilding(false);
    }
  };

  const setOne = async (pfc_detailed, account_id) => {
    try {
      await api.put(
        `/api/companies/${currentId}/pfc-map/${pfc_detailed}`,
        { account_id: account_id || "" },
      );
      // Optimistic — patch the row in place so the whole page doesn't rerender.
      setRows(rs => rs.map(r => r.pfc_detailed !== pfc_detailed ? r : {
        ...r,
        account_id: account_id || null,
        account_name: accounts.find(a => a.id === account_id)?.name || null,
        source: account_id ? "user" : null,
      }));
    } catch (e) {
      toast.error(`Save failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return rows.filter(r => {
      if (showOnlyUnmapped && r.account_id) return false;
      if (!q) return true;
      return (r.pfc_detailed + " " + (r.account_name || "")).toLowerCase().includes(q);
    });
  }, [rows, filter, showOnlyUnmapped]);

  const stats = useMemo(() => {
    const mapped = rows.filter(r => r.account_id).length;
    const bySource = { ai: 0, user: 0, pinned: 0 };
    for (const r of rows) if (r.source in bySource) bySource[r.source]++;
    return { total: rows.length, mapped, bySource };
  }, [rows]);

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6" data-testid="pfc-map-page">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Plaid Category Rules</h1>
          <p className="text-sm text-slate-500 mt-1 max-w-2xl">
            When Plaid sends a transaction, we look up its category here to decide
            which account to post it to. Use "Build with AI" to auto-map every
            Plaid category to the best account in your chart — then edit any row
            manually. Applies to Veryfi-scanned receipts too.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={load}
            className="px-3 py-2 text-sm rounded-lg border border-slate-200 hover:bg-slate-50 flex items-center gap-1.5"
            data-testid="pfc-map-refresh-btn"
          >
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
          <button
            onClick={buildWithAI}
            disabled={building}
            className="px-4 py-2 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60 flex items-center gap-1.5"
            data-testid="pfc-map-build-btn"
          >
            {building
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Asking Claude…</>
              : <><Sparkles className="w-4 h-4" /> Build with AI</>}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-6 text-sm text-slate-600">
        <span><b className="text-slate-900">{stats.mapped}</b> of {stats.total} categories mapped</span>
        <span className="text-xs">AI: {stats.bySource.ai} · User: {stats.bySource.user}</span>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
          <input
            value={filter} onChange={e => setFilter(e.target.value)}
            placeholder="Filter categories or accounts…"
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-slate-200 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none"
            data-testid="pfc-map-filter-input"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox" checked={showOnlyUnmapped}
            onChange={e => setShowOnlyUnmapped(e.target.checked)}
            data-testid="pfc-map-unmapped-only-cb"
          />
          Show only unmapped
        </label>
      </div>

      {loading ? (
        <div className="text-center py-16 text-slate-500">
          <Loader2 className="w-6 h-6 animate-spin inline mr-2" /> Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-slate-400 text-sm">
          No categories match your filter.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm" data-testid="pfc-map-table">
            <thead className="bg-slate-50 text-xs text-slate-600 uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Plaid Category</th>
                <th className="text-left px-4 py-2 font-medium">Kind</th>
                <th className="text-left px-4 py-2 font-medium">Mapped Account</th>
                <th className="text-left px-4 py-2 font-medium w-24">Source</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.pfc_detailed} className="border-t border-slate-100 hover:bg-slate-50/50">
                  <td className="px-4 py-2 font-mono text-xs text-slate-700">{r.pfc_detailed}</td>
                  <td className="px-4 py-2 text-slate-500 text-xs">{r.classification}</td>
                  <td className="px-4 py-2">
                    <select
                      value={r.account_id || ""}
                      onChange={e => setOne(r.pfc_detailed, e.target.value)}
                      className="w-full px-2 py-1 text-sm rounded border border-slate-200 focus:border-indigo-500 outline-none bg-white"
                      data-testid={`pfc-map-select-${r.pfc_detailed}`}
                    >
                      <option value="">— unmapped (use fallback) —</option>
                      {accounts.map(a => (
                        <option key={a.id} value={a.id}>
                          {a.code ? `${a.code} · ` : ""}{a.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    {r.source && (
                      <span className={
                        "inline-block px-2 py-0.5 text-xs rounded " + (
                          r.source === "user" ? "bg-emerald-50 text-emerald-700" :
                          r.source === "ai" ? "bg-indigo-50 text-indigo-700" :
                          "bg-slate-100 text-slate-600"
                        )
                      }>
                        {r.source}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
