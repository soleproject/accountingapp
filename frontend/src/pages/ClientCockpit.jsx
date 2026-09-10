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
  CheckCircle2, Clock,
  Loader2, RefreshCw, Users,
} from "lucide-react";
import ResponsibilitiesPanel from "@/components/ResponsibilitiesPanel";
import ThreadInbox from "@/components/cockpit/ThreadInbox";
import CashFlowMonitorCard from "@/components/cockpit/CashFlowMonitorCard";
import AssignedAgentsCard from "@/components/cockpit/AssignedAgentsCard";

export default function ClientCockpit() {
  const { currentId, companies } = useCompany();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [waitingOpen, setWaitingOpen] = useState(false);
  const [answersOpen, setAnswersOpen] = useState(false);

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

      {/* Vitals strip — 2 tiles. "Waiting on Client" is now a toggle
          that expands the ThreadInbox directly below (replaces the
          old middle Waiting card in the status section). */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3" data-testid="client-cockpit-vitals">
        <VitalCard
          testid="vital-waiting-on-client"
          label="Waiting on Client"
          value={vitals.open_questions}
          tone={vitals.open_questions > 0 ? "blue" : "green"}
          icon={<Clock size={14} />}
          active={waitingOpen}
          onClick={() => setWaitingOpen(v => !v)}
        />
        <VitalCard
          testid="vital-answered-unreviewed"
          label="Answers to review"
          value={vitals.answered_unreviewed}
          tone={vitals.answered_unreviewed > 0 ? "emerald" : "green"}
          icon={<CheckCircle2 size={14} />}
          active={answersOpen}
          onClick={() => setAnswersOpen(v => !v)}
        />
      </div>

      {/* Waiting on Client inbox — expands directly under the vitals
          when the top tile is clicked. */}
      {waitingOpen && (
        <div className="rounded-xl border bg-white p-3" data-testid="waiting-on-client-inbox">
          <ThreadInbox
            companyId={co.id}
            companyName={co.name}
            endpoint="waiting-on-client"
            mode="waiting"
            onDataChange={load}
          />
        </div>
      )}

      {/* Answers to Review inbox — same pattern, scoped to answered
          threads with the review-state filter. */}
      {answersOpen && (
        <div className="rounded-xl border bg-white p-3" data-testid="client-answers-inbox">
          <ThreadInbox
            companyId={co.id}
            companyName={co.name}
            endpoint="client-answers"
            mode="answers"
            onDataChange={load}
          />
        </div>
      )}

      {/* Client Status — Assigned Agents only. The two inboxes above
          are triggered from the top vitals row directly. Monitoring
          Cash Flow lives inside the Monthly Responsibilities panel. */}
      <div className="space-y-2" data-testid="client-cockpit-status">
        <AssignedAgentsCard  companyId={co.id} companyName={co.name} />
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
          preamble={<CashFlowMonitorCard companyId={co.id} />}
        />
      </div>
    </div>
  );
}

function VitalCard({ testid, label, value, tone, icon, linkTo, onClick, active }) {
  const tones = {
    green:   "border-emerald-200 bg-emerald-50 text-emerald-900",
    amber:   "border-amber-200 bg-amber-50 text-amber-900",
    blue:    "border-blue-200 bg-blue-50 text-blue-900",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-900",
  };
  const body = (
    <div
      className={`rounded-lg border p-3 text-left transition ${tones[tone] || tones.blue} ${
        active ? "ring-2 ring-blue-500 ring-offset-1" : ""
      }`}
      data-testid={testid}
    >
      <div className="text-[10px] uppercase tracking-wider font-semibold flex items-center gap-1 opacity-70">
        {icon} {label}
      </div>
      <div className="text-2xl font-bold mt-1 font-mono-num">{value ?? 0}</div>
    </div>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="block w-full hover:brightness-95 transition">
        {body}
      </button>
    );
  }
  return linkTo ? <Link to={linkTo} className="block hover:brightness-95 transition">{body}</Link> : body;
}
