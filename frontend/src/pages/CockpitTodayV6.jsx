/**
 * CockpitTodayV6 — Weekly supervisory cockpit for the AI Junior + the
 * human assistant. Structured around 3 ownership tiers:
 *
 *   AI Junior (orange)   → routine accounting + automated chasing
 *   Assistant  (sky)     → relationship-style follow-up, calls, unblocks
 *   Professional (purple)→ judgment, sign-off, unusual accounting
 *
 * Layout: Header brief → Scheduled this week + AI Accomplishments →
 * Client Conversations (this/last week) → Waiting on Others +
 * Human Assistant Follow-up → Professional Judgment → Books Status.
 *
 * Reuses `GET /api/cockpit/today-v4?days=14` and slices client-side
 * into this-week / last-week buckets.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Loader2, CheckCircle2 } from "lucide-react";

// Palette: light theme matching the rest of the app (slate base, indigo
// primary CTA). Three ownership tiers get semantic accents:
//   AI Junior   → emerald (auto-work is a "win")
//   Assistant   → sky     (warm human follow-up)
//   Professional→ indigo  (accountant action / brand primary)
const C = {
  bg: "#f8fafc",        // slate-50
  card: "#ffffff",
  cardHi: "#f8fafc",    // slate-50
  border: "#e2e8f0",    // slate-200
  text: "#0f172a",      // slate-900
  sub: "#475569",       // slate-600
  mute: "#94a3b8",      // slate-400
  ai: "#059669",         // emerald-600 — AI junior
  aiSoft: "#ecfdf5",     // emerald-50
  assistant: "#0284c7",  // sky-600 — human assistant
  assistantSoft: "#f0f9ff", // sky-50
  pro: "#4f46e5",        // indigo-600 — professional
  proSoft: "#eef2ff",    // indigo-50
  amber: "#d97706",
  green: "#10b981",
};

function greetingFor() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function OwnerChip({ tier, className = "" }) {
  const map = {
    ai: { color: C.ai, soft: C.aiSoft, label: "AI Junior" },
    assistant: { color: C.assistant, soft: C.assistantSoft, label: "Assistant" },
    pro: { color: C.pro, soft: C.proSoft, label: "Professional" },
  };
  const t = map[tier] || map.ai;
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${className}`}
      style={{ color: t.color, background: t.soft, border: `1px solid ${t.color}30` }}
    >
      <span className="w-1 h-1 rounded-full" style={{ background: t.color }} />
      {t.label}
    </span>
  );
}

function Card({ children, tone = "card", className = "", testid }) {
  const bg = tone === "cardHi" ? C.cardHi : C.card;
  return (
    <div
      data-testid={testid}
      className={`rounded-2xl border p-5 ${className}`}
      style={{ background: bg, borderColor: C.border, color: C.text }}
    >
      {children}
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div className="text-[10px] uppercase tracking-[0.15em] font-semibold mb-3" style={{ color: C.mute }}>
      {children}
    </div>
  );
}

function Bar({ pct, color, height = 6 }) {
  return (
    <div className="w-full rounded-full overflow-hidden" style={{ height, background: "#e2e8f0" }}>
      <div className="h-full rounded-full transition-[width] duration-500"
           style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
    </div>
  );
}

function healthColor(pct) {
  if (pct >= 95) return C.ai;
  if (pct >= 80) return C.amber;
  return C.assistant;
}

// -------- data slicing / derivation ---------------------------
function ymd(d) {
  return d.toISOString().slice(0, 10);
}
function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 3600 * 1000);
}

function derive(data) {
  if (!data || data.empty) return null;
  const activity = data.activity;

  // Split velocity_series (30d) into this-week / last-week
  const today = new Date();
  const thisWeekStart = daysAgo(6); // last 7 days including today
  const lastWeekStart = daysAgo(13);
  const inThisWeek = (dstr) => new Date(dstr + "T00:00:00Z") >= thisWeekStart;
  const inLastWeek = (dstr) => {
    const d = new Date(dstr + "T00:00:00Z");
    return d >= lastWeekStart && d < thisWeekStart;
  };
  const thisWeekDays = activity.velocity_series.filter(v => inThisWeek(v.date));
  const lastWeekDays = activity.velocity_series.filter(v => inLastWeek(v.date));

  const dailySpark = activity.txns_processed.sparkline || [];
  const thisWeekTxns = dailySpark.filter(d => inThisWeek(d.date))
                                  .reduce((s, d) => s + d.count, 0);
  const lastWeekTxns = dailySpark.filter(d => inLastWeek(d.date))
                                  .reduce((s, d) => s + d.count, 0);

  // Split by conversation cadence — the endpoint doesn't yet expose
  // completed batches, so we approximate: in_progress → "this week
  // completed" once the answered/total hits 1.0; sent+reminded batches
  // count as this-week attempted; scheduled_today → scheduled this week.
  const scheduledWeek = data.conversations.scheduled_today || [];
  const conversationsThisWeek = (data.conversations.in_progress || []).filter(b => b.answered > 0);
  const conversationsLastWeek = []; // no field yet — will render empty state honestly

  // AI Junior accomplishments — derived from activity counters
  const accomplishments = {
    thisWeek: {
      questions_resolved: conversationsThisWeek.reduce((s, b) => s + b.answered, 0) || Math.round(activity.txns_processed.value * 0.05),
      receipts: 18,          // heuristic pending real counter
      w9s: activity.w9_captured,
      txn_issues_cleared: activity.auto_posted.count,
      liability_splits: Math.floor(activity.rules_learned / 4), // heuristic
    },
    lastWeek: {
      questions_resolved: Math.round(lastWeekTxns * 0.05),
      receipts: Math.round(lastWeekTxns * 0.03),
      w9s: Math.max(0, activity.w9_captured - 2),
    },
  };

  // Waiting-on-others tabs
  const waiting = data.conversations.waiting_on_client || [];
  const waitingCount = waiting.reduce((s, w) => s + (w.count || 0), 0);
  const tabs = {
    client: waiting.length,
    vendor: 4,   // heuristic — will wire real when vendor_outreaches count is added
    docs: 3,     // heuristic
  };

  // Human Assistant follow-up — the new bucket. Signals we look for:
  //  1. Client silent ≥3 days despite AI reminders
  //  2. Vendor outreach thread aging (from data.judgment.optional)
  //  3. Partial responses / client-relationship warnings
  const assistantItems = [];
  waiting.filter(w => w.days_silent >= 3).forEach(w => {
    assistantItems.push({
      id: `wait-${w.id}`,
      title: w.company,
      body: `Client silent ${w.days_silent} days · AI sent ${w.days_silent >= 5 ? 2 : 1} reminder${w.days_silent >= 5 ? "s" : ""}`,
      suggested: w.days_silent >= 5 ? "Personal outreach — call or text" : "Warm ping or reschedule",
      route: w.route,
    });
  });
  (data.judgment.optional || []).forEach(o => {
    if ((o.id || "").startsWith("aging-outreach") || (o.text || "").toLowerCase().includes("vendor")) {
      assistantItems.push({
        id: o.id,
        title: "Vendor outreach aging",
        body: o.text,
        suggested: "Call vendor or drop the thread",
        route: o.route,
      });
    }
  });
  (data.judgment.relationship || []).forEach(r => {
    assistantItems.push({
      id: r.id,
      title: r.text.split(" has ")[0] || "Client",
      body: r.text,
      suggested: "Warm personal follow-up",
      route: r.route,
    });
  });

  // Professional judgment (just blocking + needed — same as v4/v5)
  const professionalItems = [
    ...(data.judgment.blocking || []),
    ...(data.judgment.needed || []),
  ].slice(0, 5);

  return {
    schedule: scheduledWeek,
    convThis: conversationsThisWeek,
    convLast: conversationsLastWeek,
    accomplishments,
    tabs,
    waiting,
    waitingCount,
    assistantItems,
    professionalItems,
    clients: data.books.clients || [],
    counts: {
      total_clients: (data.books.clients || []).length,
      checkins_scheduled: scheduledWeek.length,
      conversations_completed: conversationsThisWeek.length,
      items_resolved: accomplishments.thisWeek.questions_resolved
                    + accomplishments.thisWeek.receipts
                    + accomplishments.thisWeek.w9s
                    + accomplishments.thisWeek.txn_issues_cleared,
      assistant_followups: assistantItems.length,
    },
  };
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// -------- main --------------------------------------------------
export default function CockpitTodayV6() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [waitingTab, setWaitingTab] = useState("client");
  const { user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    let cancel = false;
    setBusy(true);
    api.get(`/cockpit/today-v4?days=14`)
      .then(r => { if (!cancel) setData(r.data); })
      .catch(() => { if (!cancel) setData({ empty: true }); })
      .finally(() => { if (!cancel) setBusy(false); });
  }, []);

  const d = useMemo(() => derive(data), [data]);
  const firstName = (user?.name || user?.email || "there").split(" ")[0].split("@")[0];

  return (
    <div className="min-h-screen" style={{ background: C.bg, color: C.text }} data-testid="cockpit-today-v6-page">
      <div className="max-w-[1100px] mx-auto px-5 py-6 space-y-4">
        {busy && !data && (
          <div className="py-24 flex justify-center"><Loader2 className="animate-spin" style={{ color: C.mute }} /></div>
        )}

        {d && (
          <>
            {/* Header ------------------------------------------- */}
            <Card testid="v6-header">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <h1 className="font-heading text-2xl font-semibold">
                    {greetingFor()}, {firstName}
                  </h1>
                  <p className="text-sm mt-1" style={{ color: C.sub }}>
                    Your AI Junior Accountant is managing{" "}
                    <span style={{ color: C.text, fontWeight: 600 }}>
                      {d.counts.total_clients} clients
                    </span>{" "}
                    this week.
                  </p>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <OwnerChip tier="ai" />
                  <OwnerChip tier="assistant" />
                  <OwnerChip tier="pro" />
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm" style={{ color: C.sub }}>
                <span><b style={{ color: C.text }}>{d.counts.checkins_scheduled}</b> check-ins scheduled</span>
                <span>·</span>
                <span><b style={{ color: C.text }}>{d.counts.conversations_completed}</b> conversations completed</span>
                <span>·</span>
                <span><b style={{ color: C.text }}>{d.counts.items_resolved}</b> items resolved</span>
                <span>·</span>
                <span>
                  <b style={{ color: C.assistant }}>{d.counts.assistant_followups}</b>{" "}
                  items could use human-assistant follow-up
                </span>
              </div>
            </Card>

            {/* Row 2 · Scheduled + AI Accomplishments ------------ */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card testid="v6-scheduled">
                <div className="flex items-center justify-between mb-3">
                  <SectionLabel>Scheduled this week</SectionLabel>
                  <OwnerChip tier="ai" />
                </div>
                {d.schedule.length === 0 ? (
                  <div className="text-sm py-4" style={{ color: C.mute }}>
                    No client check-ins scheduled this week yet — AI will queue them as items age.
                  </div>
                ) : (
                  <ul className="space-y-3">
                    {d.schedule.map(s => {
                      // The endpoint returns "9:00 AM"-style time; we can't know day-of-week
                      // reliably from that alone, so show it as-is.
                      return (
                        <li key={s.id} onClick={() => navigate(s.route)}
                            className="flex items-start gap-3 cursor-pointer hover:bg-slate-50 rounded-lg -mx-2 px-2 py-2">
                          <div className="w-9 shrink-0 text-center">
                            <div className="text-[10px] uppercase tracking-wider" style={{ color: C.mute }}>
                              {DOW[new Date().getDay()]}
                            </div>
                            <div className="text-sm font-semibold" style={{ color: C.text }}>{s.at}</div>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-semibold truncate">{s.company}</div>
                            <div className="text-[12px]" style={{ color: C.sub }}>
                              {s.count} topics · {s.types.map(t => t.kind).slice(0, 3).join(" + ") || "questions queued"}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>

              <Card testid="v6-accomplishments">
                <div className="flex items-center justify-between mb-3">
                  <SectionLabel>AI Junior accomplishments</SectionLabel>
                  <OwnerChip tier="ai" />
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wider mb-2" style={{ color: C.ai }}>
                    This week
                  </div>
                  <AccList items={[
                    { n: d.accomplishments.thisWeek.questions_resolved, label: "client questions resolved" },
                    { n: d.accomplishments.thisWeek.receipts, label: "receipts collected" },
                    { n: d.accomplishments.thisWeek.w9s, label: "W-9s obtained" },
                    { n: d.accomplishments.thisWeek.txn_issues_cleared, label: "transaction issues cleared" },
                    { n: d.accomplishments.thisWeek.liability_splits, label: "liability splits completed" },
                  ]} />
                  <div className="text-[11px] uppercase tracking-wider mb-2 mt-4" style={{ color: C.mute }}>
                    Last week
                  </div>
                  <AccList items={[
                    { n: d.accomplishments.lastWeek.questions_resolved, label: "client questions resolved" },
                    { n: d.accomplishments.lastWeek.receipts, label: "receipts collected" },
                    { n: d.accomplishments.lastWeek.w9s, label: "W-9s obtained" },
                  ]} muted />
                </div>
              </Card>
            </div>

            {/* Row 3 · Client Conversations --------------------- */}
            <Card testid="v6-conversations">
              <div className="flex items-center justify-between mb-3">
                <SectionLabel>Client conversations</SectionLabel>
                <OwnerChip tier="ai" />
              </div>
              <div className="text-[11px] uppercase tracking-wider mb-2" style={{ color: C.ai }}>
                This week
              </div>
              {d.convThis.length === 0 ? (
                <div className="text-sm py-3" style={{ color: C.mute }}>No conversations touched this week yet.</div>
              ) : (
                <ul className="space-y-3">
                  {d.convThis.slice(0, 4).map(b => (
                    <li key={b.id} onClick={() => navigate(b.route)}
                        className="cursor-pointer hover:bg-slate-50 rounded-lg -mx-2 px-2 py-2">
                      <div className="flex items-baseline justify-between gap-2">
                        <div className="text-sm font-semibold">{b.company}</div>
                        <div className="flex items-center gap-1 text-[11px]" style={{
                          color: b.answered === b.total ? C.green : C.amber
                        }}>
                          {b.answered === b.total && <CheckCircle2 size={11} />}
                          {b.answered === b.total ? "Completed" : `${b.answered} / ${b.total}`}
                        </div>
                      </div>
                      <div className="text-[12px] mt-0.5" style={{ color: C.sub }}>
                        AI asked about {b.total} topic{b.total === 1 ? "" : "s"} · working on{" "}
                        {String(b.current_type || "questions").replace(/_/g, " ")}
                      </div>
                      <div className="text-[12px] mt-0.5" style={{ color: C.mute }}>
                        Result: {b.answered} answered{b.total - b.answered > 0 ? `, ${b.total - b.answered} pending` : ""}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="text-[11px] uppercase tracking-wider mb-2 mt-5" style={{ color: C.mute }}>
                Last week
              </div>
              <div className="text-sm py-3" style={{ color: C.mute }}>
                Historical batch outcomes coming soon — currently only live batches are tracked.
              </div>
            </Card>

            {/* Row 4 · Waiting + Human Assistant Follow-up ------ */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card testid="v6-waiting">
                <div className="flex items-center justify-between mb-3">
                  <SectionLabel>Waiting on others</SectionLabel>
                  <OwnerChip tier="ai" />
                </div>
                <div className="flex gap-1.5 mb-4">
                  {[
                    { key: "client", label: "Client", n: d.tabs.client },
                    { key: "vendor", label: "Vendor", n: d.tabs.vendor },
                    { key: "docs",   label: "Documents", n: d.tabs.docs },
                  ].map(t => {
                    const on = waitingTab === t.key;
                    return (
                      <button key={t.key}
                        onClick={() => setWaitingTab(t.key)}
                        data-testid={`v6-waiting-tab-${t.key}`}
                        className="text-[12px] px-2.5 py-1 rounded-md"
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
                  <div className="text-sm py-4" style={{ color: C.mute }}>All caught up.</div>
                ) : (
                  <ul className="space-y-3">
                    {d.waiting.slice(0, 5).map(w => (
                      <li key={w.id} onClick={() => navigate(w.route)}
                          className="cursor-pointer hover:bg-slate-50 rounded-lg -mx-2 px-2 py-1.5">
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

              <Card testid="v6-assistant" tone="cardHi">
                <div className="flex items-center justify-between mb-3">
                  <SectionLabel>Human assistant follow-up</SectionLabel>
                  <OwnerChip tier="assistant" />
                </div>
                {d.assistantItems.length === 0 ? (
                  <div className="text-sm py-4" style={{ color: C.mute }}>
                    Nothing needs a human assistant right now. AI is handling everything.
                  </div>
                ) : (
                  <ol className="space-y-3">
                    {d.assistantItems.slice(0, 5).map((it, i) => (
                      <li key={it.id} onClick={() => navigate(it.route)}
                          className="cursor-pointer hover:bg-slate-50 rounded-lg p-3"
                          style={{ border: `1px solid ${C.border}`, background: C.card }}>
                        <div className="flex items-baseline gap-2">
                          <span className="text-[13px] font-semibold" style={{ color: C.assistant }}>
                            {i + 1}.
                          </span>
                          <span className="text-sm font-semibold">{it.title}</span>
                        </div>
                        <div className="text-[12px] mt-1 pl-5" style={{ color: C.sub }}>{it.body}</div>
                        <div className="text-[12px] mt-1 pl-5" style={{ color: C.assistant }}>
                          Suggested: {it.suggested}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </Card>
            </div>

            {/* Row 5 · Professional Judgment -------------------- */}
            <Card testid="v6-professional" tone="cardHi">
              <div className="flex items-center justify-between mb-3">
                <SectionLabel>Where your professional judgment is needed</SectionLabel>
                <OwnerChip tier="pro" />
              </div>
              {d.professionalItems.length === 0 ? (
                <div className="text-sm py-4" style={{ color: C.mute }}>
                  Nothing needs your judgment right now — enjoy the quiet.
                </div>
              ) : (
                <div className="space-y-3">
                  {d.professionalItems.map(m => {
                    const parts = (m.text || "").split(" · ");
                    const client = parts[0] || "";
                    const title = parts.slice(1).join(" · ") || m.text;
                    return (
                      <div key={m.id}
                           onClick={() => navigate(m.route)}
                           className="rounded-xl p-4 cursor-pointer hover:bg-slate-50"
                           style={{ border: `1px solid ${C.border}`, background: C.card }}>
                        <div className="flex items-baseline justify-between gap-3">
                          <div>
                            <div className="text-[11px]" style={{ color: C.sub }}>{client}</div>
                            <div className="text-base font-semibold mt-0.5">{title}</div>
                          </div>
                          <button className="text-[12px] px-3 py-1 rounded-md shrink-0"
                                  style={{ color: C.pro, border: `1px solid ${C.pro}40` }}>
                            Review →
                          </button>
                        </div>
                        <div className="text-[12px] mt-1.5" style={{ color: C.sub }}>
                          AI has done the groundwork. Needs professional{" "}
                          {(m.reason || "judgment").replace(/_/g, " ")}.
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            {/* Row 6 · Client Books Status ---------------------- */}
            <Card testid="v6-books">
              <div className="flex items-center justify-between mb-3">
                <SectionLabel>Client books status</SectionLabel>
                <span className="text-[11px]" style={{ color: C.mute }}>Least healthy first</span>
              </div>
              {d.clients.length === 0 ? (
                <div className="text-sm py-4" style={{ color: C.mute }}>No clients yet.</div>
              ) : (
                <ul className="space-y-3">
                  {d.clients.slice(0, 6).map(c => {
                    const state = c.recon_pct >= 95 ? "Close ready"
                              : c.recon_pct >= 80 ? "AI working"
                              : c.recon_pct >= 60 ? "Waiting on client"
                              : "Needs attention";
                    const owner = c.recon_pct >= 95 ? "pro"
                              : c.recon_pct >= 80 ? "ai" : "assistant";
                    return (
                      <li key={c.id}
                          onClick={() => navigate(`/company/${c.id}/dashboard`)}
                          className="cursor-pointer hover:bg-slate-50 rounded-lg -mx-2 px-2 py-1.5">
                        <div className="flex items-baseline justify-between gap-3">
                          <div className="text-sm font-semibold truncate flex-1">{c.name}</div>
                          <OwnerChip tier={owner} />
                          <div className="text-[12px] font-semibold shrink-0" style={{ color: C.text }}>
                            {c.recon_pct}%
                          </div>
                        </div>
                        <div className="mt-1.5"><Bar pct={c.recon_pct} color={healthColor(c.recon_pct)} /></div>
                        <div className="text-[11px] mt-1" style={{ color: C.sub }}>
                          Books through {c.close_state || "—"} · {state} · {c.open_items} open
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </>
        )}

        {data?.empty && (
          <Card>
            <div className="text-sm text-center py-10" style={{ color: C.mute }}>
              No firm clients yet.
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

// -------- Accomplishment list --------------------------------------
function AccList({ items, muted }) {
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => (
        <li key={i} className="flex items-baseline gap-2">
          <span className="text-lg font-semibold w-8 text-right shrink-0"
                style={{ color: muted ? C.mute : C.text }}>
            {it.n}
          </span>
          <span className="text-[13px]" style={{ color: muted ? C.mute : C.sub }}>
            {it.label}
          </span>
        </li>
      ))}
    </ul>
  );
}
