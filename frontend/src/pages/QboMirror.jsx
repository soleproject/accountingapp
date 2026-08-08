import React, { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Loader2, ShieldCheck, ShieldAlert, Play, RefreshCw, ArrowLeft,
  ArrowRight, GitBranch, Info,
} from "lucide-react";
import { useCompany } from "@/lib/company";
import { api } from "@/lib/api";

/**
 * /settings/qbo-mirror — Phase 1a: dry-run preview only.
 *
 * The page is intentionally read-heavy: the Toggle enables the config
 * doc; the "Preview mirror actions" button runs a full diff between
 * our local Foundation entities and QBO's live state, then renders
 * the report. NO writes hit QBO from this screen — the backend forces
 * `dry_run: true` on every request.
 */

const ENTITIES = [
  { key: "accounts",  label: "Chart of Accounts" },
  { key: "customers", label: "Customers" },
  { key: "vendors",   label: "Vendors" },
  { key: "items",     label: "Items / Products & Services" },
];

const BUCKET_META = {
  in_sync:       { label: "In sync",       tone: "text-emerald-700 bg-emerald-50 border-emerald-200" },
  field_drift:   { label: "Field drift",   tone: "text-amber-700 bg-amber-50 border-amber-200" },
  push_to_qbo:   { label: "Push to QBO",   tone: "text-indigo-700 bg-indigo-50 border-indigo-200" },
  pull_from_qbo: { label: "Pull from QBO", tone: "text-sky-700 bg-sky-50 border-sky-200" },
};

