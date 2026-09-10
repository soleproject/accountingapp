/**
 * AssignedAgentsCard — client-scoped + firm-wide agents.
 *
 * Grouped side-by-side (per user preference: "both, visually separated").
 * Each row shows the template name, cadence, enabled state, last-run
 * status, findings count, and a deep link into /cockpit/agents/{id}.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Bot, Zap, CheckCircle2, AlertTriangle, Circle, Loader2, ExternalLink, Building2, Globe } from "lucide-react";
import { api } from "@/lib/api";
import ClientCockpitCard from "./ClientCockpitCard";

const STATUS_TONE = {
  completed: "text-emerald-700",
  running:   "text-blue-700",
  failed:    "text-red-700",
  queued:    "text-slate-500",
};

const statusIcon = (status) => {
  if (status === "completed") return <CheckCircle2 size={11} className="text-emerald-600" />;
  if (status === "failed")    return <AlertTriangle size={11} className="text-red-600" />;
  if (status === "running")   return <Loader2 size={11} className="animate-spin text-blue-600" />;
  return <Circle size={11} className="text-slate-400" />;
};

const daysAgo = (iso) => {
  if (!iso) return "never";
  try {
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  } catch { return "recent"; }
};

export default function AssignedAgentsCard({ companyId, companyName }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(null);

  const load = useCallback(async () => {
    if (!companyId) return;
    setBusy(true);
    try {
      const r = await api.get(`/companies/${companyId}/cockpit-cards/assigned-agents`);
      setData(r.data);
    } finally {
      setBusy(false);
    }
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  const client = data?.client_agents || [];
  const firm = data?.firm_agents || [];
  const totalActive = (data?.counts?.client_enabled ?? 0) + (data?.counts?.firm_enabled ?? 0);
  const totalAll = (data?.counts?.client_total ?? 0) + (data?.counts?.firm_total ?? 0);
  const tone = totalAll === 0 ? "slate" : totalActive === 0 ? "amber" : "blue";
  const label = totalAll === 0 ? "None assigned" : totalActive === 0 ? "All paused" : `${totalActive} active`;

  const runNow = async (agentId) => {
    setToggleBusy(agentId);
    try {
      await api.post(`/agents/${agentId}/run-now`);
      await load();
    } finally {
      setToggleBusy(null);
    }
  };

  const toggleEnabled = async (agent) => {
    setToggleBusy(agent.id);
    try {
      await api.patch(`/agents/${agent.id}`, { enabled: !agent.enabled });
      await load();
    } finally {
      setToggleBusy(null);
    }
  };

  return (
    <ClientCockpitCard
      testid="card-assigned-agents"
      icon={<Bot size={16} className={tone === "amber" ? "text-amber-600" : "text-indigo-600"} />}
      title="Assigned Agents"
      subtitle={
        totalAll === 0
          ? "No agents assigned to this client yet."
          : `${data.counts.client_enabled}/${data.counts.client_total} client · ${data.counts.firm_enabled}/${data.counts.firm_total} firm-wide`
      }
      statusLabel={label}
      statusTone={tone}
      count={totalActive}
      isOpen={open}
      onToggle={() => setOpen(v => !v)}
      onRefresh={load}
      refreshing={busy}
    >
      {data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <AgentGroup
            title="Client-specific"
            subtitle={`Scoped to ${companyName || "this client"}`}
            icon={<Building2 size={13} className="text-slate-500" />}
            agents={client}
            emptyText="No agents scoped to this client yet."
            runNow={runNow}
            toggleEnabled={toggleEnabled}
            toggleBusy={toggleBusy}
            groupTestid="agent-group-client"
            newAgentLink={`/cockpit/agents?company_id=${companyId}`}
          />
          <AgentGroup
            title="Firm-wide"
            subtitle="Runs across every accessible client"
            icon={<Globe size={13} className="text-slate-500" />}
            agents={firm}
            emptyText="No firm-wide agents configured."
            runNow={runNow}
            toggleEnabled={toggleEnabled}
            toggleBusy={toggleBusy}
            groupTestid="agent-group-firm"
            newAgentLink="/cockpit/agents"
          />
        </div>
      )}
    </ClientCockpitCard>
  );
}

function AgentGroup({ title, subtitle, icon, agents, emptyText, runNow, toggleEnabled, toggleBusy, groupTestid, newAgentLink }) {
  return (
    <div className="border rounded-lg bg-white" data-testid={groupTestid}>
      <div className="px-3 py-2 border-b bg-slate-50/60 flex items-center gap-2">
        {icon}
        <div className="text-xs font-semibold text-slate-800">{title}</div>
        <div className="text-[10px] text-slate-500">· {subtitle}</div>
        <Link
          to={newAgentLink}
          className="ml-auto text-[10px] text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
        >
          Manage <ExternalLink size={9} />
        </Link>
      </div>
      {agents.length === 0 ? (
        <div className="py-6 text-center text-xs text-slate-400">
          {emptyText}
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 max-h-[280px] overflow-y-auto">
          {agents.map(a => (
            <li key={a.id} className="px-3 py-2" data-testid={`agent-row-${a.id}`}>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-900 truncate">
                    {a.name || a.template_name}
                  </div>
                  <div className="text-[11px] text-slate-500 flex items-center gap-2 mt-0.5 flex-wrap">
                    <span className="uppercase tracking-wider">{a.schedule || "manual"}</span>
                    <span className="text-slate-300">·</span>
                    <span className={STATUS_TONE[a.last_run_status] || "text-slate-500"}>
                      <span className="inline-flex items-center gap-1">
                        {statusIcon(a.last_run_status)}
                        {a.last_run_status || "no runs yet"}
                      </span>
                    </span>
                    <span className="text-slate-300">·</span>
                    <span>{daysAgo(a.last_run_at)}</span>
                    {a.last_findings_count > 0 && (
                      <>
                        <span className="text-slate-300">·</span>
                        <span className="text-slate-700 font-medium">{a.last_findings_count} finding{a.last_findings_count === 1 ? "" : "s"}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-1">
                  <button
                    onClick={() => runNow(a.id)}
                    disabled={toggleBusy === a.id}
                    className="text-[10px] px-1.5 py-0.5 rounded border border-slate-300 hover:bg-slate-50 inline-flex items-center gap-1 disabled:opacity-40"
                    data-testid={`agent-run-${a.id}`}
                    title="Run now"
                  >
                    {toggleBusy === a.id ? <Loader2 size={9} className="animate-spin" /> : <Zap size={9} />}
                    Run
                  </button>
                  <button
                    onClick={() => toggleEnabled(a)}
                    disabled={toggleBusy === a.id}
                    className={`text-[10px] px-1.5 py-0.5 rounded border inline-flex items-center gap-1 disabled:opacity-40 ${
                      a.enabled
                        ? "bg-emerald-100 border-emerald-200 text-emerald-800"
                        : "bg-slate-100 border-slate-200 text-slate-600"
                    }`}
                    data-testid={`agent-toggle-${a.id}`}
                    title="Toggle enabled"
                  >
                    {a.enabled ? "On" : "Off"}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
