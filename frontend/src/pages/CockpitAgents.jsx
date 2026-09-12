import React, { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  Bot, Sparkles, FileEdit, FileBarChart2, Receipt, MessageSquare, BellRing,
  Play, Pause, Trash2, Plus, RefreshCw, Loader2, X, ChevronRight, Search,
  CheckCircle2, XCircle, AlertCircle, Clock, Circle, AlertTriangle, TrendingUp,
  ArrowLeftRight, Landmark, Banknote, ReceiptText, Activity, PieChart,
  FileWarning, ScanLine, Lightbulb, Presentation,
} from "lucide-react";

// --------------------------------------------------------------------------
// Cockpit → Agents  (Phase 5A — Agent Platform)
// Scheduled AI agents built on top of the workflows we've already shipped
// (Cleanup, JE Drafters, Advisor Reports, 1099, Portal, Sign-off).  Users
// pick from a template library, configure schedule + scope, and every
// run's findings roll up into the Today feed.
// --------------------------------------------------------------------------

const ICONS = {
  Sparkles, FileEdit, FileBarChart2, Receipt, MessageSquare, BellRing, Bot,
  AlertTriangle, TrendingUp, ArrowLeftRight, Landmark, Banknote, ReceiptText,
  Activity, PieChart, FileWarning, ScanLine, Lightbulb, Presentation,
};

const SCHEDULE_LABEL = {
  hourly: "Every hour",
  daily: "Every day",
  weekly: "Every week",
  monthly: "Every month",
  quarterly: "Every quarter",
};

const SEVERITY_STYLE = {
  red:   "bg-rose-50 text-rose-700 border-rose-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  blue:  "bg-sky-50 text-sky-700 border-sky-200",
  grey:  "bg-slate-50 text-slate-700 border-slate-200",
};

