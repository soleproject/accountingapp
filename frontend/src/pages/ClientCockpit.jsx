/**
 * Client Cockpit — per-company control room for firm/pro users.
 *
 * Phase 1 goal: give the CPA a single-glance view of ONE client that
 * pulls together every piece of AI + human-decision work already
 * scattered across the app (close board, cleanup copilot, ask-client,
 * agent runs, pending proposals). No new AI, no new patterns — just a
 * facade over what exists.
 *
 * Reads `currentId` from CompanyContext so the top-nav company
 * switcher naturally re-scopes this page. The parent route
 * `/cockpit/client` stays stable across switches.
 */
import React, { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { toast } from "sonner";
import {
  Activity, AlertTriangle, Bot, CheckCircle2, Clock, Inbox,
  Loader2, MessageSquare, RefreshCw, Sparkles, Users, FileText, Play,
} from "lucide-react";
import ResponsibilitiesPanel from "@/components/ResponsibilitiesPanel";

const URGENCY_TONES = {
  red:   "border-l-red-500 bg-red-50/40",
  amber: "border-l-amber-500 bg-amber-50/40",
  blue:  "border-l-blue-500 bg-blue-50/40",
  green: "border-l-emerald-500 bg-emerald-50/40",
};

const AGENT_STATUS_TONES = {
  running:   "text-blue-700 bg-blue-100",
  completed: "text-emerald-700 bg-emerald-100",
  failed:    "text-red-700 bg-red-100",
  queued:    "text-slate-600 bg-slate-100",
};

const humanizeTemplate = (k) =>
  (k || "").replace(/__custom__/, "custom").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const daysAgo = (iso) => {
  if (!iso) return "";
  try {
    const dt = new Date(iso);
    const secs = Math.max(0, Math.round((Date.now() - dt.getTime()) / 1000));
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
    return `${Math.round(secs / 86400)}d ago`;
  } catch { return ""; }
};

export default function ClientCockpit() {
  const { currentId, companies } = useCompany();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [runningQuick, setRunningQuick] = useState(null);

  const load = useCallback(async () => {
    if (!currentId) return;
    setBusy(true);
    try {
      const r = await api.get(`/cockpit/company/${currentId}/overview`);
      setData(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load client cockpit.");
    } finally {
      setBusy(false);
    }
  }, [currentId]);

  useEffect(() => { load(); }, [load]);

  const runQuickAction = async (key) => {
    setRunningQuick(key);
    try {
      if (key === "cleanup_sweep") {
        await api.post("/cockpit/agents/run-once", {
          template_key: "cleanup_sweep",
          company_id: currentId,
        });
        toast.success("Cleanup Sweep queued.");
      } else if (key === "advisor_report") {
        await api.post(`/companies/${currentId}/advisor-reports/generate`);
        toast.success("Advisor report draft queued.");
      } else if (key === "nudge_all") {
        // Resend every open client question in one shot.
        const open = data?.waiting_on_client || [];
        for (const q of open) {
          try { await api.post(`/cockpit/requests/${q.id}/resend`); } catch { /* soft */ }
        }
        toast.success(`Nudged ${open.length} question${open.length === 1 ? "" : "s"}.`);
      }
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Action failed.");
    } finally {
      setRunningQuick(null);
    }
  };

  if (!currentId) {
    return (
      <div className="p-8 max-w-3xl mx-auto text-center" data-testid="client-cockpit-empty">
        <Users size={40} className="text-slate-300 mx-auto mb-3" />
        <div className="font-semibold text-slate-800">Pick a client to open the Cockpit</div>
        <div className="text-sm text-slate-500 mt-1">
          Use the client switcher up top. This tab shows the AI activity, human decisions, and waiting-on-client threads for whichever client you have selected.
        </div>
      </div>
    );
  }

  if (busy && !data) {
    return (
      <div className="p-12 flex items-center justify-center text-slate-400">
        <Loader2 className="animate-spin" size={24} />
      </div>
    );
  }
  if (!data) return null;

  const co = data.company || {};
  const vitals = data.vitals || {};
  const cps = data.close_status?.checkpoints || {};
  const closeOverall = data.close_status?.overall_status || "unknown";
  const period = data.period || "";

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-5" data-testid="client-cockpit-page">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">
            Client Cockpit
          </div>
          <div className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <span
              className="inline-block w-3 h-3 rounded-sm"
              style={{ background: co.primary_color || "#6366f1" }}
              aria-hidden
            />
            {co.name}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {period} close · {closeOverall.replace(/_/g, " ")}
          </div>
        </div>
        <button
          onClick={load}
          disabled={busy}
          className="text-sm px-3 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 inline-flex items-center gap-1.5 disabled:opacity-50"
          data-testid="client-cockpit-refresh"
        >
          <RefreshCw size={13} className={busy ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {/* Vitals strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3" data-testid="client-cockpit-vitals">
        <VitalCard
          testid="vital-uncategorized"
          label="Needs categorization"
          value={vitals.uncategorized_count}
          tone={vitals.uncategorized_count > 0 ? "amber" : "green"}
          icon={<AlertTriangle size={14} />}
          linkTo={`/accounting/ai-cleanup-review?company=${co.id}`}
        />
        <VitalCard
          testid="vital-open-questions"
          label="Open questions"
          value={vitals.open_questions}
          tone={vitals.open_questions > 0 ? "blue" : "green"}
          icon={<MessageSquare size={14} />}
          linkTo={`/cockpit/communications?company_ids=${co.id}&source=portal`}
        />
        <VitalCard
          testid="vital-answered-unreviewed"
          label="Answers to review"
          value={vitals.answered_unreviewed}
          tone={vitals.answered_unreviewed > 0 ? "emerald" : "green"}
          icon={<CheckCircle2 size={14} />}
          linkTo={`/cockpit/communications?company_ids=${co.id}&source=portal`}
        />
        <VitalCard
          testid="vital-pending-proposals"
          label="AI proposals pending"
          value={vitals.pending_proposals}
          tone={vitals.pending_proposals > 0 ? "blue" : "green"}
          icon={<Sparkles size={14} />}
          linkTo={`/accounting/transactions?company=${co.id}&filter=ai-proposal`}
        />
        <VitalCard
          testid="vital-running-agents"
          label="Agents running now"
          value={vitals.running_agents}
          tone={vitals.running_agents > 0 ? "blue" : "green"}
          icon={<Bot size={14} />}
          linkTo="/cockpit/agents"
        />
      </div>

      {/* Three-column body */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left — What the AI is doing */}
        <Panel title="What the AI is doing" icon={<Bot size={14} />} testid="panel-ai-activity">
          {data.agent_activity.length === 0 ? (
            <Empty text="No recent agent runs. Kick one off from Quick actions." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.agent_activity.map(r => (
                <li key={r.id} className="py-2 px-1 flex items-start justify-between gap-2" data-testid={`agent-run-${r.id}`}>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-900 truncate">
                      {humanizeTemplate(r.template_key)}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {daysAgo(r.started_at)}
                      {r.finding_count > 0 && ` · ${r.finding_count} finding${r.finding_count === 1 ? "" : "s"}`}
                    </div>
                  </div>
                  <span className={`text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded ${AGENT_STATUS_TONES[r.status] || "text-slate-600 bg-slate-100"}`}>
                    {r.status || "?"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* Middle — What needs a human decision */}
        <Panel title="What needs your decision" icon={<AlertTriangle size={14} />} testid="panel-decisions">
          {data.today_items.length === 0 ? (
            <Empty text="Nothing waiting on you for this client." />
          ) : (
            <ul className="space-y-2">
              {data.today_items.slice(0, 8).map(it => (
                <li key={it.id} data-testid={`today-item-${it.id}`}>
                  <Link
                    to={it.action_route}
                    className={`block border-l-2 pl-2 pr-2 py-1.5 rounded-r hover:bg-slate-50 ${URGENCY_TONES[it.urgency] || URGENCY_TONES.blue}`}
                  >
                    <div className="text-sm font-medium text-slate-900 flex items-center justify-between gap-2">
                      <span className="truncate">{it.title}</span>
                      {it.count > 1 && (
                        <span className="text-[10px] font-mono-num px-1 rounded bg-slate-200 text-slate-700 shrink-0">
                          {it.count}
                        </span>
                      )}
                    </div>
                    {it.subtitle && (
                      <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
                        {it.subtitle}
                      </div>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* Right — What we're waiting on */}
        <Panel title="Waiting on client" icon={<Clock size={14} />} testid="panel-waiting" action={
          data.waiting_on_client.length > 0 && (
            <button
              onClick={() => runQuickAction("nudge_all")}
              disabled={runningQuick === "nudge_all"}
              className="text-[11px] px-2 py-0.5 rounded bg-slate-800 text-white hover:bg-slate-700 disabled:opacity-50 inline-flex items-center gap-1"
              data-testid="client-cockpit-nudge-all"
            >
              {runningQuick === "nudge_all" ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
              Nudge all
            </button>
          )
        }>
          {data.waiting_on_client.length === 0 ? (
            <Empty text="Inbox zero on client questions." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.waiting_on_client.slice(0, 10).map(q => (
                <li key={q.id} className="py-2 px-1" data-testid={`waiting-${q.id}`}>
                  <div className="text-sm text-slate-900 line-clamp-2">
                    {q.question}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-2">
                    <span className="truncate">{q.to_email}</span>
                    {typeof q.days_since === "number" && (
                      <span className={`shrink-0 ${q.days_since >= 7 ? "text-red-600" : q.days_since >= 3 ? "text-amber-600" : ""}`}>
                        · {q.days_since === 0 ? "today" : `${q.days_since}d`}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {/* Quick actions — thin bar at bottom */}
      <div className="rounded-xl border bg-white p-3 flex items-center gap-2 flex-wrap" data-testid="client-cockpit-quick-actions">
        <span className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold mr-2">
          Quick actions
        </span>
        <QuickBtn
          testid="qa-cleanup"
          icon={<Play size={12} />}
          label="Run Cleanup Sweep"
          busy={runningQuick === "cleanup_sweep"}
          onClick={() => runQuickAction("cleanup_sweep")}
        />
        <QuickBtn
          testid="qa-advisor"
          icon={<FileText size={12} />}
          label="Draft advisor report"
          busy={runningQuick === "advisor_report"}
          onClick={() => runQuickAction("advisor_report")}
        />
        <Link
          to={`/accounting/month-close?ym=${period}&company=${co.id}`}
          className="text-xs px-2.5 py-1 rounded-md border border-slate-300 hover:bg-slate-50 inline-flex items-center gap-1"
          data-testid="qa-close-board"
        >
          <Activity size={12} /> Open close board
        </Link>
      </div>

      {/* Monthly responsibilities — the accountant-owned items from the
          onboarding responsibilities checklist. Shared items ("both")
          also render here. Month switcher inside the panel. */}
      <div className="rounded-xl border bg-white p-4" data-testid="client-cockpit-responsibilities">
        <div className="mb-3">
          <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">
            Monthly Responsibilities
          </div>
          <div className="text-sm font-semibold text-slate-900">Items you own for this client</div>
        </div>
        <ResponsibilitiesPanel
          companyId={co.id}
          scope="accountant"
          emptyStateHint="No accountant-owned items yet. Set responsibilities via the button above."
          returnLabel="Back to Client Cockpit"
          returnPath="/cockpit/client"
        />
      </div>
    </div>
  );
}

function VitalCard({ testid, label, value, tone, icon, linkTo }) {
  const tones = {
    green:   "border-emerald-200 bg-emerald-50 text-emerald-900",
    amber:   "border-amber-200 bg-amber-50 text-amber-900",
    blue:    "border-blue-200 bg-blue-50 text-blue-900",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-900",
  };
  const body = (
    <div className={`rounded-lg border p-3 ${tones[tone] || tones.blue}`} data-testid={testid}>
      <div className="text-[10px] uppercase tracking-wider font-semibold flex items-center gap-1 opacity-70">
        {icon} {label}
      </div>
      <div className="text-2xl font-bold mt-1 font-mono-num">{value ?? 0}</div>
    </div>
  );
  return linkTo ? <Link to={linkTo} className="block hover:brightness-95 transition">{body}</Link> : body;
}

function Panel({ title, icon, testid, action, children }) {
  return (
    <div className="rounded-xl border bg-white overflow-hidden" data-testid={testid}>
      <div className="px-3 py-2 border-b bg-slate-50/60 flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
          {icon} {title}
        </div>
        {action}
      </div>
      <div className="px-2 py-2 min-h-[220px]">
        {children}
      </div>
    </div>
  );
}

function Empty({ text }) {
  return (
    <div className="py-8 text-center text-xs text-slate-400 flex flex-col items-center gap-2">
      <Inbox size={20} className="text-slate-300" />
      {text}
    </div>
  );
}

function QuickBtn({ testid, icon, label, busy, onClick }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="text-xs px-2.5 py-1 rounded-md border border-slate-300 hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-1"
      data-testid={testid}
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : icon}
      {label}
    </button>
  );
}
