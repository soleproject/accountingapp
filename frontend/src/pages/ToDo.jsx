/**
 * To Do — the client-facing view of monthly responsibilities.
 *
 * Sibling of the Overview page under the Accounting product. Shows
 * every item where responsibility was assigned to `client` or `both`
 * at onboarding (or via the Responsibilities modal). Perpetual items
 * flow forward with live counts; month-scoped items filter per-period
 * when the month switcher moves.
 */
import React, { useEffect, useRef } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useCompany } from "@/lib/company";
import ResponsibilitiesPanel from "@/components/ResponsibilitiesPanel";
import AgentInquiriesCard from "@/components/AgentInquiriesCard";
import CashFlowMonitorCard from "@/components/cockpit/CashFlowMonitorCard";
import { Users, LayoutGrid, Sparkle, Grid3x3, CheckSquare, GraduationCap } from "lucide-react";

import PendingReviewCard from "@/components/PendingReviewCard";

/**
 * Small pill group mirroring the one on /dashboard so the CPA can jump
 * between Classic / Firm / Business dashboard views (persisted via
 * `dashboard_view` localStorage key), Cockpit (active here), and the
 * Onboarding wizard without hunting through the sidebar.
 */
function CockpitViewPills() {
  const navigate = useNavigate();
  const openDashboard = (view) => {
    try { localStorage.setItem("dashboard_view", view); } catch { /* ignore */ }
    navigate("/dashboard");
  };
  const dashPills = [
    { key: "classic", label: "Classic", Icon: LayoutGrid },
    { key: "firm", label: "Firm at a Glance", Icon: Sparkle },
    { key: "business", label: "Business Overview", Icon: Grid3x3 },
  ];
  return (
    <div className="flex items-center gap-2 flex-wrap" data-testid="cockpit-view-pills">
      <div
        role="tablist"
        aria-label="Dashboard view"
        className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 p-0.5"
      >
        {dashPills.map(({ key, label, Icon }) => (
          <button
            key={key}
            role="tab"
            onClick={() => openDashboard(key)}
            data-testid={`cockpit-view-${key}`}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 transition-colors"
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
      </div>
      <span
        aria-current="page"
        data-testid="cockpit-view-cockpit"
        className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-900 shadow-sm"
        title="You are on the Cockpit page"
      >
        <CheckSquare size={12} />
        Cockpit
      </span>
      <Link
        to="/onboarding"
        data-testid="cockpit-view-onboarding"
        className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition-colors shadow-sm"
        title="Run the onboarding wizard again"
      >
        <GraduationCap size={12} />
        Onboarding
      </Link>
    </div>
  );
}

export default function ToDo() {
  const { currentId, current } = useCompany();
  const [searchParams, setSearchParams] = useSearchParams();
  const cleanupView = searchParams.get("view") === "cleanup";
  const panelRef = useRef(null);

  useEffect(() => {
    if (cleanupView && currentId) {
      const t = setTimeout(() => panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 400);
      return () => clearTimeout(t);
    }
  }, [cleanupView, currentId]);

  const clearCleanupView = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("view");
    setSearchParams(next, { replace: true });
  };

  if (!currentId) {
    return (
      <div className="p-8 max-w-3xl mx-auto text-center" data-testid="todo-empty-no-company">
        <Users size={40} className="text-slate-300 mx-auto mb-3" />
        <div className="font-semibold text-slate-800">Pick a company first</div>
        <div className="text-sm text-slate-500 mt-1">Use the switcher up top to open a client.</div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4" data-testid="todo-page">
      {/* Dashboard-view pill group — mirrors /dashboard so the CPA can hop
          between Classic / Firm / Business / Cockpit / Onboarding without
          going through the sidebar. Right-aligned in its own row so this
          page looks like another Dashboard tab. */}
      <div className="flex justify-end items-center gap-2">
        <CockpitViewPills />
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">
          Accounting · To Do
        </div>
        <div className="text-2xl font-bold text-slate-900" data-testid="todo-heading">
          {cleanupView ? `Clean-up items for ${current?.name}` : `Your monthly items for ${current?.name}`}
        </div>
        <p className="text-sm text-slate-500 mt-1">
          {cleanupView
            ? "Older items from before your books were current. Work through them at your own pace — nothing here blocks this month's close."
            : <>Everything on this page was assigned to you (or shared) at onboarding.
          Perpetual items (bills, invoices) stay live until cleared. Month-scoped
          items (recon, closing) reset each month — use the arrows to check what's
          still open from previous months.</>}
        </p>
      </div>

      {!cleanupView && <PendingReviewCard companyId={currentId} />}

      {!cleanupView && <AgentInquiriesCard companyId={currentId} />}

      <div className="rounded-xl border bg-white p-4" ref={panelRef}>
        <ResponsibilitiesPanel
          companyId={currentId}
          scope="client"
          emptyStateHint={cleanupView ? "No clean-up items — you're all caught up." : "No items assigned to you yet."}
          returnLabel="Back to To Do"
          returnPath={cleanupView ? "/accounting/todo?view=cleanup" : "/accounting/todo"}
          preamble={<CashFlowMonitorCard companyId={currentId} />}
          filter={cleanupView ? "cleanup" : null}
          onClearFilter={clearCleanupView}
        />
      </div>
    </div>
  );
}