export default function CockpitAgents() {
  const [tab, setTab] = useState("mine"); // mine | library | runs
  const [templates, setTemplates] = useState([]);
  const [agents, setAgents] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [enableFor, setEnableFor] = useState(null); // template being enabled
  const [runOnceFor, setRunOnceFor] = useState(null); // template to run once
  const [runsDrawer, setRunsDrawer] = useState(null); // {agent}
  const [findings, setFindings] = useState([]);
  const [runbooks, setRunbooks] = useState([]);
  const [runbookTemplates, setRunbookTemplates] = useState([]);
  const [rbBusyId, setRbBusyId] = useState(null);
  const [filterCids, setFilterCids] = useState([]); // multi-select company filter
  const [analytics, setAnalytics] = useState(null);
  const [tools, setTools] = useState([]);
  const [agentFocus, setAgentFocus] = useState(null); // agent_id — when set, Findings tab shows only this agent's findings

  const load = async () => {
    setBusy(true);
    try {
      const [t, a, c, f, rb, rbt, an, tl] = await Promise.all([
        api.get("/cockpit/agents/templates"),
        api.get("/cockpit/agents"),
        api.get("/cockpit/accessible-companies"),
        api.get("/cockpit/agent-findings", { params: { status: "open", limit: 200 } }),
        api.get("/cockpit/runbooks"),
        api.get("/cockpit/runbook-templates"),
        api.get("/cockpit/agents/analytics"),
        api.get("/cockpit/agents/tools"),
      ]);
      setTemplates(t.data.templates || []);
      setAgents(a.data.agents || []);
      setCompanies(c.data.companies || []);
      setFindings(f.data.findings || []);
      setRunbooks(rb.data.runbooks || []);
      setRunbookTemplates(rbt.data.templates || []);
      setAnalytics(an.data || null);
      setTools(tl.data.tools || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load agents.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const nameById = useMemo(() => {
    const m = {};
    for (const c of companies) m[c.id] = c.name;
    return m;
  }, [companies]);

  const templateByKey = useMemo(() => {
    const m = {};
    for (const t of templates) m[t.key] = t;
    return m;
  }, [templates]);

  const findingsByAgent = useMemo(() => {
    const m = {};
    for (const f of findings) {
      m[f.agent_id] = m[f.agent_id] || [];
      m[f.agent_id].push(f);
    }
    return m;
  }, [findings]);

  // Live client-side company filter. Empty selection = show everything
  // (both firm-wide items with company_id=null AND every accessible client).
  const inFilter = (companyId) => {
    if (filterCids.length === 0) return true;
    return companyId ? filterCids.includes(companyId) : filterCids.includes("__firm__");
  };
  const filteredAgents = useMemo(() => agents.filter(a => inFilter(a.company_id)), [agents, filterCids]);
  const filteredFindings = useMemo(() => {
    let out = findings.filter(f => inFilter(f.company_id));
    if (agentFocus) out = out.filter(f => f.agent_id === agentFocus);
    return out;
  }, [findings, filterCids, agentFocus]);
  const filteredRunbooks = useMemo(() => runbooks.filter(r => inFilter(r.company_id)), [runbooks, filterCids]);

  // ---- Actions -----------------------------------------------------------
  const toggleEnabled = async (agent) => {
    setBusyId(agent.id);
    try {
      await api.patch(`/cockpit/agents/${agent.id}`, { enabled: !agent.enabled });
      toast.success(agent.enabled ? "Agent paused." : "Agent enabled.");
      await load();
    } catch (e) {
      toast.error("Toggle failed.");
    } finally { setBusyId(null); }
  };

  const runNow = async (agent) => {
    setBusyId(agent.id);
    try {
      const r = await api.post(`/cockpit/agents/${agent.id}/run-now`);
      if (r.data.ok) {
        toast.success(
          r.data.findings_count === 0
            ? "Agent ran clean — nothing to flag."
            : `Agent found ${r.data.findings_count} item${r.data.findings_count === 1 ? "" : "s"}.`
        );
      } else {
        toast.error(`Agent failed: ${r.data.error}`);
      }
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Run failed.");
    } finally { setBusyId(null); }
  };

  const deleteAgent = async (agent) => {
    if (!window.confirm(`Delete "${agent.name}"? Its run history and findings will also be removed.`)) return;
    setBusyId(agent.id);
    try {
      await api.delete(`/cockpit/agents/${agent.id}`);
      toast.success("Agent deleted.");
      await load();
    } catch (e) {
      toast.error("Delete failed.");
    } finally { setBusyId(null); }
  };

  const resolveFinding = async (finding, status) => {
    try {
      await api.patch(`/cockpit/agent-findings/${finding.id}`, { status });
      toast.success(status === "resolved" ? "Marked resolved." : "Dismissed.");
      await load();
    } catch (e) {
      toast.error("Update failed.");
    }
  };

  const applyContactFix = async (finding) => {
    try {
      const r = await api.post(`/cockpit/agent-findings/${finding.id}/apply-contact-fix`);
      toast.success("Contact reassigned.");
      await load();
      return r.data;
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Apply failed.");
    }
  };

  const undoContactFix = async (finding) => {
    try {
      const r = await api.post(`/cockpit/agent-findings/${finding.id}/undo-contact-fix`);
      toast.success("Reverted to previous contact.");
      await load();
      return r.data;
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Undo failed.");
    }
  };

  // ---- Runbook actions ---------------------------------------------------
  const seedRunbook = async (tmpl, companyId) => {
    setRbBusyId(tmpl.key);
    try {
      await api.post("/cockpit/runbooks/from-template", null, {
        params: { template_key: tmpl.key, company_id: companyId || undefined },
      });
      toast.success(`"${tmpl.name}" runbook created.`);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Create failed.");
    } finally { setRbBusyId(null); }
  };

  const runRunbookNow = async (rb) => {
    setRbBusyId(rb.id);
    try {
      const r = await api.post(`/cockpit/runbooks/${rb.id}/run-now`);
      const label = r.data.status;
      const detail = `${r.data.findings_count} finding${r.data.findings_count === 1 ? "" : "s"} across ${r.data.step_results.length} step${r.data.step_results.length === 1 ? "" : "s"}`;
      if (label === "success") toast.success(`Runbook complete — ${detail}.`);
      else if (label === "partial") toast.warning(`Runbook partial — ${detail}.`);
      else if (label === "halted") toast.error(`Runbook halted — one step failed with 'stop' policy.`);
      else toast.info(`Runbook done — ${detail}.`);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Run failed.");
    } finally { setRbBusyId(null); }
  };

  const toggleRunbook = async (rb) => {
    setRbBusyId(rb.id);
    try {
      await api.patch(`/cockpit/runbooks/${rb.id}`, { enabled: !rb.enabled });
      toast.success(rb.enabled ? "Runbook paused." : "Runbook enabled.");
      await load();
    } catch (e) { toast.error("Toggle failed."); }
    finally { setRbBusyId(null); }
  };

  const deleteRunbook = async (rb) => {
    if (!window.confirm(`Delete runbook "${rb.name}"? Its run history will also be removed.`)) return;
    setRbBusyId(rb.id);
    try {
      await api.delete(`/cockpit/runbooks/${rb.id}`);
      toast.success("Runbook deleted.");
      await load();
    } catch (e) { toast.error("Delete failed."); }
    finally { setRbBusyId(null); }
  };

  const createRunbook = async (payload) => {
    try {
      await api.post("/cockpit/runbooks", payload);
      toast.success(`"${payload.name}" runbook created.`);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Create failed.");
      throw e;
    }
  };

  const createCustomAgent = async (payload) => {
    try {
      await api.post("/cockpit/agents/custom", payload);
      toast.success(`"${payload.name}" agent created.`);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Create failed.");
      throw e;
    }
  };

  // ---- Render ------------------------------------------------------------
  return (
    <div className="p-6 max-w-[1400px] mx-auto" data-testid="cockpit-agents-page">
      <div className="mb-5 flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">Cockpit</div>
          <h1 className="font-heading text-3xl font-bold tracking-tight text-slate-900">Agents</h1>
          <p className="text-sm text-slate-500 mt-1">
            Scheduled AI coworkers that watch your books and flag anything worth your time.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <CompanyFilter
            companies={companies}
            selected={filterCids}
            onChange={setFilterCids}
          />
          <button
            onClick={load}
            disabled={busy}
            className="text-sm px-3 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50"
            data-testid="cockpit-agents-refresh"
          >
            <RefreshCw size={14} className={busy ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        <StatCard label="Enabled agents" value={filteredAgents.filter(a => a.enabled).length} tone="emerald" />
        <StatCard label="Runbooks" value={filteredRunbooks.length} tone="indigo" />
        <StatCard label="Open findings" value={filteredFindings.length} tone="amber" />
        <StatCard label="Available templates" value={templates.length} tone="slate" />
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-slate-200 mb-4">
        {[
          { key: "mine", label: `My Agents (${filteredAgents.length})` },
          { key: "library", label: `Template Library (${templates.length})` },
          { key: "runbooks", label: `Runbooks (${filteredRunbooks.length})` },
          { key: "runs", label: `Findings (${filteredFindings.length})` },
          { key: "analytics", label: `Analytics` },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            data-testid={`cockpit-agents-tab-${t.key}`}
            className={`text-sm px-3 py-2 border-b-2 -mb-px ${
              tab === t.key
                ? "border-indigo-600 text-indigo-700 font-semibold"
                : "border-transparent text-slate-600 hover:text-slate-900"
            }`}
          >{t.label}</button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "mine" && (
        <MyAgents
          agents={filteredAgents}
          templateByKey={templateByKey}
          nameById={nameById}
          findingsByAgent={findingsByAgent}
          busyId={busyId}
          onToggle={toggleEnabled}
          onRunNow={runNow}
          onDelete={deleteAgent}
          onOpenRuns={(a) => setRunsDrawer({ agent: a })}
          onEnableTemplate={() => setTab("library")}
        />
      )}
      {tab === "library" && (
        <Library
          templates={templates}
          agents={filteredAgents}
          onEnable={(t) => setEnableFor(t)}
          onRunOnce={(t) => setRunOnceFor(t)}
          tools={tools}
          companies={companies}
          onCreateCustom={createCustomAgent}
        />
      )}
      {tab === "runbooks" && (
        <Runbooks
          runbooks={filteredRunbooks}
          runbookTemplates={runbookTemplates}
          templateByKey={templateByKey}
          companies={companies}
          nameById={nameById}
          busyId={rbBusyId}
          onSeed={seedRunbook}
          onRunNow={runRunbookNow}
          onToggle={toggleRunbook}
          onDelete={deleteRunbook}
          onCreate={createRunbook}
        />
      )}
      {tab === "runs" && (
        <>
          {agentFocus && (
            <div
              className="mb-3 flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-indigo-50 border border-indigo-200 text-sm text-indigo-800"
              data-testid="cockpit-agents-findings-focus-chip"
            >
              <span>
                Filtered to <b>{(agents.find(a => a.id === agentFocus) || {}).name || "this agent"}</b>
                {" — "}
                <span className="font-mono-num">{filteredFindings.length}</span>
                {" finding"}{filteredFindings.length === 1 ? "" : "s"}
              </span>
              <button
                onClick={() => setAgentFocus(null)}
                className="text-xs px-2 py-0.5 rounded-md bg-white border border-indigo-300 hover:bg-indigo-100 font-medium"
                data-testid="cockpit-agents-findings-clear-focus"
              >
                Show all findings
              </button>
            </div>
          )}
          <FindingsList
            findings={filteredFindings}
            nameById={nameById}
            templateByKey={templateByKey}
            onResolve={resolveFinding}
            onApplyContactFix={applyContactFix}
            onUndoContactFix={undoContactFix}
          />
        </>
      )}
      {tab === "analytics" && (
        <Analytics analytics={analytics} filterCids={filterCids} />
      )}

      {enableFor && (
        <EnableModal
          template={enableFor}
          companies={companies}
          onClose={() => setEnableFor(null)}
          onCreated={async () => { setEnableFor(null); setTab("mine"); await load(); }}
        />
      )}

      {runOnceFor && (
        <RunOnceModal
          template={runOnceFor}
          companies={companies}
          onClose={() => setRunOnceFor(null)}
          onCompleted={async () => { setRunOnceFor(null); setTab("runs"); await load(); }}
        />
      )}

      {runsDrawer && (
        <RunsDrawer
          agent={runsDrawer.agent}
          onClose={() => setRunsDrawer(null)}
          onOpenFindings={(agentId) => {
            setAgentFocus(agentId);
            setTab("runs");
            setRunsDrawer(null);
          }}
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Sub-components
// --------------------------------------------------------------------------

function CompanyFilter({ companies, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const wrapperRef = React.useRef(null);
  const FIRM_KEY = "__firm__";

  React.useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const toggle = (val) => {
    onChange(selected.includes(val) ? selected.filter(v => v !== val) : [...selected, val]);
  };
  const clearAll = () => onChange([]);
  const nameById = useMemo(() => {
    const m = { [FIRM_KEY]: "Firm-wide" };
    for (const c of companies) m[c.id] = c.name;
    return m;
  }, [companies]);

  const filtered = companies.filter(c =>
    !search || (c.name || "").toLowerCase().includes(search.toLowerCase())
  );

  const label = selected.length === 0
    ? "All clients"
    : selected.length === 1
      ? nameById[selected[0]]
      : `${selected.length} clients`;

  return (
    <div className="relative" ref={wrapperRef} data-testid="cockpit-agents-company-filter">
      <button
        onClick={() => setOpen(v => !v)}
        className="text-sm px-3 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 flex items-center gap-1.5"
        data-testid="cockpit-agents-company-filter-button"
      >
        <Search size={14} className="text-slate-500" />
        <span className="text-slate-700">{label}</span>
        {selected.length > 0 && (
          <span className="text-[10px] uppercase font-semibold text-indigo-700 bg-indigo-100 rounded-full px-1.5 py-0.5">
            {selected.length}
          </span>
        )}
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-30 w-72 bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden"
          data-testid="cockpit-agents-company-filter-menu"
        >
          <div className="p-2 border-b border-slate-100">
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search clients…"
              className="w-full text-sm border border-slate-300 rounded-md px-2 py-1"
              data-testid="cockpit-agents-company-filter-search"
            />
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            <FilterRow
              label="Firm-wide agents"
              hint="Agents scoped to every client"
              checked={selected.includes(FIRM_KEY)}
              onToggle={() => toggle(FIRM_KEY)}
              testid="cockpit-agents-company-filter-option-firm"
            />
            <div className="text-[10px] uppercase font-semibold text-slate-400 px-3 pt-2 pb-1">Clients</div>
            {filtered.length === 0 ? (
              <div className="text-xs text-slate-400 px-3 py-2">No matches.</div>
            ) : (
              filtered.map(c => (
                <FilterRow
                  key={c.id}
                  label={c.name}
                  checked={selected.includes(c.id)}
                  onToggle={() => toggle(c.id)}
                  testid={`cockpit-agents-company-filter-option-${c.id}`}
                />
              ))
            )}
          </div>
          <div className="p-2 border-t border-slate-100 flex items-center justify-between">
            <button
              onClick={clearAll}
              disabled={selected.length === 0}
              className="text-xs text-slate-600 hover:text-slate-900 disabled:opacity-40"
              data-testid="cockpit-agents-company-filter-clear"
            >Clear</button>
            <button
              onClick={() => setOpen(false)}
              className="text-xs px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700"
              data-testid="cockpit-agents-company-filter-done"
            >Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

function FilterRow({ label, hint, checked, onToggle, testid }) {
  return (
    <button
      onClick={onToggle}
      className={`w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 flex items-center gap-2 ${checked ? "text-indigo-700 font-semibold" : "text-slate-700"}`}
      data-testid={testid}
    >
      <span className={`w-4 h-4 rounded border ${checked ? "bg-indigo-600 border-indigo-600" : "border-slate-300"} flex items-center justify-center shrink-0`}>
        {checked && <CheckCircle2 size={12} className="text-white" />}
      </span>
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {hint && <span className="text-[10px] text-slate-400">{hint}</span>}
    </button>
  );
}

function StatCard({ label, value, tone = "slate" }) {
  const toneCls = {
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
    amber:   "border-amber-200 bg-amber-50 text-amber-800",
    indigo:  "border-indigo-200 bg-indigo-50 text-indigo-800",
    slate:   "border-slate-200 bg-white text-slate-900",
  }[tone];
  return (
    <div className={`rounded-lg border ${toneCls} p-3`}>
      <div className="text-[10px] uppercase font-semibold opacity-70">{label}</div>
      <div className="text-2xl font-bold tabular-nums mt-1">{value}</div>
    </div>
  );
}

function Analytics({ analytics, filterCids }) {
  if (!analytics) {
    return <div className="text-center py-16 text-slate-400 text-sm">Loading analytics…</div>;
  }
  const { totals, prior_totals, delta, by_template, by_client, daily, period, assumptions } = analytics;
  const rows = filterCids && filterCids.length > 0
    ? by_client.filter(r => filterCids.includes(r.company_id) || (filterCids.includes("__firm__") && !r.company_id))
    : by_client;
  const templates = by_template || [];
  const maxTplCost = Math.max(0.0001, ...templates.map(t => t.cost));
  const maxClientCost = Math.max(0.0001, ...rows.map(t => t.cost));
  const fmtDollars = (n) => {
    const v = Number(n || 0);
    if (v === 0) return "$0.00";
    if (Math.abs(v) < 1) return `$${v.toFixed(3)}`;
    return `$${v.toFixed(2)}`;
  };
  const deltaLabel = delta.cost === 0
    ? "no change"
    : `${delta.cost > 0 ? "+" : "-"}${fmtDollars(Math.abs(delta.cost))} (${delta.cost_pct > 0 ? "+" : ""}${delta.cost_pct}%)`;
  const deltaClass = delta.cost > 0 ? "text-rose-700" : delta.cost < 0 ? "text-emerald-700" : "text-slate-500";

  return (
    <div className="space-y-4" data-testid="cockpit-agents-analytics">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="text-[10px] uppercase font-semibold text-slate-500">Spend {period}</div>
          <div className="text-2xl font-bold tabular-nums mt-1 text-slate-900">{fmtDollars(totals.cost)}</div>
          <div className={`text-[11px] mt-1 ${deltaClass}`}>vs prior: {deltaLabel}</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="text-[10px] uppercase font-semibold text-slate-500">Runs</div>
          <div className="text-2xl font-bold tabular-nums mt-1 text-slate-900">{totals.runs}</div>
          <div className="text-[11px] mt-1 text-slate-500">
            {totals.success} success · {totals.failed} failed
          </div>
        </div>
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
          <div className="text-[10px] uppercase font-semibold text-emerald-700">Findings surfaced</div>
          <div className="text-2xl font-bold tabular-nums mt-1 text-emerald-800">{totals.findings}</div>
          <div className="text-[11px] mt-1 text-emerald-700">
            {totals.runs > 0 ? `${(totals.findings / totals.runs).toFixed(2)}/run` : "—"}
          </div>
        </div>
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3">
          <div className="text-[10px] uppercase font-semibold text-indigo-700">Prior month</div>
          <div className="text-2xl font-bold tabular-nums mt-1 text-indigo-800">{fmtDollars(prior_totals?.cost)}</div>
          <div className="text-[11px] mt-1 text-indigo-700">{prior_totals?.runs || 0} runs</div>
        </div>
      </div>

      {/* Daily trend */}
      {daily && daily.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="text-xs uppercase font-semibold text-slate-500 mb-2">Daily spend · {period}</div>
          <div className="flex items-end gap-0.5 h-24">
            {(() => {
              const max = Math.max(0.0001, ...daily.map(d => d.cost));
              return daily.map(d => (
                <div key={d.date} className="flex-1 min-w-[3px] group relative">
                  <div
                    className="bg-indigo-500 hover:bg-indigo-600 rounded-sm transition-all"
                    style={{ height: `${(d.cost / max) * 100}%`, minHeight: d.cost > 0 ? "2px" : "0" }}
                    title={`${d.date}: ${fmtDollars(d.cost)} · ${d.runs} runs`}
                  />
                </div>
              ));
            })()}
          </div>
          <div className="flex justify-between text-[10px] text-slate-400 mt-1">
            <span>{daily[0]?.date}</span>
            <span>{daily[daily.length - 1]?.date}</span>
          </div>
        </div>
      )}

      {/* Breakdowns */}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="text-xs uppercase font-semibold text-slate-500 mb-3">Cost by template</div>
          {templates.length === 0 ? (
            <div className="text-sm text-slate-400 py-6 text-center">No runs yet this period.</div>
          ) : (
            <div className="space-y-2">
              {templates.slice(0, 10).map(t => (
                <div key={t.template_key} data-testid={`analytics-tpl-${t.template_key}`}>
                  <div className="flex items-center justify-between text-xs mb-0.5">
                    <span className="font-medium text-slate-800 truncate">{t.name}</span>
                    <span className="text-slate-500 tabular-nums">{fmtDollars(t.cost)} · {t.runs} runs</span>
                  </div>
                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-indigo-500"
                      style={{ width: `${(t.cost / maxTplCost) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="text-xs uppercase font-semibold text-slate-500 mb-3">Cost by client</div>
          {rows.length === 0 ? (
            <div className="text-sm text-slate-400 py-6 text-center">No runs yet this period.</div>
          ) : (
            <div className="space-y-2">
              {rows.slice(0, 10).map(r => (
                <div key={r.company_id || "firm"} data-testid={`analytics-client-${r.company_id || "firm"}`}>
                  <div className="flex items-center justify-between text-xs mb-0.5">
                    <span className="font-medium text-slate-800 truncate">{r.name}</span>
                    <span className="text-slate-500 tabular-nums">{fmtDollars(r.cost)} · {r.runs} runs</span>
                  </div>
                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-emerald-500"
                      style={{ width: `${(r.cost / maxClientCost) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="text-[11px] text-slate-400">
        Cost estimates: {assumptions?.deterministic_cost_cents}¢ per deterministic run,{" "}
        {assumptions?.llm_cost_cents}¢ per LLM-powered run. Real LLM token spend is tracked
        separately in Insights budget.
      </div>
    </div>
  );
}

function MyAgents({
  agents, templateByKey, nameById, findingsByAgent,
  busyId, onToggle, onRunNow, onDelete, onOpenRuns, onEnableTemplate,
}) {
  if (agents.length === 0) {
    return (
      <div className="text-center py-16 bg-white rounded-lg border border-dashed border-slate-300">
        <Bot size={40} className="mx-auto text-slate-300" />
        <div className="mt-3 font-semibold text-slate-800">No agents yet</div>
        <div className="text-sm text-slate-500 mt-1">
          Pick a starter agent from the Template Library to auto-watch your books.
        </div>
        <button
          onClick={onEnableTemplate}
          className="mt-4 text-sm px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700"
          data-testid="cockpit-agents-empty-cta"
        >
          Browse Templates
        </button>
      </div>
    );
  }
  return (
    <div className="grid gap-3">
      {agents.map(a => {
        const t = templateByKey[a.template_key] || {};
        const Icon = ICONS[t.icon] || Bot;
        const fCount = (findingsByAgent[a.id] || []).length;
        return (
          <div
            key={a.id}
            className="bg-white rounded-lg border border-slate-200 p-4 flex items-start gap-4"
            data-testid={`cockpit-agent-row-${a.id}`}
          >
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${a.enabled ? "bg-indigo-50 text-indigo-600" : "bg-slate-100 text-slate-400"}`}>
              <Icon size={20} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <div className="font-semibold text-slate-900">{a.name}</div>
                {!a.enabled && (
                  <span className="text-[10px] uppercase font-semibold text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">Paused</span>
                )}
                {fCount > 0 && (
                  <span className="text-[10px] uppercase font-semibold text-amber-700 bg-amber-100 rounded-full px-2 py-0.5">
                    {fCount} open
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                {SCHEDULE_LABEL[a.schedule] || a.schedule}
                {" · "}
                {a.company_id ? (nameById[a.company_id] || "Client") : "Firm-wide"}
                {a.last_run_at && (
                  <>
                    {" · Last run "}
                    <span className={a.last_run_status === "failed" ? "text-rose-600" : "text-emerald-600"}>
                      {new Date(a.last_run_at).toLocaleString()}
                    </span>
                  </>
                )}
              </div>
              {t.description && <div className="text-xs text-slate-500 mt-1">{t.description}</div>}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => onRunNow(a)}
                disabled={busyId === a.id}
                className="text-[11px] px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1"
                data-testid={`cockpit-agent-run-${a.id}`}
              >
                {busyId === a.id ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                Run now
              </button>
              <button
                onClick={() => onOpenRuns(a)}
                className="text-[11px] px-2 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-50 flex items-center gap-1"
                data-testid={`cockpit-agent-runs-${a.id}`}
              >
                Runs <ChevronRight size={11} />
              </button>
              <button
                onClick={() => onToggle(a)}
                disabled={busyId === a.id}
                title={a.enabled ? "Pause" : "Enable"}
                className="text-[11px] p-1.5 rounded border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                data-testid={`cockpit-agent-toggle-${a.id}`}
              >
                {a.enabled ? <Pause size={12} /> : <Play size={12} />}
              </button>
              <button
                onClick={() => onDelete(a)}
                disabled={busyId === a.id}
                title="Delete"
                className="text-[11px] p-1.5 rounded border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-50"
                data-testid={`cockpit-agent-delete-${a.id}`}
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Library({ templates, agents, onEnable, onRunOnce, tools, companies, onCreateCustom }) {
  const enabledKeys = new Set(agents.map(a => a.template_key));
  const [search, setSearch] = useState("");
  const [activeCat, setActiveCat] = useState("All");
  const [showCustomBuilder, setShowCustomBuilder] = useState(false);

  const categories = useMemo(() => {
    const cats = new Set();
    for (const t of templates) if (t.category) cats.add(t.category);
    return ["All", ...Array.from(cats).sort()];
  }, [templates]);

  const filtered = templates.filter(t => {
    if (activeCat !== "All" && t.category !== activeCat) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (t.name || "").toLowerCase().includes(q) || (t.description || "").toLowerCase().includes(q);
  });

  return (
    <div>
      {/* Build-from-scratch banner */}
      <div className="bg-gradient-to-br from-indigo-600 to-violet-600 text-white rounded-lg p-4 mb-4 flex items-start gap-4">
        <div className="w-10 h-10 rounded-lg bg-white/20 flex items-center justify-center shrink-0">
          <Bot size={22} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold">Build a custom agent from scratch</div>
          <div className="text-xs text-indigo-100 mt-0.5">
            Write your own prompt, pick which data slices the agent can read, and schedule it. LLM-powered.
          </div>
        </div>
        <button
          onClick={() => setShowCustomBuilder(true)}
          className="text-[11px] px-3 py-1.5 rounded bg-white text-indigo-700 hover:bg-indigo-50 font-semibold flex items-center gap-1 shrink-0"
          data-testid="cockpit-agents-build-from-scratch"
        >
          <Plus size={11} /> Build from scratch
        </button>
      </div>

      <div className="flex items-center gap-2 flex-wrap mb-3">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search templates…"
            className="w-full text-sm border border-slate-300 rounded-md pl-8 pr-3 py-1.5"
            data-testid="cockpit-agents-search"
          />
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {categories.map(c => (
            <button
              key={c}
              onClick={() => setActiveCat(c)}
              className={`text-xs px-2.5 py-1 rounded-full border ${
                activeCat === c
                  ? "bg-indigo-600 text-white border-indigo-600"
                  : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
              }`}
              data-testid={`cockpit-agents-cat-${c}`}
            >{c}</button>
          ))}
        </div>
      </div>
      {filtered.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border border-dashed border-slate-300 text-sm text-slate-500">
          No templates match your filter.
        </div>
      ) : (
        <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
          {filtered.map(t => {
            const Icon = ICONS[t.icon] || Bot;
            const inUse = enabledKeys.has(t.key);
            return (
              <div
                key={t.key}
                className="bg-white rounded-lg border border-slate-200 p-4 flex items-start gap-4"
                data-testid={`cockpit-agent-template-${t.key}`}
              >
                <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-indigo-50 text-indigo-600">
                  <Icon size={20} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="font-semibold text-slate-900">{t.name}</div>
                    {t.category && (
                      <span className="text-[10px] uppercase font-semibold text-slate-600 bg-slate-100 rounded-full px-2 py-0.5">
                        {t.category}
                      </span>
                    )}
                    <span className="text-[10px] uppercase font-semibold text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">
                      {SCHEDULE_LABEL[t.default_schedule] || t.default_schedule}
                    </span>
                    {inUse && (
                      <span className="text-[10px] uppercase font-semibold text-emerald-700 bg-emerald-100 rounded-full px-2 py-0.5">
                        In use
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 mt-1">{t.description}</div>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      onClick={() => onEnable(t)}
                      className="text-[11px] px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 flex items-center gap-1"
                      data-testid={`cockpit-agent-enable-${t.key}`}
                    >
                      <Plus size={11} /> Enable
                    </button>
                    <button
                      onClick={() => onRunOnce(t)}
                      className="text-[11px] px-2 py-1 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 flex items-center gap-1"
                      data-testid={`cockpit-agent-run-once-${t.key}`}
                    >
                      <Play size={11} /> Run once
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {showCustomBuilder && (
        <CustomAgentBuilderModal
          tools={tools}
          companies={companies}
          onClose={() => setShowCustomBuilder(false)}
          onSubmit={async (payload) => { await onCreateCustom(payload); setShowCustomBuilder(false); }}
        />
      )}
    </div>
  );
}

function CustomAgentBuilderModal({ tools, companies, onClose, onSubmit }) {
  const [name, setName] = useState("My custom agent");
  const [description, setDescription] = useState("");
  const [companyId, setCompanyId] = useState(companies[0]?.id || "");
  const [schedule, setSchedule] = useState("daily");
  const [prompt, setPrompt] = useState(
    "Look at the data provided and flag anything that looks unusual, risky, or a great cash-flow opportunity. Be specific — always cite one dollar amount or count."
  );
  const [selectedTools, setSelectedTools] = useState([]);
  const [busy, setBusy] = useState(false);

  const toggleTool = (k) => {
    setSelectedTools(s => s.includes(k) ? s.filter(v => v !== k) : [...s, k]);
  };

  const submit = async () => {
    if (!name.trim()) { toast.error("Name is required."); return; }
    if (!prompt.trim()) { toast.error("Prompt is required."); return; }
    if (selectedTools.length === 0) { toast.error("Pick at least one tool."); return; }
    setBusy(true);
    try {
      await onSubmit({
        name: name.trim(), description,
        company_id: companyId || null, schedule,
        prompt, tools: selectedTools, enabled: true,
      });
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-2xl p-5 max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
        data-testid="cockpit-agents-custom-builder-modal"
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="text-[10px] uppercase font-semibold text-slate-400">From scratch</div>
            <div className="font-heading text-xl font-bold text-slate-900">Build a custom agent</div>
            <div className="text-xs text-slate-500 mt-0.5">Write a prompt, pick the data slices, hit save.</div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={18} /></button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs uppercase font-semibold text-slate-600">Name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              className="mt-1 w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
              data-testid="cockpit-agents-custom-name"
            />
          </div>
          <div>
            <label className="block text-xs uppercase font-semibold text-slate-600">Schedule</label>
            <select
              value={schedule}
              onChange={e => setSchedule(e.target.value)}
              className="mt-1 w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
              data-testid="cockpit-agents-custom-schedule"
            >
              {Object.entries(SCHEDULE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
          <div className="col-span-2">
            <label className="block text-xs uppercase font-semibold text-slate-600">Client</label>
            <select
              value={companyId}
              onChange={e => setCompanyId(e.target.value)}
              className="mt-1 w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
              data-testid="cockpit-agents-custom-company"
            >
              <option value="">(Firm-wide — every client)</option>
              {companies.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="col-span-2">
            <label className="block text-xs uppercase font-semibold text-slate-600">Description</label>
            <input
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What this agent watches"
              className="mt-1 w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
              data-testid="cockpit-agents-custom-description"
            />
          </div>
        </div>

        <div className="mt-4">
          <label className="block text-xs uppercase font-semibold text-slate-600">Prompt</label>
          <div className="text-[11px] text-slate-500 mt-0.5">
            The LLM sees ONLY this prompt plus the selected tool data. No writes are performed.
          </div>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            rows={5}
            className="mt-1 w-full text-sm border border-slate-300 rounded-md px-2 py-1.5 font-mono"
            data-testid="cockpit-agents-custom-prompt"
          />
        </div>

        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <label className="block text-xs uppercase font-semibold text-slate-600">Tool allowlist ({selectedTools.length})</label>
            {selectedTools.length > 0 && (
              <button
                onClick={() => setSelectedTools([])}
                className="text-[11px] text-slate-500 hover:text-slate-900"
                data-testid="cockpit-agents-custom-tools-clear"
              >Clear all</button>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
            {tools.map(t => {
              const active = selectedTools.includes(t.key);
              return (
                <button
                  key={t.key}
                  onClick={() => toggleTool(t.key)}
                  className={`text-left border rounded-md p-2 flex items-start gap-2 ${active ? "border-indigo-500 bg-indigo-50" : "border-slate-200 bg-white hover:bg-slate-50"}`}
                  data-testid={`cockpit-agents-custom-tool-${t.key}`}
                >
                  <span className={`w-4 h-4 rounded border shrink-0 mt-0.5 ${active ? "bg-indigo-600 border-indigo-600" : "border-slate-300"} flex items-center justify-center`}>
                    {active && <CheckCircle2 size={11} className="text-white" />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-semibold ${active ? "text-indigo-800" : "text-slate-800"}`}>{t.label}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">{t.description}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 mt-5">
          <button onClick={onClose} className="text-sm px-3 py-1.5 rounded-md border border-slate-300 hover:bg-slate-50">Cancel</button>
          <button
            onClick={submit}
            disabled={busy}
            className="text-sm px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1"
            data-testid="cockpit-agents-custom-submit"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            Save agent
          </button>
        </div>
      </div>
    </div>
  );
}

function FindingsList({ findings, nameById, templateByKey, onResolve, onApplyContactFix, onUndoContactFix }) {
  if (findings.length === 0) {
    return (
      <div className="text-center py-16 bg-white rounded-lg border border-dashed border-slate-300">
        <CheckCircle2 size={40} className="mx-auto text-emerald-300" />
        <div className="mt-3 font-semibold text-slate-800">All quiet</div>
        <div className="text-sm text-slate-500 mt-1">No open agent findings. Come back after your agents next tick.</div>
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      {findings.map(f => {
        const t = templateByKey[f.template_key] || {};
        const Icon = ICONS[t.icon] || Bot;
        const sev = SEVERITY_STYLE[f.severity] || SEVERITY_STYLE.grey;
        // Contact-mismatch findings from the Contact Pairing Auditor get
        // a bespoke action row: "Apply fix" (when flagged but not yet
        // applied) or "Undo" (when auto-applied). Falls back to the
        // generic action_route button otherwise.
        const isContactMismatch = f.kind === "contact_mismatch";
        const applied = !!(f.meta && f.meta.applied);
        const hasProposal = f.meta && (f.meta.proposed_contact_id || f.meta.would_create_new);
        return (
          <div
            key={f.id}
            className={`rounded-lg border p-3 flex items-start gap-3 ${sev}`}
            data-testid={`cockpit-agent-finding-${f.id}`}
          >
            <Icon size={16} className="mt-1 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-sm">{f.title}</div>
              <div className="text-xs opacity-80 mt-0.5">
                {f.company_id ? (nameById[f.company_id] || "Client") : "Firm-wide"}
                {" · "}{new Date(f.created_at).toLocaleString()}
                {typeof f?.meta?.confidence === "number" && (
                  <span className="ml-2 font-mono-num opacity-70">
                    · {Math.round(f.meta.confidence * 100)}% conf.
                  </span>
                )}
              </div>
              {f.detail && <div className="text-xs opacity-80 mt-1 whitespace-pre-wrap">{f.detail}</div>}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {isContactMismatch && !applied && hasProposal && (
                <button
                  onClick={() => onApplyContactFix(f)}
                  className="text-[11px] px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 font-medium"
                  data-testid={`cockpit-agent-finding-apply-fix-${f.id}`}
                  title="Apply the auditor's proposed contact change"
                >
                  Apply fix
                </button>
              )}
              {isContactMismatch && applied && (
                <button
                  onClick={() => onUndoContactFix(f)}
                  className="text-[11px] px-2 py-1 rounded bg-white border border-current hover:brightness-95"
                  data-testid={`cockpit-agent-finding-undo-fix-${f.id}`}
                  title="Revert this auto-applied contact change"
                >
                  Undo
                </button>
              )}
              {f.action_route && !isContactMismatch && (
                <a
                  href={f.action_route}
                  className="text-[11px] px-2 py-1 rounded bg-white border border-current hover:brightness-95"
                  data-testid={`cockpit-agent-finding-open-${f.id}`}
                >
                  {f.action_label || "Open"}
                </a>
              )}
              <button
                onClick={() => onResolve(f, "resolved")}
                title="Mark resolved"
                className="text-[11px] p-1.5 rounded bg-white border border-current hover:brightness-95"
                data-testid={`cockpit-agent-finding-resolve-${f.id}`}
              >
                <CheckCircle2 size={12} />
              </button>
              <button
                onClick={() => onResolve(f, "dismissed")}
                title="Dismiss"
                className="text-[11px] p-1.5 rounded bg-white border border-current hover:brightness-95"
                data-testid={`cockpit-agent-finding-dismiss-${f.id}`}
              >
                <XCircle size={12} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EnableModal({ template, companies, onClose, onCreated }) {
  const [companyId, setCompanyId] = useState(companies[0]?.id || "");
  const [schedule, setSchedule] = useState(template.default_schedule || "daily");
  const [config, setConfig] = useState(() => ({ ...(template.default_config || {}) }));
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      await api.post("/cockpit/agents", {
        template_key: template.key,
        company_id: companyId || null,
        schedule,
        config,
        enabled: true,
      });
      toast.success(`Enabled "${template.name}".`);
      await onCreated();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Enable failed.");
    } finally { setBusy(false); }
  };

  const updateCfg = (key, val) => setConfig(c => ({ ...c, [key]: val }));

  return (
    <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5"
        onClick={e => e.stopPropagation()}
        data-testid="cockpit-agent-enable-modal"
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="font-heading text-xl font-bold text-slate-900">{template.name}</div>
            <div className="text-xs text-slate-500 mt-0.5">{template.description}</div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={18} /></button>
        </div>

        <label className="block text-xs uppercase font-semibold text-slate-600 mt-3">Client</label>
        <select
          value={companyId}
          onChange={e => setCompanyId(e.target.value)}
          className="mt-1 w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
          data-testid="cockpit-agent-enable-company"
        >
          <option value="">(Firm-wide — every client)</option>
          {companies.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        <label className="block text-xs uppercase font-semibold text-slate-600 mt-3">Schedule</label>
        <select
          value={schedule}
          onChange={e => setSchedule(e.target.value)}
          className="mt-1 w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
          data-testid="cockpit-agent-enable-schedule"
        >
          {Object.entries(SCHEDULE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>

        {(template.config_fields || []).map(field => (
          <div key={field.key} className="mt-3">
            <label className="block text-xs uppercase font-semibold text-slate-600">{field.label}</label>
            {field.type === "number" ? (
              <input
                type="number"
                value={config[field.key] ?? field.default ?? ""}
                onChange={e => updateCfg(field.key, Number(e.target.value))}
                className="mt-1 w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
                data-testid={`cockpit-agent-enable-cfg-${field.key}`}
              />
            ) : field.type === "multiselect" ? (
              <div className="mt-1 flex flex-wrap gap-2">
                {field.options.map(opt => {
                  const active = (config[field.key] || []).includes(opt.value);
                  return (
                    <button
                      key={opt.value}
                      onClick={() => {
                        const cur = new Set(config[field.key] || []);
                        active ? cur.delete(opt.value) : cur.add(opt.value);
                        updateCfg(field.key, Array.from(cur));
                      }}
                      className={`text-[11px] px-2 py-1 rounded border ${
                        active ? "bg-indigo-600 text-white border-indigo-600" : "bg-white border-slate-300 text-slate-700"
                      }`}
                      data-testid={`cockpit-agent-enable-cfg-${field.key}-${opt.value}`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        ))}

        <div className="flex items-center justify-end gap-2 mt-5">
          <button onClick={onClose} className="text-sm px-3 py-1.5 rounded-md border border-slate-300 hover:bg-slate-50">Cancel</button>
          <button
            onClick={create}
            disabled={busy}
            className="text-sm px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1"
            data-testid="cockpit-agent-enable-submit"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            Enable
          </button>
        </div>
      </div>
    </div>
  );
}

function Runbooks({
  runbooks, runbookTemplates, templateByKey, companies, nameById,
  busyId, onSeed, onRunNow, onToggle, onDelete, onCreate,
}) {
  const [seedFor, setSeedFor] = useState(null);
  const [showBuilder, setShowBuilder] = useState(false);
  const enabledKeys = new Set(runbooks.map(r => r.seeded_from).filter(Boolean));

  const statusPill = (s) => {
    const map = {
      success:  ["Success",  "bg-emerald-100 text-emerald-700"],
      partial:  ["Partial",  "bg-amber-100 text-amber-700"],
      halted:   ["Halted",   "bg-rose-100 text-rose-700"],
      failed:   ["Failed",   "bg-rose-100 text-rose-700"],
      running:  ["Running",  "bg-sky-100 text-sky-700"],
    };
    const [label, cls] = map[s] || [s, "bg-slate-100 text-slate-600"];
    return <span className={`text-[10px] uppercase font-semibold rounded-full px-2 py-0.5 ${cls}`}>{label}</span>;
  };

  return (
    <div className="space-y-6">
      {/* Existing runbooks */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs uppercase tracking-widest text-slate-500 font-semibold">My Runbooks</div>
          <button
            onClick={() => setShowBuilder(true)}
            className="text-[11px] px-2.5 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 flex items-center gap-1"
            data-testid="cockpit-runbook-create-btn"
          >
            <Plus size={11} /> Create custom runbook
          </button>
        </div>
        {runbooks.length === 0 ? (
          <div className="text-center py-10 bg-white rounded-lg border border-dashed border-slate-300">
            <div className="text-sm text-slate-500">No runbooks yet — seed one from a template below.</div>
          </div>
        ) : (
          <div className="grid gap-3">
            {runbooks.map(rb => (
              <div
                key={rb.id}
                className="bg-white rounded-lg border border-slate-200 p-4"
                data-testid={`cockpit-runbook-row-${rb.id}`}
              >
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-indigo-50 text-indigo-600">
                    <Bot size={20} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="font-semibold text-slate-900">{rb.name}</div>
                      {!rb.enabled && (
                        <span className="text-[10px] uppercase font-semibold text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">Paused</span>
                      )}
                      <span className="text-[10px] uppercase font-semibold text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">
                        {SCHEDULE_LABEL[rb.schedule] || rb.schedule}
                      </span>
                      {rb.last_run_status && statusPill(rb.last_run_status)}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {rb.company_id ? (nameById[rb.company_id] || "Client") : "Firm-wide"}
                      {rb.last_run_at && (
                        <> · Last run {new Date(rb.last_run_at).toLocaleString()}</>
                      )}
                    </div>
                    {rb.description && <div className="text-xs text-slate-500 mt-1">{rb.description}</div>}
                    {/* Steps */}
                    <div className="flex items-center gap-1.5 mt-3 flex-wrap">
                      {(rb.steps || []).map((s, i) => {
                        const t = templateByKey[s.template_key];
                        const Icon = ICONS[t?.icon] || Bot;
                        return (
                          <React.Fragment key={i}>
                            <div className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-slate-200 bg-slate-50 text-slate-700">
                              <Icon size={11} />
                              <span>{t?.name || s.template_key}</span>
                              {s.on_fail === "stop" && (
                                <span title="Chain halts on failure" className="text-rose-600 font-bold">⏹</span>
                              )}
                            </div>
                            {i < rb.steps.length - 1 && <ChevronRight size={12} className="text-slate-400" />}
                          </React.Fragment>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => onRunNow(rb)}
                      disabled={busyId === rb.id}
                      className="text-[11px] px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1"
                      data-testid={`cockpit-runbook-run-${rb.id}`}
                    >
                      {busyId === rb.id ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                      Run now
                    </button>
                    <button
                      onClick={() => onToggle(rb)}
                      disabled={busyId === rb.id}
                      title={rb.enabled ? "Pause" : "Enable"}
                      className="text-[11px] p-1.5 rounded border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      data-testid={`cockpit-runbook-toggle-${rb.id}`}
                    >
                      {rb.enabled ? <Pause size={12} /> : <Play size={12} />}
                    </button>
                    <button
                      onClick={() => onDelete(rb)}
                      disabled={busyId === rb.id}
                      title="Delete"
                      className="text-[11px] p-1.5 rounded border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-50"
                      data-testid={`cockpit-runbook-delete-${rb.id}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Template gallery */}
      <div>
        <div className="text-xs uppercase tracking-widest text-slate-500 font-semibold mb-2">Runbook Templates</div>
        <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
          {runbookTemplates.map(t => {
            const used = enabledKeys.has(t.key);
            return (
              <div
                key={t.key}
                className="bg-white rounded-lg border border-slate-200 p-4"
                data-testid={`cockpit-runbook-template-${t.key}`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="font-semibold text-slate-900">{t.name}</div>
                  <span className="text-[10px] uppercase font-semibold text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">
                    {SCHEDULE_LABEL[t.default_schedule] || t.default_schedule}
                  </span>
                  {used && (
                    <span className="text-[10px] uppercase font-semibold text-emerald-700 bg-emerald-100 rounded-full px-2 py-0.5">
                      In use
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-500 mt-1">{t.description}</div>
                <div className="flex items-center gap-1.5 mt-3 flex-wrap">
                  {t.steps.map((s, i) => {
                    const tp = templateByKey[s.template_key];
                    const Icon = ICONS[tp?.icon] || Bot;
                    return (
                      <React.Fragment key={i}>
                        <div className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-slate-200 bg-slate-50 text-slate-700">
                          <Icon size={11} />
                          <span>{tp?.name || s.template_key}</span>
                          {s.on_fail === "stop" && (
                            <span title="Chain halts on failure" className="text-rose-600 font-bold">⏹</span>
                          )}
                        </div>
                        {i < t.steps.length - 1 && <ChevronRight size={12} className="text-slate-400" />}
                      </React.Fragment>
                    );
                  })}
                </div>
                <div className="mt-3">
                  <button
                    onClick={() => setSeedFor(t)}
                    disabled={busyId === t.key}
                    className="text-[11px] px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1"
                    data-testid={`cockpit-runbook-seed-${t.key}`}
                  >
                    {busyId === t.key ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                    Add to my runbooks
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {seedFor && (
        <RunbookSeedModal
          template={seedFor}
          companies={companies}
          onClose={() => setSeedFor(null)}
          onSubmit={async (cid) => { await onSeed(seedFor, cid); setSeedFor(null); }}
        />
      )}

      {showBuilder && (
        <RunbookBuilderModal
          companies={companies}
          templateByKey={templateByKey}
          onClose={() => setShowBuilder(false)}
          onSubmit={async (payload) => { await onCreate(payload); setShowBuilder(false); }}
        />
      )}
    </div>
  );
}

function RunbookBuilderModal({ companies, templateByKey, onClose, onSubmit }) {
  const [name, setName] = useState("My runbook");
  const [description, setDescription] = useState("");
  const [companyId, setCompanyId] = useState(companies[0]?.id || "");
  const [schedule, setSchedule] = useState("monthly");
  const [steps, setSteps] = useState([]);
  const [busy, setBusy] = useState(false);
  const dragIdx = React.useRef(null);

  const templateList = useMemo(
    () => Object.values(templateByKey || {}).sort((a, b) => a.name.localeCompare(b.name)),
    [templateByKey]
  );

  const addStep = () => {
    const first = templateList[0];
    if (!first) return;
    setSteps(s => [...s, { template_key: first.key, on_fail: "continue" }]);
  };
  const removeStep = (i) => setSteps(s => s.filter((_, idx) => idx !== i));
  const updateStep = (i, patch) => setSteps(s => s.map((st, idx) => idx === i ? { ...st, ...patch } : st));
  const moveStep = (from, to) => {
    if (from === to || from < 0 || to < 0 || from >= steps.length || to >= steps.length) return;
    setSteps(s => {
      const next = [...s];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const submit = async () => {
    if (!name.trim()) { toast.error("Name is required."); return; }
    if (steps.length === 0) { toast.error("Add at least one step."); return; }
    setBusy(true);
    try {
      await onSubmit({
        name: name.trim(),
        description,
        company_id: companyId || null,
        schedule,
        steps,
        enabled: true,
      });
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-2xl p-5 max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
        data-testid="cockpit-runbook-builder-modal"
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="text-[10px] uppercase font-semibold text-slate-400">Custom runbook</div>
            <div className="font-heading text-xl font-bold text-slate-900">Design a new chain</div>
            <div className="text-xs text-slate-500 mt-0.5">Drag steps to reorder, pick each one's fail policy.</div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={18} /></button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs uppercase font-semibold text-slate-600">Name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              className="mt-1 w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
              data-testid="cockpit-runbook-builder-name"
            />
          </div>
          <div>
            <label className="block text-xs uppercase font-semibold text-slate-600">Schedule</label>
            <select
              value={schedule}
              onChange={e => setSchedule(e.target.value)}
              className="mt-1 w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
              data-testid="cockpit-runbook-builder-schedule"
            >
              {Object.entries(SCHEDULE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
          <div className="col-span-2">
            <label className="block text-xs uppercase font-semibold text-slate-600">Client</label>
            <select
              value={companyId}
              onChange={e => setCompanyId(e.target.value)}
              className="mt-1 w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
              data-testid="cockpit-runbook-builder-company"
            >
              <option value="">(Firm-wide — every client)</option>
              {companies.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="col-span-2">
            <label className="block text-xs uppercase font-semibold text-slate-600">Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={2}
              className="mt-1 w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
              data-testid="cockpit-runbook-builder-description"
            />
          </div>
        </div>

        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs uppercase font-semibold text-slate-600">Steps ({steps.length})</div>
            <button
              onClick={addStep}
              disabled={templateList.length === 0}
              className="text-[11px] px-2 py-1 rounded border border-slate-300 hover:bg-slate-50 flex items-center gap-1"
              data-testid="cockpit-runbook-builder-add-step"
            >
              <Plus size={11} /> Add step
            </button>
          </div>

          {steps.length === 0 ? (
            <div className="text-center py-8 border border-dashed border-slate-300 rounded-lg text-sm text-slate-400">
              Empty — click "Add step" to start composing the chain.
            </div>
          ) : (
            <div className="space-y-1.5">
              {steps.map((s, i) => {
                const t = templateByKey[s.template_key] || {};
                const Icon = ICONS[t.icon] || Bot;
                return (
                  <div
                    key={i}
                    draggable
                    onDragStart={() => { dragIdx.current = i; }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = dragIdx.current;
                      dragIdx.current = null;
                      if (from !== null) moveStep(from, i);
                    }}
                    className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-md p-2 hover:bg-slate-100 cursor-move"
                    data-testid={`cockpit-runbook-builder-step-${i}`}
                  >
                    <div className="text-slate-400 text-lg leading-none">⋮⋮</div>
                    <span className="text-[10px] uppercase font-semibold text-slate-500 bg-white rounded px-1.5 py-0.5 border border-slate-200 w-6 text-center">
                      {i + 1}
                    </span>
                    <Icon size={14} className="text-indigo-600 shrink-0" />
                    <select
                      value={s.template_key}
                      onChange={e => updateStep(i, { template_key: e.target.value })}
                      className="flex-1 text-sm border border-slate-300 rounded-md px-2 py-1 bg-white"
                      data-testid={`cockpit-runbook-builder-step-template-${i}`}
                    >
                      {templateList.map(t => (
                        <option key={t.key} value={t.key}>{t.name} · {t.category}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => updateStep(i, { on_fail: s.on_fail === "stop" ? "continue" : "stop" })}
                      title={s.on_fail === "stop"
                        ? "On failure: halt the chain"
                        : "On failure: keep going"}
                      className={`text-[10px] uppercase font-semibold rounded-full px-2 py-0.5 ${s.on_fail === "stop" ? "bg-rose-100 text-rose-700" : "bg-slate-200 text-slate-600"}`}
                      data-testid={`cockpit-runbook-builder-step-onfail-${i}`}
                    >
                      {s.on_fail === "stop" ? "⏹ Stop" : "→ Continue"}
                    </button>
                    <div className="flex items-center gap-0.5">
                      <button
                        onClick={() => moveStep(i, i - 1)}
                        disabled={i === 0}
                        title="Move up"
                        className="text-slate-500 hover:text-slate-900 disabled:opacity-30 p-1"
                        data-testid={`cockpit-runbook-builder-step-up-${i}`}
                      >↑</button>
                      <button
                        onClick={() => moveStep(i, i + 1)}
                        disabled={i === steps.length - 1}
                        title="Move down"
                        className="text-slate-500 hover:text-slate-900 disabled:opacity-30 p-1"
                        data-testid={`cockpit-runbook-builder-step-down-${i}`}
                      >↓</button>
                      <button
                        onClick={() => removeStep(i)}
                        className="text-rose-500 hover:text-rose-700 p-1"
                        data-testid={`cockpit-runbook-builder-step-remove-${i}`}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 mt-5">
          <button onClick={onClose} className="text-sm px-3 py-1.5 rounded-md border border-slate-300 hover:bg-slate-50">Cancel</button>
          <button
            onClick={submit}
            disabled={busy || steps.length === 0}
            className="text-sm px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1"
            data-testid="cockpit-runbook-builder-submit"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            Create runbook
          </button>
        </div>
      </div>
    </div>
  );
}

function RunbookSeedModal({ template, companies, onClose, onSubmit }) {
  const [companyId, setCompanyId] = useState(companies[0]?.id || "");
  const [busy, setBusy] = useState(false);
  return (
    <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5"
        onClick={e => e.stopPropagation()}
        data-testid="cockpit-runbook-seed-modal"
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="text-[10px] uppercase font-semibold text-slate-400">Add runbook</div>
            <div className="font-heading text-xl font-bold text-slate-900">{template.name}</div>
            <div className="text-xs text-slate-500 mt-0.5">{template.description}</div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={18} /></button>
        </div>
        <label className="block text-xs uppercase font-semibold text-slate-600 mt-3">Client</label>
        <select
          value={companyId}
          onChange={e => setCompanyId(e.target.value)}
          className="mt-1 w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
          data-testid="cockpit-runbook-seed-company"
        >
          <option value="">(Firm-wide — every client)</option>
          {companies.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <div className="flex items-center justify-end gap-2 mt-5">
          <button onClick={onClose} className="text-sm px-3 py-1.5 rounded-md border border-slate-300 hover:bg-slate-50">Cancel</button>
          <button
            onClick={async () => { setBusy(true); await onSubmit(companyId); setBusy(false); }}
            disabled={busy}
            className="text-sm px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1"
            data-testid="cockpit-runbook-seed-submit"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            Add runbook
          </button>
        </div>
      </div>
    </div>
  );
}

function RunOnceModal({ template, companies, onClose, onCompleted }) {
  const [companyId, setCompanyId] = useState(companies[0]?.id || "");
  const [busy, setBusy] = useState(false);

  const runNow = async () => {
    setBusy(true);
    try {
      const r = await api.post("/cockpit/agents/run-once", {
        template_key: template.key,
        company_id: companyId || null,
        config: {},
      });
      if (r.data.ok) {
        toast.success(
          r.data.findings_count === 0
            ? `${template.name} ran clean — nothing to flag.`
            : `${template.name} surfaced ${r.data.findings_count} finding${r.data.findings_count === 1 ? "" : "s"}.`
        );
      } else {
        toast.error(`Run failed: ${r.data.error || "unknown error"}`);
      }
      await onCompleted();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Run failed.");
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5"
        onClick={e => e.stopPropagation()}
        data-testid="cockpit-agent-run-once-modal"
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="text-[10px] uppercase font-semibold text-slate-400">Run once — no schedule</div>
            <div className="font-heading text-xl font-bold text-slate-900">{template.name}</div>
            <div className="text-xs text-slate-500 mt-0.5">{template.description}</div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={18} /></button>
        </div>

        <label className="block text-xs uppercase font-semibold text-slate-600 mt-3">Client</label>
        <select
          value={companyId}
          onChange={e => setCompanyId(e.target.value)}
          className="mt-1 w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
          data-testid="cockpit-agent-run-once-company"
        >
          <option value="">(Firm-wide — every client)</option>
          {companies.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        <div className="text-xs text-slate-500 mt-3">
          Uses the template's default settings. Findings will appear in the Findings tab and Today feed.
        </div>

        <div className="flex items-center justify-end gap-2 mt-5">
          <button onClick={onClose} className="text-sm px-3 py-1.5 rounded-md border border-slate-300 hover:bg-slate-50">Cancel</button>
          <button
            onClick={runNow}
            disabled={busy}
            className="text-sm px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1"
            data-testid="cockpit-agent-run-once-submit"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
            Run now
          </button>
        </div>
      </div>
    </div>
  );
}

function RunsDrawer({ agent, onClose, onOpenFindings }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const r = await api.get(`/cockpit/agents/${agent.id}/runs`);
        setRuns(r.data.runs || []);
      } catch (e) {
        toast.error("Failed to load runs.");
      } finally { setLoading(false); }
    })();
  }, [agent.id]);

  const statusPill = (s) => {
    if (s === "success") return <span className="text-[10px] uppercase font-semibold text-emerald-700 bg-emerald-100 rounded-full px-2 py-0.5">Success</span>;
    if (s === "failed")  return <span className="text-[10px] uppercase font-semibold text-rose-700 bg-rose-100 rounded-full px-2 py-0.5">Failed</span>;
    if (s === "running") return <span className="text-[10px] uppercase font-semibold text-sky-700 bg-sky-100 rounded-full px-2 py-0.5">Running</span>;
    return <span className="text-[10px] uppercase font-semibold text-slate-600 bg-slate-100 rounded-full px-2 py-0.5">{s}</span>;
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 z-50 flex justify-end" onClick={onClose}>
      <div
        className="bg-white w-full max-w-lg h-full shadow-2xl p-5 overflow-y-auto"
        onClick={e => e.stopPropagation()}
        data-testid="cockpit-agent-runs-drawer"
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="text-[10px] uppercase font-semibold text-slate-400">Agent · Run history</div>
            <div className="font-heading text-xl font-bold text-slate-900">{agent.name}</div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={18} /></button>
        </div>

        {loading ? (
          <div className="py-16 flex items-center justify-center text-slate-400"><Loader2 className="animate-spin" size={20} /></div>
        ) : runs.length === 0 ? (
          <div className="py-16 text-center text-slate-500 text-sm">
            <Clock size={32} className="mx-auto text-slate-300 mb-2" />
            No runs yet — hit "Run now" or wait for the next scheduled tick.
          </div>
        ) : (
          <>
            {/* Quick jump to this agent's open findings — the whole point of the drawer */}
            <button
              onClick={() => onOpenFindings && onOpenFindings(agent.id)}
              className="w-full mb-3 text-left px-3 py-2 rounded-lg bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-800 text-sm font-medium flex items-center justify-between transition-colors"
              data-testid="cockpit-agent-runs-view-findings"
            >
              <span>View this agent's findings →</span>
              <span className="text-[11px] text-indigo-600 font-mono-num">opens Findings tab</span>
            </button>
            <div className="space-y-2">
              {runs.map(r => {
                const hasFindings = (r.findings_count || 0) > 0;
                return (
                  <div
                    key={r.id}
                    className={`border rounded-lg p-3 transition-colors ${
                      hasFindings
                        ? "border-amber-200 bg-amber-50/40 hover:bg-amber-50 cursor-pointer"
                        : "border-slate-200"
                    }`}
                    onClick={hasFindings && onOpenFindings ? () => onOpenFindings(agent.id) : undefined}
                    data-testid={`cockpit-agent-run-row-${r.id}`}
                    title={hasFindings ? "Click to view this agent's findings" : ""}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs text-slate-500">
                        {new Date(r.started_at).toLocaleString()}
                        {r.triggered_by && <> · {r.triggered_by}</>}
                      </div>
                      {statusPill(r.status)}
                    </div>
                    <div className="text-sm mt-1 flex items-center justify-between">
                      <span>
                        {hasFindings
                          ? <span className="text-amber-700 font-semibold">{r.findings_count} finding{r.findings_count === 1 ? "" : "s"}</span>
                          : <span className="text-slate-500">No findings</span>}
                        {r.error && <span className="text-rose-600 ml-2">{r.error}</span>}
                      </span>
                      {hasFindings && (
                        <span className="text-[11px] text-indigo-600 font-medium">Open →</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
