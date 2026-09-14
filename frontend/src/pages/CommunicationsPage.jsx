/**
 * Communications — cross-client transcript archive of every batch
 * review the platform has produced. Sits alongside the Cockpit as a
 * top-level Firm-scoped surface.
 *
 * MVP:
 *   * Cross-client list of threads (sorted most-recent-first).
 *   * Filter chips: All / Open / Completed / Expired.
 *   * Per-row: company name, subject, dates, unread-ish counters,
 *     latest snippet.
 *   * Click → detail page (see CommunicationsDetailPage.jsx).
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Loader2, MessageSquare, ArrowRight } from "lucide-react";

const STATUS_TABS = [
  { key: "any",       label: "All" },
  { key: "open",      label: "Open" },
  { key: "completed", label: "Completed" },
  { key: "expired",   label: "Expired" },
];

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const diffH = (now - d) / 3_600_000;
  if (diffH < 1)  return `${Math.max(1, Math.round(diffH * 60))}m ago`;
  if (diffH < 24) return `${Math.round(diffH)}h ago`;
  if (diffH < 24 * 7) return `${Math.round(diffH / 24)}d ago`;
  return d.toISOString().slice(0, 10);
}

function StatusPill({ status }) {
  const cfg = {
    open:      { bg: "bg-amber-50",   fg: "text-amber-800",   ring: "ring-amber-200",   label: "Open" },
    completed: { bg: "bg-emerald-50", fg: "text-emerald-800", ring: "ring-emerald-200", label: "Completed" },
    expired:   { bg: "bg-slate-100",  fg: "text-slate-600",   ring: "ring-slate-300",   label: "Expired" },
    scheduled: { bg: "bg-blue-50",    fg: "text-blue-800",    ring: "ring-blue-200",    label: "Scheduled" },
  }[status] || { bg: "bg-slate-100", fg: "text-slate-700", ring: "ring-slate-300", label: status || "—" };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-mono-num rounded ring-1 ${cfg.bg} ${cfg.fg} ${cfg.ring}`}>
      {cfg.label}
    </span>
  );
}

export default function CommunicationsPage() {
  const [status, setStatus] = useState("any");
  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const r = await api.get(`/comms/threads?status=${status}&limit=100`);
        if (!cancelled) setThreads(r.data?.threads || []);
      } catch (e) {
        if (!cancelled) setError(e?.response?.data?.detail || "Couldn't load threads.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [status]);

  const grouped = useMemo(() => {
    const byCompany = {};
    for (const t of threads) {
      (byCompany[t.company_name || "—"] ||= []).push(t);
    }
    return byCompany;
  }, [threads]);

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-4" data-testid="communications-page">
      <div className="flex items-center gap-3">
        <MessageSquare className="text-slate-500" size={22} />
        <h1 className="font-heading text-2xl font-semibold text-slate-900">
          Communications
        </h1>
      </div>
      <p className="text-sm text-slate-600 max-w-2xl">
        Every client review conversation, saved with all answers intact.
        Filter by state, click a thread to read the full transcript.
      </p>

      <div className="flex flex-wrap gap-1.5 border-b border-slate-200 pb-2">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            data-testid={`comms-tab-${t.key}`}
            onClick={() => setStatus(t.key)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition ${
              status === t.key
                ? "bg-slate-900 text-white"
                : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="py-10 flex items-center gap-2 text-slate-500 text-sm">
          <Loader2 className="animate-spin" size={16} /> Loading threads…
        </div>
      ) : error ? (
        <div className="border border-rose-200 bg-rose-50 rounded-lg p-4 text-sm text-rose-800">
          {error}
        </div>
      ) : threads.length === 0 ? (
        <div className="py-16 text-center text-slate-500">
          <MessageSquare className="mx-auto mb-2 opacity-50" size={32} />
          <div className="text-sm">No conversations {status !== "any" ? `in ${status}` : "yet"}.</div>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([companyName, rows]) => (
            <section key={companyName} data-testid={`comms-company-${companyName}`}>
              <h2 className="text-xs uppercase tracking-wide text-slate-500 mb-2 font-semibold">
                {companyName}
              </h2>
              <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 bg-white overflow-hidden">
                {rows.map((t) => (
                  <Link
                    key={t.thread_id}
                    to={`/communications/${t.thread_id}`}
                    className="group flex items-start gap-3 px-4 py-3 hover:bg-slate-50 transition"
                    data-testid={`comms-thread-${t.thread_id}`}
                  >
                    <div className="pt-1 shrink-0"><MessageSquare size={16} className="text-slate-400" /></div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-slate-900 truncate">{t.subject}</span>
                        <StatusPill status={t.status} />
                        <span className="text-[11px] text-slate-500 font-mono-num">
                          {t.answered_count}/{t.total_items} answered · {t.deferred_count} deferred
                        </span>
                      </div>
                      <div className="text-xs text-slate-500 truncate mt-0.5">
                        {t.snippet || "—"}
                      </div>
                      <div className="text-[11px] text-slate-400 mt-1 flex flex-wrap gap-x-3">
                        <span>Client: {t.client_email}</span>
                        <span>Updated {formatDate(t.updated_at)}</span>
                        <span>Started {formatDate(t.created_at)}</span>
                      </div>
                    </div>
                    <ArrowRight size={14} className="text-slate-300 group-hover:text-slate-500 mt-2" />
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
