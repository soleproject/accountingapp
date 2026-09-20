/**
 * CockpitTodayV4 — Manager view for CPAs.
 *
 * Sections (top-to-bottom):
 *   Row 0 · Header — greeting + hours-saved banner
 *   Row 1 · AI Activity Pulse (4 KPI + donut + velocity)
 *   Row 2 · Client Conversations (3 columns)
 *   Row 3 · Books Pulse (health grid + volume + runway)
 *   Row 4 · Where Your Judgment Is Needed (only pro-owned work)
 *
 * All data comes from one aggregate call to `/api/cockpit/today-v4`.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  Sparkles, Zap, Brain, FileCheck, ChevronDown, Loader2,
  AlertOctagon, Eye, ClipboardCheck, Users, Clock, ArrowRight,
  TrendingUp, MessageCircle, CalendarClock,
} from "lucide-react";

const RANGES = [
  { key: 7, label: "Last 7 days" },
  { key: 30, label: "Last 30 days" },
  { key: 90, label: "Last 90 days" },
];

function MockedChip() {
  return (
    <span className="ml-1.5 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200"
          title="Heuristic — will be tuned as we learn what works">
      Heuristic
    </span>
  );
}

// -------- tiny SVG chart primitives ---------------------------------
function Sparkline({ data, color = "#4f46e5", height = 26 }) {
  if (!data?.length) return null;
  const max = Math.max(...data, 1);
  const w = 100;
  const step = w / Math.max(1, data.length - 1);
  const points = data.map((v, i) => `${i * step},${height - (v / max) * (height - 3) - 1}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="w-full h-6" preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

function AreaChart({ series, height = 60 }) {
  if (!series?.length) return null;
  const w = 100;
  const step = w / Math.max(1, series.length - 1);
  const points = series.map((v, i) => `${i * step},${height - (v.pct / 100) * (height - 6) - 3}`).join(" ");
  const fill = `M0,${height} L${points.split(" ").join(" L")} L${w},${height} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="w-full" preserveAspectRatio="none" style={{ height }}>
      <path d={fill} fill="rgba(99,102,241,0.14)" />
      <polyline points={points} fill="none" stroke="#6366f1" strokeWidth="1.5" />
    </svg>
  );
}

function Donut({ parts }) {
  const total = parts.reduce((s, p) => s + (p.hours || 0), 0) || 1;
  const R = 42, C = 2 * Math.PI * R;
  const COLORS = { categorization: "#10b981", reconciliation: "#0ea5e9",
                    learning: "#8b5cf6", rules: "#f59e0b", w9: "#f43f5e" };
  let offset = 0;
  return (
    <div className="flex items-center gap-5">
      <div className="relative w-28 h-28 shrink-0">
        <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
          <circle cx="50" cy="50" r={R} fill="none" stroke="#f1f5f9" strokeWidth="12" />
          {parts.map(p => {
            const len = C * ((p.hours || 0) / total);
            const seg = <circle key={p.key} cx="50" cy="50" r={R} fill="none"
              stroke={COLORS[p.key] || "#94a3b8"} strokeWidth="12"
              strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} />;
            offset += len;
            return seg;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-base font-semibold text-slate-900">{total.toFixed(1)}h</div>
          <div className="text-[9px] text-slate-500">saved</div>
        </div>
      </div>
      <ul className="space-y-1 text-[11px] flex-1">
        {parts.map(p => (
          <li key={p.key} className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full" style={{ background: COLORS[p.key] }} />
            <span className="text-slate-700 flex-1 truncate">{p.label}</span>
            <span className="text-slate-500 font-mono-num">{(p.hours || 0).toFixed(1)}h</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HealthRing({ pct, size = 44 }) {
  const R = 18, C = 2 * Math.PI * R;
  const len = C * (pct / 100);
  const color = pct >= 95 ? "#10b981" : pct >= 70 ? "#f59e0b" : "#f43f5e";
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 44 44" className="w-full h-full -rotate-90">
        <circle cx="22" cy="22" r={R} fill="none" stroke="#f1f5f9" strokeWidth="4" />
        <circle cx="22" cy="22" r={R} fill="none" stroke={color} strokeWidth="4"
                strokeLinecap="round"
                strokeDasharray={`${len} ${C - len}`} />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold text-slate-800">
        {pct}%
      </div>
    </div>
  );
}

// -------- section shells --------------------------------------------
function Card({ title, right, mocked, children, testid }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 flex flex-col min-h-0"
         data-testid={testid}>
      {(title || right) && (
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-semibold text-slate-900 flex items-center">
            {title}
            {mocked && <MockedChip />}
          </div>
          {right}
        </div>
      )}
      <div className="flex-1 overflow-auto min-h-0 scrollbar-on-hover">{children}</div>
    </div>
  );
}

function KpiTile({ icon: Icon, tone, label, value, sub, testid }) {
  const toneBg = {
    emerald: "bg-emerald-50 text-emerald-600",
    indigo:  "bg-indigo-50 text-indigo-600",
    amber:   "bg-amber-50 text-amber-600",
    rose:    "bg-rose-50 text-rose-600",
    sky:     "bg-sky-50 text-sky-600",
  }[tone] || "bg-slate-100 text-slate-600";
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 flex-1 min-w-0"
         data-testid={testid}>
      <div className="flex items-start gap-2.5">
        <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${toneBg}`}>
          <Icon size={14} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xl font-semibold text-slate-900 leading-tight">{value}</div>
          <div className="text-[11px] text-slate-500 leading-tight">{label}</div>
          <div className="text-[10px] text-slate-400 mt-1">{sub}</div>
        </div>
      </div>
    </div>
  );
}

// -------- main --------------------------------------------------------
export default function CockpitTodayV4() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [rangeOpen, setRangeOpen] = useState(false);
  const [softExpanded, setSoftExpanded] = useState(false);
  const { user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    let cancel = false;
    setBusy(true);
    api.get(`/cockpit/today-v4?days=${days}`)
      .then(r => { if (!cancel) setData(r.data); })
      .catch(() => { if (!cancel) setData({ empty: true }); })
      .finally(() => { if (!cancel) setBusy(false); });
    return () => { cancel = true; };
  }, [days]);

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  }, []);
  const firstName = (user?.name || user?.email || "there").split(" ")[0].split("@")[0];
  const rangeLabel = RANGES.find(r => r.key === days)?.label || "Last 7 days";

  return (
    <div className="min-h-screen bg-slate-50" data-testid="cockpit-today-v4-page">
      <div className="max-w-[1400px] mx-auto px-6 py-4 space-y-3">
        {/* Header */}
        <div className="rounded-2xl bg-gradient-to-br from-indigo-600 to-indigo-800 text-white px-5 py-4 flex flex-wrap items-center justify-between gap-3 shadow-sm">
          <div>
            <h1 className="font-heading text-2xl font-semibold leading-tight">
              {greeting}, {firstName}
            </h1>
            {data?.header && (
              <p className="text-[13px] text-indigo-100 mt-0.5">
                Your AI junior worked{" "}
                <span className="font-semibold text-white">
                  ⏱ {data.header.hours_saved} hrs
                </span>{" "}
                this period —{" "}
                <span className="font-semibold text-white">{data.header.tasks_handled}</span> tasks
                handled,{" "}
                <span className="font-semibold text-amber-200">{data.header.tasks_escalated}</span>{" "}
                need your eyes.
              </p>
            )}
          </div>
          <div className="relative">
            <button
              onClick={() => setRangeOpen(v => !v)}
              className="flex items-center gap-1.5 text-sm bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-md text-white border border-white/20"
              data-testid="cockpit-today-v4-range-trigger"
            >
              {rangeLabel} <ChevronDown size={13} />
            </button>
            {rangeOpen && (
              <div className="absolute right-0 mt-1 w-40 rounded-md border border-slate-200 bg-white shadow-lg z-10">
                {RANGES.map(r => (
                  <button key={r.key}
                    onClick={() => { setDays(r.key); setRangeOpen(false); }}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 ${r.key === days ? "font-medium text-indigo-700" : "text-slate-700"}`}>
                    {r.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {busy && !data && (
          <div className="py-16 flex justify-center">
            <Loader2 className="animate-spin text-slate-400" />
          </div>
        )}

        {data && !data.empty && (
          <>
            {/* Row 1 · Activity pulse ------------------------------ */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-3">
              <KpiTile icon={Zap} tone="emerald"
                testid="today-v4-kpi-txns"
                label="Transactions processed"
                value={data.activity.txns_processed.value.toLocaleString()}
                sub={
                  <>
                    <Sparkline data={data.activity.txns_processed.sparkline.map(d => d.count)} />
                    <span className={data.activity.txns_processed.delta_pct >= 0 ? "text-emerald-600" : "text-rose-600"}>
                      {data.activity.txns_processed.delta_pct >= 0 ? "↑" : "↓"}{" "}
                      {Math.abs(data.activity.txns_processed.delta_pct)}%
                    </span>{" "}
                    <span className="text-slate-400">vs. prev</span>
                  </>
                }
              />
              <KpiTile icon={Sparkles} tone="indigo"
                testid="today-v4-kpi-auto"
                label="Auto-posted"
                value={`${data.activity.auto_posted.pct}%`}
                sub={<>{data.activity.auto_posted.count.toLocaleString()} posted · {data.activity.auto_posted.queued_count.toLocaleString()} queued for you</>}
              />
              <KpiTile icon={Brain} tone="amber"
                testid="today-v4-kpi-rules"
                label="Rules learned"
                value={data.activity.rules_learned}
                sub="Auto-promoted at 10+ hits, ≥98% majority"
              />
              <KpiTile icon={FileCheck} tone="rose"
                testid="today-v4-kpi-w9"
                label="W-9s captured"
                value={data.activity.w9_captured}
                sub="Vendor outreach agent · autonomous"
              />
              {/* Time-saved donut */}
              <div className="rounded-xl border border-slate-200 bg-white p-3 col-span-1 md:col-span-2 lg:col-span-1"
                   data-testid="today-v4-time-saved">
                <div className="text-[11px] font-semibold text-slate-700 mb-1">
                  Time saved
                  <MockedChip />
                </div>
                <Donut parts={data.activity.time_saved_donut} />
              </div>
              {/* Velocity area */}
              <div className="rounded-xl border border-slate-200 bg-white p-3 col-span-1 md:col-span-2 lg:col-span-1"
                   data-testid="today-v4-velocity">
                <div className="text-[11px] font-semibold text-slate-700 mb-1 flex items-center">
                  Automation velocity <TrendingUp size={11} className="ml-1 text-emerald-500" />
                </div>
                <AreaChart series={data.activity.velocity_series} />
                <div className="text-[10px] text-slate-500 mt-1">30-day auto-post %</div>
              </div>
            </div>

            {/* Row 2 · Client conversations ---------------------- */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 h-[320px]">
              <Card testid="today-v4-scheduled"
                title={<><CalendarClock size={13} className="inline mr-1 text-indigo-500" /> Scheduled today</>}
                right={<span className="text-[10px] text-slate-500">{data.conversations.scheduled_today.length} pending</span>}>
                {data.conversations.scheduled_today.length === 0 ? (
                  <div className="text-[12px] text-slate-400 py-6 text-center">
                    No client appointments scheduled today.
                  </div>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {data.conversations.scheduled_today.map(b => (
                      <li key={b.id} className="py-2 cursor-pointer hover:bg-slate-50 rounded px-1 -mx-1"
                          onClick={() => navigate(b.route)}>
                        <div className="flex items-baseline justify-between gap-2">
                          <div className="text-[12px] font-semibold text-indigo-700 shrink-0">{b.at}</div>
                          <div className="text-sm text-slate-900 flex-1 truncate">{b.company}</div>
                          <div className="text-[10px] text-slate-500">{b.count} q</div>
                        </div>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {b.types.map(t => (
                            <span key={t.kind} className="text-[9px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100">
                              {t.count}× {t.kind}
                            </span>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card testid="today-v4-inprogress"
                title={<><MessageCircle size={13} className="inline mr-1 text-emerald-500" /> In conversation now</>}
                right={<span className="text-[10px] text-slate-500">{data.conversations.in_progress.length} live</span>}>
                {data.conversations.in_progress.length === 0 ? (
                  <div className="text-[12px] text-slate-400 py-6 text-center">
                    No live client conversations right now.
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {data.conversations.in_progress.map(b => (
                      <li key={b.id} className="cursor-pointer hover:bg-slate-50 rounded px-1 py-1.5 -mx-1"
                          onClick={() => navigate(b.route)}>
                        <div className="flex items-baseline justify-between gap-2">
                          <div className="text-sm text-slate-900 truncate flex-1">{b.company}</div>
                          <div className="text-[10px] text-slate-500 shrink-0">{b.answered}/{b.total}</div>
                        </div>
                        <div className="h-1.5 rounded-full bg-slate-200 mt-1 overflow-hidden">
                          <div className="h-full bg-emerald-500 rounded-full transition-[width] duration-500"
                               style={{ width: `${b.total ? (b.answered / b.total) * 100 : 0}%` }} />
                        </div>
                        <div className="text-[10px] text-slate-500 mt-0.5">
                          On {b.current_type} · started {b.started_ago}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card testid="today-v4-waiting"
                title={<><Clock size={13} className="inline mr-1 text-amber-500" /> Waiting on client</>}
                right={<span className="text-[10px] text-slate-500">{data.conversations.waiting_on_client.length} silent</span>}>
                {data.conversations.waiting_on_client.length === 0 ? (
                  <div className="text-[12px] text-slate-400 py-6 text-center">
                    All clients responsive. Nice.
                  </div>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {data.conversations.waiting_on_client.map(b => (
                      <li key={b.id} className="py-2 cursor-pointer hover:bg-slate-50 rounded px-1 -mx-1"
                          onClick={() => navigate(b.route)}>
                        <div className="flex items-baseline justify-between gap-2">
                          <div className="text-sm text-slate-900 truncate flex-1">{b.company}</div>
                          <div className="text-[10px] text-slate-500 shrink-0">{b.count} q</div>
                        </div>
                        <div className={`text-[10px] mt-0.5 ${b.days_silent >= 3 ? "text-rose-600" : "text-slate-500"}`}>
                          {b.days_silent === 0 ? "Sent today" : `⚠ ${b.days_silent}d silent`}
                          {b.reminder_at && ` · reminder ${b.reminder_at}`}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            {/* Row 3 · Books pulse -------------------------------- */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              <Card testid="today-v4-books-grid"
                title="Book health · least healthy first"
                right={
                  <button onClick={() => navigate("/pro/clients")}
                          className="text-[11px] text-indigo-600 hover:text-indigo-800">
                    View all clients →
                  </button>
                }>
                {data.books.clients.length === 0 ? (
                  <div className="text-[12px] text-slate-400 py-6 text-center">
                    No clients yet — invite one to get started.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {data.books.clients.slice(0, 6).map(c => (
                      <div key={c.id}
                           onClick={() => navigate(`/company/${c.id}/dashboard`)}
                           className="flex items-center gap-3 border border-slate-200 rounded-lg px-2.5 py-2 hover:bg-slate-50 cursor-pointer">
                        <HealthRing pct={c.recon_pct} />
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-medium text-slate-900 truncate">{c.name}</div>
                          <div className="text-[10px] text-slate-500">
                            ${c.cash_current.toLocaleString()} · {c.close_state}
                          </div>
                          <Sparkline data={c.cash_spark} color="#10b981" height={16} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card testid="today-v4-cross-volume"
                title="Cross-client transaction volume · 14d"
                right={<span className="text-[10px] text-slate-500">top {data.books.cross_labels.length}</span>}>
                <StackedArea data={data.books.cross_volume} labels={data.books.cross_labels} />
              </Card>

              <Card testid="today-v4-runway"
                title="Cash runway"
                mocked={data.books.runway_mocked}>
                {data.books.runway.length === 0 ? (
                  <div className="text-[12px] text-slate-400 py-6 text-center">No burn signal yet.</div>
                ) : (
                  <ul className="space-y-2">
                    {data.books.runway.map(r => (
                      <li key={r.id} className="border border-slate-200 rounded-lg px-2.5 py-2 hover:bg-slate-50 cursor-pointer"
                          onClick={() => navigate(`/company/${r.id}/dashboard`)}>
                        <div className="flex items-center justify-between">
                          <div className="text-[13px] text-slate-900 truncate">{r.name}</div>
                          <div className={`text-[11px] font-semibold ${
                            r.months == null ? "text-slate-400" :
                            r.months >= 6 ? "text-emerald-600" :
                            r.months >= 3 ? "text-amber-600" : "text-rose-600"
                          }`}>
                            {r.months == null ? "—" : `${r.months}mo`}
                          </div>
                        </div>
                        <div className="text-[10px] text-slate-500">
                          ${r.cash.toLocaleString()} on hand · ${r.burn.toLocaleString()}/mo burn
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            {/* Row 4 · Judgment needed --------------------------- */}
            <JudgmentPanel
              j={data.judgment}
              softExpanded={softExpanded}
              onToggleSoft={() => setSoftExpanded(v => !v)}
              onNav={(r) => navigate(r)}
            />
          </>
        )}

        {data?.empty && (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center text-slate-500">
            No firm clients accessible yet. Invite a client to see your AI junior at work.
          </div>
        )}
      </div>
    </div>
  );
}

// -------- Row 4 helper --------------------------------------------
function JudgmentPanel({ j, softExpanded, onToggleSoft, onNav }) {
  const softCount = (j.optional?.length || 0) + (j.relationship?.length || 0);
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4" data-testid="today-v4-judgment">
      <div className="text-sm font-semibold text-slate-900 mb-3">Where your judgment is needed</div>

      <Bucket icon={AlertOctagon} tone="rose" label="Blocking"
        items={j.blocking} onNav={onNav} testid="today-v4-judgment-blocking" />
      <Bucket icon={Eye} tone="amber" label="Judgment needed"
        items={j.needed} onNav={onNav} testid="today-v4-judgment-needed" />

      {softCount > 0 && (
        <button onClick={onToggleSoft}
          className="mt-2 text-[11px] text-indigo-600 hover:text-indigo-800 flex items-center"
          data-testid="today-v4-judgment-toggle-soft">
          {softExpanded ? "Hide" : "Show"} {softCount} softer item{softCount === 1 ? "" : "s"}
          <ChevronDown size={12} className={`ml-1 transition-transform ${softExpanded ? "rotate-180" : ""}`} />
        </button>
      )}
      {softExpanded && (
        <div className="mt-3 space-y-3">
          <Bucket icon={ClipboardCheck} tone="sky" label="Optional sign-off"
            items={j.optional} onNav={onNav} testid="today-v4-judgment-optional" />
          <Bucket icon={Users} tone="indigo" label="Client relationship"
            items={j.relationship} onNav={onNav} testid="today-v4-judgment-relationship" />
        </div>
      )}

      {(j.blocking?.length + j.needed?.length + softCount) === 0 && (
        <div className="text-[12px] text-slate-400 py-4 text-center">
          Nothing needs your judgment right now — enjoy the quiet.
        </div>
      )}
    </div>
  );
}

function Bucket({ icon: Icon, tone, label, items, onNav, testid }) {
  if (!items || items.length === 0) return null;
  const toneText = {
    rose: "text-rose-600", amber: "text-amber-600",
    sky: "text-sky-600", indigo: "text-indigo-600",
  }[tone] || "text-slate-600";
  return (
    <div className="mb-2" data-testid={testid}>
      <div className={`flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider mb-1 ${toneText}`}>
        <Icon size={12} /> {label} <span className="text-slate-400 font-normal">({items.length})</span>
      </div>
      <ul className="space-y-1">
        {items.map(it => (
          <li key={it.id}
              onClick={() => onNav(it.route)}
              className="flex items-center gap-2 text-[13px] text-slate-800 hover:bg-slate-50 rounded px-2 py-1 cursor-pointer">
            <span className={`w-1.5 h-1.5 rounded-full ${
              tone === "rose" ? "bg-rose-500" :
              tone === "amber" ? "bg-amber-500" :
              tone === "sky" ? "bg-sky-500" : "bg-indigo-500"
            } shrink-0`} />
            <span className="flex-1 truncate">{it.text}</span>
            <ArrowRight size={12} className="text-slate-300 shrink-0" />
          </li>
        ))}
      </ul>
    </div>
  );
}

// -------- Stacked area for cross-client volume --------------------
function StackedArea({ data, labels }) {
  if (!data?.length || !labels?.length) {
    return <div className="text-[12px] text-slate-400 py-6 text-center">No volume yet.</div>;
  }
  const w = 100, h = 60;
  const step = w / Math.max(1, data.length - 1);
  const perDayTotal = data.map(d => labels.reduce((s, l) => s + (d[l.id] || 0), 0));
  const max = Math.max(...perDayTotal, 1);
  const COLORS = ["#6366f1", "#10b981", "#f59e0b", "#0ea5e9", "#f43f5e"];
  // Build bands bottom-up
  const bands = [];
  let running = data.map(() => 0);
  labels.forEach((lbl, li) => {
    const top = data.map((d, i) => running[i] + (d[lbl.id] || 0));
    const path = "M" + data.map((_, i) => `${i * step},${h - (running[i] / max) * (h - 4) - 2}`).join(" L")
      + " L" + top.map((v, i) => `${(data.length - 1 - i) * step},${h - (top[data.length - 1 - i] / max) * (h - 4) - 2}`).join(" L")
      + " Z";
    bands.push({ path, color: COLORS[li % COLORS.length], name: lbl.name });
    running = top;
  });
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none" style={{ height: h }}>
        {bands.map((b, i) => <path key={i} d={b.path} fill={b.color} fillOpacity={0.35} stroke={b.color} strokeWidth="0.4" />)}
      </svg>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-600 mt-1">
        {bands.map((b, i) => (
          <li key={i} className="flex items-center gap-1 truncate">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: b.color }} />
            <span className="truncate">{b.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
