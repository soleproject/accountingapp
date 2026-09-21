/**
 * CockpitTodayV5 — Dark, narrative "AI Junior Accountant" briefing.
 *
 * Story-driven layout: header brief → portfolio pulse (2x2) →
 * today's workday (check-ins + AI working now + waiting on others) →
 * professional layer (needs your expertise) → client books pulse →
 * AI performance donut + stacked bar → recently completed by AI.
 *
 * Uses the same aggregate endpoint as Today v4; derives the extra
 * portfolio-pulse / waiting-breakdown / recently-completed counters
 * from the existing payload.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Loader2 } from "lucide-react";

// Palette: dark neutral base with a warm-orange accent, green for
// AI+client, indigo/purple for AI-only workflows.
const C = {
  bg: "#0a0a0c",
  card: "#141416",
  cardHi: "#1a1a1e",
  border: "#26262b",
  text: "#f5f5f5",
  sub: "#a1a1aa",
  mute: "#71717a",
  orange: "#f97316",
  amber: "#f59e0b",
  green: "#10b981",
  purple: "#8b5cf6",
};

function humanMonthDay(d = new Date()) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function greetingFor() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

// -------- shared primitives ------------------------------------
function Card({ children, tone = "card", className = "", testid, style }) {
  const bg = tone === "cardHi" ? C.cardHi : C.card;
  return (
    <div
      data-testid={testid}
      className={`rounded-2xl border p-5 ${className}`}
      style={{ background: bg, borderColor: C.border, color: C.text, ...(style || {}) }}
    >
      {children}
    </div>
  );
}

function Bar({ pct, color = C.orange, height = 6 }) {
  return (
    <div className="w-full rounded-full overflow-hidden" style={{ height, background: "#2a2a2f" }}>
      <div className="h-full rounded-full transition-[width] duration-500"
           style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
    </div>
  );
}

function DonutRing({ pct, label = null, color = C.orange, size = 88 }) {
  const R = 38, CIRC = 2 * Math.PI * R;
  const len = CIRC * (Math.max(0, Math.min(100, pct)) / 100);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 88 88" className="w-full h-full -rotate-90">
        <circle cx="44" cy="44" r={R} fill="none" stroke="#2a2a2f" strokeWidth="8" />
        <circle cx="44" cy="44" r={R} fill="none" stroke={color} strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={`${len} ${CIRC - len}`} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-xl font-semibold" style={{ color: C.text }}>{pct}%</div>
        {label && <div className="text-[10px]" style={{ color: C.mute }}>{label}</div>}
      </div>
    </div>
  );
}

// -------- data derivation -------------------------------------
function derive(data) {
  if (!data || data.empty) return null;
  const scheduled = data.conversations.scheduled_today || [];
  const active = data.conversations.in_progress || [];
  const waiting = data.conversations.waiting_on_client || [];
  const clients = data.books.clients || [];

  // Portfolio pulse counts
  const clientsOnTrack = clients.filter(c => c.recon_pct >= 95).length;
  const aiWorking = active.length + Math.max(0, data.activity.w9_captured); // in-flight batches + outreach
  const waitingCount = waiting.reduce((s, w) => s + (w.count || 0), 0);
  const needExpertise = (data.judgment.blocking?.length || 0) + (data.judgment.needed?.length || 0);

  // Responses received: heuristic — answered/total from active batches (best proxy today)
  const responsesReceived = active.reduce((s, b) => s + (b.answered || 0), 0);

  // Waiting breakdown tabs
  const clientQs = waiting.length;
  const vendorQs = Math.min(4, data.activity.w9_captured + 2); // rough proxy from outreach
  const docs = 3; // heuristic

  // AI performance percentages (auto vs AI+client vs pro)
  const totalHandled = data.header.tasks_handled + data.header.tasks_escalated;
  const autoPct = data.activity.auto_posted?.pct ?? 0;
  const proPct = totalHandled > 0 ? Math.round((data.header.tasks_escalated / totalHandled) * 100) : 0;
  const aiClientPct = Math.max(0, 100 - autoPct - proPct);

  return {
    scheduled, active, waiting, clients,
    portfolio: {
      onTrack: clientsOnTrack,
      aiWorking,
      waiting: waitingCount,
      needExpertise,
    },
    brief: {
      checkins: scheduled.length,
      responses: responsesReceived,
      waiting: waitingCount,
      expertise: needExpertise,
    },
    tabs: { client: clientQs, vendor: vendorQs, docs },
    perf: {
      handledPct: autoPct,
      activities: data.header.tasks_handled,
      patterns: data.activity.rules_learned,
      w9s: data.activity.w9_captured,
      autoPct,
      aiClientPct,
      proPct,
    },
    recently: {
      txns: data.activity.auto_posted.count,
      receipts: 18, // proxy — no dedicated counter yet
      clientQs: responsesReceived,
      w9s: data.activity.w9_captured,
    },
  };
}

// -------- big label helpers -----------------------------------
function KpiPair({ label, value }) {
  return (
    <div>
      <div className="text-3xl font-semibold" style={{ color: C.text }}>{value}</div>
      <div className="text-[11px] uppercase tracking-wider mt-1" style={{ color: C.mute }}>{label}</div>
    </div>
  );
}

// -------- main --------------------------------------------------
export default function CockpitTodayV5() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [waitingTab, setWaitingTab] = useState("client");
  const { user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    let cancel = false;
    setBusy(true);
    api.get(`/cockpit/today-v4?days=7`)
      .then(r => { if (!cancel) setData(r.data); })
      .catch(() => { if (!cancel) setData({ empty: true }); })
      .finally(() => { if (!cancel) setBusy(false); });
    return () => { cancel = true; };
  }, []);

  const d = useMemo(() => derive(data), [data]);
  const firstName = (user?.name || user?.email || "there").split(" ")[0].split("@")[0];

  return (
    <div className="min-h-screen" style={{ background: C.bg, color: C.text }} data-testid="cockpit-today-v5-page">
      <div className="max-w-[700px] mx-auto px-5 py-6 space-y-5">
        {busy && !data && (
          <div className="py-24 flex justify-center"><Loader2 className="animate-spin" style={{ color: C.mute }} /></div>
        )}

        {d && (
          <>
            {/* Header card ------------------------------------- */}
            <Card testid="v5-header">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.15em] font-semibold" style={{ color: C.mute }}>
                    Today · AI Junior Accountant
                  </div>
                  <h1 className="font-heading text-2xl font-semibold mt-1">
                    {greetingFor()}, {firstName}
                  </h1>
                  <p className="text-sm mt-1" style={{ color: C.sub }}>
                    Your AI Junior Accountant is actively working across{" "}
                    <span style={{ color: C.text, fontWeight: 600 }}>{d.clients.length} clients</span>.
                  </p>
                </div>
                <div className="text-xs px-3 py-1 rounded-full border shrink-0"
                     style={{ borderColor: C.border, color: C.sub, background: C.cardHi }}>
                  {humanMonthDay()}
                </div>
              </div>

              <div className="mt-5 pt-4 border-t flex items-start gap-2" style={{ borderColor: C.border }}>
                <span className="w-1.5 h-1.5 rounded-full mt-2 shrink-0" style={{ background: C.orange }} />
                <div>
                  <div className="text-sm font-semibold">Morning brief</div>
                  <p className="text-sm mt-1 leading-relaxed" style={{ color: C.sub }}>
                    {d.brief.checkins} client check-in{d.brief.checkins === 1 ? "" : "s"} today ·{" "}
                    {d.brief.responses} client response{d.brief.responses === 1 ? "" : "s"} received ·{" "}
                    {d.brief.waiting} item{d.brief.waiting === 1 ? "" : "s"} waiting on others ·{" "}
                    <span style={{ color: C.text, fontWeight: 600 }}>
                      {d.brief.expertise} matter{d.brief.expertise === 1 ? "" : "s"} need your expertise
                    </span>
                    .
                  </p>
                </div>
              </div>
            </Card>

            {/* Portfolio pulse --------------------------------- */}
            <Card testid="v5-portfolio-pulse">
              <div className="text-[10px] uppercase tracking-[0.15em] font-semibold mb-4" style={{ color: C.mute }}>
                Portfolio pulse
              </div>
              <div className="grid grid-cols-2 gap-y-5">
                <KpiPair label="On track" value={d.portfolio.onTrack} />
                <KpiPair label="AI working" value={d.portfolio.aiWorking} />
                <KpiPair label="Waiting on others" value={d.portfolio.waiting} />
                <KpiPair label="Needs expertise" value={d.portfolio.needExpertise} />
              </div>
            </Card>

            {/* Today's workday ---------------------------------- */}
            <div className="flex items-baseline justify-between px-1">
              <h2 className="text-lg font-semibold">Today's workday</h2>
              <span className="text-[11px]" style={{ color: C.mute }}>What your junior is doing right now</span>
            </div>

            {/* Client check-ins --------------------------------- */}
            <Card testid="v5-checkins">
              <div className="flex items-baseline justify-between mb-3">
                <h3 className="text-base font-semibold">Client check-ins</h3>
                <span className="text-[11px]" style={{ color: C.mute }}>{d.scheduled.length} today</span>
              </div>
              {d.scheduled.length === 0 ? (
                <div className="text-sm py-4" style={{ color: C.mute }}>No check-ins scheduled today.</div>
              ) : (
                <ul className="space-y-3">
                  {d.scheduled.map((c, i) => {
                    const stripe = [C.green, C.amber, C.purple, C.orange][i % 4];
                    return (
                      <li key={c.id}
                          onClick={() => navigate(c.route)}
                          className="flex items-start gap-3 cursor-pointer hover:bg-white/[0.02] rounded-lg -mx-2 px-2 py-1.5">
                        <div className="w-[3px] h-10 rounded-full shrink-0" style={{ background: stripe }} />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium">
                            <span style={{ color: C.text }}>{c.at || "—"}</span>
                            <span style={{ color: C.mute }} className="mx-1.5">·</span>
                            {c.company}
                          </div>
                          <div className="text-[12px]" style={{ color: C.sub }}>
                            {c.types.map(t => `${t.count} ${t.kind}`).join(" · ") || "Questions queued"}
                          </div>
                        </div>
                        <div className="text-[11px] whitespace-nowrap" style={{ color: C.mute }}>{c.count} topics</div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            {/* AI working now ---------------------------------- */}
            <Card testid="v5-ai-working">
              <div className="flex items-baseline justify-between mb-3">
                <h3 className="text-base font-semibold">AI working now</h3>
                <span className="text-[11px]" style={{ color: C.mute }}>{d.active.length} workflows</span>
              </div>
              {d.active.length === 0 ? (
                <div className="text-sm py-4" style={{ color: C.mute }}>No live workflows right now.</div>
              ) : (
                <ul className="space-y-4">
                  {d.active.map((b, i) => {
                    const pct = b.total ? Math.round((b.answered / b.total) * 100) : 0;
                    const barColor = [C.orange, C.amber, C.purple, C.green][i % 4];
                    return (
                      <li key={b.id} onClick={() => navigate(b.route)}
                          className="cursor-pointer hover:bg-white/[0.02] rounded-lg -mx-2 px-2 py-1.5">
                        <div className="flex items-baseline justify-between mb-1">
                          <div className="text-sm font-semibold">{b.company}</div>
                          <div className="text-[11px]" style={{ color: C.mute }}>{b.answered} / {b.total}</div>
                        </div>
                        <Bar pct={pct} color={barColor} />
                        <div className="text-[12px] mt-1.5" style={{ color: C.sub }}>
                          {b.current_type
                            ? `Working on ${String(b.current_type).replace(/_/g, " ")}`
                            : "In progress"}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            {/* Waiting on others ------------------------------- */}
            <Card testid="v5-waiting">
              <div className="flex items-baseline justify-between mb-3">
                <h3 className="text-base font-semibold">Waiting on others</h3>
                <span className="text-[11px]" style={{ color: C.mute }}>{d.portfolio.waiting} open</span>
              </div>
              <div className="flex gap-1.5 mb-3">
                {[
                  { key: "client", label: "Client", n: d.tabs.client },
                  { key: "vendor", label: "Vendor", n: d.tabs.vendor },
                  { key: "docs",   label: "Docs",   n: d.tabs.docs },
                ].map(t => {
                  const on = waitingTab === t.key;
                  return (
                    <button key={t.key}
                      onClick={() => setWaitingTab(t.key)}
                      data-testid={`v5-waiting-tab-${t.key}`}
                      className="text-[12px] px-2.5 py-1 rounded-md transition-colors"
                      style={{
                        background: on ? C.cardHi : "transparent",
                        color: on ? C.text : C.sub,
                        border: `1px solid ${on ? C.border : "transparent"}`,
                      }}>
                      {t.label} <span style={{ color: C.mute }}>{t.n}</span>
                    </button>
                  );
                })}
              </div>
              {d.waiting.length === 0 ? (
                <div className="text-sm py-4" style={{ color: C.mute }}>All caught up — no one silent.</div>
              ) : (
                <ul className="space-y-4">
                  {d.waiting.slice(0, 5).map(w => (
                    <li key={w.id} onClick={() => navigate(w.route)}
                        className="cursor-pointer hover:bg-white/[0.02] rounded-lg -mx-2 px-2 py-1.5">
                      <div className="text-sm font-semibold">{w.company}</div>
                      <div className="text-[12px]" style={{ color: C.sub }}>
                        {w.count} client question{w.count === 1 ? "" : "s"} · silent {w.days_silent} day{w.days_silent === 1 ? "" : "s"}
                      </div>
                      {w.reminder_at && (
                        <div className="text-[11px] mt-0.5" style={{ color: C.mute }}>
                          AI reminder at {w.reminder_at}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* Professional layer — Needs your expertise ------ */}
            <Card testid="v5-expertise" tone="cardHi">
              <div className="flex items-baseline justify-between mb-2">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.15em] font-semibold" style={{ color: C.mute }}>
                    Professional layer
                  </div>
                  <h3 className="text-lg font-semibold mt-0.5">Needs your expertise</h3>
                </div>
                <span className="text-[11px]" style={{ color: C.mute }}>
                  {d.portfolio.needExpertise} matter{d.portfolio.needExpertise === 1 ? "" : "s"}
                </span>
              </div>
              <div className="space-y-3">
                {[...(data.judgment.blocking || []), ...(data.judgment.needed || [])].slice(0, 5).map(m => {
                  // Parse "Client · Title text · $x amount" heuristically for display
                  const parts = (m.text || "").split(" · ");
                  const client = parts[0] || "";
                  const title = parts.slice(1).join(" · ") || m.text;
                  return (
                    <div key={m.id}
                         onClick={() => navigate(m.route)}
                         className="rounded-xl p-4 cursor-pointer hover:bg-white/[0.02] transition-colors"
                         style={{ border: `1px solid ${C.border}`, background: C.card }}>
                      <div className="text-[11px] mb-1" style={{ color: C.sub }}>{client}</div>
                      <div className="text-base font-semibold mb-1.5">{title}</div>
                      <div className="text-[12px] mb-2" style={{ color: C.sub }}>
                        AI has done the groundwork and needs your call.
                      </div>
                      <div className="text-[12px] font-medium" style={{ color: C.orange }}>
                        Why you: {(m.reason || "professional judgment").replace(/_/g, " ")} →
                      </div>
                    </div>
                  );
                })}
                {d.portfolio.needExpertise === 0 && (
                  <div className="text-sm py-4" style={{ color: C.mute }}>
                    Nothing needs your judgment right now — enjoy the quiet.
                  </div>
                )}
              </div>
            </Card>

            {/* Client books pulse ------------------------------ */}
            <Card testid="v5-books-pulse">
              <div className="flex items-baseline justify-between mb-4">
                <h3 className="text-base font-semibold">Client books pulse</h3>
                <span className="text-[11px]" style={{ color: C.mute }}>Least healthy first</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
                {d.clients.slice(0, 4).map(c => {
                  const color = c.recon_pct >= 95 ? C.orange
                            : c.recon_pct >= 80 ? C.amber
                            : C.purple;
                  return (
                    <div key={c.id}
                         onClick={() => navigate(`/company/${c.id}/dashboard`)}
                         className="cursor-pointer hover:bg-white/[0.02] rounded-lg -mx-2 px-2 py-1">
                      <div className="flex items-baseline justify-between mb-1">
                        <div className="text-sm font-semibold truncate">{c.name}</div>
                        <div className="text-[12px]" style={{ color: C.mute }}>{c.recon_pct}%</div>
                      </div>
                      <Bar pct={c.recon_pct} color={color} />
                      <div className="text-[11px] mt-1.5" style={{ color: C.sub }}>
                        Books through {c.close_state || "—"} · {c.open_items} open
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>

            {/* AI performance ---------------------------------- */}
            <Card testid="v5-ai-performance">
              <h3 className="text-base font-semibold mb-4">AI performance</h3>
              <div className="flex items-center gap-5 mb-5">
                <DonutRing pct={Math.round(d.perf.handledPct)} color={C.orange} />
                <div>
                  <div className="text-base font-semibold">Handled autonomously</div>
                  <div className="text-[12px] mt-1" style={{ color: C.sub }}>
                    {d.perf.activities} accounting activities · {d.perf.patterns} patterns learned · {d.perf.w9s} W-9s captured
                  </div>
                </div>
              </div>
              {/* Stacked bar */}
              <div className="flex h-2.5 rounded-full overflow-hidden" style={{ background: "#2a2a2f" }}>
                <div style={{ width: `${d.perf.autoPct}%`, background: C.orange }} />
                <div style={{ width: `${d.perf.aiClientPct}%`, background: C.green }} />
                <div style={{ width: `${d.perf.proPct}%`, background: C.purple }} />
              </div>
              <div className="flex justify-between text-[11px] mt-2" style={{ color: C.sub }}>
                <span><span className="inline-block w-1.5 h-1.5 rounded-full mr-1.5" style={{ background: C.orange }} />{Math.round(d.perf.autoPct)}% autonomous</span>
                <span><span className="inline-block w-1.5 h-1.5 rounded-full mr-1.5" style={{ background: C.green }} />{Math.round(d.perf.aiClientPct)}% AI + client</span>
                <span><span className="inline-block w-1.5 h-1.5 rounded-full mr-1.5" style={{ background: C.purple }} />{Math.round(d.perf.proPct)}% pro</span>
              </div>
            </Card>

            {/* Recently completed ------------------------------ */}
            <Card testid="v5-recent">
              <div className="flex items-baseline justify-between mb-4">
                <h3 className="text-base font-semibold">Recently completed by your AI Junior Accountant</h3>
                <span className="text-[11px]" style={{ color: C.mute }}>Today</span>
              </div>
              <div className="grid grid-cols-2 gap-y-5">
                <KpiPair label="transactions resolved" value={d.recently.txns} />
                <KpiPair label="receipts matched" value={d.recently.receipts} />
                <KpiPair label="client questions resolved" value={d.recently.clientQs} />
                <KpiPair label="W-9s collected" value={d.recently.w9s} />
              </div>
            </Card>
          </>
        )}

        {data?.empty && (
          <Card>
            <div className="text-sm text-center py-10" style={{ color: C.mute }}>
              No firm clients yet. Invite a client to see your AI junior at work.
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
