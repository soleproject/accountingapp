import { useEffect, useRef, useState } from "react";
import { api, fmtMoney } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { useAuth } from "@/lib/auth";
import { TID } from "@/constants/testIds";
import { Link, useNavigate } from "react-router-dom";
import { emitAction, useActionListener } from "@/lib/createBus";
import {
  Sparkles, Zap, AlertTriangle, TrendingUp, Wand2, FileCheck2, Bot, ArrowRight,
  Wallet2, FileText, Receipt as ReceiptIcon, Activity, BellRing, ScrollText,
  FileWarning, ReceiptText, ChevronLeft, ChevronRight,
} from "lucide-react";

// -------- Timeframe helpers ---------------------------------------
// The Dashboard "Income snapshot" defaults to YTD but users asked for a way
// to step back through prior months / years. Rather than build a full date
// picker we ship three simple modes ("ytd", "month", "year") with left/right
// arrows to shift the anchor month. All range math is derived from a single
// anchor `YYYY-MM` string.
function monthAnchor(offset = 0) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function shiftAnchor(anchor, delta, mode) {
  const [y, m] = anchor.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  if (mode === "year") d.setFullYear(d.getFullYear() + delta);
  else d.setMonth(d.getMonth() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function rangeFor(anchor, mode) {
  const [y, m] = anchor.split("-").map(Number);
  if (mode === "year") {
    return { start: `${y}-01-01`, end: `${y}-12-31` };
  }
  if (mode === "ytd") {
    const now = new Date();
    return {
      start: `${now.getFullYear()}-01-01`,
      end: now.toISOString().slice(0, 10),
    };
  }
  // month
  const last = new Date(y, m, 0).getDate();
  return {
    start: `${y}-${String(m).padStart(2, "0")}-01`,
    end: `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`,
  };
}
function labelFor(anchor, mode) {
  if (mode === "ytd") return "YTD";
  const [y, m] = anchor.split("-").map(Number);
  if (mode === "year") return `${y}`;
  const monthName = new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long" });
  return `${monthName} ${y}`;
}
import FirstConnectWelcome from "@/components/FirstConnectWelcome";

const kindLabel = {
  categorize: "Transactions Categorized",
  post_je: "Journal Entries Auto-Posted",
  flag_review: "Flagged for Review",
  rule_created: "Rules Created",
  coa_generated: "CoA Accounts Suggested",
  veryfi_ocr: "Statement Lines OCR'd",
  webhook_sync: "Webhook Auto-Syncs",
};

const kindIcon = {
  categorize: Zap, post_je: FileCheck2, flag_review: AlertTriangle,
  rule_created: Wand2, coa_generated: Sparkles, veryfi_ocr: Bot,
  webhook_sync: Zap,
};

const kindColor = {
  categorize: "#6366F1", post_je: "#10B981", flag_review: "#F97316",
  rule_created: "#6366F1", coa_generated: "#3B82F6", veryfi_ocr: "#3B82F6",
  webhook_sync: "#6366F1",
};

export default function Dashboard() {
  const { currentId, current } = useCompany();
  const [totals, setTotals] = useState(null);
  const [activity, setActivity] = useState([]);
  const [income, setIncome] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [attention, setAttention] = useState(null);
  const [syncStatus, setSyncStatus] = useState(null);
  // Income-snapshot timeframe — user asked for a way to step back through
  // prior months / years. `mode` is one of "ytd" | "month" | "year";
  // `anchor` is a YYYY-MM string that arrow-navigates within the chosen mode.
  const [tfMode, setTfMode] = useState("ytd");
  const [tfAnchor, setTfAnchor] = useState(() => monthAnchor(0));
  // Track the last-observed sync status so we can trigger a heavy refetch
  // exactly once when a background sync transitions from `syncing → idle`.
  const prevStatusRef = useRef(null);

  useEffect(() => {
    if (!currentId) return;
    let cancelled = false;

    const { start, end } = rangeFor(tfAnchor, tfMode);

    // -------- Heavy fetch (ai/activity + reports + metrics) ------------
    // Server responses are already 15s-cached, so this is safe to call
    // fairly often, but we still gate it — see poll strategy below.
    const fetchHeavy = () => {
      api.get(`/companies/${currentId}/ai/activity`).then(r => {
        if (cancelled) return;
        setTotals(r.data.totals); setActivity(r.data.activity);
      }).catch(() => {});
      api.get(`/companies/${currentId}/reports/income-statement`, {
        params: { start, end },
      })
        .then(r => { if (!cancelled) setIncome(r.data); }).catch(() => {});
      api.get(`/companies/${currentId}/dashboard/metrics`)
        .then(r => { if (!cancelled) setMetrics(r.data); }).catch(() => {});
      api.get(`/companies/${currentId}/dashboard/attention`)
        .then(r => { if (!cancelled) setAttention(r.data); }).catch(() => {});
    };

    // -------- Cheap sync-status poll (single Mongo lookup) -------------
    // Also drives the heavy refetch when a sync completes.
    const fetchStatus = async () => {
      try {
        const r = await api.get(`/companies/${currentId}/sync-status`);
        if (cancelled) return;
        const next = r.data;
        const prev = prevStatusRef.current;
        setSyncStatus(next);
        // Fire a heavy refetch whenever any of these signals fire:
        //   • the pill flips syncing → idle (existing behavior), OR
        //   • total_txns changed (new webhook rows landed even without a
        //     visible syncing state — e.g. a very fast sync that finishes
        //     between two 5-second polls).
        // Second condition is what fixed the "Dashboard is slow to
        // populate right after Plaid Link" complaint — without it, we'd
        // sit on stale zeros for up to 120s (the safety-net interval).
        const flipped = prev && prev.status === "syncing" && next.status !== "syncing";
        const rowsChanged = (prev?.total_txns ?? -1) !== (next.total_txns ?? -1);
        if (flipped || rowsChanged) fetchHeavy();
        prevStatusRef.current = next;
      } catch { /* ignore */ }
    };

    // Initial burst
    fetchHeavy();
    fetchStatus();

    // Adaptive polling: cheap pill every 5s while syncing, 15s while idle;
    // heavy re-fetch runs only when the pill flips syncing→idle, on tab
    // focus, or as a slow 120s safety net.
    const heavyEvery = 120_000;
    const heavyInterval = setInterval(fetchHeavy, heavyEvery);
    let statusTimer;
    const tickStatus = () => {
      fetchStatus();
      const delay = prevStatusRef.current?.status === "syncing" ? 5_000 : 15_000;
      statusTimer = setTimeout(tickStatus, delay);
    };
    statusTimer = setTimeout(tickStatus, 5_000);

    // Immediate refresh when the tab regains focus.
    const onFocus = () => {
      if (document.visibilityState !== "visible") return;
      fetchStatus();
      fetchHeavy();
    };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      clearInterval(heavyInterval);
      clearTimeout(statusTimer);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, [currentId, tfMode, tfAnchor]);

  if (!current) return <div className="text-slate-500">Select a company to view your Dashboard.</div>;

  if (!current.onboarding_complete) {
    return <OnboardingNudge company={current} />;
  }

  return (
    <div className="space-y-6" data-testid={TID.aiPulseSection}>
      <FirstConnectWelcome
        status={syncStatus}
        companyId={currentId}
        companyName={current?.name}
      />

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-slate-500 text-sm mt-1">
            What the AI has done for {current.name} · {current.reporting_basis} basis
          </p>
        </div>
      </div>

      <AttentionTile attention={attention} />

      {totals && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            ["Transactions", totals.transactions, "#6366F1"],
            ["Auto-posted", totals.posted, "#10B981"],
            ["Needs review", totals.flagged, "#F97316"],
            ["AI accuracy", `${totals.accuracy}%`, "#10B981"],
          ].map(([label, val, col]) => (
            <div key={label} className="rounded-xl border bg-white p-4">
              <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
              <div className="font-heading text-3xl font-bold mt-1" style={{ color: col }}>{val}</div>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 rounded-xl border bg-white p-5">
          <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <TrendingUp size={16} className="text-slate-500" />
              <h2 className="font-heading font-semibold">
                Income snapshot · {labelFor(tfAnchor, tfMode)}
              </h2>
            </div>
            <TimeframePicker
              mode={tfMode}
              anchor={tfAnchor}
              onModeChange={(m) => {
                setTfMode(m);
                // Reset anchor to current period whenever mode changes so
                // "This month" / "This year" always start where the user
                // expects, regardless of where they'd navigated to.
                setTfAnchor(monthAnchor(0));
              }}
              onShift={(delta) => setTfAnchor(a => shiftAnchor(a, delta, tfMode))}
              onReset={() => setTfAnchor(monthAnchor(0))}
            />
          </div>
          {income ? (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <div className="text-xs text-slate-500 uppercase">Revenue</div>
                <div className="font-mono-num text-2xl font-semibold text-emerald-600">{fmtMoney(income.total_revenue)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 uppercase">Expenses</div>
                <div className="font-mono-num text-2xl font-semibold text-orange-600">{fmtMoney(income.total_expense)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 uppercase">Net Income</div>
                <div className="font-mono-num text-2xl font-semibold text-slate-900">{fmtMoney(income.net_income)}</div>
              </div>
            </div>
          ) : <div className="text-sm text-slate-500">Loading…</div>}
          <div className="mt-4 flex gap-2">
            <Link to="/reports/income-statement" className="text-xs text-slate-600 hover:text-slate-900 underline">Open income statement</Link>
            <Link to="/reports/balance-sheet" className="text-xs text-slate-600 hover:text-slate-900 underline">Balance sheet</Link>
          </div>

          {metrics && (
            <div className="mt-5 pt-4 border-t grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="dashboard-metrics">
              <div className="rounded-lg bg-emerald-50 border border-emerald-100 p-3">
                <div className="text-[10px] uppercase tracking-wider text-emerald-700 font-semibold flex items-center gap-1">
                  <Wallet2 size={11} /> Cash on hand
                </div>
                <div className="font-mono-num font-semibold text-emerald-700 text-lg mt-0.5">{fmtMoney(metrics.cash_on_hand)}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">Across all bank accounts</div>
              </div>
              <Link to="/invoices" className="rounded-lg bg-indigo-50 border border-indigo-100 p-3 hover:border-indigo-300 transition">
                <div className="text-[10px] uppercase tracking-wider text-indigo-700 font-semibold flex items-center gap-1">
                  <FileText size={11} /> Outstanding A/R
                </div>
                <div className="font-mono-num font-semibold text-indigo-700 text-lg mt-0.5">{fmtMoney(metrics.outstanding_invoices)}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  {metrics.invoice_count} open invoice{metrics.invoice_count === 1 ? "" : "s"}
                  {metrics.overdue_invoices > 0 && <span className="text-red-600"> · {fmtMoney(metrics.overdue_invoices)} overdue</span>}
                </div>
              </Link>
              <Link to="/bills" className="rounded-lg bg-orange-50 border border-orange-100 p-3 hover:border-orange-300 transition">
                <div className="text-[10px] uppercase tracking-wider text-orange-700 font-semibold flex items-center gap-1">
                  <ReceiptIcon size={11} /> Outstanding A/P
                </div>
                <div className="font-mono-num font-semibold text-orange-700 text-lg mt-0.5">{fmtMoney(metrics.outstanding_bills)}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  {metrics.bill_count} open bill{metrics.bill_count === 1 ? "" : "s"}
                  {metrics.overdue_bills > 0 && <span className="text-red-600"> · {fmtMoney(metrics.overdue_bills)} overdue</span>}
                </div>
              </Link>
              <Link to="/accounting/transactions" className="rounded-lg bg-slate-50 border border-slate-200 p-3 hover:border-slate-400 transition">
                <div className="text-[10px] uppercase tracking-wider text-slate-700 font-semibold flex items-center gap-1">
                  <Activity size={11} /> Cash activity · 30d
                </div>
                <div className={`font-mono-num font-semibold text-lg mt-0.5 ${metrics.net_cash_30d >= 0 ? "text-emerald-700" : "text-orange-700"}`}>
                  {metrics.net_cash_30d >= 0 ? "+" : ""}{fmtMoney(metrics.net_cash_30d)}
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  {fmtMoney(metrics.cash_in_30d)} in · {fmtMoney(metrics.cash_out_30d)} out · {metrics.activity_count_30d} txns
                </div>
              </Link>
            </div>
          )}
        </div>

        <div className="rounded-xl border bg-white p-5 flex flex-col max-h-[420px]">
          <div className="flex items-center gap-2 mb-3 shrink-0">
            <Bot size={16} className="text-slate-500" />
            <h2 className="font-heading font-semibold">AI activity</h2>
          </div>
          <div className="space-y-2 overflow-y-auto pr-1 -mr-1 flex-1">
            {activity.map(a => {
              const Icon = kindIcon[a.type] || Sparkles;
              return (
                <div key={a.id} data-testid={TID.aiActivityCard} className="flex items-center gap-3 rounded-md border px-3 py-2">
                  <div className="w-8 h-8 rounded-md flex items-center justify-center" style={{ background: `${kindColor[a.type] || "#6366F1"}18` }}>
                    <Icon size={15} style={{ color: kindColor[a.type] || "#6366F1" }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{kindLabel[a.type] || a.type}</div>
                  </div>
                  <div className="font-mono-num font-semibold text-slate-800">{a.count}</div>
                </div>
              );
            })}
            {!activity.length && <div className="text-xs text-slate-500">No AI activity yet.</div>}
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-white p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-heading font-semibold">Next steps</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Link to="/accounting/transactions?filter=review" className="rounded-md border p-3 hover:border-slate-400 transition">
            <div className="text-sm font-medium">Review flagged transactions</div>
            <div className="text-xs text-slate-500">The AI needs your call on {totals?.flagged || 0} items.</div>
          </Link>
          <Link to="/accounting/rules" className="rounded-md border p-3 hover:border-slate-400 transition">
            <div className="text-sm font-medium">Turn approvals into rules</div>
            <div className="text-xs text-slate-500">Automate categorization for repeat merchants.</div>
          </Link>
          <Link to="/reports" className="rounded-md border p-3 hover:border-slate-400 transition">
            <div className="text-sm font-medium">Download month-end reports</div>
            <div className="text-xs text-slate-500">PDF-ready CPA statements — one click.</div>
          </Link>
        </div>
      </div>
    </div>
  );
}

function AttentionTile({ attention }) {
  if (!attention) return null;
  const {
    flagged_count: flagged = 0,
    suggested_rules_count: rules = 0,
    overdue_invoices_count: ovInv = 0,
    overdue_bills_count: ovBill = 0,
    unreconciled_accounts_count: unrecon = 0,
    unreconciled_accounts = [],
    staleness_days = 45,
  } = attention;

  const total = flagged + rules + ovInv + ovBill + unrecon;
  // Priority for the single "rainbow shimmer" card. Order matters — only the
  // FIRST bucket in this list that has count > 0 lights up so the user's eye
  // lands on the most urgent action first. Order: overdue bills → overdue
  // invoices → flagged → suggested rules → unreconciled.
  const priorityKey =
    ovBill  > 0 ? "ovBill"  :
    ovInv   > 0 ? "ovInv"   :
    flagged > 0 ? "flagged" :
    rules   > 0 ? "rules"   :
    unrecon > 0 ? "unrecon" : null;
  if (total === 0) {
    return (
      <div
        className="rounded-xl border bg-emerald-50/60 border-emerald-200 p-4 flex items-center gap-3"
        data-testid="attention-tile-empty"
      >
        <FileCheck2 size={18} className="text-emerald-600" />
        <div className="text-sm text-emerald-900">
          <b>All clear.</b> No transactions to review, no pending rule suggestions,
          and every bank account was reconciled within the last {staleness_days} days.
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-white overflow-hidden" data-testid="attention-tile">
      <div className="px-5 py-3 border-b bg-amber-50/60 flex items-center gap-2">
        <BellRing size={16} className="text-amber-700" />
        <h2 className="font-heading font-semibold text-sm">Needs your attention</h2>
        <span className="text-[11px] text-amber-800 bg-amber-100 px-1.5 py-0.5 rounded-full ml-1">
          {total} item{total === 1 ? "" : "s"}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 divide-y sm:divide-y-0 lg:divide-x">
        <AttentionCard
          testid="attention-flagged"
          to="/accounting/transactions?filter=review&auto=1"
          icon={AlertTriangle}
          tone={flagged > 0 ? "amber" : "muted"}
          count={flagged}
          label="Flagged for review"
          hint="AI wants your call before posting"
          highlight={priorityKey === "flagged"}
        />
        <AttentionCard
          testid="attention-rules"
          to="/accounting/rules"
          icon={Wand2}
          tone={rules > 0 ? "indigo" : "muted"}
          count={rules}
          label="Suggested rules"
          hint={rules > 0 ? "1-click accept to auto-categorize repeats" : "None pending"}
          highlight={priorityKey === "rules"}
        />
        <AttentionCard
          testid="attention-overdue-invoices"
          to="/invoices?filter=overdue"
          icon={FileWarning}
          tone={ovInv > 0 ? "rose" : "muted"}
          count={ovInv}
          label="Overdue invoices"
          hint={ovInv > 0 ? "Past-due customer invoices" : "All paid or current"}
          highlight={priorityKey === "ovInv"}
        />
        <AttentionCard
          testid="attention-overdue-bills"
          to="/bills?filter=overdue"
          icon={ReceiptText}
          tone={ovBill > 0 ? "rose" : "muted"}
          count={ovBill}
          label="Overdue bills"
          hint={ovBill > 0 ? "Past-due vendor bills" : "All paid or current"}
          highlight={priorityKey === "ovBill"}
        />
        <AttentionCard
          testid="attention-reconcile"
          to="/accounting/reconciliation"
          icon={ScrollText}
          tone={unrecon > 0 ? "rose" : "muted"}
          count={unrecon}
          label="Unreconciled"
          hint={
            unrecon > 0
              ? unreconciled_accounts.slice(0, 2)
                  .map(a => `${a.code} ${a.name}`).join(", ")
                  + (unreconciled_accounts.length > 2
                      ? ` +${unreconciled_accounts.length - 2} more` : "")
              : `Reconciled within ${staleness_days} days`
          }
          highlight={priorityKey === "unrecon"}
        />
      </div>
    </div>
  );
}

const TONE_CLS = {
  amber:  { bg: "hover:bg-amber-50",  fg: "text-amber-700",  ring: "bg-amber-100" },
  indigo: { bg: "hover:bg-indigo-50", fg: "text-indigo-700", ring: "bg-indigo-100" },
  rose:   { bg: "hover:bg-rose-50",   fg: "text-rose-700",   ring: "bg-rose-100" },
  muted:  { bg: "hover:bg-slate-50",  fg: "text-slate-500",  ring: "bg-slate-100" },
};

function AttentionCard({ testid, to, icon: Icon, tone, count, label, hint, highlight }) {
  const t = TONE_CLS[tone] || TONE_CLS.muted;
  // When highlight === true we swap the default divider styling for a
  // 3px rainbow border + shimmer (see .attention-rainbow in index.css).
  // Adding relative + z-10 pulls the card above the sibling dividers so
  // the border isn't clipped by the parent's `divide-x` rule.
  return (
    <Link
      to={to}
      data-testid={testid}
      className={`px-5 py-4 flex items-start gap-3 transition ${t.bg} ${
        highlight ? "attention-rainbow relative z-10" : ""
      }`}
    >
      <div className={`w-9 h-9 rounded-full flex items-center justify-center ${t.ring}`}>
        <Icon size={16} className={t.fg} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className={`text-2xl font-bold tabular-nums ${count > 0 ? "text-slate-900" : "text-slate-400"}`}>
            {count}
          </span>
          <span className="text-sm font-medium text-slate-700">{label}</span>
        </div>
        <div className="text-xs text-slate-500 mt-0.5 truncate" title={hint}>{hint}</div>
      </div>
      <ArrowRight size={14} className="text-slate-400 mt-2 flex-shrink-0" />
    </Link>
  );
}



// -------- Timeframe picker (arrows + mode dropdown) ------------------
// Lightweight header control for the Income Snapshot section. Purely
// presentational — it just fires callbacks the parent uses to update state
// and re-fetch the report.
function TimeframePicker({ mode, anchor, onModeChange, onShift, onReset }) {
  const isYTD = mode === "ytd";
  return (
    <div
      className="flex items-center gap-1 rounded-lg border bg-slate-50 p-1"
      data-testid="dashboard-timeframe"
    >
      <button
        type="button"
        onClick={() => onShift(-1)}
        disabled={isYTD}
        className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-white disabled:opacity-30 disabled:cursor-not-allowed transition"
        aria-label="Previous period"
        title="Previous"
        data-testid="dashboard-timeframe-prev"
      >
        <ChevronLeft size={14} className="text-slate-600" />
      </button>
      <select
        value={mode}
        onChange={(e) => onModeChange(e.target.value)}
        className="h-7 px-2 text-xs bg-transparent focus:outline-none cursor-pointer font-medium text-slate-700"
        data-testid="dashboard-timeframe-mode"
      >
        <option value="ytd">Year to date</option>
        <option value="month">By month</option>
        <option value="year">By year</option>
      </select>
      <button
        type="button"
        onClick={() => onShift(1)}
        disabled={isYTD}
        className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-white disabled:opacity-30 disabled:cursor-not-allowed transition"
        aria-label="Next period"
        title="Next"
        data-testid="dashboard-timeframe-next"
      >
        <ChevronRight size={14} className="text-slate-600" />
      </button>
      {!isYTD && anchor !== monthAnchor(0) && (
        <button
          type="button"
          onClick={onReset}
          className="h-7 px-2 text-[11px] text-slate-500 hover:text-slate-900 hover:bg-white rounded-md transition"
          title="Jump to current period"
          data-testid="dashboard-timeframe-reset"
        >
          Today
        </button>
      )}
    </div>
  );
}


// Onboarding not done → show the "let's finish onboarding" card AND fire a
// live-accountant greeting into the AI panel. If the user replies "yes" /
// "ok" / "sure" / "let's go" in the chat, we navigate them straight into
// /onboarding. Otherwise the existing manual button still works.
function OnboardingNudge({ company }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const greetedRef = useRef(new Set());
  useEffect(() => {
    if (!company?.id) return;
    if (greetedRef.current.has(company.id)) return;
    greetedRef.current.add(company.id);
    emitAction("ai-open");
    // Small delay so AiPanel has time to mount and register its
    // `onboarding-coach-greet` listener — otherwise the emit races the
    // mount and the message never lands in the chat (TTS still speaks it
    // because the speak path is invoked directly on emit).
    const firstName = (user?.name || "").split(" ")[0];
    const hello = firstName ? `Hi ${firstName} — ` : "Welcome — ";
    setTimeout(() => {
      emitAction("onboarding-coach-greet", {
        message: `${hello}**${company.name}** still needs a quick onboarding to get its books ready. Ready to knock it out? Say **yes** and I'll take you there, or click the button when you're ready.`,
      });
    }, 500);
  }, [company?.id, company?.name, user?.name]);

  // Chat-driven affirmative → navigate to /onboarding.
  useActionListener("onboarding-user-message", (payload) => {
    const t = (payload?.text || "").toLowerCase().trim();
    if (!t) return;
    if (/^(yes|yeah|yep|yup|sure|ok|okay|let'?s (?:go|do it|start)|ready|go)\b/.test(t)) {
      emitAction("onboarding-coach-greet", { message: "Great — heading to onboarding now." });
      setTimeout(() => navigate("/onboarding"), 800);
    }
  });

  return (
    <div className="max-w-2xl">
      <div className="rounded-xl border bg-white p-8">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-indigo-100 flex items-center justify-center">
            <Sparkles className="text-indigo-600" size={20} />
          </div>
          <div>
            <h1 className="font-heading text-2xl font-bold">Let's finish onboarding {company.name}</h1>
            <p className="text-slate-500 text-sm">Say <b>yes</b> in the AI panel and I'll walk you through it — or click the button to start manually.</p>
          </div>
        </div>
        <Link to="/onboarding" data-testid="start-onboarding-btn"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-slate-900 text-white text-sm">
          Start onboarding <ArrowRight size={14} />
        </Link>
      </div>
    </div>
  );
}