export default function QboMirror() {
  const { currentId } = useCompany();
  const [config, setConfig] = useState(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [report, setReport] = useState(null);
  const [logEntries, setLogEntries] = useState([]);

  const loadConfig = async () => {
    const r = await api.get(`/companies/${currentId}/qbo/mirror/config`);
    setConfig(r.data);
  };
  const loadLog = async () => {
    const r = await api.get(`/companies/${currentId}/qbo/mirror/log?limit=25`);
    setLogEntries(r.data?.entries || []);
  };
  useEffect(() => {
    if (!currentId) return;
    loadConfig().catch(e => toast.error(`Load config failed: ${e.message}`));
    loadLog().catch(() => {});
  }, [currentId]);

  const patchConfig = async (patch) => {
    setSaving(true);
    try {
      const r = await api.put(`/companies/${currentId}/qbo/mirror/config`, patch);
      setConfig(r.data);
      await loadLog();
      toast.success("Config saved");
    } catch (e) {
      toast.error(`Save failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setSaving(false); }
  };

  const runDryRun = async () => {
    setRunning(true);
    setReport(null);
    try {
      const r = await api.post(`/companies/${currentId}/qbo/mirror/dry-run`);
      if (r.data?.error) {
        toast.error(r.data.error);
      } else {
        setReport(r.data);
        toast.success("Dry-run complete — no writes were made.");
      }
      await loadLog();
    } catch (e) {
      toast.error(`Dry-run failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setRunning(false); }
  };

  const runPull = async () => {
    // Only Foundation entities. Enabled entities from the config are
    // sent so the executor respects the user's checkbox choices.
    const entities = Object.entries(config.entities || {})
      .filter(([_, v]) => v)
      .map(([k]) => k)
      .filter(k => ["accounts", "customers", "vendors", "items"].includes(k));
    if (!entities.length) {
      toast.error("Enable at least one Foundation entity first.");
      return;
    }
    const proceed = confirm(
      "Pull missing rows from QBO into our system for: " +
      entities.join(", ") + "?\n\n" +
      "QBO Wins policy — any drifted field will be overwritten with " +
      "QBO's value. This never touches invoices, bills, payments, or " +
      "any ledger data. Safe to re-run."
    );
    if (!proceed) return;
    setPulling(true);
    try {
      const r = await api.post(`/companies/${currentId}/qbo/mirror/pull`,
                                { entities });
      if (r.data?.error) {
        toast.error(r.data.error);
      } else {
        const t = r.data.totals || {};
        toast.success(
          `Pull complete — inserted ${t.inserted || 0}, updated ${t.updated || 0}`
        );
        // Refresh the preview so the user sees the new baseline (all
        // zeros in Push/Pull ideally).
        setReport(null);
        await runDryRun();
      }
      await loadLog();
    } catch (e) {
      toast.error(`Pull failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setPulling(false); }
  };

  const runPush = async () => {
    const entities = Object.entries(config.entities || {})
      .filter(([_, v]) => v)
      .map(([k]) => k)
      .filter(k => ["accounts", "customers", "vendors", "items"].includes(k));
    if (!entities.length) {
      toast.error("Enable at least one Foundation entity first.");
      return;
    }
    const proceed = confirm(
      "⚠️ THIS WRITES TO QBO ⚠️\n\n" +
      "Push local-only rows from our system → QBO for: " +
      entities.join(", ") + "?\n\n" +
      "Only rows created in our app (with no qbo_id yet) will be sent. " +
      "Existing QBO entities are never modified. Failures per row are " +
      "shown after — nothing is atomic.\n\n" +
      "Run Preview first to see how many rows will be pushed."
    );
    if (!proceed) return;
    setPushing(true);
    try {
      const r = await api.post(`/companies/${currentId}/qbo/mirror/push`,
                                { entities });
      if (r.data?.error) {
        toast.error(r.data.error);
      } else {
        const t = r.data.totals || {};
        if (t.failed > 0) {
          toast.warning(
            `Push complete — created ${t.inserted || 0} on QBO, ` +
            `${t.failed} failed (see audit log for details).`
          );
        } else {
          toast.success(
            `Push complete — created ${t.inserted || 0} on QBO.`
          );
        }
        setReport(null);
        await runDryRun();
      }
      await loadLog();
    } catch (e) {
      toast.error(`Push failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setPushing(false); }
  };

  if (!config) {
    return (
      <div className="p-8 flex items-center gap-2 text-slate-500">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading mirror config…
      </div>
    );
  }

  const enabled = config.enabled === true;

  return (
    <div className="min-h-[calc(100vh-64px)] bg-slate-50">
      <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
              <a href="/connections/qbo" className="hover:underline flex items-center gap-1"
                 data-testid="mirror-back-qbo">
                <ArrowLeft size={12} /> QBO Connection
              </a>
            </div>
            <h1 className="text-2xl font-semibold text-slate-900 flex items-center gap-2">
              <GitBranch className="w-6 h-6 text-indigo-600" />
              QBO Live Mirror
              <span className="text-[10px] font-medium tracking-wider uppercase px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200">
                Phase 1c · Bi-directional Foundation
              </span>
            </h1>
            <p className="text-sm text-slate-600 mt-1 max-w-2xl">
              Keep our system in bi-directional sync with QuickBooks Online.
              Ideal for prospects trialing our app before shutting down QBO.
              This early phase runs in <strong>preview mode only</strong> — nothing
              is written to QBO until we unlock live mode in a later release.
            </p>
          </div>
          {config.master_disabled ? (
            <div className="text-xs px-3 py-2 rounded-md border border-rose-300 bg-rose-50 text-rose-800 flex items-center gap-2">
              <ShieldAlert size={14} /> Master switch OFF (env)
            </div>
          ) : (
            <div className={`text-xs px-3 py-2 rounded-md border inline-flex items-center gap-2
                ${enabled ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                          : "border-slate-300 bg-white text-slate-600"}`}>
              <ShieldCheck size={14} /> Mirror {enabled ? "ENABLED" : "OFF"}
            </div>
          )}
        </div>

        {/* Config panel */}
        <div className="bg-white border rounded-lg p-5 space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-slate-900">Enable mirror for this company</div>
              <div className="text-xs text-slate-500 mt-1 max-w-lg">
                When enabled, this company appears in the background sync
                queue. Nothing is written to QBO until dry-run is unlocked
                in Phase 1b.
              </div>
            </div>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={enabled}
                disabled={saving || config.master_disabled}
                onChange={(e) => patchConfig({ enabled: e.target.checked })}
                data-testid="mirror-enable-toggle"
                className="w-4 h-4 accent-indigo-600"
              />
              <span className="text-sm font-medium text-slate-800">
                {enabled ? "On" : "Off"}
              </span>
            </label>
          </div>

          <hr className="border-slate-200" />

          <div>
            <div className="text-sm font-medium text-slate-900 mb-2">
              Foundation entities to include
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {ENTITIES.map(e => (
                <label key={e.key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={config.entities?.[e.key] !== false}
                    disabled={saving || !enabled}
                    onChange={(ev) => patchConfig({
                      entities: { ...(config.entities || {}), [e.key]: ev.target.checked }
                    })}
                    data-testid={`mirror-entity-${e.key}`}
                    className="w-4 h-4 accent-indigo-600"
                  />
                  <span className="text-slate-700">{e.label}</span>
                </label>
              ))}
            </div>
            <div className="text-xs text-slate-500 mt-2 flex items-start gap-1.5">
              <Info size={12} className="mt-0.5 flex-shrink-0" />
              Later phases add Invoices, Bills, Purchases, Deposits, Transfers,
              Payments, Bill Payments, and Journal Entries.
            </div>
          </div>

          <hr className="border-slate-200" />

          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Conflict policy</div>
              <div className="text-sm text-slate-900 font-medium">QBO Wins</div>
              <div className="text-xs text-slate-500 mt-0.5">
                Safest default while trialing. Configurable in Phase 4.
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Sync cadence</div>
              <div className="text-sm text-slate-900 font-medium">Manual preview</div>
              <div className="text-xs text-slate-500 mt-0.5">
                Real-time webhooks + 15-min CDC in Phase 3.
              </div>
            </div>
          </div>
        </div>

        {/* Preview & Pull actions */}
        <div className="bg-white border rounded-lg p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-slate-900">
                Preview & Pull
              </div>
              <div className="text-xs text-slate-500 mt-1 max-w-xl">
                <strong>Preview</strong> reads both sides and shows what
                a live sync <em>would</em> do — zero writes.{" "}
                <strong>Pull now</strong> executes an inbound-only sync:
                inserts missing rows and overwrites drifted fields with
                QBO's version (QBO Wins policy).{" "}
                <strong>Push now</strong> executes an outbound-only sync:
                creates local-only rows (no <code>qbo_id</code>) on QBO.
                Neither touches ledger data.
              </div>
            </div>
            <div className="flex gap-2 flex-shrink-0 flex-wrap justify-end">
              <button
                onClick={runDryRun}
                disabled={running || pulling || pushing || !enabled}
                data-testid="mirror-run-dryrun-btn"
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
              >
                {running ? <><Loader2 className="w-4 h-4 animate-spin" /> Preview…</>
                         : <><Play size={14} /> Preview</>}
              </button>
              <button
                onClick={runPull}
                disabled={running || pulling || pushing || !enabled}
                data-testid="mirror-run-pull-btn"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
              >
                {pulling ? <><Loader2 className="w-4 h-4 animate-spin" /> Pulling…</>
                         : <><ArrowLeft size={14} /> Pull now (QBO → us)</>}
              </button>
              <button
                onClick={runPush}
                disabled={running || pulling || pushing || !enabled}
                data-testid="mirror-run-push-btn"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
                title="Writes to QBO — new local rows get created on Intuit's side"
              >
                {pushing ? <><Loader2 className="w-4 h-4 animate-spin" /> Pushing…</>
                         : <><ArrowRight size={14} /> Push now (us → QBO)</>}
              </button>
            </div>
          </div>
        </div>

        {/* Report */}
        {report && (
          <div className="bg-white border rounded-lg p-5 space-y-4"
               data-testid="mirror-report">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">
                Dry-run report
              </h2>
              <div className="text-xs text-slate-500">
                realm: <code className="text-slate-700">{report.realm_id || "—"}</code>
              </div>
            </div>

            {/* Summary tiles */}
            <div className="grid grid-cols-4 gap-3">
              {[
                ["total_in_sync",  "In sync",  "text-emerald-700 bg-emerald-50 border-emerald-200"],
                ["total_drift",    "Drift",    "text-amber-700 bg-amber-50 border-amber-200"],
                ["total_push",     "→ Push",   "text-indigo-700 bg-indigo-50 border-indigo-200"],
                ["total_pull",     "← Pull",   "text-sky-700 bg-sky-50 border-sky-200"],
              ].map(([k, lbl, tone]) => (
                <div key={k} className={`border rounded-md px-3 py-2 ${tone}`}>
                  <div className="text-2xl font-semibold">{report.summary?.[k] ?? 0}</div>
                  <div className="text-[11px] uppercase tracking-wide">{lbl}</div>
                </div>
              ))}
            </div>

            {/* Per-entity breakdown */}
            <div className="space-y-3">
              {(report.reports || []).map(r => (
                <div key={r.entity} className="border rounded-md p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-sm font-medium text-slate-900 capitalize">
                      {r.entity}
                    </div>
                    {r.error ? (
                      <span className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-full px-2 py-0.5">
                        Error: {r.error}
                      </span>
                    ) : (
                      <div className="flex gap-1.5 flex-wrap">
                        {Object.entries(r.totals || {}).map(([k, v]) => (
                          <span key={k} className={`text-[11px] px-2 py-0.5 rounded-full border ${BUCKET_META[k]?.tone || ""}`}>
                            {BUCKET_META[k]?.label || k}: <b>{v}</b>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Sample rows for buckets with actionable items */}
                  {["field_drift", "push_to_qbo", "pull_from_qbo"].map(bucket => {
                    const rows = (r.samples || {})[bucket] || [];
                    if (!rows.length) return null;
                    return (
                      <details key={bucket} className="mt-2">
                        <summary className="text-xs text-slate-600 hover:text-slate-900 cursor-pointer inline-flex items-center gap-1">
                          {bucket === "push_to_qbo" && <ArrowRight size={10} />}
                          {bucket === "pull_from_qbo" && <ArrowLeft size={10} />}
                          {BUCKET_META[bucket]?.label} — {rows.length} shown
                        </summary>
                        <div className="mt-2 border rounded overflow-hidden bg-slate-50">
                          <table className="w-full text-xs">
                            <thead className="bg-slate-100 text-slate-600">
                              <tr>
                                <th className="text-left px-2 py-1">Name</th>
                                {bucket === "field_drift"
                                  ? <th className="text-left px-2 py-1">Drifted fields</th>
                                  : <th className="text-left px-2 py-1">qbo_id</th>}
                              </tr>
                            </thead>
                            <tbody className="divide-y">
                              {rows.map((row, i) => {
                                const nm = bucket === "field_drift"
                                  ? row.local?.name
                                  : row.name;
                                const meta = bucket === "field_drift"
                                  ? (row.fields || []).join(", ")
                                  : (row.qbo_id || "—");
                                return (
                                  <tr key={i} className="bg-white">
                                    <td className="px-2 py-1 text-slate-800">{nm}</td>
                                    <td className="px-2 py-1 text-slate-600">{meta}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Audit log */}
        <div className="bg-white border rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-slate-900">Audit log</h2>
            <button onClick={loadLog}
              className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900"
              data-testid="mirror-refresh-log">
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
          {logEntries.length === 0 ? (
            <div className="text-xs text-slate-500">No activity yet.</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {logEntries.map((e, i) => (
                <li key={i} className="py-2 text-xs">
                  <details>
                    <summary className="flex items-start gap-3 cursor-pointer hover:bg-slate-50 rounded px-1 -mx-1">
                      <span className={`px-1.5 py-0.5 rounded font-medium border
                        ${e.kind === "config_change" ? "bg-slate-50 border-slate-200 text-slate-700"
                        : e.kind === "dry_run"       ? "bg-indigo-50 border-indigo-200 text-indigo-700"
                        : e.kind === "mirror_pull"   ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                        : e.kind === "mirror_push"   ? "bg-violet-50 border-violet-200 text-violet-700"
                        : e.kind === "warning"       ? "bg-amber-50 border-amber-200 text-amber-700"
                        : e.kind === "error"         ? "bg-rose-50 border-rose-200 text-rose-700"
                                                     : "bg-slate-50 border-slate-200 text-slate-700"}`}>
                        {e.kind}
                      </span>
                      <div className="flex-1">
                        <div className="text-slate-800">{e.message}</div>
                        <div className="text-slate-400 text-[10px] mt-0.5">
                          {e.created_at}
                        </div>
                      </div>
                    </summary>
                    {e.details && Object.keys(e.details).length > 0 && (
                      <pre className="mt-2 ml-6 p-2 bg-slate-900 text-slate-100 rounded text-[10px] overflow-x-auto whitespace-pre-wrap max-h-96">
                        {JSON.stringify(e.details, null, 2)}
                      </pre>
                    )}
                  </details>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
