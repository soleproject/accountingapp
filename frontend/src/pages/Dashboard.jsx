import { useEffect, useState } from "react";
import { api, fmtMoney } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Link } from "react-router-dom";
import {
  Sparkles, Zap, AlertTriangle, TrendingUp, Wand2, FileCheck2, Bot, ArrowRight,
} from "lucide-react";

const kindLabel = {
  categorize: "Transactions Categorized",
  post_je: "Journal Entries Auto-Posted",
  flag_review: "Flagged for Review",
  rule_created: "Rules Created",
  coa_generated: "CoA Accounts Suggested",
  veryfi_ocr: "Statement Lines OCR'd",
};

const kindIcon = {
  categorize: Zap, post_je: FileCheck2, flag_review: AlertTriangle,
  rule_created: Wand2, coa_generated: Sparkles, veryfi_ocr: Bot,
};

const kindColor = {
  categorize: "#6366F1", post_je: "#10B981", flag_review: "#F97316",
  rule_created: "#8B5CF6", coa_generated: "#06B6D4", veryfi_ocr: "#3B82F6",
};

export default function Dashboard() {
  const { currentId, current } = useCompany();
  const [totals, setTotals] = useState(null);
  const [activity, setActivity] = useState([]);
  const [income, setIncome] = useState(null);

  useEffect(() => {
    if (!currentId) return;
    api.get(`/companies/${currentId}/ai/activity`).then(r => {
      setTotals(r.data.totals); setActivity(r.data.activity);
    }).catch(() => {});
    api.get(`/companies/${currentId}/reports/income-statement`).then(r => setIncome(r.data)).catch(() => {});
  }, [currentId]);

  if (!current) return <div className="text-slate-500">Select a company to view your Pulse.</div>;

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
      <div>
        <h1 className="font-heading text-3xl font-bold tracking-tight">Pulse</h1>
        <p className="text-slate-500 text-sm mt-1">
          What the AI has done for {current.name} · {current.reporting_basis} basis
        </p>
      </div>

      {totals && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            ["Transactions", totals.transactions, "#6366F1"],
            ["Auto-posted", totals.posted, "#10B981"],
            ["Needs review", totals.flagged, "#F97316"],
            ["AI accuracy", `${totals.accuracy}%`, "#22C55E"],
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
