import { useEffect, useRef, useState } from "react";
import { api, fmtMoney } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Link } from "react-router-dom";
import {
  Sparkles, Zap, AlertTriangle, TrendingUp, Wand2, FileCheck2, Bot, ArrowRight,
  Wallet2, FileText, Receipt as ReceiptIcon, Activity,
} from "lucide-react";
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
  const [syncStatus, setSyncStatus] = useState(null);
  // Track the last-observed sync status so we can trigger a heavy refetch
  // exactly once when a background sync transitions from `syncing → idle`.
  const prevStatusRef = useRef(null);

  useEffect(() => {
    if (!currentId) return;
    let cancelled = false;

    // -------- Heavy fetch (ai/activity + reports + metrics) ------------
    // Server responses are already 15s-cached, so this is safe to call
    // fairly often, but we still gate it — see poll strategy below.
    const fetchHeavy = () => {
      api.get(`/companies/${currentId}/ai/activity`).then(r => {
        if (cancelled) return;
        setTotals(r.data.totals); setActivity(r.data.activity);
      }).catch(() => {});
      api.get(`/companies/${currentId}/reports/income-statement`)
        .then(r => { if (!cancelled) setIncome(r.data); }).catch(() => {});
      api.get(`/companies/${currentId}/dashboard/metrics`)
        .then(r => { if (!cancelled) setMetrics(r.data); }).catch(() => {});
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
  }, [currentId]);

  if (!current) return <div className="text-slate-500">Select a company to view your Dashboard.</div>;

  if (!current.onboarding_complete) {
    return (
      <div className="max-w-2xl">
        <div className="rounded-xl border bg-white p-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-indigo-100 flex items-center justify-center">
              <Sparkles className="text-indigo-600" size={20} />
            </div>
            <div>
              <h1 className="font-heading text-2xl font-bold">Let's finish onboarding {current.name}</h1>
              <p className="text-slate-500 text-sm">Our AI needs a few minutes to set up your books.</p>
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
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp size={16} className="text-slate-500" />
            <h2 className="font-heading font-semibold">Income snapshot · YTD</h2>
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

        <div className="rounded-xl border bg-white p-5">
          <div className="flex items-center gap-2 mb-3">
            <Bot size={16} className="text-slate-500" />
            <h2 className="font-heading font-semibold">AI activity</h2>
          </div>
          <div className="space-y-2">
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
