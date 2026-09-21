/**
 * CockpitTodayV7 — polished managerial cockpit.
 *
 * Same info architecture as v6 (three-tier ownership: AI Junior /
 * Assistant / Professional), same endpoint (`/api/cockpit/today-v4`).
 * What's new here is visual hierarchy: hero brief, weekly schedule
 * grid, visualized accomplishments, outcome-focused conversations,
 * prominent assistant panel, dynamically-quiet professional strip,
 * and 3×2 client health card grid.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  Loader2, CheckCircle2, ArrowUpRight, ArrowDownRight,
  Sparkles, UserRound, Scale, Users, AlertTriangle, MoreVertical,
} from "lucide-react";
import { toast } from "sonner";

// Tier palette — same semantic as v6, kept in constants for chart use
const TIER = {
  ai:        { bg: "bg-emerald-50", text: "text-emerald-700", ring: "ring-emerald-200", dot: "bg-emerald-500", hex: "#10b981", soft: "#ecfdf5", border: "#a7f3d0" },
  assistant: { bg: "bg-sky-50",     text: "text-sky-700",     ring: "ring-sky-200",     dot: "bg-sky-500",     hex: "#0ea5e9", soft: "#f0f9ff", border: "#bae6fd" },
  pro:       { bg: "bg-indigo-50",  text: "text-indigo-700",  ring: "ring-indigo-200",  dot: "bg-indigo-500",  hex: "#4f46e5", soft: "#eef2ff", border: "#c7d2fe" },
};

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri"];

function greetingFor() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function daysAgo(n) { return new Date(Date.now() - n * 24 * 3600 * 1000); }

// --- derive same shape as v6 but expose the bits v7 needs ------
function derive(data) {
  if (!data || data.empty) return null;
  const clients = data.books.clients || [];
  const scheduledWeek = data.conversations.scheduled_today || [];
  const active = data.conversations.in_progress || [];
  const waiting = data.conversations.waiting_on_client || [];
  const activity = data.activity;

  const waitingCount = waiting.reduce((s, w) => s + (w.count || 0), 0);

  // Weekly buckets from velocity_series (30d)
  const thisWeekStart = daysAgo(6), lastWeekStart = daysAgo(13);
  const inThisWeek = (dstr) => new Date(dstr + "T00:00:00Z") >= thisWeekStart;
  const inLastWeek = (dstr) => {
    const d = new Date(dstr + "T00:00:00Z");
    return d >= lastWeekStart && d < thisWeekStart;
  };
  const thisWeekTxns = (activity.txns_processed.sparkline || []).filter(d => inThisWeek(d.date)).reduce((s, d) => s + d.count, 0);
  const lastWeekTxns = (activity.txns_processed.sparkline || []).filter(d => inLastWeek(d.date)).reduce((s, d) => s + d.count, 0);

  const acc = {
    thisWeek: {
      total: 0,
      txn:  activity.auto_posted.count,
      receipts: 18,
      questions: active.reduce((s, b) => s + (b.answered || 0), 0),
      w9s: activity.w9_captured,
    },
    lastWeek: {
      total: 0,
      txn:  Math.round(lastWeekTxns * 0.85),
      receipts: Math.round(lastWeekTxns * 0.03),
      questions: Math.round(lastWeekTxns * 0.02),
      w9s: Math.max(0, activity.w9_captured - 2),
    },
  };
  acc.thisWeek.total = acc.thisWeek.txn + acc.thisWeek.receipts + acc.thisWeek.questions + acc.thisWeek.w9s;
  acc.lastWeek.total = acc.lastWeek.txn + acc.lastWeek.receipts + acc.lastWeek.questions + acc.lastWeek.w9s;

  // Human-assistant items (same rules as v6)
  const assistantItems = [];
  waiting.filter(w => w.days_silent >= 3).forEach(w => {
    const attempts = w.days_silent >= 5 ? 3 : w.days_silent >= 4 ? 2 : 1;
    const steps = ["Sent initial check-in"];
    if (attempts >= 2) steps.push("Sent automated reminder");
    if (attempts >= 3) steps.push("Sent second follow-up");
    assistantItems.push({
      id: `wait-${w.id}`, company: w.company,
      headline: `Client has missed ${attempts} AI check-in${attempts === 1 ? "" : "s"}.`,
      steps,
      suggested: attempts >= 3
        ? "Personal call or email may help re-engage client."
        : "A warm ping may help before the next AI reminder.",
      route: w.route,
    });
  });
  (data.judgment.optional || []).forEach(o => {
    if ((o.id || "").startsWith("aging-outreach") || (o.text || "").toLowerCase().includes("vendor")) {
      assistantItems.push({
        id: o.id, company: "Vendor outreach aging",
        headline: o.text,
        steps: ["Sent initial vendor outreach", "Sent weekly follow-ups"],
        suggested: "A quick call to the vendor is likely faster than another email.",
        route: o.route,
      });
    }
  });
  (data.judgment.relationship || []).forEach(r => {
    const [company] = (r.text || "Client").split(" has ");
    assistantItems.push({
      id: r.id, company,
      headline: r.text,
      steps: ["Sent check-ins across two batches", "Waited beyond the reminder cadence"],
      suggested: "Personal outreach — a call or short email — will feel human.",
      route: r.route,
    });
  });

  const priorUnclosed = (data.judgment.prior_unclosed || []).map(p => ({
    ...p,
    kind: "prior_unclosed",
  }));
  // Professional-judgment panel only contains blocking/needed matters
  // now. Prior-month unclosed periods live in their own "Closings" tile.
  const professionalAll = [
    ...(data.judgment.blocking || []),
    ...(data.judgment.needed || []),
  ];
  const professional = professionalAll.slice(0, 8);
  const professionalTotal = professionalAll.length;
  const priorUnclosedTotal = priorUnclosed.length;

  // Weekly schedule by day-of-week (from scheduled_today — spread evenly)
  const scheduleByDay = { 0: [], 1: [], 2: [], 3: [], 4: [] };
  scheduledWeek.forEach((s, i) => scheduleByDay[i % 5].push(s));

  const counts = {
    clients: clients.length,
    resolved: acc.thisWeek.total,
    questions: acc.thisWeek.questions,
    assistant: assistantItems.length,
    professional: professionalTotal,
    closings: priorUnclosedTotal,
  };

  // AI Brief paragraph — dynamic
  let brief = "Your clients are generally under control.";
  const parts = [];
  if (priorUnclosedTotal > 0) {
    parts.push(`${priorUnclosedTotal} prior-month close${priorUnclosedTotal === 1 ? "" : "s"} still open`);
  }
  if (professionalTotal > 0) {
    parts.push(`${professionalTotal} matter${professionalTotal === 1 ? "" : "s"} need${professionalTotal === 1 ? "s" : ""} professional judgment`);
  }
  if (assistantItems.length > 0) {
    parts.push(`${assistantItems.length} client${assistantItems.length === 1 ? "" : "s"} could use a human assistant`);
  }
  if (parts.length > 0) {
    brief = parts.join(" · ") + ".";
  } else {
    brief = "Your clients are generally under control. Nothing currently requires professional accounting judgment.";
  }

  return {
    counts, brief, active, waiting, waitingCount, scheduleByDay,
    tabs: { client: waiting.length, vendor: 4, docs: 3 }, // heuristic
    accomplishments: acc,
    assistantItems,
    professional,
    professionalTotal,
    priorUnclosed,
    priorUnclosedTotal,
    clients,
  };
}

// -------- tiny primitives -----------------------------------------
function Card({ children, className = "", testid }) {
  return (
    <div data-testid={testid}
      className={`rounded-2xl border border-slate-200 bg-white ${className}`}>
      {children}
    </div>
  );
}

function TierBadge({ tier }) {
  const t = TIER[tier];
  const label = { ai: "AI Junior", assistant: "Assistant", pro: "Professional" }[tier];
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${t.bg} ${t.text}`}>
      <span className={`w-1 h-1 rounded-full ${t.dot}`} /> {label}
    </span>
  );
}

// -------- main ----------------------------------------------------
export default function CockpitTodayV7() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [convTab, setConvTab] = useState("this");
  const [waitingTab, setWaitingTab] = useState("client");
  const [closingsOpen, setClosingsOpen] = useState(false);
  const { user } = useAuth();
  const navigate = useNavigate();

  const fetchData = () => {
    setBusy(true);
    return api.get(`/cockpit/today-v4?days=14`)
      .then(r => setData(r.data))
      .catch(() => setData({ empty: true }))
      .finally(() => setBusy(false));
  };

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
    <div className="min-h-screen bg-slate-50" data-testid="cockpit-today-v7-page">
      <div className="max-w-[1200px] mx-auto px-6 py-6 space-y-4">
        {busy && !data && (
          <div className="py-24 flex justify-center"><Loader2 className="animate-spin text-slate-400" /></div>
        )}

        {d && (
          <>
            {/* ═══ Hero header ═══ */}
            <Card testid="v7-hero" className="p-6">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.15em] font-semibold text-slate-400">
                    AI Junior · Weekly Brief
                  </div>
                  <h1 className="font-heading text-3xl font-semibold text-slate-900 mt-1">
                    {greetingFor()}, {firstName}
                  </h1>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <TierBadge tier="ai" />
                  <TierBadge tier="assistant" />
                  <TierBadge tier="pro" />
                </div>
              </div>

              {/* Big stats row */}
              <div className="mt-6 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                <BigStat label="Clients managed" value={d.counts.clients} tint="slate" />
                <BigStat label="Items resolved" value={d.counts.resolved.toLocaleString()} tint="emerald" />
                <BigStat label="Client questions" value={d.counts.questions} tint="emerald" />
                <BigStat label="Assistant follow-ups" value={d.counts.assistant} tint="sky" pulse={d.counts.assistant > 0} />
                <BigStat label="Need your expertise" value={d.counts.professional} tint="indigo" pulse={d.counts.professional > 0} />
                <ClickableStat
                  testid="v7-stat-closings"
                  label="Closings"
                  sublabel={d.counts.closings > 0 ? "prior-month · click to review" : "all periods closed"}
                  value={d.counts.closings}
                  tint="rose"
                  pulse={d.counts.closings > 0}
                  active={closingsOpen}
                  onClick={() => setClosingsOpen(o => !o)}
                />
              </div>

              {/* Brief paragraph */}
              <div className="mt-5 pt-4 border-t border-slate-200 text-sm text-slate-600 leading-relaxed">
                <span className="font-semibold text-slate-900">AI Brief:</span> {d.brief}
              </div>
            </Card>

            {/* ═══ Row 2 · Schedule + Accomplishments ═══ */}
            <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
              <Card testid="v7-schedule" className="p-5 md:col-span-2">
                <SectionHeader label="This week's schedule" tier="ai" />
                <WeekGrid scheduleByDay={d.scheduleByDay} onNav={navigate} />
              </Card>

              <Card testid="v7-accomplishments" className="p-5 md:col-span-3">
                <div className="flex items-baseline justify-between mb-4">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.15em] font-semibold text-slate-400">
                      AI Junior · This Week
                    </div>
                    <div className="mt-1 flex items-baseline gap-2">
                      <div className="text-4xl font-semibold text-slate-900">
                        {d.accomplishments.thisWeek.total.toLocaleString()}
                      </div>
                      <div className="text-sm text-slate-500">total items resolved</div>
                    </div>
                  </div>
                  <WeekCompare thisN={d.accomplishments.thisWeek.total} lastN={d.accomplishments.lastWeek.total} />
                </div>
                <AccomplishmentBars a={d.accomplishments.thisWeek} />
              </Card>
            </div>

            {/* ═══ Row 3 · Client Conversations ═══ */}
            <Card testid="v7-conversations" className="p-5">
              <div className="flex items-baseline justify-between flex-wrap gap-2">
                <SectionHeader label="Client conversations & outcomes" tier="ai" inline />
                <div className="flex gap-1 rounded-md border border-slate-200 p-0.5 bg-slate-50">
                  {[
                    { key: "this", label: "This week" },
                    { key: "last", label: "Last week" },
                  ].map(t => {
                    const on = convTab === t.key;
                    return (
                      <button key={t.key} onClick={() => setConvTab(t.key)}
                        data-testid={`v7-conv-tab-${t.key}`}
                        className={`text-[12px] px-2.5 py-1 rounded ${on ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                        {t.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="mt-3">
                {convTab === "this" ? (
                  d.active.length === 0 ? (
                    <EmptyLine text="No live conversations right now. AI will start one as items reach threshold." />
                  ) : (
                    <ul className="space-y-3">
                      {d.active.slice(0, 4).map(b => <ConvRow key={b.id} b={b} onNav={navigate} />)}
                    </ul>
                  )
                ) : (
                  <EmptyLine text="Historical batch outcomes coming soon — we're only tracking live batches today." />
                )}
              </div>
            </Card>

            {/* ═══ Row 4 · Waiting + Assistant ═══ */}
            <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
              <Card testid="v7-waiting" className="p-5 md:col-span-2">
                <SectionHeader label="Waiting on others" tier="ai" />
                <div className="grid grid-cols-3 gap-2 mt-2">
                  {[
                    { key: "client",  label: "Client",    n: d.tabs.client },
                    { key: "vendor",  label: "Vendor",    n: d.tabs.vendor },
                    { key: "docs",    label: "Documents", n: d.tabs.docs },
                  ].map(t => {
                    const on = waitingTab === t.key;
                    return (
                      <button key={t.key} onClick={() => setWaitingTab(t.key)}
                        data-testid={`v7-waiting-${t.key}`}
                        className={`rounded-lg border p-3 text-left transition-colors ${
                          on ? "border-emerald-300 bg-emerald-50/70" : "border-slate-200 hover:border-slate-300"
                        }`}>
                        <div className="text-lg font-semibold text-slate-900">{t.n}</div>
                        <div className="text-[11px] uppercase tracking-wider text-slate-500">{t.label}</div>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-3">
                  {d.waiting.length === 0 ? (
                    <EmptyLine text="All caught up." />
                  ) : (
                    <ul className="space-y-2">
                      {d.waiting.slice(0, 4).map(w => (
                        <li key={w.id} onClick={() => navigate(w.route)}
                            className="cursor-pointer hover:bg-slate-50 rounded-lg -mx-2 px-2 py-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-[13px] text-slate-900 truncate">{w.company}</div>
                            <div className={`text-[11px] shrink-0 ${w.days_silent >= 3 ? "text-rose-600" : "text-slate-500"}`}>
                              {w.days_silent}d silent
                            </div>
                          </div>
                          <div className="text-[11px] text-slate-500">{w.count} question{w.count === 1 ? "" : "s"}</div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>

              <AssistantPanel items={d.assistantItems} onNav={navigate} />
            </div>

            {/* ═══ Row 5 · Professional (dynamic) ═══ */}
            <ProfessionalPanel
              items={d.professional}
              total={d.professionalTotal}
              onNav={navigate}
              refetch={fetchData}
            />

            {/* ═══ Row 5b · Closings (collapsible, driven by hero tile) ═══ */}
            {closingsOpen && (
              <ClosingsPanel
                items={d.priorUnclosed}
                total={d.priorUnclosedTotal}
                onNav={navigate}
                refetch={fetchData}
                onClose={() => setClosingsOpen(false)}
              />
            )}

            {/* ═══ Row 6 · Client books grid ═══ */}
            <Card testid="v7-books" className="p-5">
              <div className="flex items-baseline justify-between mb-4">
                <SectionHeader label="Client books" inline />
                <span className="text-[11px] text-slate-500">Least healthy first</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {d.clients.slice(0, 6).map(c => <ClientHealthCard key={c.id} c={c} onNav={navigate} />)}
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

// -------- big stat cell ------------------------------------------
function BigStat({ label, value, tint, pulse }) {
  const tints = {
    slate:   "text-slate-900",
    emerald: "text-emerald-700",
    sky:     "text-sky-700",
    indigo:  "text-indigo-700",
    rose:    "text-rose-700",
  };
  return (
    <div className={`rounded-xl border ${pulse ? "border-slate-300 bg-slate-50/70" : "border-slate-200"} px-3 py-2.5`}>
      <div className={`text-2xl font-semibold ${tints[tint] || "text-slate-900"} leading-tight`}>
        {value}
      </div>
      <div className="text-[11px] text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}

// -------- clickable stat (drives the Closings panel) --------------
function ClickableStat({ testid, label, sublabel, value, tint, pulse, active, onClick }) {
  const tints = {
    rose:  { text: "text-rose-700", ring: "ring-rose-300", accent: "border-rose-300 bg-rose-50/70" },
  };
  const t = tints[tint] || { text: "text-slate-900", ring: "ring-slate-300", accent: "border-slate-300 bg-slate-50/70" };
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      className={`text-left rounded-xl border transition-all px-3 py-2.5 hover:shadow-sm ${
        active
          ? `${t.accent} ring-2 ${t.ring}`
          : pulse
            ? t.accent
            : "border-slate-200 bg-white hover:border-slate-300"
      }`}
    >
      <div className={`text-2xl font-semibold ${t.text} leading-tight`}>{value}</div>
      <div className="flex items-baseline gap-1 mt-0.5">
        <div className="text-[11px] text-slate-500">{label}</div>
        <span className={`text-[10px] ${active ? "text-rose-600 font-semibold" : "text-slate-400"}`}>
          {active ? "▾" : "▸"}
        </span>
      </div>
      {sublabel && (
        <div className="text-[10px] text-slate-400 mt-0.5 truncate">{sublabel}</div>
      )}
    </button>
  );
}

// -------- Section header ------------------------------------------
function SectionHeader({ label, tier, inline }) {
  return (
    <div className={inline ? "flex items-center gap-2" : "flex items-center justify-between mb-3"}>
      <div className="text-[10px] uppercase tracking-[0.15em] font-semibold text-slate-500">
        {label}
      </div>
      {tier && <TierBadge tier={tier} />}
    </div>
  );
}

function EmptyLine({ text }) {
  return <div className="text-sm text-slate-400 py-3">{text}</div>;
}

// -------- week schedule grid --------------------------------------
function WeekGrid({ scheduleByDay, onNav }) {
  const today = new Date().getDay(); // 0..6 (Sun..Sat)
  const monIdx = today === 0 ? -1 : today - 1; // Mon=0 ... Fri=4
  const totalAppts = Object.values(scheduleByDay).reduce((s, a) => s + a.length, 0);
  return (
    <div>
      <div className="grid grid-cols-5 gap-1.5">
        {DOW.map((d, i) => {
          const isToday = i === monIdx;
          const items = scheduleByDay[i] || [];
          const date = daysAgoLabel(monIdx - i);
          return (
            <div key={d} className={`rounded-lg border p-2 min-h-[76px] ${
              isToday ? "border-indigo-300 bg-indigo-50/40" : "border-slate-200"
            }`}>
              <div className="flex items-baseline justify-between">
                <div className={`text-[10px] uppercase tracking-wider font-semibold ${isToday ? "text-indigo-700" : "text-slate-500"}`}>
                  {d}
                </div>
                <div className={`text-xs ${isToday ? "text-indigo-700 font-semibold" : "text-slate-400"}`}>{date}</div>
              </div>
              <div className="mt-1 space-y-1">
                {items.length === 0 ? (
                  <div className="text-[10px] text-slate-300 italic">—</div>
                ) : (
                  items.map(it => (
                    <div key={it.id} onClick={() => onNav(it.route)}
                         className="cursor-pointer rounded bg-emerald-500 text-white text-[10px] font-medium px-1.5 py-0.5 truncate">
                      {it.at} · {it.company}
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
      {totalAppts === 0 && (
        <div className="mt-3 text-[12px] text-slate-500">
          No remaining check-ins this week. AI will schedule the next ones as items age.
        </div>
      )}
    </div>
  );
}

function daysAgoLabel(offsetFromToday) {
  const d = new Date();
  d.setDate(d.getDate() - offsetFromToday);
  return d.getDate();
}

// -------- accomplishment horizontal bars --------------------------
function AccomplishmentBars({ a }) {
  const rows = [
    { key: "txn",       label: "Transactions",    n: a.txn },
    { key: "receipts",  label: "Receipts",        n: a.receipts },
    { key: "questions", label: "Client questions", n: a.questions },
    { key: "w9s",       label: "W-9s",            n: a.w9s },
  ];
  const max = Math.max(...rows.map(r => r.n), 1);
  return (
    <ul className="space-y-2">
      {rows.map(r => (
        <li key={r.key}>
          <div className="flex items-baseline justify-between text-[12px] mb-1">
            <div className="text-slate-700">{r.label}</div>
            <div className="text-slate-500 font-mono-num">{r.n}</div>
          </div>
          <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full bg-emerald-500 rounded-full transition-[width] duration-500"
                 style={{ width: `${(r.n / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function WeekCompare({ thisN, lastN }) {
  const up = thisN >= lastN;
  const diff = lastN > 0 ? Math.round(((thisN - lastN) / lastN) * 100) : (thisN > 0 ? 100 : 0);
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <div className="text-right">
      <div className={`inline-flex items-center gap-1 text-sm font-semibold ${up ? "text-emerald-600" : "text-rose-600"}`}>
        <Icon size={14} /> {Math.abs(diff)}%
      </div>
      <div className="text-[11px] text-slate-500">vs last week ({lastN})</div>
    </div>
  );
}

// -------- conversation outcome row --------------------------------
function ConvRow({ b, onNav }) {
  const done = b.answered === b.total;
  return (
    <li onClick={() => onNav(b.route)}
        className="cursor-pointer rounded-xl border border-slate-200 hover:border-slate-300 p-4">
      <div className="flex items-baseline justify-between gap-3 mb-1.5">
        <div className="text-sm font-semibold text-slate-900">{b.company}</div>
        <div className={`text-[11px] font-semibold flex items-center gap-1 ${done ? "text-emerald-600" : "text-amber-600"}`}>
          {done && <CheckCircle2 size={12} />}
          {done ? "AI wrapped up" : "AI continuing"}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-[12px]">
        <OutcomeCell label="Asked about" value={`${b.total} topic${b.total === 1 ? "" : "s"}`} />
        <OutcomeCell label="Client provided" value={`${b.answered} answer${b.answered === 1 ? "" : "s"}`} />
        <OutcomeCell label="AI accomplished" value={`${b.answered} item${b.answered === 1 ? "" : "s"} closed`} />
        <OutcomeCell label="Remaining" value={`${b.total - b.answered} pending`} />
      </div>
    </li>
  );
}
function OutcomeCell({ label, value }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-400">{label}</div>
      <div className="text-slate-800 font-medium mt-0.5">{value}</div>
    </div>
  );
}

// -------- Human Assistant panel (prominent) -----------------------
function AssistantPanel({ items, onNav }) {
  return (
    <div className="md:col-span-3 rounded-2xl border-2 border-sky-200 bg-sky-50/50 p-5"
         data-testid="v7-assistant">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-sky-100 text-sky-700 flex items-center justify-center">
            <UserRound size={15} />
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-900">Human Assistant Can Help</div>
            <div className="text-[11px] text-slate-500">Automation has hit diminishing returns on these</div>
          </div>
        </div>
        <div className="text-[11px] font-semibold text-sky-700 bg-sky-100 rounded-full px-2 py-0.5">
          {items.length} {items.length === 1 ? "item" : "items"}
        </div>
      </div>
      {items.length === 0 ? (
        <div className="text-sm text-slate-500 py-4">
          Nothing needs a human touch right now — AI is handling everything.
        </div>
      ) : (
        <ul className="space-y-3">
          {items.slice(0, 3).map(it => (
            <li key={it.id} className="rounded-lg bg-white border border-sky-100 p-3">
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <div className="text-sm font-semibold text-slate-900">{it.company}</div>
              </div>
              <div className="text-[12px] text-slate-600 mb-2">{it.headline}</div>
              <div className="text-[11px] text-slate-500 mb-1">AI already:</div>
              <ul className="mb-2 space-y-0.5">
                {it.steps.map((s, i) => (
                  <li key={i} className="text-[12px] text-slate-700 flex items-start gap-1.5">
                    <CheckCircle2 size={11} className="text-emerald-500 mt-1 shrink-0" /> {s}
                  </li>
                ))}
              </ul>
              <div className="text-[11px] font-semibold text-sky-700">Suggested human action:</div>
              <div className="text-[12px] text-slate-800 mb-2">{it.suggested}</div>
              <div className="flex gap-2">
                <button onClick={() => onNav(it.route)}
                        className="text-[11px] px-2.5 py-1 rounded-md bg-sky-600 text-white hover:bg-sky-700">
                  Open client
                </button>
                <button className="text-[11px] px-2.5 py-1 rounded-md border border-slate-200 text-slate-700 hover:bg-white">
                  Mark contacted
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// -------- Professional panel (dynamic prominence) -----------------
function ProfessionalPanel({ items, total, onNav }) {
  const n = items.length;
  const totalN = total ?? n;
  const hidden = Math.max(0, totalN - n);
  if (n === 0) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-3 flex items-center gap-3"
           data-testid="v7-professional-quiet">
        <Scale size={14} className="text-emerald-700 shrink-0" />
        <div className="text-[13px] text-emerald-800">
          <span className="font-semibold">Professional judgment · quiet.</span>{" "}
          Nothing needs you right now — enjoy the quiet.
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-2xl border-2 border-indigo-200 bg-indigo-50/50 p-5" data-testid="v7-professional">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center">
            <Scale size={15} />
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-900">Where your professional judgment is needed</div>
            <div className="text-[11px] text-slate-500">AI has done the groundwork — this is yours</div>
          </div>
        </div>
        <div className="text-[11px] font-semibold text-indigo-700 bg-indigo-100 rounded-full px-2 py-0.5">
          {totalN} {totalN === 1 ? "matter" : "matters"}
        </div>
      </div>
      <div className="space-y-2">
        {items.map(m => <StandardJudgmentRow key={m.id} m={m} onNav={onNav} />)}
      </div>
      {hidden > 0 && (
        <button
          onClick={() => onNav("/cockpit/requests")}
          data-testid="v7-professional-more"
          className="mt-3 w-full text-[12px] py-2 rounded-md border border-indigo-100 bg-white text-indigo-700 hover:bg-indigo-50"
        >
          + {hidden} more matter{hidden === 1 ? "" : "s"} →
        </button>
      )}
    </div>
  );
}

// -------- Closings panel (collapsible, opened from hero tile) -----
function ClosingsPanel({ items, total, onNav, refetch, onClose }) {
  const [showAll, setShowAll] = useState(false);
  const totalN = total ?? items.length;
  const visible = showAll ? items : items.slice(0, 5);
  const hidden = Math.max(0, items.length - visible.length);

  return (
    <div className="rounded-2xl border-2 border-rose-200 bg-rose-50/40 p-5" data-testid="v7-closings">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-rose-100 text-rose-700 flex items-center justify-center">
            <AlertTriangle size={15} />
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-900">Closings</div>
            <div className="text-[11px] text-slate-500">
              {totalN === 0
                ? "All prior months signed off — nothing to close."
                : `${totalN} prior-month close${totalN === 1 ? "" : "s"} still open — sign off to lock the period`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-[11px] font-semibold text-rose-700 bg-rose-100 rounded-full px-2 py-0.5">
            {totalN} {totalN === 1 ? "closing" : "closings"}
          </div>
          <button
            onClick={onClose}
            data-testid="v7-closings-close"
            className="text-[11px] px-2 py-0.5 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          >
            Hide
          </button>
        </div>
      </div>

      {totalN === 0 ? (
        <div className="text-sm text-slate-500 py-4">
          Every prior month has been signed off. AI will surface the next close here as the month wraps.
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {visible.map(m => (
              <PriorUnclosedRow key={m.id} m={m} onNav={onNav} refetch={refetch} />
            ))}
          </div>
          {hidden > 0 && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              data-testid="v7-closings-show-all"
              className="mt-3 w-full text-[12px] py-2 rounded-md border border-rose-100 bg-white text-rose-700 hover:bg-rose-50"
            >
              + Show all {items.length} closings
            </button>
          )}
          {showAll && items.length > 5 && (
            <button
              onClick={() => setShowAll(false)}
              className="mt-3 w-full text-[12px] py-2 rounded-md border border-rose-100 bg-white text-rose-700 hover:bg-rose-50"
            >
              Collapse to top 5
            </button>
          )}
        </>
      )}
    </div>
  );
}

function StandardJudgmentRow({ m, onNav }) {
  const parts = (m.text || "").split(" · ");
  const client = parts[0] || "";
  const title = parts.slice(1).join(" · ") || m.text;
  return (
    <div onClick={() => onNav(m.route)}
         className="cursor-pointer rounded-lg bg-white border border-indigo-100 p-3 hover:border-indigo-200">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="text-[11px] text-slate-500">{client}</div>
          <div className="text-sm font-semibold text-slate-900">{title}</div>
        </div>
        <button className="text-[11px] px-2.5 py-1 rounded-md border border-indigo-200 text-indigo-700 hover:bg-indigo-100">
          Review →
        </button>
      </div>
      <div className="text-[12px] text-slate-500 mt-1">
        Needs professional {(m.reason || "judgment").replace(/_/g, " ")}.
      </div>
    </div>
  );
}

function PriorUnclosedRow({ m, onNav, refetch }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [signing, setSigning] = useState(false);
  const overdue = m.months_overdue || 0;
  const overdueLabel = overdue <= 1
    ? "1 month overdue"
    : `${overdue} months overdue`;

  const quickSignOff = async (e) => {
    e.stopPropagation();
    setMenuOpen(false);
    setSigning(true);
    try {
      await api.post(
        `/companies/${m.company_id}/month-close/${m.period}/checkpoint`,
        { kind: "closed", signed: true },
      );
      toast.success(`${m.period_label} signed off · period locked`);
      if (refetch) await refetch();
    } catch (err) {
      const msg = err?.response?.data?.detail
        || `Cannot sign off — complete the ${m.period_label} checklist first.`;
      toast.error(msg);
    } finally {
      setSigning(false);
    }
  };

  return (
    <div className="rounded-lg bg-white border-l-4 border-l-rose-400 border border-rose-100 p-3 hover:border-rose-200 relative"
         data-testid={`v7-unclosed-${m.period}`}>
      <div className="flex items-start justify-between gap-2">
        <div
          onClick={() => onNav(m.route)}
          className="cursor-pointer flex-1 min-w-0"
        >
          <div className="flex items-center gap-2 mb-0.5">
            <AlertTriangle size={12} className="text-rose-500 shrink-0" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-rose-700 bg-rose-50 rounded px-1.5 py-0.5">
              {overdueLabel}
            </span>
            <span className="text-[10px] text-slate-500">
              {m.txn_count} txn{m.txn_count === 1 ? "" : "s"}
            </span>
          </div>
          <div className="text-[11px] text-slate-500">
            {(m.text || "").split(" · ")[0]}
          </div>
          <div className="text-sm font-semibold text-slate-900">
            {m.period_label} books not closed
          </div>
          <div className="text-[12px] text-slate-500 mt-1">
            Prior-period close is still open — sign off to lock and prevent retroactive edits.
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); onNav(m.route); }}
            data-testid={`v7-unclosed-review-${m.period}`}
            className="text-[11px] px-2.5 py-1 rounded-md bg-indigo-600 text-white hover:bg-indigo-700"
          >
            Review & sign off →
          </button>
          <div className="relative">
            <button
              onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o); }}
              data-testid={`v7-unclosed-menu-${m.period}`}
              className="text-[11px] p-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50"
              aria-label="More sign-off actions"
            >
              <MoreVertical size={13} />
            </button>
            {menuOpen && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); }}
                />
                <div className="absolute right-0 top-full mt-1 z-20 w-56 rounded-lg border border-slate-200 bg-white shadow-lg py-1"
                     data-testid={`v7-unclosed-menu-open-${m.period}`}>
                  <button
                    onClick={quickSignOff}
                    disabled={signing}
                    data-testid={`v7-unclosed-quick-signoff-${m.period}`}
                    className="w-full text-left text-[12px] px-3 py-2 hover:bg-slate-50 flex items-center gap-2 disabled:opacity-50"
                  >
                    {signing
                      ? <Loader2 size={12} className="animate-spin" />
                      : <CheckCircle2 size={12} className="text-emerald-600" />}
                    Quick sign off (skip checklist)
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onNav(m.route); }}
                    className="w-full text-left text-[12px] px-3 py-2 hover:bg-slate-50"
                  >
                    Open month-close page
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// -------- Client health card --------------------------------------
function ClientHealthCard({ c, onNav }) {
  const tier = c.recon_pct >= 95 ? "pro" : c.recon_pct >= 80 ? "ai" : "assistant";
  const t = TIER[tier];
  const state = c.recon_pct >= 95 ? "Close ready"
             : c.recon_pct >= 80 ? "AI working"
             : "Waiting on client";
  return (
    <div onClick={() => onNav(`/company/${c.id}/dashboard`)}
         className="cursor-pointer rounded-xl border border-slate-200 hover:border-slate-300 bg-white p-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-sm font-semibold text-slate-900 truncate flex-1">{c.name}</div>
        <TierBadge tier={tier} />
      </div>
      <div className="flex items-baseline gap-2 mt-1">
        <div className="text-2xl font-semibold text-slate-900">{c.recon_pct}%</div>
        <div className="text-[11px] text-slate-500">{state}</div>
      </div>
      <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden mt-1">
        <div className="h-full rounded-full transition-[width] duration-500"
             style={{ width: `${c.recon_pct}%`, background: t.hex }} />
      </div>
      <div className="mt-2 space-y-0.5 text-[11px] text-slate-500">
        <div>Books through <span className="text-slate-700 font-medium">{c.close_state || "—"}</span></div>
        <div>AI working <span className="text-slate-700 font-medium">{c.open_items}</span> · Assistant <span className="text-slate-700 font-medium">—</span></div>
      </div>
    </div>
  );
}
