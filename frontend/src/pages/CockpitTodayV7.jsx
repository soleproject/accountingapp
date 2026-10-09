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
  ChevronLeft, ChevronRight, ChevronDown, Lock, Clock, MessageSquare,
} from "lucide-react";
import { toast } from "sonner";
import {
  Tooltip, TooltipTrigger, TooltipContent, TooltipProvider,
} from "@/components/ui/tooltip";
import { deriveAssistantItems } from "@/lib/cockpitAssistant";
import { ClientMessagesCard } from "@/components/ClientMessagesCard";
import { NewClientModal } from "@/pages/ProClients";
import PaymentsAppResumeCard from "@/components/PaymentsAppResumeCard";
import { useCompany } from "@/lib/company";

// Tier palette — same semantic as v6, kept in constants for chart use
const TIER = {
  ai:        { bg: "bg-emerald-50", text: "text-emerald-700", ring: "ring-emerald-200", dot: "bg-emerald-500", hex: "#10b981", soft: "#ecfdf5", border: "#a7f3d0" },
  assistant: { bg: "bg-sky-50",     text: "text-sky-700",     ring: "ring-sky-200",     dot: "bg-sky-500",     hex: "#0ea5e9", soft: "#f0f9ff", border: "#bae6fd" },
  pro:       { bg: "bg-indigo-50",  text: "text-indigo-700",  ring: "ring-indigo-200",  dot: "bg-indigo-500",  hex: "#4f46e5", soft: "#eef2ff", border: "#c7d2fe" },
};

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri"];

// Pretty labels for the compact kind tokens the backend emits
// (see _item_type_mix in cockpit_today_v4.py — it splits on "_"
// and keeps the leading token, so "w9_missing" arrives as "w9").
const KIND_LABEL = {
  uncategorized: "uncategorized",
  w9: "W-9",
  bank: "bank transfer",
  meals: "meals over cap",
  unusual: "unusual amount",
  self: "self-cancelling JE",
  generic: "generic category",
  other: "other",
};

function labelForKind(k) {
  return KIND_LABEL[k] || (k || "other").replace(/_/g, " ");
}

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
  const clientMessages = data.conversations.client_messages || [];
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

  // Human-assistant items (same rules as v6, shared with /cockpit/assistant)
  const assistantItems = deriveAssistantItems(data);

  const priorUnclosed = (data.judgment.prior_unclosed || []).map(p => ({
    ...p,
    kind: "prior_unclosed",
  }));
  const closeGrid = data.judgment.close_grid || [];
  // Professional-judgment panel only contains blocking/needed matters
  // now. Prior-month unclosed periods live in their own "Closings" tile.
  const professionalAll = [
    ...(data.judgment.blocking || []),
    ...(data.judgment.needed || []),
  ];
  const professional = professionalAll.slice(0, 8);
  const professionalTotal = professionalAll.length;
  const priorUnclosedTotal = priorUnclosed.length;

  // Weekly schedule bucketed by actual day-of-week (Mon..Fri).
  const scheduleByDay = { 0: [], 1: [], 2: [], 3: [], 4: [] };
  scheduledWeek.forEach(s => {
    const dow = typeof s.dow === "number" ? s.dow : 0;
    if (dow >= 0 && dow <= 4) scheduleByDay[dow].push(s);
  });

  const counts = {
    clients: clients.length,
    resolved: acc.thisWeek.total,
    questions: clientMessages.filter(m => m.status !== "resolved" && !((m.replies || []).length && m.replies[m.replies.length - 1].by_pro)).length,
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
    counts, brief, active, clientMessages, waiting, waitingCount, scheduleByDay,
    tabs: { client: waiting.length, vendor: 4, docs: 3 }, // heuristic
    accomplishments: acc,
    assistantItems,
    professional,
    professionalTotal,
    priorUnclosed,
    priorUnclosedTotal,
    closeGrid,
    clients,
  };
}

