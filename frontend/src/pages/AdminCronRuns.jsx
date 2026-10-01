/**
 * AdminCronRuns — tiny superadmin page showing the Emergent platform cron
 * runs that live in `db.cron_runs` (latest-per-cron) and `db.cron_run_history`
 * (append-only log of each sweep). Lets a pro confirm "last sweep ran at
 * 2:15am · 23 companies, 7 finalized, 2 errors" at a glance and fire a
 * manual sweep without waiting for the next scheduled fire.
 *
 * Route: /admin/cron-runs (fenced to superadmin role).
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { ChevronLeft, Clock, Play, RefreshCw, Loader2 } from "lucide-react";

export default function AdminCronRuns() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [msg, setMsg] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get("/cron/runs");
      setData(r.data);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const trigger = async () => {
    setTriggering(true);
    setMsg("");
    try {
      await api.post("/cron/runs/trigger");
      setMsg("Sweep enqueued — refreshing in a few seconds…");
      // Give the backgrounded sweep a moment to persist its breadcrumb.
      setTimeout(() => { load(); setMsg(""); }, 4000);
    } catch (e) {
      setMsg("Trigger failed — are you signed in as superadmin?");
    } finally {
      setTriggering(false);
    }
  };

  const fmtWhen = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleString();
  };
  const fmtAgo = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    const diffSec = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (diffSec < 60) return "just now";
    if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
    return `${Math.round(diffSec / 86400)}d ago`;
  };

  return (
    <div className="space-y-5" data-testid="admin-cron-runs">
      <div className="flex items-center gap-2 flex-wrap">
        <Link to="/superadmin" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900">
          <ChevronLeft size={14} /> Superadmin
        </Link>
        <h1 className="font-heading text-2xl font-bold tracking-tight ml-1">Cron Runs</h1>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={load}
            disabled={loading}
            data-testid="cron-runs-refresh"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh
          </button>
          <button
            onClick={trigger}
            disabled={triggering}
            data-testid="cron-runs-trigger"
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
            title="Fire the auto-finalize reconciliation sweep right now instead of waiting for 02:15 UTC"
          >
            {triggering ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Run sweep now
          </button>
        </div>
      </div>

      {msg && (
        <div className="rounded-md bg-cyan-50 border border-cyan-200 text-cyan-800 text-sm px-3 py-2">
          {msg}
        </div>
      )}

      {/* Latest-per-cron panel */}
      <div className="rounded-xl border bg-white overflow-hidden">
        <div className="px-4 py-3 border-b bg-slate-50">
          <div className="font-heading font-semibold text-sm">Latest run · per cron</div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            One row per scheduled job showing when it last fired and what it did.
          </div>
        </div>
        {loading ? (
          <div className="p-6 text-center text-xs text-slate-500">
            <Loader2 size={14} className="inline animate-spin mr-1" /> Loading…
          </div>
        ) : (data?.latest || []).length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500">
            No cron runs recorded yet. Click <strong>Run sweep now</strong> above to fire one.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-white text-xs uppercase text-slate-500 border-b">
              <tr>
                <th className="px-4 py-2 text-left">Cron</th>
                <th className="px-2 py-2 text-left whitespace-nowrap">Last run</th>
                <th className="px-2 py-2 text-right whitespace-nowrap">Companies</th>
                <th className="px-2 py-2 text-right whitespace-nowrap">Processed</th>
                <th className="px-2 py-2 text-right whitespace-nowrap">Finalized</th>
                <th className="px-2 py-2 text-right whitespace-nowrap">Skipped</th>
                <th className="px-2 py-2 text-right whitespace-nowrap">Errors</th>
                <th className="px-2 py-2 text-right whitespace-nowrap">Elapsed</th>
              </tr>
            </thead>
            <tbody>
              {(data?.latest || []).map(row => {
                const s = row.last_stats || {};
                return (
                  <tr key={row.name} className="border-b last:border-b-0 hover:bg-slate-50"
                      data-testid={`cron-run-latest-${row.name}`}>
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-900">{row.name}</div>
                    </td>
                    <td className="px-2 py-2.5">
                      <div className="text-xs text-slate-700">{fmtWhen(row.last_run_at)}</div>
                      <div className="text-[11px] text-slate-400">{fmtAgo(row.last_run_at)}</div>
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono text-xs">{s.companies ?? "—"}</td>
                    <td className="px-2 py-2.5 text-right font-mono text-xs">{s.processed ?? "—"}</td>
                    <td className="px-2 py-2.5 text-right font-mono text-xs font-semibold text-emerald-700">
                      {s.created ?? "—"}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono text-xs text-slate-500">
                      {s.skipped_stale ?? "—"}
                    </td>
                    <td className={`px-2 py-2.5 text-right font-mono text-xs ${s.errors ? "font-semibold text-rose-700" : "text-slate-400"}`}>
                      {s.errors ?? "—"}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono text-xs text-slate-500">
                      {s.elapsed_ms != null ? `${s.elapsed_ms}ms` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* History panel */}
      <div className="rounded-xl border bg-white overflow-hidden">
        <div className="px-4 py-3 border-b bg-slate-50 flex items-center gap-2">
          <Clock size={14} className="text-slate-500" />
          <div>
            <div className="font-heading font-semibold text-sm">Recent run history</div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              Last {(data?.history || []).length} runs across all cron jobs.
            </div>
          </div>
        </div>
        {loading ? (
          <div className="p-6 text-center text-xs text-slate-500">Loading…</div>
        ) : (data?.history || []).length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500">
            No history yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-white text-xs uppercase text-slate-500 border-b">
              <tr>
                <th className="px-4 py-2 text-left">Run at</th>
                <th className="px-2 py-2 text-left">Cron</th>
                <th className="px-2 py-2 text-right whitespace-nowrap">Companies</th>
                <th className="px-2 py-2 text-right whitespace-nowrap">Finalized</th>
                <th className="px-2 py-2 text-right whitespace-nowrap">Errors</th>
                <th className="px-2 py-2 text-right whitespace-nowrap">Elapsed</th>
              </tr>
            </thead>
            <tbody>
              {(data?.history || []).map((row, i) => {
                const s = row.stats || {};
                return (
                  <tr key={`${row.name}-${row.run_at}-${i}`}
                      className="border-b last:border-b-0 hover:bg-slate-50"
                      data-testid={`cron-run-history-${i}`}>
                    <td className="px-4 py-2">
                      <div className="text-xs text-slate-700">{fmtWhen(row.run_at)}</div>
                      <div className="text-[11px] text-slate-400">{fmtAgo(row.run_at)}</div>
                    </td>
                    <td className="px-2 py-2 text-slate-700">{row.name}</td>
                    <td className="px-2 py-2 text-right font-mono text-xs">{s.companies ?? "—"}</td>
                    <td className="px-2 py-2 text-right font-mono text-xs font-semibold text-emerald-700">
                      {s.created ?? "—"}
                    </td>
                    <td className={`px-2 py-2 text-right font-mono text-xs ${s.errors ? "font-semibold text-rose-700" : "text-slate-400"}`}>
                      {s.errors ?? "—"}
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-xs text-slate-500">
                      {s.elapsed_ms != null ? `${s.elapsed_ms}ms` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
