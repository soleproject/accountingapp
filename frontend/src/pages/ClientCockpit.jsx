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
  Activity, AlertTriangle, Bot, CheckCircle2,
  Loader2, MessageSquare, RefreshCw, Sparkles, Users, FileText, Play,
} from "lucide-react";
import ResponsibilitiesPanel from "@/components/ResponsibilitiesPanel";
import WaitingOnClientCard from "@/components/cockpit/WaitingOnClientCard";
import ClientAnswersCard from "@/components/cockpit/ClientAnswersCard";
import CashFlowMonitorCard from "@/components/cockpit/CashFlowMonitorCard";
import AssignedAgentsCard from "@/components/cockpit/AssignedAgentsCard";

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

      {/* Client Status — 4 cards replacing the old 3-column body.
          Waiting on Client + Client Answers reuse the Reconciling
          Accounts inline-dropdown pattern; Cash Flow Monitor + Assigned
          Agents follow the same shell. Order matters for scanability:
          most urgent → least. */}
      <div className="space-y-2" data-testid="client-cockpit-status">
        <WaitingOnClientCard companyId={co.id} companyName={co.name} />
        <ClientAnswersCard   companyId={co.id} companyName={co.name} />
        <CashFlowMonitorCard companyId={co.id} />
        <AssignedAgentsCard  companyId={co.id} companyName={co.name} />
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