// -------- tiny primitives -----------------------------------------
function Card({ children, className = "", testid, id }) {
  return (
    <div data-testid={testid} id={id}
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
  const [clientsOpen, setClientsOpen] = useState(false);
  // Which work panel is open: null | "inprogress" | "messages" | "assistant"
  const [panel, setPanel] = useState(null);
  const inProgressOpen = panel !== null;
  const setInProgressOpen = (v) => setPanel(typeof v === "function" ? (v(panel !== null) ? "inprogress" : null) : (v ? "inprogress" : null));
  const togglePanel = (k) => { setPanel(p => (p === k ? null : k)); setClientsOpen(false); setClosingsOpen(false); };
  const [newClientOpen, setNewClientOpen] = useState(false);
  const { user } = useAuth();
  const { refresh: refreshCompanies, switchCompany, currentId } = useCompany();
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
  // Live-work tally powering the "In Progress" clickable stat. Mirrors
  // the tab counts rendered inside InProgressPanel so the number on
  // the tile and inside the tabs always agree.
  const inProgressTotal = useMemo(() => {
    if (!d) return 0;
    const emailQs   = (d.waiting || []).reduce((s, w) => s + (w.count || 0), 0);
    const live      = (d.active || []).length;
    return emailQs + live;
  }, [d]);
  const firstName = (user?.name || user?.email || "there").split(" ")[0].split("@")[0];

  // If the URL arrived with a #hash, wait for data to render then scroll.
  useEffect(() => {
    if (!d) return;
    const hash = window.location.hash;
    if (!hash) return;
    const id = hash.slice(1);
    // rAF gives the browser one paint cycle after the section mounts.
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [d]);

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
                <div className="flex gap-2 flex-wrap items-center">
                  <button
                    type="button"
                    onClick={() => setNewClientOpen(true)}
                    data-testid="v7-new-client-link"
                    className="text-[12px] text-slate-600 hover:text-slate-900 underline underline-offset-4 decoration-slate-300 hover:decoration-slate-600 mr-1"
                  >
                    + New Client
                  </button>
                  <TierBadge tier="ai" />
                  <TierBadge tier="assistant" />
                  <TierBadge tier="pro" />
                </div>
              </div>

              {/* Payments app resume — hides unless the currently-selected
                  client has a draft. Pros use this as a shortcut back to
                  the intake without hunting through the client's cockpit. */}
              {currentId && (
                <div className="mt-4">
                  <PaymentsAppResumeCard companyId={currentId} variant="pro-cockpit" />
                </div>
              )}

              {/* Big stats row */}
              <div className="mt-6 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                <ClickableStat
                  testid="v7-stat-questions"
                  label="Client questions"
                  sublabel={d.counts.questions > 0 ? "from clients · click to reply" : "no open questions"}
                  value={d.counts.questions}
                  tint="emerald"
                  pulse={d.counts.questions > 0}
                  active={panel === "messages"}
                  onClick={() => togglePanel("messages")}
                />
                <ClickableStat
                  testid="v7-stat-closings"
                  label="Closings"
                  sublabel={d.counts.closings > 0 ? "prior-month · click to review" : "all periods closed"}
                  value={d.counts.closings}
                  tint="rose"
                  pulse={d.counts.closings > 0}
                  active={closingsOpen}
                  onClick={() => { setClosingsOpen(o => !o); setClientsOpen(false); setPanel(null); }}
                />
                <ClickableStat
                  testid="v7-stat-assistant"
                  label="Assistant follow-ups"
                  sublabel={d.counts.assistant > 0 ? "needs a human · click to see" : "nobody stuck"}
                  value={d.counts.assistant}
                  tint="sky"
                  pulse={d.counts.assistant > 0}
                  active={panel === "assistant"}
                  onClick={() => togglePanel("assistant")}
                />
                <ClickableStat
                  testid="v7-stat-in-progress"
                  label="In Progress"
                  sublabel={inProgressTotal > 0 ? "click to open live work" : "nothing moving right now"}
                  value={inProgressTotal}
                  tint="indigo"
                  pulse={inProgressTotal > 0}
                  active={panel === "inprogress"}
                  onClick={() => togglePanel("inprogress")}
                />
                <ClickableStat
                  testid="v7-stat-clients"
                  label="Clients managed"
                  sublabel={d.counts.clients > 0 ? "click to review roster" : "no clients yet"}
                  value={d.counts.clients}
                  tint="slate"
                  active={clientsOpen}
                  onClick={() => { setClientsOpen(o => !o); setClosingsOpen(false); setPanel(null); }}
                />
                <BigStat label="Items resolved" value={d.counts.resolved.toLocaleString()} tint="emerald" />
              </div>

              {/* Brief paragraph */}
              <div className="mt-5 pt-4 border-t border-slate-200 text-sm text-slate-600 leading-relaxed">
                <span className="font-semibold text-slate-900">AI Brief:</span> {d.brief}
              </div>
            </Card>

            {/* When Closings or Clients is expanded, hide the rest of
                the dashboard and focus on that single panel. */}
            {closingsOpen ? (
              <>
                <ClosingsPanel
                  grid={d.closeGrid}
                  total={d.priorUnclosedTotal}
                  onNav={navigate}
                  refetch={fetchData}
                  onClose={() => setClosingsOpen(false)}
                />
                <PendingReconciliationsCard onNav={navigate} />
              </>
            ) : clientsOpen ? (
              <ClientsPanel
                clients={d.clients}
                counts={d.counts}
                onNav={navigate}
                onClose={() => setClientsOpen(false)}
              />
            ) : panel ? (
              <InProgressPanel
                key={panel}
                mode={panel}
                d={d}
                onNav={navigate}
                refetch={fetchData}
                onClose={() => setPanel(null)}
              />
            ) : (
              <>
            {/* ═══ Row 2 · Accomplishments (full width) ═══ */}
            <Card testid="v7-accomplishments" className="p-5">
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

            {/* ═══ Row 3 · This Week's Schedule (full width, below) ═══ */}
            <Card testid="v7-schedule" className="p-5">
              <SectionHeader label="This week's schedule" tier="ai" />
              <WeekGrid scheduleByDay={d.scheduleByDay} onNav={navigate} />
            </Card>

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

              <AssistantPanel items={d.assistantItems} onNav={navigate} refetch={fetchData} />
            </div>

            {/* ═══ Row 5 · Professional (dynamic) ═══ */}
            <ProfessionalPanel
              items={d.professional}
              total={d.professionalTotal}
              onNav={navigate}
              refetch={fetchData}
            />

            {/* ═══ Row 6 · Client books grid ═══ */}
            <Card testid="v7-books" className="p-5" id="client-books">
              <div className="flex items-baseline justify-between mb-4">
                <SectionHeader label="Client books" inline />
                <span className="text-[11px] text-slate-500">Least healthy first</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {d.clients.slice(0, 6).map(c => <ClientHealthCard key={c.id} c={c} onNav={navigate} />)}
              </div>
            </Card>

            {/* Row 7 (Payments Applications) moved to the superadmin
                area only — see Sidebar.jsx superadmin block for the
                "Payments Applications" link into
                /cockpit/payments-apps. */}
              </>
            )}
          </>
        )}
      </div>

      {/* Add-new-client modal (opened from the header link). Reuses the
          fully-featured modal that powers /pro/clients so the flow is
          identical everywhere. */}
      {newClientOpen && (
        <NewClientModal
          onClose={() => setNewClientOpen(false)}
          onCreated={async (newCid) => {
            // Refresh Today's aggregate + the shared company list so
            // the new client shows up immediately in Clients managed.
            await fetchData();
            if (refreshCompanies) await refreshCompanies();
            if (newCid && switchCompany) switchCompany(newCid);
            setNewClientOpen(false);
            // Brand-new clients always land in the onboarding wizard.
            // Skip the Dashboard indirection to avoid a race where the
            // just-switched company hasn't propagated to `current` yet
            // and Dashboard falls through to the full view instead of
            // the OnboardingNudge redirect.
            if (newCid) navigate("/onboarding");
          }}
        />
      )}
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
    rose:  { text: "text-rose-700",  ring: "ring-rose-300",  accent: "border-rose-300 bg-rose-50/70" },
    slate: { text: "text-slate-900", ring: "ring-slate-300", accent: "border-slate-300 bg-slate-50/70" },
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
        <span className={`text-[10px] ${active ? t.text + " font-semibold" : "text-slate-400"}`}>
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

// -------- Payments applications panel -----------------------------
// REMOVED — this firm-wide roll-up now lives in the superadmin area
// only (/cockpit/payments-apps, linked from the superadmin sidebar
// block in Sidebar.jsx). Kept the standalone CockpitPaymentsApps.jsx
// page as the single source for this view.

function EmptyLine({ text }) {
  return <div className="text-sm text-slate-400 py-3">{text}</div>;
}

// -------- week schedule grid --------------------------------------
function WeekGrid({ scheduleByDay, onNav }) {
  const today = new Date().getDay(); // 0..6 (Sun..Sat)
  const monIdx = today === 0 ? -1 : today - 1; // Mon=0 ... Fri=4
  const totalAppts = Object.values(scheduleByDay).reduce((s, a) => s + a.length, 0);
  return (
    <TooltipProvider delayDuration={100} skipDelayDuration={200}>
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
                    items.map(it => <SchedulePill key={it.id} it={it} onNav={onNav} />)
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
    </TooltipProvider>
  );
}

function SchedulePill({ it, onNav }) {
  const types = it.types || [];
  const total = types.reduce((s, t) => s + (t.count || 0), 0) || it.count || 0;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          onClick={() => onNav(it.route)}
          data-testid={`v7-schedule-pill-${it.id}`}
          className="cursor-pointer rounded bg-emerald-500 hover:bg-emerald-600 text-white text-[11px] font-medium px-2 py-1 truncate transition-colors"
        >
          <span className="font-semibold">{it.at}</span>
          {it.company && <span className="opacity-90"> · {it.company}</span>}
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={6}
        className="bg-slate-900 text-white px-3 py-2 rounded-md shadow-lg max-w-[260px]"
      >
        <div className="text-[11px] font-semibold text-white">
          {it.at}{it.company ? ` · ${it.company}` : ""}
        </div>
        <div className="text-[10px] uppercase tracking-wider text-slate-400 mt-1 mb-1">
          {total} item{total === 1 ? "" : "s"}
        </div>
        {types.length === 0 ? (
          <div className="text-[11px] text-slate-300">No item details.</div>
        ) : (
          <ul className="space-y-0.5">
            {types.map(t => (
              <li key={t.kind} className="text-[11px] text-slate-100 flex items-baseline gap-1.5">
                <span className="text-white font-semibold tabular-nums">{t.count}</span>
                <span className="text-slate-300">{labelForKind(t.kind)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="text-[10px] text-slate-400 mt-1.5">Click to open batch →</div>
      </TooltipContent>
    </Tooltip>
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
function AssistantPanel({ items, onNav, refetch }) {
  const [idx, setIdx] = useState(0);
  const [marking, setMarking] = useState(false);
  const n = items.length;
  const safeIdx = n === 0 ? 0 : ((idx % n) + n) % n; // wrap-around
  const it = n > 0 ? items[safeIdx] : null;
  const prev = () => setIdx(safeIdx - 1);
  const next = () => setIdx(safeIdx + 1);

  const markContacted = async () => {
    if (!it) return;
    setMarking(true);
    try {
      await api.post("/cockpit/assistant/mark-contacted", {
        item_id: it.id,
        company_id: it.company_id || null,
        headline: it.headline,
      });
      toast.success(`Marked ${it.company} contacted · won't reappear tomorrow`);
      // Advance past the removed item so the carousel doesn't jump.
      if (n <= 1) {
        setIdx(0);
      } else if (safeIdx >= n - 1) {
        setIdx(0);
      }
      if (refetch) await refetch();
    } catch (err) {
      const msg = err?.response?.data?.detail || "Couldn't record — please retry.";
      toast.error(msg);
    } finally {
      setMarking(false);
    }
  };

  return (
    <div className="md:col-span-3 rounded-2xl border-2 border-sky-200 bg-sky-50/50 p-5"
         data-testid="v7-assistant">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-sky-100 text-sky-700 flex items-center justify-center">
            <UserRound size={15} />
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-900">Human Assistant Can Help</div>
            <div className="text-[11px] text-slate-500">Automation has hit diminishing returns on these</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {n > 1 && (
            <div className="flex items-center gap-1"
                 data-testid="v7-assistant-nav">
              <button
                onClick={prev}
                data-testid="v7-assistant-prev"
                aria-label="Previous item"
                className="w-6 h-6 rounded-md border border-sky-200 bg-white text-sky-700 hover:bg-sky-100 flex items-center justify-center"
              >
                <ChevronLeft size={13} />
              </button>
              <div className="text-[11px] text-sky-800 tabular-nums px-1">
                {safeIdx + 1} / {n}
              </div>
              <button
                onClick={next}
                data-testid="v7-assistant-next"
                aria-label="Next item"
                className="w-6 h-6 rounded-md border border-sky-200 bg-white text-sky-700 hover:bg-sky-100 flex items-center justify-center"
              >
                <ChevronRight size={13} />
              </button>
            </div>
          )}
          <div className="text-[11px] font-semibold text-sky-700 bg-sky-100 rounded-full px-2 py-0.5">
            {n} {n === 1 ? "item" : "items"}
          </div>
        </div>
      </div>

      {n === 0 ? (
        <div className="text-sm text-slate-500 py-4">
          Nothing needs a human touch right now — AI is handling everything.
        </div>
      ) : (
        <>
          <div key={it.id}
               className="rounded-lg bg-white border border-sky-100 p-3"
               data-testid={`v7-assistant-card-${it.id}`}>
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
                      data-testid="v7-assistant-open-client"
                      className="text-[11px] px-2.5 py-1 rounded-md bg-sky-600 text-white hover:bg-sky-700">
                Open client
              </button>
              <button
                onClick={markContacted}
                disabled={marking}
                data-testid="v7-assistant-mark-contacted"
                className="text-[11px] px-2.5 py-1 rounded-md border border-slate-200 text-slate-700 hover:bg-white disabled:opacity-50 inline-flex items-center gap-1"
              >
                {marking && <Loader2 size={11} className="animate-spin" />}
                Mark contacted
              </button>
            </div>
          </div>
          <div className="mt-2 text-right">
            <button
              onClick={() => onNav("/cockpit/assistant")}
              data-testid="v7-assistant-view-all"
              className="text-[11px] text-sky-700 hover:text-sky-900 hover:underline"
            >
              View all {n} → 
            </button>
          </div>
        </>
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

// -------- Clients panel (Clients-managed tile → focus mode) -------
const BOOKS_HEALTH_LS = "v7_books_health_visible";

function ClientsPanel({ clients, counts, onNav, onClose }) {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState("all");
  const [attention, setAttention] = useState(null); // /pro/firm-attention
  const [kpiFilter, setKpiFilter] = useState(null); // null | "flagged" | ...
  const [healthVisible, setHealthVisible] = useState(() => {
    // Default: visible. Only "hidden" is remembered — a fresh user
    // gets the tiles on their first visit, then their toggle sticks.
    try { return localStorage.getItem(BOOKS_HEALTH_LS) !== "hidden"; }
    catch { return true; }
  });
  const setHealthVisiblePersist = (v) => {
    setHealthVisible(v);
    try { localStorage.setItem(BOOKS_HEALTH_LS, v ? "visible" : "hidden"); }
    catch { /* ignore quota */ }
  };

  useEffect(() => {
    let cancel = false;
    api.get("/pro/firm-attention")
      .then(r => { if (!cancel) setAttention(r.data || null); })
      .catch(() => { if (!cancel) setAttention({ totals: {}, clients: [] }); });
    return () => { cancel = true; };
  }, []);

  const attnById = useMemo(() => {
    const m = {};
    (attention?.clients || []).forEach(a => { m[a.id] = a; });
    return m;
  }, [attention]);
  const totals = attention?.totals || {};

  const list = clients || [];
  const filtered = list.filter(c => {
    if (q && !c.name.toLowerCase().includes(q.toLowerCase())) return false;
    if (tab === "action") if (!(c.recon_pct < 80 || (c.open_items || 0) > 0)) return false;
    if (tab === "waiting") if (!(c.recon_pct < 80)) return false;
    if (tab === "close-ready") if (!(c.recon_pct >= 95)) return false;
    if (kpiFilter) {
      const a = attnById[c.id] || {};
      const cnt = a[`${kpiFilter}_count`] || 0;
      if (cnt <= 0) return false;
    }
    return true;
  });

  // Roster tallies (unchanged)
  const totalOpenItems = list.reduce((s, c) => s + (c.open_items || 0), 0);
  const actionCount = list.filter(c => c.recon_pct < 80 || (c.open_items || 0) > 0).length;
  const waitingCount = list.filter(c => c.recon_pct < 80).length;
  const closeReadyCount = list.filter(c => c.recon_pct >= 95).length;

  // Books-health tallies — sourced from /pro/firm-attention.
  const clientsWith = (kind) =>
    (attention?.clients || []).filter(a => (a[`${kind}_count`] || 0) > 0).length;

  const kpiTiles = [
    { key: "flagged", label: "Flagged", sub: "txns needing review", tint: "amber", total: totals.flagged || 0, clientCount: clientsWith("flagged") },
    { key: "suggested_rules", label: "Suggested rules", sub: "AI rule candidates", tint: "purple", total: totals.suggested_rules || 0, clientCount: clientsWith("suggested_rules") },
    { key: "overdue_invoices", label: "Overdue invoices", sub: "past due · unpaid", tint: "red", total: totals.overdue_invoices || 0, clientCount: clientsWith("overdue_invoices") },
    { key: "overdue_bills", label: "Overdue bills", sub: "past due · unpaid", tint: "red", total: totals.overdue_bills || 0, clientCount: clientsWith("overdue_bills") },
    { key: "unreconciled", label: "Unreconciled", sub: "accounts > 45 days", tint: "indigo", total: totals.unreconciled || 0, clientCount: clientsWith("unreconciled") },
  ];

  return (
    <div className="rounded-2xl border-2 border-slate-300 bg-slate-50/40 p-5" data-testid="v7-clients-panel">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-slate-200 text-slate-700 flex items-center justify-center">
            <Users size={15} />
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-900">Clients managed</div>
            <div className="text-[11px] text-slate-500">
              {list.length} client{list.length === 1 ? "" : "s"} · {actionCount} need action today · {totalOpenItems.toLocaleString()} open items across all books
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onNav("/pro/clients")}
            data-testid="v7-clients-open-full"
            className="text-[11px] px-2.5 py-1 rounded-md bg-slate-900 text-white hover:bg-slate-800"
          >
            Open full clients page →
          </button>
          <button
            onClick={onClose}
            data-testid="v7-clients-close"
            className="text-[11px] px-2 py-0.5 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          >
            Hide
          </button>
        </div>
      </div>

      {/* KPI band — roster */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
        <KpiTile label="Clients" value={list.length} tint="slate" />
        <KpiTile label="Need action today" value={actionCount} tint="amber" />
        <KpiTile label="Waiting on client" value={waitingCount} tint="sky" />
        <KpiTile label="Close-ready" value={closeReadyCount} tint="emerald" />
      </div>

      {/* Books-health strip — hidden state persists in localStorage */}
      {healthVisible ? (
        <div className="mb-3" data-testid="v7-books-health">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <div className="text-[10px] uppercase tracking-[0.15em] text-slate-400 font-semibold">
              Books health · this week
            </div>
            <div className="flex items-center gap-2">
              {kpiFilter && (
                <button
                  onClick={() => setKpiFilter(null)}
                  data-testid="v7-books-health-clear"
                  className="text-[10px] text-slate-500 hover:text-slate-800 underline underline-offset-2"
                >
                  Clear filter
                </button>
              )}
              <button
                onClick={() => setHealthVisiblePersist(false)}
                data-testid="v7-books-health-hide"
                className="text-[10px] text-slate-500 hover:text-slate-800"
              >
                Hide
              </button>
            </div>
          </div>
          {attention === null ? (
            <div className="rounded-lg border border-slate-200 bg-white p-3 text-[12px] text-slate-400 flex items-center gap-2">
              <Loader2 size={13} className="animate-spin" /> Loading books health…
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              {kpiTiles.map(t => (
                <BooksHealthTile
                  key={t.key}
                  t={t}
                  active={kpiFilter === t.key}
                  onClick={() => setKpiFilter(k => k === t.key ? null : t.key)}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="mb-3 text-right" data-testid="v7-books-health-collapsed">
          <button
            onClick={() => setHealthVisiblePersist(true)}
            data-testid="v7-books-health-show"
            className="text-[11px] text-slate-500 hover:text-slate-800 underline underline-offset-2"
          >
            Show books health
          </button>
        </div>
      )}

      {/* Search + tabs */}
      <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search clients by name…"
          data-testid="v7-clients-search"
          className="flex-1 min-w-[220px] text-[13px] px-3 py-1.5 rounded-md border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-slate-300"
        />
        <div className="flex gap-1 rounded-md border border-slate-200 p-0.5 bg-white">
          {[
            { key: "all", label: `All ${list.length}` },
            { key: "action", label: `Need action ${actionCount}` },
            { key: "waiting", label: `Waiting ${waitingCount}` },
            { key: "close-ready", label: `Close-ready ${closeReadyCount}` },
          ].map(tt => {
            const on = tab === tt.key;
            return (
              <button key={tt.key} onClick={() => setTab(tt.key)}
                data-testid={`v7-clients-tab-${tt.key}`}
                className={`text-[11px] px-2 py-1 rounded ${on ? "bg-slate-900 text-white shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                {tt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Active filter breadcrumb */}
      {kpiFilter && (
        <div className="text-[11px] text-slate-600 mb-2 flex items-center gap-1.5"
             data-testid="v7-books-health-active">
          Filtered to clients with
          <span className="font-semibold">
            {(kpiTiles.find(x => x.key === kpiFilter) || {}).label?.toLowerCase()}
          </span>
          · <button
              onClick={() => setKpiFilter(null)}
              className="underline underline-offset-2 hover:text-slate-900"
            >clear</button>
        </div>
      )}

      {/* Grid */}
      {filtered.length === 0 ? (
        <div className="text-[13px] text-slate-500 py-6 text-center">
          No clients match this filter.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map(c => <ClientHealthCard key={c.id} c={c} onNav={onNav} />)}
        </div>
      )}
    </div>
  );
}

function BooksHealthTile({ t, active, onClick }) {
  const tints = {
    amber:  { text: "text-amber-700",  ring: "ring-amber-300",  bg: "bg-amber-50/70" },
    purple: { text: "text-purple-700", ring: "ring-purple-300", bg: "bg-purple-50/70" },
    red:    { text: "text-rose-700",   ring: "ring-rose-300",   bg: "bg-rose-50/70" },
    indigo: { text: "text-indigo-700", ring: "ring-indigo-300", bg: "bg-indigo-50/70" },
    slate:  { text: "text-slate-800",  ring: "ring-slate-300",  bg: "bg-slate-50/70" },
  };
  const tint = tints[t.tint] || tints.slate;
  const zero = (t.total || 0) === 0;
  const base = "text-left rounded-lg border transition-all px-3 py-2 hover:shadow-sm w-full";
  const state = active
    ? `${tint.bg} ring-2 ${tint.ring} border-transparent`
    : zero
      ? "border-slate-200 bg-slate-50 hover:border-slate-300"
      : "border-slate-200 bg-white hover:border-slate-300";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={zero}
      data-testid={`v7-books-health-${t.key}`}
      className={`${base} ${state} disabled:opacity-70 disabled:cursor-not-allowed`}
    >
      <div className={`text-xl font-semibold tabular-nums ${zero ? "text-slate-400" : tint.text}`}>
        {(t.total || 0).toLocaleString()}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mt-0.5 truncate">
        {t.label}
      </div>
      <div className="text-[10px] text-slate-400 truncate mt-0.5">
        {zero
          ? "✓ all clear"
          : <>▸ <span className="tabular-nums">{t.clientCount}</span> client{t.clientCount === 1 ? "" : "s"}</>}
      </div>
    </button>
  );
}

function KpiTile({ label, value, tint }) {
  const tints = {
    slate:   "text-slate-900",
    amber:   "text-amber-700",
    sky:     "text-sky-700",
    emerald: "text-emerald-700",
  };
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
      <div className={`text-xl font-semibold ${tints[tint] || "text-slate-900"} tabular-nums`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}

// ---- "In Progress" panel ------------------------------------------------
// Collapsible roster of live firm work, modelled on ClientsPanel. Takes
// over the lower half of the dashboard when the "In Progress" stat tile
// is clicked. Six tabs:
//   1. Client Messages      — active review conversations
//   2. AI Email Questions   — questions AI is preparing / waiting to send
//   3. Scheduled QC         — upcoming + emailed-not-responded + last done
//   4. Auto Reconciliations — pending auto-recons across all clients
//   5. Sent to Professional — matters escalated to the accountant
//   6. Client Cockpit       — assistant/human follow-up work by client
const IN_PROGRESS_TABS = [
  { key: "ai_emails",  label: "AI Email Questions",   tint: "emerald", icon: "✉" },
  { key: "scheduled",  label: "Scheduled QC",         tint: "indigo",  icon: "📅" },
  { key: "autorecon",  label: "Auto Reconciliations", tint: "cyan",    icon: "🔁" },
];

// Standalone work cards that share the In Progress panel chrome.
const PANEL_MODES = {
  inprogress: { tab: "ai_emails", title: "In Progress", icon: Clock, tint: "indigo",
                sub: "Everything the AI has moving right now — emails it's waiting on, scheduled & live check-ins, running recons.", testid: "v7-in-progress-panel" },
  messages:   { tab: "messages", title: "Client Messages", icon: MessageSquare, tint: "emerald",
                sub: "Questions your clients sent you — from “Ask my accountant”, a transaction, or a check-in they sent to their bookkeeper.", testid: "v7-client-messages-panel" },
  assistant:  { tab: "cockpit", title: "Assistant follow up", icon: Sparkles, tint: "sky",
                sub: "Clients the AI has stopped making progress with and where a human touch is needed.", testid: "v7-assistant-panel" },
};

// Small "Open QC" affordance rendered at the end of every In Progress
// row that maps to a client review batch. Opens the client's Quick
// Check-in inline (under the tabs) so the pro can walk it with the
// client on a call.
function OpenQcButton({ token, onOpen, testid }) {
  if (!token) return null;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onOpen(); }}
      data-testid={testid}
      className="text-[11px] font-medium px-2 py-1 rounded-md border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 shrink-0 inline-flex items-center gap-1"
    >
      Open QC <ArrowUpRight size={11} />
    </button>
  );
}

function InProgressQcViewer({ qc, onBack, backLabel }) {
  const url = qc.url
    ? `${qc.url}${qc.url.includes("?") ? "&" : "?"}via=pro`
    : `/client-review/${qc.token}?via=pro${qc.item_id ? `&item=${encodeURIComponent(qc.item_id)}` : ""}`;
  return (
    <div data-testid="v7-ip-qc-viewer" className="-m-4">
      <div className="flex items-center justify-between gap-2 flex-wrap px-3 py-2 border-b border-slate-200 bg-slate-50 rounded-t-lg">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={onBack}
            data-testid="v7-ip-qc-back"
            className="text-[11px] font-medium px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 inline-flex items-center gap-1"
          >
            <ChevronLeft size={12} /> {backLabel}
          </button>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-slate-900 truncate">
              {qc.company_name || "Quick Check-in"}
            </div>
            <div className="text-[11px] text-slate-500 truncate">
              {qc.client_email || "client"}{qc.meta ? ` · ${qc.meta}` : ""} · live client view — anything you enter here posts exactly as if the client did
            </div>
          </div>
        </div>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          data-testid="v7-ip-qc-new-tab"
          className="text-[11px] text-indigo-700 hover:underline inline-flex items-center gap-1"
        >
          Open in new tab <ArrowUpRight size={11} />
        </a>
      </div>
      <iframe
        key={`${qc.url || qc.token}:${qc.item_id || ""}`}
        title="Client Quick Check-in"
        src={url}
        data-testid="v7-ip-qc-iframe"
        className="w-full bg-white rounded-b-lg"
        style={{ height: "min(78vh, 820px)", border: 0 }}
      />
    </div>
  );
}

// Matches an in-progress item to a set of selected company ids. Items
// carry `company_id` when the backend knows it; otherwise fall back to
// the display name so legacy rows still filter correctly.
function _matchesCompany(item, selectedIds, nameById) {
  if (!selectedIds.size) return true;
  if (item.company_id && selectedIds.has(item.company_id)) return true;
  const nm = item.company_name || item.company || "";
  for (const id of selectedIds) {
    if (nm && nameById[id] === nm) return true;
  }
  return false;
}

function InProgressCompanyFilter({ companies, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const list = companies.filter(c => !q || c.name.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    onChange(next);
  };
  const label = selected.size === 0
    ? "All companies"
    : selected.size === 1
      ? (companies.find(c => c.id === [...selected][0])?.name || "1 company")
      : `${selected.size} companies`;

  return (
    <div className="relative" data-testid="v7-ip-company-filter">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        data-testid="v7-ip-company-filter-trigger"
        className={`inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-md border bg-white transition-colors ${
          selected.size ? "border-indigo-400 text-indigo-700" : "border-slate-200 text-slate-700 hover:bg-slate-50"
        }`}
      >
        <Users size={13} />
        <span className="max-w-[180px] truncate">{label}</span>
        <span className="text-slate-400 text-[10px]">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 z-20 w-72 rounded-lg border border-slate-200 bg-white shadow-lg p-2"
               data-testid="v7-ip-company-filter-menu">
            <input
              autoFocus
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search companies…"
              data-testid="v7-ip-company-filter-search"
              className="w-full text-[12px] px-2 py-1.5 rounded-md border border-slate-200 mb-2 outline-none focus:border-indigo-400"
            />
            <div className="max-h-56 overflow-y-auto">
              {list.length === 0 && (
                <div className="text-[12px] text-slate-400 px-2 py-3 text-center">No matches</div>
              )}
              {list.map(c => {
                const on = selected.has(c.id);
                return (
                  <label key={c.id}
                         className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-slate-50 cursor-pointer text-[13px] text-slate-800"
                         data-testid={`v7-ip-company-option-${c.id}`}>
                    <input type="checkbox" checked={on} onChange={() => toggle(c.id)}
                           className="accent-indigo-600" />
                    <span className="truncate">{c.name}</span>
                  </label>
                );
              })}
            </div>
            <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100">
              <button type="button" onClick={() => onChange(new Set(companies.map(c => c.id)))}
                      data-testid="v7-ip-company-select-all"
                      className="text-[11px] text-indigo-700 hover:underline">Select all</button>
              <button type="button" onClick={() => onChange(new Set())}
                      data-testid="v7-ip-company-clear"
                      className="text-[11px] text-slate-500 hover:underline">Clear</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function InProgressPanel({ d, onNav, refetch, onClose, mode = "inprogress" }) {
  const cfg = PANEL_MODES[mode] || PANEL_MODES.inprogress;
  const [tab, setTab] = useState(cfg.tab);
  const PanelIcon = cfg.icon;
  const [selectedCos, setSelectedCos] = useState(() => new Set());
  // Inline Quick Check-in viewer. { token, company_name, client_email, meta }
  const [openQc, setOpenQc] = useState(null);
  const [qcPill, setQcPill] = useState("scheduled"); // lifted so it survives the inline QC viewer
  const [emailPill, setEmailPill] = useState("quick_ones");
  const [emailQ, setEmailQ] = useState(null);
  const switchTab = (k) => { setTab(k); setOpenQc(null); };

  const companies = useMemo(
    () => (d?.clients || []).map(c => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)),
    [d],
  );
  const nameById = useMemo(() => Object.fromEntries(companies.map(c => [c.id, c.name])), [companies]);
  const byCo = (arr) => (arr || []).filter(it => _matchesCompany(it, selectedCos, nameById));

  // Lazy-load tab data on first open of a given tab to keep the panel
  // cheap when a pro only clicks one tab.
  const [scheduledQc, setScheduledQc] = useState(null);
  const [autoRecon, setAutoRecon]     = useState(null);

  useEffect(() => {
    if (tab === "ai_emails" && emailQ === null) {
      api.get("/cockpit/email-questions")
        .then(r => setEmailQ(r.data || { rows: [] }))
        .catch(() => setEmailQ({ rows: [] }));
    }
    if (tab === "scheduled" && scheduledQc === null) {
      api.get("/cockpit/scheduled-qc")
        .then(r => setScheduledQc(r.data || { scheduled: [], missed: [], sent_awaiting: [], expired_no_response: [], last_completed: [] }))
        .catch(() => setScheduledQc({ scheduled: [], missed: [], sent_awaiting: [], expired_no_response: [], last_completed: [] }));
    }
    if (tab === "autorecon" && autoRecon === null) {
      api.get("/cockpit/pending-reconciliations")
        .then(r => setAutoRecon(r.data || { companies: [] }))
        .catch(() => setAutoRecon({ companies: [] }));
    }
  }, [tab, scheduledQc, autoRecon, emailQ]);

  // Live refresh: the inline QC iframe posts `qc:changed` after every
  // answer / defer / park. Debounce and re-pull the roster + today data.
  useEffect(() => {
    let timer = null;
    const onMsg = (e) => {
      if (e.origin !== window.location.origin || e.data?.type !== "qc:changed") return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        api.get("/cockpit/scheduled-qc")
          .then(r => setScheduledQc(r.data))
          .catch(() => {});
        api.get("/cockpit/email-questions")
          .then(r => setEmailQ(r.data))
          .catch(() => {});
        refetch?.();
      }, 600);
    };
    window.addEventListener("message", onMsg);
    return () => { window.removeEventListener("message", onMsg); clearTimeout(timer); };
  }, [refetch]);

  const filtered = useMemo(() => ({
    active:        byCo(d?.active),
    clientMessages: byCo(d?.clientMessages),
    waiting:       byCo(d?.waiting),
    professional:  byCo(d?.professional),
    priorUnclosed: byCo(d?.priorUnclosed),
    assistant:     byCo(d?.assistantItems),
    scheduledQc:   scheduledQc ? {
      ...scheduledQc,
      scheduled:      byCo(scheduledQc.scheduled),
      in_progress:    byCo(scheduledQc.in_progress || []),
      completed:      byCo(scheduledQc.completed || []),
      missed:         byCo(scheduledQc.missed || []),
      sent_awaiting:  byCo(scheduledQc.sent_awaiting),
      expired_no_response: byCo(scheduledQc.expired_no_response || []),
      last_completed: byCo(scheduledQc.last_completed),
    } : null,
    autoRecon: autoRecon ? { ...autoRecon, companies: byCo(autoRecon.companies) } : null,
    emailQ:    emailQ ? { ...emailQ, rows: byCo(emailQ.rows) } : null,
  }), [d, scheduledQc, autoRecon, emailQ, selectedCos, nameById]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const messages  = filtered.clientMessages.length;
    const ai_emails = filtered.emailQ
      ? filtered.emailQ.rows.filter(r => r.outcome === "waiting").length
      : filtered.waiting.reduce((s, w) => s + (w.count || 0), 0);
    const cockpit   = filtered.assistant.length;
    const scheduled = filtered.scheduledQc
      ? (filtered.scheduledQc.scheduled.length + (filtered.scheduledQc.in_progress || []).length
         + (filtered.scheduledQc.missed || []).length + filtered.scheduledQc.sent_awaiting.length
         + (filtered.scheduledQc.expired_no_response || []).length)
      : null;
    const autorecon = filtered.autoRecon
      ? (filtered.autoRecon.companies || []).reduce(
          (s, c) => s + (c.totals?.waiting || 0) + (c.totals?.ready || 0) + (c.totals?.manual || 0), 0)
      : null;
    return { messages, ai_emails, scheduled, autorecon, cockpit };
  }, [filtered]);

  return (
    <div className={`rounded-2xl border-2 p-5 ${cfg.tint === "emerald" ? "border-emerald-200 bg-emerald-50/30" : cfg.tint === "sky" ? "border-sky-200 bg-sky-50/30" : "border-indigo-200 bg-indigo-50/30"}`}
         data-testid={cfg.testid}>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <div className={`w-8 h-8 rounded-full flex items-center justify-center ${cfg.tint === "emerald" ? "bg-emerald-100 text-emerald-700" : cfg.tint === "sky" ? "bg-sky-100 text-sky-700" : "bg-indigo-100 text-indigo-700"}`}>
            <PanelIcon size={15} />
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-900">{cfg.title}</div>
            <div className="text-[11px] text-slate-500">{cfg.sub}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <InProgressCompanyFilter companies={companies} selected={selectedCos} onChange={setSelectedCos} />
          <button
            onClick={onClose}
            data-testid="v7-in-progress-close"
            className="text-[11px] px-2 py-0.5 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          >
            Hide
          </button>
        </div>
      </div>

      {selectedCos.size > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-3" data-testid="v7-ip-company-chips">
          {[...selectedCos].map(id => (
            <span key={id}
                  className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700"
                  data-testid={`v7-ip-company-chip-${id}`}>
              {nameById[id] || "Company"}
              <button type="button" aria-label="Remove"
                      onClick={() => setSelectedCos(prev => { const n = new Set(prev); n.delete(id); return n; })}
                      className="hover:text-indigo-900">×</button>
            </span>
          ))}
        </div>
      )}

      {/* Tab strip (In Progress only — Client Messages / Assistant are single-purpose cards) */}
      {mode === "inprogress" && <div className="flex flex-wrap gap-1 border-b border-slate-200 mb-4">
        {IN_PROGRESS_TABS.map(t => {
          const on = tab === t.key;
          const n  = counts[t.key];
          return (
            <button
              key={t.key}
              onClick={() => switchTab(t.key)}
              data-testid={`v7-in-progress-tab-${t.key}`}
              className={`text-[12px] font-medium px-3 py-2 -mb-px border-b-2 transition-colors ${
                on
                  ? "border-indigo-500 text-indigo-700 bg-white rounded-t-md"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              <span className="mr-1.5" aria-hidden>{t.icon}</span>
              {t.label}
              {n !== null && n !== undefined && n > 0 && (
                <span className={`ml-2 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold ${
                  on ? "bg-indigo-100 text-indigo-700" : "bg-slate-200 text-slate-600"
                }`}>
                  {n}
                </span>
              )}
            </button>
          );
        })}
      </div>}

      {/* Tab bodies */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 min-h-[220px]">
        {openQc ? (
          <InProgressQcViewer
            qc={openQc}
            onBack={() => setOpenQc(null)}
            backLabel={IN_PROGRESS_TABS.find(t => t.key === tab)?.label || "Back"}
          />
        ) : (<>
        {tab === "messages"  && <InProgressClientMessages items={filtered.clientMessages} onNav={onNav} refetch={refetch} />}
        {tab === "ai_emails" && <InProgressAiEmails data={filtered.emailQ} onOpenQc={setOpenQc} pill={emailPill} setPill={setEmailPill} />}
        {tab === "scheduled" && <InProgressScheduledQc data={filtered.scheduledQc} onNav={onNav} onOpenQc={setOpenQc}
                                   pill={qcPill} setPill={setQcPill}
                                   onNudged={(batchId, at) => setScheduledQc(q => {
                                     if (!q) return q;
                                     const bump = (arr) => (arr || []).map(r => r.batch_id === batchId
                                       ? { ...r, manual_nudge_at: at, manual_nudge_count: (r.manual_nudge_count || 0) + 1 } : r);
                                     return { ...q, missed: bump(q.missed), sent_awaiting: bump(q.sent_awaiting) };
                                   })} />}
        {tab === "autorecon" && <InProgressAutoRecon data={filtered.autoRecon} onNav={onNav} />}
        {tab === "cockpit"   && <InProgressCockpit items={filtered.assistant} onNav={onNav} />}
        </>)}
      </div>
    </div>
  );
}

function _EmptyTab({ text }) {
  return (
    <div className="text-center py-10 text-slate-400 text-sm">{text}</div>
  );
}

// Messages clients sent to the firm ("Ask my accountant", transaction
// questions, check-in items deferred to the bookkeeper). Reply inline.
function InProgressClientMessages({ items, onNav, refetch }) {
  if (!items.length) return <_EmptyTab text="No messages from clients yet. Clients reach you here via “Ask my accountant”, a transaction's “Ask my accountant about this”, or a check-in's “send to my bookkeeper”." />;
  const reply = async (m, text, _resolve, attachments = []) => {
    try { await api.post(`/client-messages/${m.id}/reply`, { text, attachments }); toast.success("Reply sent"); refetch?.(); }
    catch { toast.error("Couldn't send reply"); }
  };
  return (
    <ClientMessagesCard
      messages={items}
      perspective="pro"
      onReply={reply}
      onChanged={refetch}
      onOpenCompany={(m) => onNav(m.txn ? `/accounting/transactions?company=${m.company_id}&tid=${m.txn.id}` : `/company/${m.company_id}/dashboard`)}
      testidPrefix="v7-cm"
    />
  );
}

function _fmtDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch { return "—"; }
}
function _fmtRelDays(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso).getTime();
    const diff = Math.round((Date.now() - d) / 86400000);
    if (diff === 0) return "today";
    if (diff === 1) return "yesterday";
    if (diff < 7)   return `${diff}d ago`;
    if (diff < 30)  return `${Math.round(diff / 7)}w ago`;
    return `${Math.round(diff / 30)}mo ago`;
  } catch { return "—"; }
}

const EMAIL_Q_PILLS = [
  { key: "quick_ones",    label: "Quick Ones" },
  { key: "setup_invites", label: "Set-up & Invites" },
  { key: "qc_emails",     label: "QC Emails" },
];

const EMAIL_KIND_LABEL = {
  ai_ask_client: "AI quick one", ask_client: "Pro question", client_review_batch: "Quick Check-in",
  client_welcome: "Set password & activate", client_welcome_returning: "Welcome back",
  portal_invite: "Portal invite", team_invite: "Team invite",
};

const OUTCOME_STYLE = {
  waiting:       ["Waiting",       "bg-amber-50 text-amber-700 border-amber-200"],
  answered:      ["Answered",      "bg-emerald-50 text-emerald-700 border-emerald-200"],
  completed:     ["Completed",     "bg-emerald-50 text-emerald-700 border-emerald-200"],
  activated:     ["Activated",     "bg-emerald-50 text-emerald-700 border-emerald-200"],
  accepted:      ["Accepted",      "bg-emerald-50 text-emerald-700 border-emerald-200"],
  info:          ["Sent",          "bg-slate-50 text-slate-600 border-slate-200"],
  expired:       ["Expired",       "bg-rose-50 text-rose-700 border-rose-200"],
  revoked:       ["Revoked",       "bg-slate-50 text-slate-600 border-slate-200"],
  superseded:    ["Re-sent",       "bg-slate-50 text-slate-600 border-slate-200"],
  not_delivered: ["Not delivered", "bg-slate-50 text-slate-500 border-slate-200"],
};

const DELIVERY_LABEL = {
  sent: null, failed: "send failed", skipped_pref_off: "flow turned off",
  skipped_test_recipient: "test address — not sent",
};

function EmailQRow({ r, onOpen }) {
  const [label, cls] = OUTCOME_STYLE[r.outcome] || OUTCOME_STYLE.waiting;
  const dl = DELIVERY_LABEL[r.delivery];
  const isQc = r.kind === "client_review_batch";
  return (
    <li className="px-3 py-2 flex items-start justify-between gap-3 flex-wrap" data-testid={`v7-ip-email-${r.id}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] text-slate-900 truncate">{r.company_name}</span>
          <span className="text-[10px] uppercase tracking-wider text-slate-400 shrink-0">{EMAIL_KIND_LABEL[r.kind] || r.kind}</span>
        </div>
        <div className="text-[12px] text-slate-700 truncate" title={r.subject}>{r.subject}</div>
        <div className="text-[11px] text-slate-500 truncate">
          to {r.to} · sent {_fmtRelDays(r.sent_at)}{r.detail ? ` · ${r.detail}` : ""}
          {dl ? <span className="text-rose-500"> · {dl}</span> : null}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${cls}`} data-testid={`v7-ip-email-outcome-${r.id}`}>
          {label}{r.outcome === "waiting" && r.days_since >= 1 ? ` · ${r.days_since}d` : ""}
        </span>
        {r.open_url && (
          <button type="button" data-testid={`v7-ip-email-open-${r.id}`}
                  onClick={(e) => { e.stopPropagation(); onOpen(r); }}
                  className="text-[11px] font-medium px-2 py-1 rounded-md border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 inline-flex items-center gap-1">
            {isQc ? "Open QC" : "Open"} <ArrowUpRight size={11} />
          </button>
        )}
      </div>
    </li>
  );
}

function InProgressAiEmails({ data, onOpenQc, pill, setPill }) {
  const [showUndelivered, setShowUndelivered] = useState(false);
  if (!data) return <div className="text-center py-10 text-slate-400 text-sm">Loading…</div>;
  const rows = data.rows || [];
  const inGroup = rows.filter(r => r.group === pill);
  const waiting   = inGroup.filter(r => r.outcome === "waiting");
  const resolved  = inGroup.filter(r => !["waiting", "not_delivered"].includes(r.outcome));
  const undeliv   = inGroup.filter(r => r.outcome === "not_delivered");
  const counts = Object.fromEntries(EMAIL_Q_PILLS.map(p => [p.key, rows.filter(r => r.group === p.key && r.outcome === "waiting").length]));
  const open = (r) => onOpenQc({
    url: r.open_url, token: null, company_name: r.company_name, client_email: r.to,
    meta: `${EMAIL_KIND_LABEL[r.kind] || r.kind} · sent ${_fmtRelDays(r.sent_at)}`,
  });
  const scopeNote = data.scope === "enterprise"
    ? `All companies under ${data.enterprise_name || "your enterprise"}`
    : data.scope === "superadmin" ? "All companies on the platform" : "Your client companies";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5" data-testid="v7-ip-email-pills">
          {EMAIL_Q_PILLS.map(p => {
            const on = pill === p.key;
            const n = counts[p.key];
            return (
              <button key={p.key} type="button" onClick={() => setPill(p.key)} data-testid={`v7-ip-email-pill-${p.key}`}
                      className={`text-[12px] font-medium px-3 py-1 rounded-full border transition-colors inline-flex items-center gap-1.5 ${
                        on ? "bg-indigo-600 border-indigo-600 text-white" : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
                {p.label}
                <span className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold ${
                  on ? "bg-white/20 text-white" : n > 0 ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"}`}>{n}</span>
              </button>
            );
          })}
        </div>
        <div className="text-[11px] text-slate-400" data-testid="v7-ip-email-scope">{scopeNote} · last {data.days}d</div>
      </div>

      <QcSection title="Waiting on the client" count={waiting.length} empty="Nothing outstanding — every email in this group has been actioned.">
        {waiting.slice(0, 40).map(r => <EmailQRow key={r.id} r={r} onOpen={open} />)}
      </QcSection>
      <QcSection title="Resolved" count={resolved.length} empty="No resolved emails yet in this window.">
        {resolved.slice(0, 25).map(r => <EmailQRow key={r.id} r={r} onOpen={open} />)}
      </QcSection>
      {undeliv.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowUndelivered(v => !v)} data-testid="v7-ip-email-undelivered-toggle"
                  className="text-[11px] uppercase tracking-wider font-semibold text-slate-400 hover:text-slate-600 inline-flex items-center gap-1">
            {showUndelivered ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Not delivered · {undeliv.length}
          </button>
          {showUndelivered && (
            <ul className="mt-2 divide-y divide-slate-100 border border-slate-100 rounded-md">
              {undeliv.slice(0, 40).map(r => <EmailQRow key={r.id} r={r} onOpen={open} />)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

const QC_PILLS = [
  { key: "scheduled",   label: "Scheduled" },
  { key: "in_progress", label: "In Progress" },
  { key: "missed",      label: "Missed" },
  { key: "no_response", label: "No Response" },
  { key: "completed",   label: "Completed" },
];

function _fmtDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  } catch { return "—"; }
}

// One row shared by all Scheduled QC pills: company / email line on the
// left, a status string on the right, and the inline Open QC button.
function _fmtShortWhen(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch { return "—"; }
}

// Chips listing the specific questions a client parked ("don't have it
// now") and when each reminder fires.
function ParkedChips({ parked, testid, onJump }) {
  if (!parked?.length) return null;
  return (
    <div className="w-full flex flex-wrap gap-1.5 mt-1.5" data-testid={`${testid}-parked`}>
      {parked.map(p => (
        <button key={p.item_id} type="button"
              title={`${p.prompt} — open this question`}
              onClick={(e) => { e.stopPropagation(); onJump?.(p); }}
              data-testid={`${testid}-parked-${p.item_id}`}
              className="inline-flex items-center gap-1.5 max-w-full text-[11px] px-2 py-0.5 rounded-full bg-sky-50 text-sky-800 border border-sky-200 hover:bg-sky-100 hover:border-sky-300 transition-colors cursor-pointer">
          <Clock size={10} className="shrink-0" />
          <span className="truncate max-w-[380px]">{p.prompt || "Question"}</span>
          <span className="text-sky-600 shrink-0">· {p.reminded ? "reminded" : "reminds"} {_fmtShortWhen(p.remind_at)}</span>
          <ArrowUpRight size={10} className="shrink-0 text-sky-500" />
        </button>
      ))}
    </div>
  );
}

function _fmtRelShort(iso) {
  if (!iso) return "";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return _fmtRelDays(iso);
}

// One-click re-ping for Missed / No Response rows.
function NudgeButton({ r, testid, onNudged }) {
  const [busy, setBusy] = useState(false);
  const send = async (e) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const { data } = await api.post(`/cockpit/scheduled-qc/${r.batch_id}/nudge`);
      if (data.status === "sent") {
        toast.success(`Reminder sent to ${data.to}`);
        onNudged?.(r.batch_id, data.manual_nudge_at);
      } else if (data.status === "skipped_test_recipient") {
        toast.warning(`Not sent — ${data.to} is a test address`);
      } else if (data.status === "skipped_pref_off") {
        toast.warning("Not sent — client check-in emails are turned off in your settings");
      } else {
        toast.error(data.error || "Couldn't send the reminder");
      }
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't send the reminder");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-end gap-0.5 shrink-0">
      <button type="button" onClick={send} disabled={busy} data-testid={`${testid}-nudge`}
              className="text-[11px] font-medium px-2 py-1 rounded-md border border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100 disabled:opacity-50 inline-flex items-center gap-1">
        {busy ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
        Send reminder
      </button>
      {r.manual_nudge_at && (
        <span className="text-[10px] text-slate-400" data-testid={`${testid}-nudged-at`}>
          Reminded {_fmtRelShort(r.manual_nudge_at)}{r.manual_nudge_count > 1 ? ` · ×${r.manual_nudge_count}` : ""}
        </span>
      )}
    </div>
  );
}

function QcRow({ r, status, statusClass, sub, testid, onOpenQc, meta, children, extra }) {
  return (
    <li className="px-3 py-2 flex items-center justify-between gap-2 flex-wrap" data-testid={testid}>
      <div className="min-w-0">
        <div className="text-[13px] text-slate-900 truncate">{r.company_name}</div>
        <div className="text-[11px] text-slate-500 truncate">{sub}</div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <div className={`text-[11px] font-medium text-right ${statusClass}`}>{status}</div>
        {extra}
        <OpenQcButton token={r.client_token} testid={`${testid}-open`}
          onOpen={() => onOpenQc({ token: r.client_token, company_name: r.company_name,
                                   client_email: r.client_email, meta })} />
      </div>
      {children}
    </li>
  );
}

function QcSection({ title, count, empty, children }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider font-semibold text-slate-500 mb-2">
        {title} · {count}
      </div>
      {count === 0
        ? <div className="text-[12px] text-slate-400">{empty}</div>
        : <ul className="divide-y divide-slate-100 border border-slate-100 rounded-md">{children}</ul>}
    </div>
  );
}

const _plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function InProgressScheduledQc({ data, onNav, onOpenQc, onNudged, pill, setPill }) {
  if (!data) {
    return <div className="text-center py-10 text-slate-400 text-sm">Loading…</div>;
  }
  const {
    scheduled = [], in_progress = [], missed = [], sent_awaiting = [],
    expired_no_response = [], completed = [], last_completed = [],
  } = data;
  const neverDone  = last_completed.filter(r => r.never);
  const pillCounts = {
    scheduled:   scheduled.length,
    in_progress: in_progress.length,
    missed:      missed.length,
    no_response: sent_awaiting.length + expired_no_response.length,
    completed:   completed.length,
  };
  const items = (arr) => arr.slice(0, 25);
  const badgeTone = (key, n, on) => {
    if (on) return "bg-white/20 text-white";
    if (n === 0) return "bg-slate-100 text-slate-500";
    return { scheduled: "bg-indigo-100 text-indigo-700", in_progress: "bg-sky-100 text-sky-700",
             missed: "bg-amber-100 text-amber-700", no_response: "bg-rose-100 text-rose-700",
             completed: "bg-emerald-100 text-emerald-700" }[key];
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5" data-testid="v7-ip-qc-pills">
        {QC_PILLS.map(p => {
          const on = pill === p.key;
          const n  = pillCounts[p.key];
          return (
            <button key={p.key} type="button" onClick={() => setPill(p.key)}
                    data-testid={`v7-ip-qc-pill-${p.key}`}
                    className={`text-[12px] font-medium px-3 py-1 rounded-full border transition-colors inline-flex items-center gap-1.5 ${
                      on ? "bg-indigo-600 border-indigo-600 text-white"
                         : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                    }`}>
              {p.label}
              <span className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold ${badgeTone(p.key, n, on)}`}>{n}</span>
            </button>
          );
        })}
      </div>

      {pill === "scheduled" && (
        <QcSection title="Client picked a time" count={scheduled.length}
                   empty="No upcoming times — clients haven't scheduled a check-in yet.">
          {items(scheduled).map(b => (
            <QcRow key={b.batch_id} r={b} testid={`v7-ip-sched-${b.batch_id}`} onOpenQc={onOpenQc}
              sub={`${b.client_email || "—"} · ${_plural(b.item_count, "question")}${b.note ? ` · ${b.note}` : ""}`}
              status={_fmtDateTime(b.scheduled_for)} statusClass="text-indigo-700"
              meta={`${_plural(b.item_count, "question")} · ${_fmtDateTime(b.scheduled_for)}`} />
          ))}
        </QcSection>
      )}

      {pill === "in_progress" && (
        <QcSection title="Started · not finished" count={in_progress.length}
                   empty="No check-ins are mid-flight right now.">
          {items(in_progress).map(b => {
            const done = (b.answered || 0) + (b.deferred || 0);
            const bits = [`${b.client_email || "—"}`, `${done}/${b.item_count} done`];
            if (b.snoozed_count) bits.push(`${_plural(b.snoozed_count, "question")} parked`);
            if (b.pro_answered) bits.push(`${b.pro_answered} by ${(b.pro_names || []).join(", ") || "pro"}`);
            const when = b.follow_up_at || b.next_snooze_at;
            return (
              <QcRow key={b.batch_id} r={b} testid={`v7-ip-inprog-${b.batch_id}`} onOpenQc={onOpenQc}
                sub={bits.join(" · ")}
                status={when ? `Follow-up ${_fmtDateTime(when)}` : `Last activity ${_fmtRelDays(b.updated_at)}`}
                statusClass={when ? "text-sky-700" : "text-slate-500"}
                meta={`${done}/${b.item_count} done`}>
                <ParkedChips parked={b.parked} testid={`v7-ip-inprog-${b.batch_id}`}
                  onJump={(p) => onOpenQc({ token: b.client_token, company_name: b.company_name,
                                            client_email: b.client_email, item_id: p.item_id,
                                            meta: `parked question · reminds ${_fmtShortWhen(p.remind_at)}` })} />
              </QcRow>
            );
          })}
        </QcSection>
      )}

      {pill === "missed" && (
        <QcSection title="Scheduled time passed · no engagement" count={missed.length}
                   empty="No missed check-ins — every scheduled slot was kept.">
          {items(missed).map(b => (
            <QcRow key={b.batch_id} r={b} testid={`v7-ip-missed-${b.batch_id}`} onOpenQc={onOpenQc}
              sub={`${b.client_email || "—"} · ${_plural(b.item_count, "question")} · was ${_fmtDateTime(b.scheduled_for)}${
                b.nudge_sent ? " · nudged" : b.reminder_sent ? " · reminded" : ""}`}
              status={b.days_past === 0 ? "Missed today" : `Missed · ${b.days_past}d ago`}
              statusClass={b.days_past >= 3 ? "text-rose-600" : "text-amber-600"}
              meta={`missed ${_fmtDateTime(b.scheduled_for)}`}
              extra={<NudgeButton r={b} testid={`v7-ip-missed-${b.batch_id}`} onNudged={onNudged} />} />
          ))}
        </QcSection>
      )}

      {pill === "no_response" && (<>
        <QcSection title="Emailed · never opened or answered" count={sent_awaiting.length}
                   empty="Every emailed check-in has been engaged with.">
          {items(sent_awaiting).map(b => (
            <QcRow key={b.batch_id} r={b} testid={`v7-ip-noresp-${b.batch_id}`} onOpenQc={onOpenQc}
              sub={`${b.client_email || "—"} · 0/${b.item_count} answered`}
              status={`Sent ${_fmtRelDays(b.email_sent_at)}`}
              statusClass={b.days_waiting >= 5 ? "text-rose-600" : b.days_waiting >= 3 ? "text-amber-600" : "text-slate-500"}
              meta={`0/${b.item_count} answered`}
              extra={<NudgeButton r={b} testid={`v7-ip-noresp-${b.batch_id}`} onNudged={onNudged} />} />
          ))}
        </QcSection>
        <QcSection title="Link expired · never answered" count={expired_no_response.length}
                   empty="No check-ins have lapsed unanswered in the last 60 days.">
          {items(expired_no_response).map(b => (
            <QcRow key={b.batch_id} r={b} testid={`v7-ip-expired-${b.batch_id}`} onOpenQc={onOpenQc}
              sub={`${b.client_email || "—"} · ${_plural(b.item_count, "question")} · sent ${_fmtDate(b.email_sent_at || b.scheduled_for)}`}
              status={`Expired ${_fmtRelDays(b.expired_at)}`} statusClass="text-rose-600"
              meta={`expired ${_fmtRelDays(b.expired_at)}`} />
          ))}
        </QcSection>
        {neverDone.length > 0 && (
          <QcSection title="Clients who have never completed a check-in" count={neverDone.length} empty="">
            {items(neverDone).map((r, i) => (
              <QcRow key={`${r.company_id}-${r.client_email}-${i}`} r={r} testid={`v7-ip-engagement-${i}`} onOpenQc={onOpenQc}
                sub={r.client_email || "—"}
                status={`First emailed ${_fmtRelDays(r.first_sent)}`} statusClass="text-rose-600"
                meta="never completed" />
            ))}
          </QcSection>
        )}
      </>)}

      {pill === "completed" && (
        <QcSection title="Finished · newest first" count={completed.length}
                   empty="No completed check-ins yet.">
          {items(completed).map(b => (
            <QcRow key={b.batch_id} r={b} testid={`v7-ip-done-${b.batch_id}`} onOpenQc={onOpenQc}
              sub={`${b.client_email || "—"} · ${_plural(b.answered, "answer")}${b.deferred ? ` · ${b.deferred} to bookkeeper` : ""}${b.pro_answered ? ` · ${b.pro_answered} by ${(b.pro_names || []).join(", ") || "pro"}` : ""} · ${_plural(b.item_count, "question")}`}
              status={`Completed ${_fmtDateTime(b.completed_at)}`} statusClass="text-emerald-700"
              meta={`completed ${_fmtRelDays(b.completed_at)}`} />
          ))}
        </QcSection>
      )}
    </div>
  );
}

function InProgressAutoRecon({ data, onNav }) {
  if (!data) return <div className="text-center py-10 text-slate-400 text-sm">Loading…</div>;
  const companies = data.companies || [];
  if (!companies.length) return <_EmptyTab text="No auto-reconciliations in flight." />;
  return (
    <div className="space-y-3">
      <div className="text-[11px] text-slate-500">
        {data.waiting
          ? <>Plaid 5-day settle · <b>{data.days_left} day{data.days_left === 1 ? "" : "s"} left</b> · eligible {data.eligible_at}.</>
          : <>Settle period complete — next Plaid sync will auto-finalize eligible accounts.</>}
      </div>
      {companies.map(c => (
        <div key={c.company_id} className="rounded-md border border-slate-100 p-3">
          <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
            <div className="text-sm font-medium text-slate-900">{c.company_name}</div>
            <div className="text-[11px] text-slate-500 flex items-center gap-2 flex-wrap">
              {c.totals.done    > 0 && <span className="text-emerald-700 font-medium">{c.totals.done} done</span>}
              {c.totals.waiting > 0 && <span className="text-cyan-700 font-medium">{c.totals.waiting} waiting</span>}
              {c.totals.ready   > 0 && <span className="text-amber-700 font-medium">{c.totals.ready} ready</span>}
              {c.totals.manual  > 0 && <span className="text-rose-700 font-medium">{c.totals.manual} manual</span>}
            </div>
          </div>
          <ul className="space-y-1">
            {c.rows.map(r => (
              <li key={r.account_id}
                  className="flex items-center gap-2 text-[12px] px-2 py-1 rounded border border-slate-100">
                <ReconStatusIcon status={r.status} />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-slate-800 truncate">{r.account_name}</div>
                  <div className="text-[11px] text-slate-500 truncate">
                    {r.txn_count} txn{r.txn_count === 1 ? "" : "s"} · {r.reason}
                  </div>
                </div>
                {r.status === "ineligible_non_plaid" && (
                  <button
                    onClick={() => onNav(`/accounting/reconciliation?month=${data.month}&from=cockpit&ym=${data.month}`)}
                    className="text-[11px] px-2 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 shrink-0"
                    data-testid={`v7-ip-autorecon-manual-${r.account_id}`}
                  >
                    Reconcile →
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}


function InProgressCockpit({ items, onNav }) {
  if (!items.length) return <_EmptyTab text="No cockpit follow-ups outstanding." />;
  return (
    <div>
      <p className="text-[11px] text-slate-500 pb-2 border-b border-slate-100" data-testid="v7-ip-cockpit-intro">
        Clients the AI has stopped making progress with — what it already tried and what a human touch could do. Click a row to open the client.
      </p>
      <ul className="divide-y divide-slate-100">
        {items.map((it, i) => (
          <li key={it.id || i}
              onClick={() => it.route && onNav(it.route)}
              className={`py-3 ${it.route ? "cursor-pointer hover:bg-slate-50 -mx-2 px-2 rounded" : ""}`}
              data-testid={`v7-ip-cockpit-${i}`}>
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-slate-900 truncate">
                  {it.company || it.title || "—"}
                </div>
                <div className="text-[12px] text-slate-700 mt-0.5">
                  {it.headline || it.summary || it.reason || it.kind || "Needs human follow-up"}
                </div>
                {Array.isArray(it.steps) && it.steps.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5" data-testid={`v7-ip-cockpit-steps-${i}`}>
                    {it.steps.map((s, j) => (
                      <span key={j} className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600">✓ {s}</span>
                    ))}
                  </div>
                )}
                {it.suggested && (
                  <div className="text-[11px] text-sky-700 mt-1.5">Suggested: {it.suggested}</div>
                )}
              </div>
              <div className="text-[11px] text-sky-700 font-medium shrink-0 px-2 py-0.5 rounded-full bg-sky-50">Assistant</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}



// -------- Closings panel (collapsible, opened from hero tile) -----
function ClosingsPanel({ grid, total, onNav, refetch, onClose }) {
  const [showAll, setShowAll] = useState(false);
  const clients = grid || [];
  const totalN = total ?? clients.reduce((s, c) => s + (c.unclosed_count || 0), 0);
  const clientCount = clients.length;
  const visible = showAll ? clients : clients.slice(0, 6);
  const hiddenClients = Math.max(0, clientCount - visible.length);

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
              {clientCount === 0
                ? "All prior months signed off — nothing to close."
                : `${clientCount} client${clientCount === 1 ? "" : "s"} · ${totalN} prior-month close${totalN === 1 ? "" : "s"} still open — click any red month to see what it needs`}
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

      {clientCount === 0 ? (
        <div className="text-sm text-slate-500 py-4">
          Every prior month has been signed off. AI will surface the next close here as the month wraps.
        </div>
      ) : (
        <>
          {/* Legend */}
          <div className="flex items-center gap-4 mb-3 text-[11px] text-slate-500 flex-wrap">
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-emerald-500" /> Signed off
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-white border-2 border-emerald-500" /> Auto-closed
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-rose-500" /> Unreconciled
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-slate-200 border border-slate-300" /> No activity
            </div>
          </div>

          <div className="space-y-2">
            {visible.map(c => (
              <ClientCloseGridRow
                key={c.id}
                client={c}
                onNav={onNav}
                refetch={refetch}
              />
            ))}
          </div>

          {hiddenClients > 0 && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              data-testid="v7-closings-show-all"
              className="mt-3 w-full text-[12px] py-2 rounded-md border border-rose-100 bg-white text-rose-700 hover:bg-rose-50"
            >
              + Show all {clientCount} clients with open closings
            </button>
          )}
          {showAll && clientCount > 6 && (
            <button
              onClick={() => setShowAll(false)}
              className="mt-3 w-full text-[12px] py-2 rounded-md border border-rose-100 bg-white text-rose-700 hover:bg-rose-50"
            >
              Collapse to top 6
            </button>
          )}
        </>
      )}
    </div>
  );
}

// -------- Per-client 12-month strip + inline checklist expansion --
function ClientCloseGridRow({ client, onNav, refetch }) {
  const [selected, setSelected] = useState(null); // period ym string
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signing, setSigning] = useState(false);

  const overdue = client.oldest_unclosed_months_ago || 0;
  const overdueLabel = overdue <= 1 ? "1 month overdue" : `${overdue} months overdue`;

  const selectedMonth = selected
    ? (client.months || []).find(m => m.period === selected)
    : null;

  const openMonth = async (m) => {
    if (m.state === "no_activity") return;
    if (selected === m.period) {
      setSelected(null);
      setStatus(null);
      return;
    }
    setSelected(m.period);
    setStatus(null);
    setLoading(true);
    try {
      const r = await api.get(
        `/companies/${client.company_id}/month-close/${m.period}`,
      );
      setStatus(r.data);
    } catch (err) {
      toast.error("Couldn't load month-close status");
      setSelected(null);
    } finally {
      setLoading(false);
    }
  };

  const goReview = () => {
    if (!selected) return;
    onNav(`/accounting/month-close?ym=${selected}&company=${client.company_id}`);
  };

  const quickSignOff = async (e) => {
    e.stopPropagation();
    setMenuOpen(false);
    if (!selected) return;
    setSigning(true);
    try {
      await api.post(
        `/companies/${client.company_id}/month-close/${selected}/checkpoint`,
        { kind: "closed", signed: true },
      );
      toast.success(`${selectedMonth?.label} ${selectedMonth?.year} signed off · period locked`);
      setSelected(null);
      setStatus(null);
      if (refetch) await refetch();
    } catch (err) {
      const msg = err?.response?.data?.detail
        || `Cannot sign off — complete the checklist first.`;
      toast.error(msg);
    } finally {
      setSigning(false);
    }
  };

  return (
    <div
      className="rounded-lg bg-white border-l-4 border-l-rose-400 border border-rose-100 p-3"
      data-testid={`v7-close-row-${client.company_id}`}
    >
      {/* Client header */}
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <AlertTriangle size={12} className="text-rose-500 shrink-0" />
          <div className="text-sm font-semibold text-slate-900 truncate">
            {client.company_name}
          </div>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-rose-700 bg-rose-50 rounded px-1.5 py-0.5 shrink-0">
            {overdueLabel}
          </span>
          <span className="text-[10px] text-slate-500 shrink-0">
            {client.unclosed_count} month{client.unclosed_count === 1 ? "" : "s"} open
          </span>
        </div>
      </div>

      {/* 12-month horizontal strip */}
      <div className="grid grid-cols-12 gap-1">
        {(client.months || []).map(m => {
          const isSelected = selected === m.period;
          const base = "flex flex-col items-center justify-center rounded-md py-1.5 text-[10px] font-medium transition-all";
          let cls;
          let titleSuffix = "";
          if (m.state === "closed") {
            if (m.auto_locked) {
              // Auto-closed: green outlined / white fill — all gates
              // reviewed but no human sign-off yet. New activity will
              // silently reopen it. See routes/month_close.py.
              cls = "bg-white text-emerald-700 border-2 border-emerald-500 hover:bg-emerald-50";
              titleSuffix = " · auto-closed (new activity reopens automatically)";
            } else {
              cls = "bg-emerald-500 text-white hover:bg-emerald-600 border-2 border-emerald-500";
            }
          } else if (m.state === "unclosed") {
            cls = "bg-rose-500 text-white hover:bg-rose-600 cursor-pointer border-2 border-rose-500";
          } else {
            cls = "bg-slate-100 text-slate-400 border-2 border-slate-200 cursor-not-allowed";
          }
          if (isSelected) cls += " ring-2 ring-offset-1 ring-rose-700 scale-105";
          // Any month with activity is clickable — opens the inline detail
          // panel so the pro can see gates + the Complete Closing button
          // (works for red "unclosed" AND for already-auto-locked periods
          // where the pro may want to promote to a manual lock).
          const clickable = m.state !== "no_activity";
          return (
            <button
              key={m.period}
              type="button"
              onClick={() => openMonth(m)}
              disabled={!clickable}
              data-testid={`v7-close-cell-${client.company_id}-${m.period}`}
              title={`${m.label} ${m.year} · ${m.state} · ${m.txn_count} txn${m.txn_count === 1 ? "" : "s"}${titleSuffix}`}
              className={`${base} ${cls}`}
            >
              <span className="leading-none">{m.label}</span>
              <span className="leading-none text-[9px] opacity-80 mt-0.5">
                {String(m.year).slice(-2)}
              </span>
            </button>
          );
        })}
      </div>

      {/* Inline checklist for the selected month */}
      {selected && (
        <div className="mt-3 rounded-lg border border-rose-100 bg-rose-50/30 p-3"
             data-testid={`v7-close-checklist-${client.company_id}-${selected}`}>
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <div>
              <div className="text-[10px] uppercase tracking-wider font-semibold text-rose-700">
                To reconcile {selectedMonth?.label} {selectedMonth?.year}
              </div>
              <div className="text-[11px] text-slate-500">
                {selectedMonth?.txn_count} txn{selectedMonth?.txn_count === 1 ? "" : "s"} in this period
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={goReview}
                data-testid={`v7-close-review-${client.company_id}-${selected}`}
                className="text-[11px] px-2.5 py-1 rounded-md bg-indigo-600 text-white hover:bg-indigo-700"
              >
                Review & sign off →
              </button>
              <div className="relative">
                <button
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o); }}
                  data-testid={`v7-close-menu-${client.company_id}-${selected}`}
                  className="text-[11px] p-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50"
                  aria-label="More sign-off actions"
                >
                  <MoreVertical size={13} />
                </button>
                {menuOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 z-20 w-56 rounded-lg border border-slate-200 bg-white shadow-lg py-1">
                      <button
                        onClick={quickSignOff}
                        disabled={signing}
                        data-testid={`v7-close-quick-signoff-${client.company_id}-${selected}`}
                        className="w-full text-left text-[12px] px-3 py-2 hover:bg-slate-50 flex items-center gap-2 disabled:opacity-50"
                      >
                        {signing
                          ? <Loader2 size={12} className="animate-spin" />
                          : <CheckCircle2 size={12} className="text-emerald-600" />}
                        Quick sign off (skip checklist)
                      </button>
                      <button
                        onClick={() => { setMenuOpen(false); goReview(); }}
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

          {loading && (
            <div className="py-4 flex justify-center text-slate-400">
              <Loader2 size={16} className="animate-spin" />
            </div>
          )}

          {status && !loading && (
            <ChecklistRows
              cid={client.company_id}
              ym={selected}
              status={status}
              onNav={onNav}
              onCompleteClosing={quickSignOff}
              signing={signing}
            />
          )}
        </div>
      )}
    </div>
  );
}

// -------- Renders the 5 month-close checkpoint rows --------------
function ChecklistRows({ cid, ym, status, onNav, onCompleteClosing, signing }) {
  const cps = status.checkpoints || {};
  // All four pre-conditions green? → "Complete Closing" button enabled.
  const preGreen = ["txns_reviewed", "invoices", "bills", "recon"]
    .every(k => Boolean(cps[k]?.green));
  const closedCp = cps.closed || {};
  const autoLocked = Boolean(closedCp.auto_locked);
  const manuallyLocked = Boolean(closedCp.green) && !autoLocked;
  const rows = [
    {
      key: "txns_reviewed",
      label: "Transactions reviewed & categorized",
      cp: cps.txns_reviewed,
      detail: (cp) => {
        if (!cp || cp.total == null) return "Auto-computed";
        if (cp.green) return `${cp.total} txns · all reviewed`;
        const bits = [];
        if (cp.uncategorized) bits.push(`${cp.uncategorized} uncategorized`);
        if (cp.unreviewed) bits.push(`${cp.unreviewed} unreviewed`);
        return `${cp.total} txns · ${bits.join(" · ") || "needs review"}`;
      },
      route: `/company/${cid}/transactions?ym=${ym}&filter=unreviewed`,
      ctaLabel: "Review transactions",
    },
    {
      key: "invoices",
      label: "Outstanding invoices triaged",
      cp: cps.invoices,
      detail: (cp) => {
        if (!cp) return "";
        if (cp.auto) return "No outstanding invoices — auto";
        if (cp.signed_at) return `Signed off ${new Date(cp.signed_at).toLocaleDateString()}`;
        return `${cp.outstanding || 0} outstanding · sign off to complete`;
      },
      route: `/accounting/invoices?company=${cid}`,
      ctaLabel: "Open invoices",
    },
    {
      key: "bills",
      label: "Outstanding bills triaged",
      cp: cps.bills,
      detail: (cp) => {
        if (!cp) return "";
        if (cp.auto) return "No outstanding bills — auto";
        if (cp.signed_at) return `Signed off ${new Date(cp.signed_at).toLocaleDateString()}`;
        return `${cp.outstanding || 0} outstanding · sign off to complete`;
      },
      route: `/accounting/bills?company=${cid}`,
      ctaLabel: "Open bills",
    },
    {
      key: "recon",
      label: "Bank & credit-card reconciled",
      cp: cps.recon,
      detail: (cp) => {
        if (!cp) return "";
        if (cp.auto) return `Auto (Plaid) · ${cp.cleared || 0}/${cp.total || 0} cleared`;
        if (cp.signed_at) return `Signed off ${new Date(cp.signed_at).toLocaleDateString()}`;
        return `${cp.cleared || 0}/${cp.total || 0} cleared · sign off to complete`;
      },
      route: `/accounting/reconciliation?month=${ym}&from=month-close&ym=${ym}`,
      ctaLabel: "Reconcile",
    },
    {
      key: "closed",
      label: "Period locked (final sign-off)",
      cp: cps.closed,
      detail: (cp) => {
        if (!cp) return "";
        if (cp.signed_at && cp.auto_locked) return `Auto-closed ${new Date(cp.signed_at).toLocaleDateString()} · click Complete Closing to lock permanently`;
        if (cp.signed_at) return `Locked ${new Date(cp.signed_at).toLocaleDateString()}`;
        if (preGreen) return "All gates green — ready to lock permanently";
        return "Gated — sign off after the four above are green";
      },
      route: null,
      ctaLabel: null,
    },
  ];

  return (
    <ul className="space-y-1.5">
      {rows.map(r => {
        const green = r.cp?.green;
        const isClosedRow = r.key === "closed";
        // "Complete Closing" button — shows on the Period Locked row when
        // the 4 preconditions are green (auto-locked or not), and converts
        // either an auto-lock into a manual lock, or stamps the first lock.
        const showComplete = isClosedRow && preGreen && !manuallyLocked;
        return (
          <li
            key={r.key}
            className="flex items-center gap-2 rounded-md bg-white border border-slate-100 px-2.5 py-1.5"
          >
            {green
              ? (isClosedRow && autoLocked
                  ? <CheckCircle2 size={14} className="text-emerald-500 shrink-0" style={{opacity:0.7}} />
                  : <CheckCircle2 size={14} className="text-emerald-500 shrink-0" />)
              : <AlertTriangle size={14} className="text-rose-500 shrink-0" />}
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-medium text-slate-800 truncate flex items-center gap-1.5">
                {r.label}
                {isClosedRow && autoLocked && (
                  <span className="text-[9px] uppercase tracking-wider font-semibold text-emerald-700 border border-emerald-500 rounded px-1 py-[1px] bg-white">
                    auto
                  </span>
                )}
              </div>
              <div className="text-[11px] text-slate-500 truncate">{r.detail(r.cp)}</div>
            </div>
            {showComplete ? (
              <button
                onClick={onCompleteClosing}
                disabled={Boolean(signing)}
                data-testid={`v7-complete-closing-${cid}-${ym}`}
                className="text-[11px] font-semibold px-3 py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 shrink-0 inline-flex items-center gap-1"
                title={autoLocked
                  ? "This period is auto-closed. Click to permanently lock it with your sign-off."
                  : "Lock this period permanently with your sign-off."}
              >
                <Lock size={12} /> Complete Closing
              </button>
            ) : (!green && r.route && r.ctaLabel && (
              <button
                onClick={() => onNav(r.route)}
                className="text-[11px] px-2 py-1 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 shrink-0"
              >
                {r.ctaLabel} →
              </button>
            ))}
          </li>
        );
      })}
    </ul>
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

// -------- Client health card --------------------------------------
function ClientHealthCard({ c, onNav }) {
  const tier = c.recon_pct >= 95 ? "pro" : c.recon_pct >= 80 ? "ai" : "assistant";
  const t = TIER[tier];
  const state = c.recon_pct >= 95 ? "Close ready"
             : c.recon_pct >= 80 ? "AI working"
             : "Waiting on client";
  const openCockpit = () => {
    // Open Client Cockpit scoped to this company; leave a breadcrumb
    // hint so the destination page can render a "back to Today"
    // link that scrolls to the Client books grid.
    const back = encodeURIComponent("/cockpit/today-v7#client-books");
    onNav(`/cockpit/client?company=${c.id}&back_to=${back}&back_label=${encodeURIComponent("Back to Today · Client books")}`);
  };
  return (
    <div onClick={openCockpit}
         data-testid={`v7-client-card-${c.id}`}
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


// ---- Pending Reconciliations card (shown below Closings panel) ---------
// Renders during the end-of-month → day-6 handoff when the prior month's
// per-account reconciliations are auto-finalizing via Plaid's free balance
// snapshot (reconciliation_engine.bootstrap_from_plaid → source:
// "plaid_balance_verified"). The card simply surfaces what the backend
// has already decided — no action required for Plaid-mapped accounts,
// and a clear flag for anything that will need the pro's attention.
function PendingReconciliationsCard({ onNav }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get("/cockpit/pending-reconciliations");
        if (!cancelled) setData(r.data);
      } catch {
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  if (loading) return null;
  if (!data || !(data.companies || []).length) return null;
  const monthLabel = (() => {
    const m = /^(\d{4})-(\d{2})$/.exec(data.month || "");
    if (!m) return data.month || "";
    const d = new Date(Number(m[1]), Number(m[2]) - 1, 1);
    return d.toLocaleString("en-US", { month: "long", year: "numeric" });
  })();
  return (
    <div className="rounded-2xl border-2 border-cyan-200 bg-cyan-50/40 p-5"
         data-testid="v7-pending-recons">
      <div className="flex items-start justify-between gap-2 mb-3 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-full bg-cyan-100 flex items-center justify-center shrink-0">
            <Clock size={14} className="text-cyan-700" />
          </div>
          <div>
            <div className="font-heading text-lg font-semibold">
              {monthLabel} auto-reconciliations
            </div>
            <div className="text-[12px] text-slate-600 mt-0.5">
              {data.waiting
                ? <>Plaid 5-day settle · <b>{data.days_left} day{data.days_left === 1 ? "" : "s"} left</b> · eligible {data.eligible_at}. Reconciliations will auto-finalize on the next Plaid sync after that.</>
                : <>Settle period complete — next Plaid sync will auto-finalize any eligible accounts.</>}
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {(data.companies || []).map(c => (
          <div key={c.company_id} className="rounded-lg bg-white border border-cyan-100 p-3">
            <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
              <div className="font-medium text-sm text-slate-900">{c.company_name}</div>
              <div className="text-[11px] text-slate-500 flex items-center gap-2 flex-wrap">
                {c.totals.done > 0 && <span className="text-emerald-700 font-medium">{c.totals.done} done</span>}
                {c.totals.waiting > 0 && <span className="text-cyan-700 font-medium">{c.totals.waiting} waiting</span>}
                {c.totals.ready > 0 && <span className="text-amber-700 font-medium">{c.totals.ready} ready</span>}
                {c.totals.manual > 0 && <span className="text-rose-700 font-medium">{c.totals.manual} manual</span>}
              </div>
            </div>
            <ul className="space-y-1">
              {c.rows.map(r => (
                <li key={r.account_id}
                    className="flex items-center gap-2 text-[12px] px-2 py-1 rounded border border-slate-100 bg-white">
                  <ReconStatusIcon status={r.status} />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-slate-800 truncate">{r.account_name}</div>
                    <div className="text-[11px] text-slate-500 truncate">
                      {r.txn_count} txn{r.txn_count === 1 ? "" : "s"} · {r.reason}
                    </div>
                  </div>
                  {r.status === "ineligible_non_plaid" && (
                    <button
                      onClick={() => onNav(`/accounting/reconciliation?month=${data.month}&from=cockpit&ym=${data.month}`)}
                      className="text-[11px] px-2 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 shrink-0"
                      data-testid={`v7-pending-recon-manual-${r.account_id}`}
                    >
                      Reconcile →
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReconStatusIcon({ status }) {
  if (status === "auto_reconciled") return <CheckCircle2 size={13} className="text-emerald-600 shrink-0" />;
  if (status === "manually_reconciled") return <CheckCircle2 size={13} className="text-emerald-700 shrink-0" />;
  // Static clock during the settle window — nothing is actively "spinning"
  // on the backend, we're just waiting for the calendar to advance.
  if (status === "waiting_settle") return <Clock size={13} className="text-cyan-600 shrink-0" />;
  // Ready-to-finalize uses an hourglass vibe — still static.
  if (status === "ready_next_sync") return <Clock size={13} className="text-amber-600 shrink-0" />;
  return <AlertTriangle size={13} className="text-rose-600 shrink-0" />;
}

