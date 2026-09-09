import React, { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  Bot, Sparkles, FileEdit, FileBarChart2, Receipt, MessageSquare, BellRing,
  Play, Pause, Trash2, Plus, RefreshCw, Loader2, X, ChevronRight, Search,
  CheckCircle2, XCircle, AlertCircle, Clock, Circle, AlertTriangle, TrendingUp,
  ArrowLeftRight, Landmark, Banknote, ReceiptText, Activity, PieChart,
  FileWarning, ScanLine,
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
  Activity, PieChart, FileWarning, ScanLine,
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
  const [runsDrawer, setRunsDrawer] = useState(null); // {agent}
  const [findings, setFindings] = useState([]);

  const load = async () => {
    setBusy(true);
    try {
      const [t, a, c, f] = await Promise.all([
        api.get("/cockpit/agents/templates"),
        api.get("/cockpit/agents"),
        api.get("/cockpit/accessible-companies"),
        api.get("/cockpit/agent-findings", { params: { status: "open", limit: 200 } }),
      ]);
      setTemplates(t.data.templates || []);
      setAgents(a.data.agents || []);
      setCompanies(c.data.companies || []);
      setFindings(f.data.findings || []);
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
        <button
          onClick={load}
          disabled={busy}
          className="text-sm px-3 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50"
          data-testid="cockpit-agents-refresh"
        >
          <RefreshCw size={14} className={busy ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatCard label="Enabled agents" value={agents.filter(a => a.enabled).length} tone="emerald" />
        <StatCard label="Open findings" value={findings.length} tone="amber" />
        <StatCard label="Available templates" value={templates.length} tone="indigo" />
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-slate-200 mb-4">
        {[
          { key: "mine", label: `My Agents (${agents.length})` },
          { key: "library", label: `Template Library (${templates.length})` },
          { key: "runs", label: `Findings (${findings.length})` },
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
          agents={agents}
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
          agents={agents}
          onEnable={(t) => setEnableFor(t)}
        />
      )}
      {tab === "runs" && (
        <FindingsList
          findings={findings}
          nameById={nameById}
          templateByKey={templateByKey}
          onResolve={resolveFinding}
        />
      )}

      {enableFor && (
        <EnableModal
          template={enableFor}
          companies={companies}
          onClose={() => setEnableFor(null)}
          onCreated={async () => { setEnableFor(null); setTab("mine"); await load(); }}
        />
      )}

      {runsDrawer && (
        <RunsDrawer
          agent={runsDrawer.agent}
          onClose={() => setRunsDrawer(null)}
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Sub-components
// --------------------------------------------------------------------------

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

function Library({ templates, agents, onEnable }) {
  const enabledKeys = new Set(agents.map(a => a.template_key));
  const [search, setSearch] = useState("");
  const [activeCat, setActiveCat] = useState("All");

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
                  <div className="mt-3">
                    <button
                      onClick={() => onEnable(t)}
                      className="text-[11px] px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 flex items-center gap-1"
                      data-testid={`cockpit-agent-enable-${t.key}`}
                    >
                      <Plus size={11} /> Enable
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FindingsList({ findings, nameById, templateByKey, onResolve }) {
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
              </div>
              {f.detail && <div className="text-xs opacity-80 mt-1">{f.detail}</div>}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {f.action_route && (
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

function RunsDrawer({ agent, onClose }) {
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
          <div className="space-y-2">
            {runs.map(r => (
              <div key={r.id} className="border border-slate-200 rounded-lg p-3" data-testid={`cockpit-agent-run-row-${r.id}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-slate-500">
                    {new Date(r.started_at).toLocaleString()}
                    {r.triggered_by && <> · {r.triggered_by}</>}
                  </div>
                  {statusPill(r.status)}
                </div>
                <div className="text-sm mt-1">
                  {r.findings_count > 0
                    ? <span className="text-amber-700 font-semibold">{r.findings_count} finding{r.findings_count === 1 ? "" : "s"}</span>
                    : <span className="text-slate-500">No findings</span>}
                  {r.error && <span className="text-rose-600 ml-2">{r.error}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
