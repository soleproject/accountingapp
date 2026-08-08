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
  const [tab, setTab] = useState("pfc");     // "pfc" | "coa"
  const [rows, setRows] = useState([]);
  const [accounts, setAccounts] = useState([]);        // for dropdowns (PFC targets)
  const [allAccounts, setAllAccounts] = useState([]);  // full COA for the "Chart" tab
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
        api.get(`/companies/${currentId}/pfc-map`),
        api.get(`/companies/${currentId}/accounts`),
      ]);
      setRows(mapRes.data.rows || []);
      const raw = accRes.data.accounts || accRes.data || [];
      setAllAccounts(raw);
      // Trim bank/credit-card accounts — those are never valid PFC
      // targets (see pfc_resolver rule 3). Keeps the dropdown lean.
      const list = raw.filter(a => {
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
      const planRes = await api.get(`/companies/${currentId}/pfc-map/plan`);
      const plan = planRes.data;
      const applyRes = await api.post(`/companies/${currentId}/pfc-map/apply`, {
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
        `/companies/${currentId}/pfc-map/${pfc_detailed}`,
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

      {/* Tab bar — Plaid Categories view vs. Chart of Accounts view.
          The Chart view is a "reverse index" of the map, showing every
          account in the CoA and which PFCs (if any) point to it —
          useful for spotting accounts that will never see traffic. */}
      <div className="flex gap-1 border-b border-slate-200">
        {[
          {id: "pfc", label: "Plaid Categories"},
          {id: "coa", label: `Chart of Accounts (${allAccounts.length})`},
          {id: "cleanup", label: "Cleanup Duplicates"},
        ].map(t => (
          <button
            key={t.id} onClick={() => setTab(t.id)}
            data-testid={`pfc-map-tab-${t.id}`}
            className={
              "px-4 py-2 text-sm border-b-2 -mb-px transition " + (
                tab === t.id
                  ? "border-indigo-600 text-indigo-700 font-medium"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              )
            }
          >{t.label}</button>
        ))}
      </div>

      {tab === "pfc" && (
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
      )}

      {tab === "pfc" && (loading ? (
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
      ))}

      {tab === "coa" && <CoaTab allAccounts={allAccounts} rows={rows} loading={loading} />}
      {tab === "cleanup" && <CleanupTab currentId={currentId} onDone={load} />}
    </div>
  );
}


/**
 * Cleanup Duplicates tab — after the PFC map is built, some seeded
 * accounts (Meals, Utilities, Rent, etc.) have QBO equivalents doing
 * the same work. Deactivating the duplicates keeps the sidebar and
 * reports clean without deleting data.
 *
 * SAFETY:
 *  - Only deactivates seeded accounts (`source != qbo`) that:
 *    (a) have a QBO replacement getting PFC traffic
 *    (b) are not structural fallbacks (Uncategorized, banks, AP/AR)
 *    (c) have ZERO ledger references (no txns/invoices/bills/JEs)
 *  - Deactivate = `active: false` (still queryable) — NOT a delete
 *  - "Reactivate all" button restores everything in one click
 */
function CleanupTab({ currentId, onDone }) {
  const [plan, setPlan] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (currentId) refresh(); /* eslint-disable-next-line */ }, [currentId]);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await api.get(`/companies/${currentId}/qbo/cleanup-plan`);
      setPlan(r.data);
      // Pre-select all candidates.
      setSelected(new Set((r.data.candidates || []).map(c => c.id)));
    } catch (e) {
      toast.error(`Failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const apply = async () => {
    const ids = [...selected];
    if (!ids.length) { toast.error("Select at least one account."); return; }
    if (!confirm(`Deactivate ${ids.length} seeded accounts? Reversible.`)) return;
    setBusy(true);
    try {
      const r = await api.post(`/companies/${currentId}/qbo/cleanup-apply`, { account_ids: ids });
      toast.success(`Deactivated ${r.data.deactivated} accounts`);
      await refresh();
      onDone?.();
    } catch (e) {
      toast.error(`Failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setBusy(false); }
  };

  const reverseAll = async () => {
    if (!confirm("Reactivate every seeded account that was previously deactivated?")) return;
    setBusy(true);
    try {
      const r = await api.post(`/companies/${currentId}/qbo/cleanup-reverse`);
      toast.success(`Reactivated ${r.data.reactivated}`);
      await refresh();
      onDone?.();
    } catch (e) {
      toast.error(`Failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setBusy(false); }
  };

  const toggle = (id) => setSelected(s => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  if (loading) return <div className="text-center py-16 text-slate-500">
    <Loader2 className="w-6 h-6 animate-spin inline mr-2" /> Loading…
  </div>;

  const cands = plan?.candidates || [];
  const kept = plan?.kept || [];

  return <>
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <b>Read first:</b> Deactivating hides accounts from the sidebar and reports but
      keeps them in the database. You can reactivate anytime. Nothing is deleted.
      Accounts with existing ledger entries are auto-excluded (shown below).
    </div>

    <div className="flex items-center justify-between">
      <div className="text-sm text-slate-700">
        <b>{cands.length}</b> seeded accounts have QBO equivalents and are safe to deactivate.
        Selected: <b>{selected.size}</b>.
      </div>
      <div className="flex gap-2">
        <button onClick={reverseAll} disabled={busy}
          className="px-3 py-1.5 text-xs rounded-md border bg-white hover:bg-slate-50 disabled:opacity-60"
          data-testid="cleanup-reverse-btn">
          Reactivate all previously deactivated
        </button>
        <button onClick={apply} disabled={busy || selected.size === 0}
          className="px-4 py-2 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60"
          data-testid="cleanup-apply-btn">
          {busy ? <><Loader2 className="w-4 h-4 animate-spin inline mr-1" /> Working…</>
                : `Deactivate ${selected.size} selected`}
        </button>
      </div>
    </div>

    {cands.length > 0 && (
      <div className="rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm" data-testid="cleanup-candidates-table">
          <thead className="bg-slate-50 text-xs text-slate-600 uppercase tracking-wide">
            <tr>
              <th className="px-3 py-2 w-8"></th>
              <th className="text-left px-3 py-2 font-medium w-20">Code</th>
              <th className="text-left px-3 py-2 font-medium">Seeded Account (will hide)</th>
              <th className="text-left px-3 py-2 font-medium w-8"></th>
              <th className="text-left px-3 py-2 font-medium">Replaced by (QBO)</th>
            </tr>
          </thead>
          <tbody>
            {cands.map(c => (
              <tr key={c.id} className="border-t border-slate-100 hover:bg-slate-50/50">
                <td className="px-3 py-2">
                  <input type="checkbox" checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                    data-testid={`cleanup-cb-${c.id}`} />
                </td>
                <td className="px-3 py-2 font-mono text-xs text-slate-700">{c.code || "—"}</td>
                <td className="px-3 py-2">{c.name}</td>
                <td className="text-slate-400 text-center">→</td>
                <td className="px-3 py-2 text-slate-700">
                  {c.replacement_name || <span className="text-slate-400">(via PFC map)</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}

    {kept.length > 0 && (
      <details className="rounded-xl border border-slate-200 p-4 bg-white text-sm">
        <summary className="cursor-pointer text-slate-700 font-medium">
          Why {kept.length} seeded accounts are being kept
        </summary>
        <table className="w-full text-sm mt-3">
          <thead className="text-xs text-slate-500">
            <tr>
              <th className="text-left px-2 py-1 font-medium w-20">Code</th>
              <th className="text-left px-2 py-1 font-medium">Name</th>
              <th className="text-left px-2 py-1 font-medium">Reason kept</th>
            </tr>
          </thead>
          <tbody>
            {kept.map(k => (
              <tr key={k.id} className="border-t border-slate-100">
                <td className="px-2 py-1 font-mono text-xs">{k.code || "—"}</td>
                <td className="px-2 py-1">{k.name}</td>
                <td className="px-2 py-1 text-slate-500 text-xs">{k.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    )}
  </>;
}


/**
 * Chart of Accounts tab — inverse view of the map. One row per
 * account, showing which PFC codes route TO it. Handy for spotting:
 *   • Accounts that will never see Plaid traffic (no PFCs mapped)
 *   • Accounts inheriting too many PFCs (over-broad mapping)
 *   • Structural accounts (AP/AR/Inventory) — should always show 0
 *     PFCs since those are guarded from auto-mapping.
 */
function CoaTab({ allAccounts, rows, loading }) {
  const [filter, setFilter] = useState("");
  const [onlyOrphans, setOnlyOrphans] = useState(false);

  // Invert the map: account_id -> array of PFC codes pointing to it.
  const pfcsByAccount = useMemo(() => {
    const m = {};
    for (const r of rows) {
      if (!r.account_id) continue;
      (m[r.account_id] = m[r.account_id] || []).push(r.pfc_detailed);
    }
    return m;
  }, [rows]);

  const enriched = useMemo(() => {
    return allAccounts.map(a => ({
      ...a,
      pfcs: pfcsByAccount[a.id] || [],
    })).sort((a, b) => (a.code || "zzz").localeCompare(b.code || "zzz"));
  }, [allAccounts, pfcsByAccount]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return enriched.filter(a => {
      if (onlyOrphans && a.pfcs.length > 0) return false;
      if (!q) return true;
      return [a.code, a.name, a.type, a.subtype].filter(Boolean)
        .join(" ").toLowerCase().includes(q);
    });
  }, [enriched, filter, onlyOrphans]);

  const stats = useMemo(() => {
    const bySource = { qbo: 0, seeded: 0 };
    let withPfcs = 0;
    for (const a of enriched) {
      bySource[a.source === "qbo" ? "qbo" : "seeded"]++;
      if (a.pfcs.length) withPfcs++;
    }
    return { total: enriched.length, withPfcs, bySource };
  }, [enriched]);

  if (loading) {
    return <div className="text-center py-16 text-slate-500">
      <Loader2 className="w-6 h-6 animate-spin inline mr-2" /> Loading…
    </div>;
  }
  return <>
    <div className="flex items-center gap-6 text-sm text-slate-600 -mt-2">
      <span><b className="text-slate-900">{stats.withPfcs}</b> of {stats.total} accounts have Plaid categories routed to them</span>
      <span className="text-xs">QBO: {stats.bySource.qbo} · Seeded: {stats.bySource.seeded}</span>
    </div>
    <div className="flex items-center gap-3">
      <div className="relative flex-1 max-w-md">
        <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
        <input
          value={filter} onChange={e => setFilter(e.target.value)}
          placeholder="Filter by code, name, or type…"
          className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-slate-200 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none"
          data-testid="coa-filter-input"
        />
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-600">
        <input type="checkbox" checked={onlyOrphans}
          onChange={e => setOnlyOrphans(e.target.checked)}
          data-testid="coa-orphans-only-cb" />
        Show only orphaned (no PFCs mapped)
      </label>
    </div>
    <div className="rounded-xl border border-slate-200 overflow-hidden">
      <table className="w-full text-sm" data-testid="coa-table">
        <thead className="bg-slate-50 text-xs text-slate-600 uppercase tracking-wide">
          <tr>
            <th className="text-left px-4 py-2 font-medium w-20">Code</th>
            <th className="text-left px-4 py-2 font-medium">Account Name</th>
            <th className="text-left px-4 py-2 font-medium w-24">Type</th>
            <th className="text-left px-4 py-2 font-medium w-20">Source</th>
            <th className="text-left px-4 py-2 font-medium w-28">PFCs Mapped</th>
            <th className="text-left px-4 py-2 font-medium">Which Plaid Categories</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(a => (
            <tr key={a.id} className={
              "border-t border-slate-100 hover:bg-slate-50/50 " +
              (a.active === false ? "opacity-50" : "")
            }>
              <td className="px-4 py-2 font-mono text-xs text-slate-700">{a.code || "—"}</td>
              <td className="px-4 py-2">
                {a.name}
                {a.active === false && <span className="ml-2 text-xs text-slate-400">(inactive)</span>}
              </td>
              <td className="px-4 py-2 text-slate-500 text-xs">{a.type}</td>
              <td className="px-4 py-2">
                <span className={
                  "inline-block px-2 py-0.5 text-xs rounded " + (
                    a.source === "qbo"
                      ? "bg-blue-50 text-blue-700"
                      : "bg-slate-100 text-slate-600"
                  )
                }>{a.source || "seed"}</span>
              </td>
              <td className="px-4 py-2 text-sm">
                {a.pfcs.length > 0
                  ? <span className="font-medium text-emerald-700">{a.pfcs.length}</span>
                  : <span className="text-slate-300">0</span>}
              </td>
              <td className="px-4 py-2 text-xs text-slate-500 max-w-md">
                {a.pfcs.length === 0
                  ? <span className="text-slate-300">—</span>
                  : a.pfcs.slice(0, 3).join(", ") + (a.pfcs.length > 3 ? `, +${a.pfcs.length - 3} more` : "")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </>;
}
