/**
 * MerchantReviewDashboard — the underwriter's landing page.
 *
 * Route: /admin/merchant-review (replaces the old redirect to /awaiting)
 *
 * Three KPI hero cards (Awaiting Review, Waiting on Client, New
 * Submissions Today) with sparklines and trend deltas, a "Pick up
 * next" queue of the five oldest actionable apps, and a rolling
 * activity feed of the last seven days of approvals / declines /
 * info-requests.
 *
 * All data comes from a single `GET /api/underwriter/dashboard`
 * round trip so the page paints in one shot.
 */
import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  Inbox, MessageSquareWarning, Sparkles, TrendingUp, TrendingDown,
  Clock, ArrowRight, CheckCircle2, XCircle, Loader2, ShieldCheck,
  AlertTriangle, Zap, MailCheck,
} from "lucide-react";
import { api } from "@/lib/api";

/** Inline SVG sparkline. Zero-dep, crisp on retina. */
function Sparkline({ data, stroke = "#38bdf8", fill = "rgba(56,189,248,0.18)", height = 42, width = 168 }) {
  if (!data || data.length === 0) return <div style={{ height, width }} />;
  const max = Math.max(...data, 1);
  const step = width / (data.length - 1 || 1);
  const points = data.map((v, i) => {
    const x = i * step;
    const y = height - (v / max) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = points.join(" ");
  const area = `0,${height} ${line} ${width},${height}`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <polygon points={area} fill={fill} />
      <polyline
        points={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Endpoint dot for extra emphasis. */}
      <circle
        cx={(data.length - 1) * step}
        cy={height - (data[data.length - 1] / max) * (height - 4) - 2}
        r={2.5}
        fill={stroke}
      />
    </svg>
  );
}

/** ± delta chip with directional arrow + trend color. */
function DeltaChip({ pct }) {
  if (pct === null || pct === undefined) {
    return <span className="text-[10px] text-slate-500">no prior data</span>;
  }
  const up = pct >= 0;
  const Icon = up ? TrendingUp : TrendingDown;
  const tone = up ? "text-emerald-400" : "text-rose-400";
  const sign = up ? "+" : "";
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-semibold ${tone}`}>
      <Icon size={11} /> {sign}{pct.toFixed(1)}% vs prior 7d
    </span>
  );
}

/** Human-friendly "X hours ago" / "3 days ago". */
function fmtAgo(hours) {
  if (hours === null || hours === undefined) return "—";
  if (hours < 1) return "just now";
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const d = hours / 24;
  return `${d.toFixed(d < 10 ? 1 : 0)}d ago`;
}

/** Localized date+time — used sparingly, only where full precision matters. */
function fmtDT(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  } catch { return iso; }
}

export default function MerchantReviewDashboard() {
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await api.get("/underwriter/dashboard");
        if (!cancelled) setData(r.data);
      } catch (e) {
        const msg = e?.response?.data?.detail || "Couldn't load dashboard.";
        setErr(msg);
        toast.error(msg);
      }
    };
    load();
    // Refresh every 60s so the KPI cards feel live during the workday.
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (err && !data) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-slate-600 text-[13px]">{err}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="animate-spin text-slate-400" />
      </div>
    );
  }

  const aw   = data.kpis.awaiting_review;
  const wait = data.kpis.waiting_on_client;
  const nsub = data.kpis.new_submissions_today;
  const rcvd = data.kpis.info_received || { count: 0, freshest_hours: null, over_24h_count: 0, items: [] };
  const now  = new Date();

  const openApp = (cid) => nav(`/admin/merchant-review/apps/${cid}`);

  return (
    <div className="min-h-screen bg-slate-50" data-testid="merchant-review-dashboard">
      <div className="max-w-[1400px] mx-auto px-6 py-6">

        {/* -------- Hero -------------------------------------------------- */}
        <div
          className="relative rounded-3xl overflow-hidden mb-6 text-white shadow-2xl"
          style={{
            background:
              "radial-gradient(1200px 400px at 0% 0%, rgba(56,189,248,0.18), transparent 60%)," +
              "radial-gradient(900px 500px at 100% 100%, rgba(16,185,129,0.15), transparent 60%)," +
              "linear-gradient(135deg, #0b1220 0%, #111827 55%, #0f172a 100%)",
          }}
          data-testid="uw-dashboard-hero"
        >
          {/* Soft grain overlay — subtle texture on top of the gradient. */}
          <div
            className="pointer-events-none absolute inset-0 opacity-[0.05]"
            style={{
              backgroundImage:
                "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence baseFrequency='0.9'/></filter><rect width='100%25' height='100%25' filter='url(%23n)' opacity='0.6'/></svg>\")",
            }}
          />
          <div className="relative p-7 sm:p-9 flex flex-col md:flex-row md:items-center md:justify-between gap-6">
            <div>
              <div className="inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] font-bold text-sky-300/90">
                <ShieldCheck size={13} /> Underwriter · Merchant Services
              </div>
              <h1 className="mt-2 text-3xl sm:text-4xl font-extrabold tracking-tight">
                {(() => {
                  const h = now.getHours();
                  const greet = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
                  return `${greet} — here's your pipeline.`;
                })()}
              </h1>
              <p className="mt-2 text-slate-300/90 text-[13.5px] max-w-xl leading-relaxed">
                {(() => {
                  // "Needs attention" now includes info_received —
                  // clients who responded are top priority to close.
                  const attn = aw.count + wait.count + rcvd.count;
                  if (attn === 0) return "You're all clear. Nothing waiting on you right now.";
                  const oldest = aw.oldest_hours != null
                    ? `Oldest awaiting review is ${fmtAgo(aw.oldest_hours)}.`
                    : rcvd.freshest_hours != null
                      ? `${rcvd.count} client${rcvd.count === 1 ? " has" : "s have"} just responded.`
                      : "";
                  return `${attn} application${attn === 1 ? "" : "s"} need your attention. ${oldest}`.trim();
                })()}
              </p>
            </div>

            {/* Live funnel mini-strip inside the hero. */}
            <div className="grid grid-cols-4 sm:grid-cols-7 gap-1.5 md:max-w-[520px]">
              <FunnelPip label="Started"    count={data.funnel.draft}             onClick={() => nav("/admin/merchant-review/started")}   tone="text-slate-200" />
              <FunnelPip label="Awaiting"   count={data.funnel.submitted}         onClick={() => nav("/admin/merchant-review/awaiting")}  tone="text-amber-300"     accent hot />
              <FunnelPip label="Processing" count={data.funnel.processing}        onClick={() => nav("/admin/merchant-review/processing")} tone="text-sky-300" />
              <FunnelPip label="Waiting"    count={data.funnel.waiting_on_client} onClick={() => nav("/admin/merchant-review/waiting")}    tone="text-orange-300"    accent hot={wait.over_3d_count > 0} />
              <FunnelPip label="Info recv." count={data.funnel.info_received}     onClick={() => nav("/admin/merchant-review/info-received")} tone="text-violet-300" accent hot={rcvd.count > 0} />
              <FunnelPip label="Approved"   count={data.funnel.approved}          onClick={() => nav("/admin/merchant-review/approved")}   tone="text-emerald-300" />
              <FunnelPip label="Declined"   count={data.funnel.declined}          onClick={() => nav("/admin/merchant-review/declined")}   tone="text-rose-300" />
            </div>
          </div>
        </div>

        {/* -------- Four KPI cards --------------------------------------
            Order intentional:
              1. Awaiting Review — new work
              2. Info Received  — client just responded, hot follow-up
              3. Waiting on Client — blocked, needs a nudge
              4. New Submissions Today — today's inbox snapshot */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">

          {/* Awaiting Review */}
          <KpiCard
            testid="kpi-awaiting"
            tone="amber"
            title="Awaiting Review"
            subtitle={aw.oldest_hours ? `Oldest waiting ${fmtAgo(aw.oldest_hours)}` : "Queue is empty"}
            value={aw.count}
            icon={Inbox}
            onOpen={() => nav("/admin/merchant-review/awaiting")}
            body={
              <>
                <div className="flex items-end justify-between mt-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">14d submissions</div>
                    <DeltaChip pct={aw.delta_pct_7d} />
                  </div>
                  <Sparkline data={aw.sparkline_14d} stroke="#f59e0b" fill="rgba(245,158,11,0.15)" width={110} />
                </div>
                {aw.top_oldest.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-slate-100">
                    <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold mb-1.5">
                      Top oldest
                    </div>
                    <ul className="space-y-1">
                      {aw.top_oldest.map((r) => (
                        <li key={r.company_id}>
                          <button
                            type="button"
                            onClick={() => openApp(r.company_id)}
                            className="w-full flex items-center justify-between gap-2 text-left rounded-md px-2 py-1.5 hover:bg-amber-50 group"
                            data-testid={`awaiting-oldest-${r.company_id}`}
                          >
                            <span className="text-[13px] font-medium text-slate-800 truncate">{r.company_name}</span>
                            <span className="text-[11px] text-amber-700 font-semibold whitespace-nowrap">
                              {fmtAgo(r.hours_waiting)}
                              <ArrowRight size={10} className="inline ml-1 opacity-0 group-hover:opacity-100 transition" />
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            }
          />

          {/* Info Received — client just responded, actionable NOW */}
          <KpiCard
            testid="kpi-info-received"
            tone="violet"
            title="Info Received"
            subtitle={
              rcvd.count === 0
                ? "No pending responses"
                : rcvd.freshest_hours != null
                  ? `Freshest response ${fmtAgo(rcvd.freshest_hours)}`
                  : `${rcvd.count} awaiting close-out`
            }
            value={rcvd.count}
            icon={MailCheck}
            onOpen={() => nav("/admin/merchant-review/info-received")}
            body={
              <>
                <div className="flex items-center gap-2 mt-3">
                  <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                    rcvd.over_24h_count > 0
                      ? "bg-rose-50 text-rose-700 border border-rose-200"
                      : rcvd.count > 0
                        ? "bg-violet-50 text-violet-700 border border-violet-200"
                        : "bg-slate-100 text-slate-600 border border-slate-200"
                  }`}>
                    {rcvd.over_24h_count > 0 && <AlertTriangle size={11} />}
                    {rcvd.over_24h_count > 0
                      ? `${rcvd.over_24h_count} stale (>24h)`
                      : rcvd.count > 0 ? "Fresh — close the loop" : "All caught up"}
                  </div>
                </div>
                {rcvd.items.length > 0 ? (
                  <div className="mt-4 pt-3 border-t border-slate-100">
                    <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold mb-1.5">
                      Just responded
                    </div>
                    <ul className="space-y-1">
                      {rcvd.items.map((r) => (
                        <li key={r.company_id}>
                          <button
                            type="button"
                            onClick={() => openApp(r.company_id)}
                            className="w-full text-left rounded-md px-2 py-1.5 hover:bg-violet-50 group"
                            data-testid={`info-received-${r.company_id}`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-[13px] font-medium text-slate-800 truncate">{r.company_name}</span>
                              <span className={`text-[11px] font-semibold whitespace-nowrap ${
                                r.hours_since_resubmit >= 24 ? "text-rose-600" : "text-violet-700"
                              }`}>
                                {fmtAgo(r.hours_since_resubmit)}
                              </span>
                            </div>
                            {r.note_preview && (
                              <div className="text-[11px] text-slate-500 truncate italic">re: "{r.note_preview}"</div>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="mt-4 pt-3 border-t border-slate-100 text-[12px] text-slate-500 italic">
                    No client responses waiting.
                  </div>
                )}
              </>
            }
          />

          {/* Waiting on Client */}
          <KpiCard
            testid="kpi-waiting"
            tone="orange"
            title="Waiting on Client"
            subtitle={wait.oldest_days != null ? `Longest wait ${wait.oldest_days}d` : "Nothing outstanding"}
            value={wait.count}
            icon={MessageSquareWarning}
            onOpen={() => nav("/admin/merchant-review/waiting")}
            body={
              <>
                <div className="flex items-center gap-2 mt-3">
                  <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                    wait.over_3d_count > 0
                      ? "bg-rose-50 text-rose-700 border border-rose-200"
                      : "bg-slate-100 text-slate-600 border border-slate-200"
                  }`}>
                    {wait.over_3d_count > 0 && <AlertTriangle size={11} />}
                    {wait.over_3d_count} nudge-eligible (&gt;3d)
                  </div>
                </div>
                {wait.watchlist.length > 0 ? (
                  <div className="mt-4 pt-3 border-t border-slate-100">
                    <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold mb-1.5">
                      Watchlist
                    </div>
                    <ul className="space-y-1">
                      {wait.watchlist.map((r) => (
                        <li key={r.company_id}>
                          <button
                            type="button"
                            onClick={() => openApp(r.company_id)}
                            className="w-full text-left rounded-md px-2 py-1.5 hover:bg-orange-50 group"
                            data-testid={`waiting-watch-${r.company_id}`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-[13px] font-medium text-slate-800 truncate">{r.company_name}</span>
                              <span className={`text-[11px] font-semibold whitespace-nowrap ${
                                r.days_waiting >= 3 ? "text-rose-600" : "text-orange-700"
                              }`}>
                                {r.days_waiting != null ? `${r.days_waiting}d` : "—"}
                              </span>
                            </div>
                            {r.note_preview && (
                              <div className="text-[11px] text-slate-500 truncate italic">"{r.note_preview}"</div>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="mt-4 pt-3 border-t border-slate-100 text-[12px] text-slate-500 italic">
                    No merchants waiting — all clear.
                  </div>
                )}
              </>
            }
          />

          {/* New Submissions Today */}
          <KpiCard
            testid="kpi-new-today"
            tone="sky"
            title="New Submissions Today"
            subtitle={nsub.count === 0 ? "None yet today" : `${nsub.count} came in today`}
            value={nsub.count}
            icon={Sparkles}
            onOpen={() => nav("/admin/merchant-review/awaiting")}
            body={
              nsub.items.length > 0 ? (
                <div className="mt-4 pt-3 border-t border-slate-100">
                  <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold mb-1.5">
                    Today's inbox
                  </div>
                  <ul className="space-y-1">
                    {nsub.items.map((r) => (
                      <li key={r.company_id}>
                        <button
                          type="button"
                          onClick={() => openApp(r.company_id)}
                          className="w-full flex items-center justify-between gap-2 text-left rounded-md px-2 py-1.5 hover:bg-sky-50 group"
                          data-testid={`new-today-${r.company_id}`}
                        >
                          <span className="text-[13px] font-medium text-slate-800 truncate">
                            {r.company_name}
                            {r.dba && <span className="text-slate-400 font-normal"> · {r.dba}</span>}
                          </span>
                          <span className="text-[11px] text-sky-700 font-semibold whitespace-nowrap">
                            {fmtAgo(r.hours_since_submit)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="mt-4 pt-3 border-t border-slate-100 text-[12px] text-slate-500 italic">
                  Empty inbox — nothing new since midnight UTC.
                </div>
              )
            }
          />
        </div>

        {/* -------- Pick up next strip ------------------------------------ */}
        <section
          className="rounded-2xl border border-slate-200 bg-white shadow-sm p-5 mb-6"
          data-testid="pick-up-next"
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Zap size={14} className="text-amber-500" />
              <h2 className="text-[14px] font-bold text-slate-900">Pick up next</h2>
              <span className="text-[11px] text-slate-500">Five oldest actionable applications</span>
            </div>
            <button
              onClick={() => nav("/admin/merchant-review/awaiting")}
              className="text-[12px] text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
            >
              View all awaiting <ArrowRight size={11} />
            </button>
          </div>
          {data.pick_up_next.length === 0 ? (
            <div className="py-8 text-center text-[13px] text-slate-500 italic">
              Nothing waiting — go pour a coffee. ☕
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              {data.pick_up_next.map((r, i) => (
                <button
                  key={r.company_id}
                  onClick={() => openApp(r.company_id)}
                  className="text-left rounded-xl border border-slate-200 p-3 bg-slate-50/40 hover:bg-slate-50 hover:border-slate-300 hover:shadow-sm transition group"
                  data-testid={`pick-up-${r.company_id}`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">#{i + 1}</span>
                    <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                      r.status === "submitted"
                        ? "bg-amber-50 text-amber-700"
                        : "bg-violet-100 text-violet-800 ring-1 ring-violet-300"
                    }`} title={r.status === "info_received" ? "Client just responded — close the loop" : "Fresh submission"}>
                      {r.status === "submitted" ? "Awaiting" : "Info recv. ★"}
                    </span>
                  </div>
                  <div className="text-[13px] font-semibold text-slate-900 truncate">{r.company_name}</div>
                  <div className="text-[11px] text-slate-500 truncate">{r.dba || "—"}</div>
                  <div className="mt-2 flex items-center gap-1 text-[11px] text-slate-600">
                    <Clock size={11} />
                    <span className="font-semibold">{fmtAgo(r.hours_waiting)}</span>
                    <ArrowRight size={10} className="ml-auto text-slate-300 group-hover:text-slate-600 group-hover:translate-x-0.5 transition" />
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* -------- Recent activity feed ---------------------------------- */}
        <section className="rounded-2xl border border-slate-200 bg-white shadow-sm p-5" data-testid="recent-activity">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[14px] font-bold text-slate-900">Recent activity</h2>
            <span className="text-[11px] text-slate-500">Last 7 days · newest first</span>
          </div>
          {data.recent_activity.length === 0 ? (
            <div className="py-6 text-center text-[13px] text-slate-500 italic">
              No activity in the last 7 days.
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.recent_activity.map((a, idx) => {
                const conf = ACTIVITY_STYLE[a.type] || ACTIVITY_STYLE.approved;
                const Icon = conf.icon;
                return (
                  <li key={`${a.company_id}-${a.at}-${idx}`}>
                    <button
                      type="button"
                      onClick={() => openApp(a.company_id)}
                      className="w-full flex items-start gap-3 py-2 px-1 text-left hover:bg-slate-50 rounded"
                      data-testid={`activity-${idx}`}
                    >
                      <div className={`shrink-0 mt-0.5 w-6 h-6 rounded-full flex items-center justify-center ${conf.bg}`}>
                        <Icon size={12} className={conf.fg} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[13px] font-semibold text-slate-900 truncate">{a.company_name}</span>
                          <span className={`text-[10px] uppercase tracking-widest font-bold ${conf.fg}`}>
                            {conf.label}
                          </span>
                        </div>
                        {(a.note_preview || a.reason) && (
                          <div className="text-[12px] text-slate-500 truncate italic">
                            "{a.note_preview || a.reason}"
                          </div>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-400 shrink-0">
                        {fmtDT(a.at)}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <div className="mt-4 text-[11px] text-slate-400 text-center">
          Data refreshes every 60 seconds · last update {fmtDT(data.generated_at)}
        </div>
      </div>
    </div>
  );
}

/** Small helper card — same shape thrice with different tone/data. */
function KpiCard({ testid, tone, title, subtitle, value, icon: Icon, body, onOpen }) {
  const toneMap = {
    amber:  { border: "border-amber-200",  ring: "ring-amber-100",  iconBg: "bg-amber-50",  iconFg: "text-amber-600",  countFg: "text-amber-700" },
    orange: { border: "border-orange-200", ring: "ring-orange-100", iconBg: "bg-orange-50", iconFg: "text-orange-600", countFg: "text-orange-700" },
    sky:    { border: "border-sky-200",    ring: "ring-sky-100",    iconBg: "bg-sky-50",    iconFg: "text-sky-600",    countFg: "text-sky-700" },
    violet: { border: "border-violet-200", ring: "ring-violet-100", iconBg: "bg-violet-50", iconFg: "text-violet-600", countFg: "text-violet-700" },
  }[tone] || {};
  return (
    <div
      className={`rounded-2xl border ${toneMap.border} bg-white shadow-sm p-5 hover:shadow-md hover:ring-4 ${toneMap.ring} transition-shadow`}
      data-testid={testid}
    >
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <div className={`inline-flex items-center gap-1.5 w-7 h-7 rounded-lg ${toneMap.iconBg} ${toneMap.iconFg} justify-center`}>
            <Icon size={14} />
          </div>
          <div className="mt-2 text-[11px] uppercase tracking-widest font-bold text-slate-500">{title}</div>
          <div className={`mt-1 text-4xl font-black tracking-tight ${toneMap.countFg}`}>{value}</div>
          <div className="text-[12px] text-slate-500">{subtitle}</div>
        </div>
        <button
          onClick={onOpen}
          className="text-[11px] text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
          data-testid={`${testid}-open`}
        >
          Open <ArrowRight size={11} />
        </button>
      </div>
      {body}
    </div>
  );
}

/** Tiny hero-strip funnel pill — clickable jump to the matching bucket. */
function FunnelPip({ label, count, onClick, tone, accent, hot }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-2.5 py-2 text-left transition ${
        accent ? "bg-white/10 hover:bg-white/15" : "bg-white/5 hover:bg-white/10"
      } ${hot ? "ring-1 ring-rose-400/40" : ""}`}
      data-testid={`funnel-pip-${label.toLowerCase().replace(/\W+/g,'-')}`}
    >
      <div className={`text-[9px] uppercase tracking-widest ${tone} font-bold opacity-90`}>{label}</div>
      <div className="text-lg font-black text-white leading-tight">{count}</div>
    </button>
  );
}

const ACTIVITY_STYLE = {
  approved:       { icon: CheckCircle2,         label: "Approved",     bg: "bg-emerald-50", fg: "text-emerald-700" },
  declined:       { icon: XCircle,              label: "Declined",     bg: "bg-rose-50",    fg: "text-rose-700" },
  info_requested: { icon: MessageSquareWarning, label: "Info request", bg: "bg-orange-50",  fg: "text-orange-700" },
};
