/**
 * CockpitTodayV3 — cross-client "Today" dashboard for CPA firms.
 *
 * Renders the mockup: 6-KPI strip · Needs-Attention / AI-Working /
 * Communications three-up · Bookkeeping table / Resolution donut /
 * Activity feed. All data lives behind a single aggregate call to
 * `GET /api/cockpit/today-v3?days=<n>`.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  CheckCircle2, Brain, AlertCircle, MessageSquare, FileText, Users,
  Loader2, ChevronDown,
} from "lucide-react";

const RANGES = [
  { key: 7, label: "Last 7 days" },
  { key: 30, label: "Last 30 days" },
  { key: 90, label: "Last 90 days" },
];

const ICONS = {
  check: CheckCircle2, brain: Brain, alert: AlertCircle,
  message: MessageSquare, doc: FileText, users: Users,
};

const TONE_BG = {
  emerald: "bg-emerald-50 text-emerald-600",
  indigo:  "bg-indigo-50 text-indigo-600",
  rose:    "bg-rose-50 text-rose-600",
  sky:     "bg-sky-50 text-sky-600",
  amber:   "bg-amber-50 text-amber-600",
  slate:   "bg-slate-100 text-slate-600",
};

function MockedChip() {
  return (
    <span className="ml-1.5 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200"
          title="Placeholder data — real metric wired in a future update">
      Mocked
    </span>
  );
}

function KpiCard({ kpi }) {
  const Icon = ICONS[kpi.icon] || CheckCircle2;
  const delta = kpi.delta_pct;
  const deltaUp = (kpi.invert_delta ? -1 : 1) * (delta ?? 0) >= 0;
  return (
    <div className="flex-1 min-w-0 rounded-xl border border-slate-200 bg-white p-3"
         data-testid={`cockpit-today-v3-kpi-${kpi.key}`}>
      <div className="flex items-start gap-2">
        <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${TONE_BG[kpi.tone] || TONE_BG.slate}`}>
          <Icon size={13} />
        </div>
        <div className="min-w-0">
          <div className="text-lg font-semibold text-slate-900 leading-tight">
            {kpi.value ?? 0}
          </div>
          <div className="text-[10px] text-slate-500 leading-tight mt-0.5 flex items-center flex-wrap">
            {kpi.label}
            {kpi.mocked && <MockedChip />}
          </div>
          <div className="mt-1 text-[10px] text-slate-500 truncate">
            {delta != null ? (
              <span className={deltaUp ? "text-emerald-600" : "text-rose-600"}>
                {deltaUp ? "↑" : "↓"} {Math.abs(delta)}%
              </span>
            ) : (
              <span className="text-slate-400">—</span>
            )}{" "}
            <span className="text-slate-400">{kpi.delta_note}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionCard({ title, count, onViewAll, children, mocked }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 flex flex-col min-h-0">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold text-slate-900 flex items-center">
          {title}
          {mocked && <MockedChip />}
        </div>
        {onViewAll && (
          <button onClick={onViewAll}
                  className="text-[11px] text-indigo-600 hover:text-indigo-800">
            View all{typeof count === "number" ? ` (${count})` : ""} →
          </button>
        )}
      </div>
      <div className="flex-1 overflow-auto min-h-0 scrollbar-on-hover">{children}</div>
    </div>
  );
}

function EmptyRow({ text }) {
  return (
    <div className="text-[12px] text-slate-400 py-6 text-center border border-dashed border-slate-200 rounded-lg">
      {text}
    </div>
  );
}

export default function CockpitTodayV3() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [rangeOpen, setRangeOpen] = useState(false);
  const { user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    let cancel = false;
    setBusy(true);
    api.get(`/cockpit/today-v3?days=${days}`)
      .then(r => { if (!cancel) setData(r.data); })
      .catch(() => { if (!cancel) setData({ empty: true }); })
      .finally(() => { if (!cancel) setBusy(false); });
    return () => { cancel = true; };
  }, [days]);

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  }, []);
  const dateStr = useMemo(() => new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  }), []);
  const firstName = (user?.name || user?.email || "there").split(" ")[0].split("@")[0];
  const rangeLabel = RANGES.find(r => r.key === days)?.label || "Last 30 days";

  const empty = data?.empty || (data && (data.kpis || []).every(k => !k.value));

  return (
    <div className="min-h-screen bg-slate-50" data-testid="cockpit-today-v3-page">
      <div className="max-w-[1400px] mx-auto px-6 py-4 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="font-heading text-2xl font-semibold text-slate-900 leading-tight">
              {greeting}, {firstName}
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Here's what's happening across your clients today.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-sm text-slate-500">{dateStr}</div>
            <div className="relative">
              <button
                onClick={() => setRangeOpen(v => !v)}
                data-testid="cockpit-today-v3-range-trigger"
                className="flex items-center gap-1.5 text-sm border border-slate-200 bg-white px-3 py-1.5 rounded-md hover:border-slate-300"
              >
                {rangeLabel} <ChevronDown size={13} />
              </button>
              {rangeOpen && (
                <div className="absolute right-0 mt-1 w-40 rounded-md border border-slate-200 bg-white shadow-lg z-10">
                  {RANGES.map(r => (
                    <button
                      key={r.key}
                      onClick={() => { setDays(r.key); setRangeOpen(false); }}
                      className={`w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 ${r.key === days ? "font-medium text-indigo-700" : "text-slate-700"}`}
                      data-testid={`cockpit-today-v3-range-${r.key}`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {busy && !data && (
          <div className="py-16 flex justify-center"><Loader2 className="animate-spin text-slate-400" /></div>
        )}

        {data && (
          <>
            {/* KPI strip */}
            <div className="grid grid-cols-3 lg:grid-cols-6 gap-3" data-testid="cockpit-today-v3-kpis">
              {(data.kpis || []).map(k => <KpiCard key={k.key} kpi={k} />)}
            </div>

            {/* Row 2 — 3 columns */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 h-[calc((100vh-320px)/2)] min-h-[240px]">
              <SectionCard
                title="Needs Your Attention"
                count={data.needs_your_attention?.length}
                onViewAll={() => navigate("/cockpit/today-v2")}
              >
                {(data.needs_your_attention || []).length === 0 ? (
                  <EmptyRow text="Nothing needs your attention right now. Nice." />
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {data.needs_your_attention.map(item => (
                      <li key={item.id} className="py-2.5 flex items-start gap-3 cursor-pointer hover:bg-slate-50 rounded px-1 -mx-1"
                          onClick={() => navigate(item.route)}
                          data-testid={`cockpit-today-v3-attn-${item.id}`}>
                        <span className="w-1.5 h-1.5 rounded-full bg-rose-500 mt-2 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-slate-900 truncate">{item.title}</div>
                          <div className="text-[11px] text-slate-500">{item.subtitle}</div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-sm font-mono-num text-slate-900">${Math.abs(item.amount).toLocaleString()}</div>
                          <div className="text-[11px] text-slate-400">{item.date}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>

              <SectionCard
                title="AI Working"
                count={data.ai_working?.length}
                mocked={data.ai_working_mocked}
              >
                {(data.ai_working || []).length === 0 ? (
                  <EmptyRow text="No live AI runs. Invite a client to see activity here." />
                ) : (
                  <ul className="space-y-3">
                    {data.ai_working.map(item => (
                      <li key={item.id} data-testid={`cockpit-today-v3-ai-${item.id}`}>
                        <div className="text-sm text-slate-900">{item.title}</div>
                        <div className="text-[11px] text-slate-500 mb-1.5">{item.subtitle}</div>
                        <div className="h-1.5 rounded-full bg-slate-200 overflow-hidden">
                          <div className="h-full bg-indigo-500 rounded-full transition-[width] duration-500"
                               style={{ width: `${Math.min(100, Math.max(3, item.progress_pct))}%` }} />
                        </div>
                        <div className="text-[10px] text-slate-500 mt-1">{item.status_label}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>

              <SectionCard
                title="Client Communications"
                count={data.client_communications?.length}
                onViewAll={() => navigate("/cockpit/communications")}
                mocked={data.client_communications_mocked}
              >
                {(data.client_communications || []).length === 0 ? (
                  <EmptyRow text="No client communications yet. They'll appear as they come in." />
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {data.client_communications.map(c => (
                      <li key={c.id} className="py-2.5 flex items-start gap-3">
                        <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center text-[10px] font-semibold text-slate-600 shrink-0">
                          {(c.who || "?").split(" ").map(n => n[0]).slice(0, 2).join("").toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline justify-between gap-2">
                            <div className="text-sm text-slate-900 truncate">{c.who}</div>
                            <div className="text-[10px] text-slate-400 shrink-0">{c.at}</div>
                          </div>
                          <div className="text-[11px] text-slate-700 truncate">{c.subject}</div>
                          <div className="text-[11px] text-slate-500 truncate italic">"{c.preview}"</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>
            </div>

            {/* Row 3 — 3 columns */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 h-[calc((100vh-320px)/2)] min-h-[240px]">
              <SectionCard
                title="Client Bookkeeping Status"
                onViewAll={() => navigate("/pro/clients")}
              >
                {(data.bookkeeping || []).length === 0 ? (
                  <EmptyRow text="No clients yet — invite one to get started." />
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-[10px] uppercase text-slate-400 tracking-wider">
                        <th className="text-left pb-2 font-medium">Client</th>
                        <th className="text-left pb-2 font-medium">Status</th>
                        <th className="text-left pb-2 font-medium">Last activity</th>
                        <th className="text-right pb-2 font-medium">Items</th>
                      </tr>
                    </thead>
                    <tbody className="text-slate-700">
                      {data.bookkeeping.map(c => (
                        <tr key={c.id} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
                            onClick={() => navigate(`/company/${c.id}/dashboard`)}>
                          <td className="py-2 truncate max-w-[140px]">{c.name}</td>
                          <td className="py-2">
                            <span className={`inline-flex items-center gap-1 text-[11px]`}>
                              <span className={`w-1.5 h-1.5 rounded-full ${c.status === "current" ? "bg-emerald-500" : "bg-amber-500"}`} />
                              {c.status === "current" ? `Current (${c.status_pct}%)` : `In Progress (${c.status_pct}%)`}
                            </span>
                          </td>
                          <td className="py-2 text-[12px]">{c.last_activity}</td>
                          <td className="py-2 text-right font-mono-num">{c.items}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </SectionCard>

              <SectionCard title={`Transaction Resolution · ${rangeLabel}`}>
                {(() => {
                  const r = data.resolution || {};
                  const total = r.total || 0;
                  const parts = [
                    { key: "auto",         color: "#10b981", label: "Auto-resolved",           v: r.auto },
                    { key: "client_input", color: "#0ea5e9", label: "Resolved with client input", v: r.client_input },
                    { key: "manual",       color: "#f59e0b", label: "Requires professional review", v: r.manual_review },
                  ];
                  // Build stroke-dasharray donut
                  const R = 42, C = 2 * Math.PI * R;
                  let offset = 0;
                  return (
                    <div className="flex items-center gap-6">
                      <div className="relative w-32 h-32 shrink-0">
                        <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                          <circle cx="50" cy="50" r={R} fill="none" stroke="#f1f5f9" strokeWidth="12" />
                          {parts.map(p => {
                            const pct = (p.v?.pct || 0) / 100;
                            const len = C * pct;
                            const seg = <circle key={p.key} cx="50" cy="50" r={R} fill="none"
                              stroke={p.color} strokeWidth="12"
                              strokeDasharray={`${len} ${C - len}`}
                              strokeDashoffset={-offset} />;
                            offset += len;
                            return seg;
                          })}
                        </svg>
                        <div className="absolute inset-0 flex flex-col items-center justify-center">
                          <div className="text-lg font-semibold text-slate-900">{total.toLocaleString()}</div>
                          <div className="text-[10px] text-slate-500">Total transactions</div>
                        </div>
                      </div>
                      <ul className="space-y-2 text-[12px]">
                        {parts.map(p => (
                          <li key={p.key} className="flex items-start gap-2">
                            <span className="w-2 h-2 rounded-full mt-1.5" style={{ background: p.color }} />
                            <div>
                              <div className="text-slate-700">{p.label}</div>
                              <div className="text-slate-500">{(p.v?.count || 0).toLocaleString()} ({p.v?.pct || 0}%)</div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })()}
              </SectionCard>

              <SectionCard
                title="AI Activity Feed"
                mocked={data.ai_activity_mocked}
                onViewAll={() => navigate("/cockpit/agents")}
              >
                {(data.ai_activity || []).length === 0 ? (
                  <EmptyRow text="No agent activity yet. Findings will appear here as they land." />
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {data.ai_activity.map(a => (
                      <li key={a.id} className="py-2.5">
                        <div className="flex items-baseline justify-between gap-2">
                          <div className="text-sm text-slate-900 truncate flex-1">{a.title}</div>
                          <div className="text-[10px] text-slate-400 shrink-0">{a.at}</div>
                        </div>
                        <div className="text-[11px] text-slate-500">{a.subtitle}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
