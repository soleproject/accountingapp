import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  AlertTriangle, Clock, CheckCircle2, Sparkles, RefreshCw, Filter, X,
} from "lucide-react";

// --------------------------------------------------------------------------
// Cockpit → Today
// Unified todo feed across every accessible company. Grouped by urgency:
//   red    Attention Now       (blocking close / overdue)
//   amber  Waiting on Client   (portal questions, missing docs)
//   blue   Ready for Review    (agent findings, sign-off checkpoints)
//   grey   Overnight Updates   (informational)
// --------------------------------------------------------------------------

const URGENCY_META = {
  red:   { label: "Attention now",     icon: AlertTriangle, ring: "border-red-200",    dot: "bg-red-500",    heading: "text-red-700"    },
  amber: { label: "Waiting on client", icon: Clock,         ring: "border-amber-200",  dot: "bg-amber-500",  heading: "text-amber-700"  },
  blue:  { label: "Ready for review",  icon: CheckCircle2,  ring: "border-blue-200",   dot: "bg-blue-500",   heading: "text-blue-700"   },
  grey:  { label: "Overnight updates", icon: Sparkles,      ring: "border-slate-200",  dot: "bg-slate-400",  heading: "text-slate-600"  },
};

export default function CockpitToday() {
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [companies, setCompanies] = useState([]);
  const [selectedCompanyIds, setSelectedCompanyIds] = useState(() => new Set());
  const [urgencyFilter, setUrgencyFilter] = useState(null);
  const [busy, setBusy] = useState(false);
  const [accessDeniedMsg, setAccessDeniedMsg] = useState(null);

  const loadCompanies = async () => {
    try {
      const r = await api.get(`/cockpit/accessible-companies`);
      setCompanies(r.data?.companies || []);
    } catch (e) {
      // 403 → user isn't firm-scoped. Show empty state + surface the
      // backend message so single-book clients understand why the
      // Cockpit is empty for them.
      if (e?.response?.status === 403) {
        setAccessDeniedMsg(
          e?.response?.data?.detail ||
          "Cockpit is a cross-client surface — your account only manages one book."
        );
      }
      setCompanies([]);
    }
  };

  const load = async () => {
    setBusy(true);
    try {
      const params = {};
      if (selectedCompanyIds.size > 0) params.company_ids = [...selectedCompanyIds].join(",");
      if (urgencyFilter) params.urgency = urgencyFilter;
      const r = await api.get(`/cockpit/today`, { params });
      setData(r.data);
    } catch (e) {
      if (e?.response?.status === 403) {
        setAccessDeniedMsg(
          e?.response?.data?.detail ||
          "Cockpit is a cross-client surface — your account only manages one book."
        );
        setData({ items: [], counts_by_urgency: {}, counts_by_source: {} });
      } else {
        toast.error(e?.response?.data?.detail || "Failed to load Today feed.");
        setData({ items: [], counts_by_urgency: {}, counts_by_source: {} });
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { loadCompanies(); }, []);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [urgencyFilter, selectedCompanyIds]);

  // Auto-refresh every 15s so client answers land here without a manual
  // reload. Paired with the Cockpit Requests rail's own polling, this
  // closes the loop: client answers via portal → next poll picks up the
  // status flip → Today's amber count drops → toast fires below.
  useEffect(() => {
    const t = setInterval(() => { load(); }, 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line
  }, [urgencyFilter, selectedCompanyIds]);

  // Diff-toast: when the amber (waiting-on-client) count drops between
  // polls, the CPA sees "N answers landed" — real-time-feel unblock.
  const prevAmberRef = React.useRef(null);
  useEffect(() => {
    const amber = data?.counts_by_urgency?.amber || 0;
    if (prevAmberRef.current !== null && amber < prevAmberRef.current) {
      const delta = prevAmberRef.current - amber;
      toast.success(`${delta} client answer${delta === 1 ? "" : "s"} just landed.`);
    }
    prevAmberRef.current = amber;
  }, [data]);

  const grouped = useMemo(() => {
    const buckets = { red: [], amber: [], blue: [], grey: [] };
    for (const it of data?.items || []) {
      (buckets[it.urgency] || buckets.grey).push(it);
    }
    return buckets;
  }, [data]);

  const totalItems = data?.items?.length || 0;
  const now = new Date();
  const greeting = now.getHours() < 12 ? "Good morning" : now.getHours() < 18 ? "Good afternoon" : "Good evening";

  const toggleCompany = (cid) => {
    setSelectedCompanyIds((prev) => {
      const next = new Set(prev);
      if (next.has(cid)) next.delete(cid);
      else next.add(cid);
      return next;
    });
  };

  const clearFilters = () => {
    setSelectedCompanyIds(new Set());
    setUrgencyFilter(null);
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto" data-testid="cockpit-today-page">
      {/* Greeting strip */}
      <div className="mb-5 flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight text-slate-900">
            {greeting}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {busy && !data ? "Scanning your practice…" : (
              totalItems === 0
                ? "You're all caught up across every client."
                : `You have ${totalItems} thing${totalItems === 1 ? "" : "s"} waiting across ${companies.length} client${companies.length === 1 ? "" : "s"}.`
            )}
          </p>
        </div>
        <button
          onClick={load}
          disabled={busy}
          className="text-sm px-3 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50"
          data-testid="cockpit-today-refresh"
        >
          <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {/* Filter row */}
      <div className="mb-5 flex items-center gap-2 flex-wrap" data-testid="cockpit-today-filter-row">
        <span className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold flex items-center gap-1">
          <Filter size={12} /> Filter
        </span>
        {Object.entries(URGENCY_META).map(([k, meta]) => {
          const count = data?.counts_by_urgency?.[k] || 0;
          const active = urgencyFilter === k;
          return (
            <button
              key={k}
              onClick={() => setUrgencyFilter(active ? null : k)}
              data-testid={`cockpit-today-filter-urgency-${k}`}
              className={`text-xs px-2.5 py-1 rounded-full border flex items-center gap-1.5 transition-colors ${
                active
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
              {meta.label}
              <span className="font-mono-num opacity-70">{count}</span>
            </button>
          );
        })}
        {companies.length > 1 && (
          <CompanyFilter
            companies={companies}
            selected={selectedCompanyIds}
            onToggle={toggleCompany}
          />
        )}
        {(selectedCompanyIds.size > 0 || urgencyFilter) && (
          <button
            onClick={clearFilters}
            data-testid="cockpit-today-filter-clear"
            className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1"
          >
            <X size={12} /> Clear
          </button>
        )}
      </div>

      {/* Access-denied state (single-book clients hitting /cockpit directly) */}
      {accessDeniedMsg && (
        <div
          className="bg-amber-50 border border-amber-200 rounded-lg p-6 mb-4"
          data-testid="cockpit-today-access-denied"
        >
          <div className="flex items-center gap-2 text-amber-800">
            <AlertTriangle size={18} />
            <span className="font-semibold">Cockpit is for firms</span>
          </div>
          <p className="text-sm text-amber-800/90 mt-1.5">{accessDeniedMsg}</p>
        </div>
      )}

      {/* Sections */}
      {totalItems === 0 && !busy && !accessDeniedMsg && (
        <div className="bg-white rounded-lg border border-slate-200 p-12 text-center" data-testid="cockpit-today-empty">
          <CheckCircle2 className="mx-auto text-emerald-500 mb-3" size={40} />
          <div className="text-lg font-semibold text-slate-900">Inbox zero.</div>
          <div className="text-sm text-slate-600 mt-1">Nothing needs your attention across any client right now.</div>
        </div>
      )}

      {["red", "amber", "blue", "grey"].map((k) => {
        const items = grouped[k] || [];
        if (items.length === 0) return null;
        const meta = URGENCY_META[k];
        const Icon = meta.icon;
        return (
          <section
            key={k}
            className="mb-6"
            data-testid={`cockpit-today-section-${k}`}
          >
            <div className={`flex items-center gap-2 mb-2 ${meta.heading}`}>
              <Icon size={16} />
              <h2 className="text-sm font-semibold uppercase tracking-wider">
                {meta.label}
              </h2>
              <span className="text-xs text-slate-500 font-normal">{items.length}</span>
            </div>
            <div className={`bg-white rounded-lg border ${meta.ring} divide-y divide-slate-100`}>
              {items.map((it) => (
                <TodoRow key={it.id} item={it} onClick={() => nav(it.action_route)} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function TodoRow({ item, onClick }) {
  const meta = URGENCY_META[item.urgency] || URGENCY_META.grey;
  return (
    <div
      className="px-4 py-3 flex items-center gap-3 hover:bg-slate-50 cursor-pointer"
      onClick={onClick}
      data-testid={`cockpit-today-card-${item.id}`}
    >
      <span className={`w-2 h-2 rounded-full shrink-0 ${meta.dot}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-semibold text-slate-900 truncate">
            {item.title}
          </span>
          {item.count > 1 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-mono-num">
              {item.count}
            </span>
          )}
        </div>
        <div className="text-xs text-slate-500 mt-0.5 truncate">
          <span className="font-medium text-slate-700">{item.company_name}</span>
          {item.subtitle ? <span> · {item.subtitle}</span> : null}
        </div>
      </div>
      <button
        className="text-xs text-indigo-600 hover:text-indigo-800 font-medium shrink-0"
        data-testid={`cockpit-today-action-${item.id}`}
      >
        {item.action_label} →
      </button>
    </div>
  );
}

function CompanyFilter({ companies, selected, onToggle }) {
  const [open, setOpen] = useState(false);
  const label = selected.size === 0
    ? "All clients"
    : `${selected.size} client${selected.size === 1 ? "" : "s"}`;
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
        data-testid="cockpit-today-filter-client"
        className={`text-xs px-2.5 py-1 rounded-full border flex items-center gap-1.5 transition-colors ${
          selected.size > 0
            ? "bg-indigo-50 text-indigo-700 border-indigo-300"
            : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
        }`}
      >
        {label}
      </button>
      {open && (
        <div className="absolute z-20 left-0 top-full mt-1 bg-white border border-slate-200 rounded-md shadow-lg w-72 max-h-72 overflow-auto py-1">
          {companies.map((c) => (
            <button
              key={c.id}
              onMouseDown={(e) => { e.preventDefault(); onToggle(c.id); }}
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 flex items-center gap-2"
              data-testid={`cockpit-today-filter-client-option-${c.id}`}
            >
              <input
                type="checkbox"
                readOnly
                checked={selected.has(c.id)}
                className="pointer-events-none"
              />
              <span className="truncate">{c.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
