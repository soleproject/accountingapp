import { Link } from "react-router-dom";
import { TID } from "@/constants/testIds";
import { FileText, Scale, TrendingUp, Notebook, Percent, DollarSign, ClipboardList, Receipt } from "lucide-react";

const REPORTS = [
  { key: "trial-balance", title: "Trial Balance", desc: "Verify debits = credits across all accounts", icon: Scale, color: "#8B5CF6", tint: "#F3E8FF" },
  { key: "balance-sheet", title: "Balance Sheet", desc: "Assets = Liabilities + Equity at a point in time", icon: ClipboardList, color: "#3B82F6", tint: "#DBEAFE" },
  { key: "income-statement", title: "Income Statement", desc: "Revenue, expenses, and net income for a period", icon: TrendingUp, color: "#10B981", tint: "#D1FAE5" },
  { key: "general-ledger", title: "General Ledger", desc: "Drill into entries by account and date range", icon: Notebook, color: "#6366F1", tint: "#E0E7FF" },
  { key: "cash-flow", title: "Cash Flow", desc: "Operating, investing, and financing cash movements", icon: DollarSign, color: "#F59E0B", tint: "#FEF3C7" },
  { key: "sales-tax", title: "Sales Tax Liability", desc: "Sales tax collected vs. remitted and what you owe", icon: Percent, color: "#F97316", tint: "#FFEDD5" },
  { key: "1099-summary", title: "1099 Summary", desc: "Contractors paid ≥ $600 · W-9 status · 1099-NEC prep", icon: Receipt, color: "#EF4444", tint: "#FEE2E2" },
];

export default function Reports() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-3xl font-bold tracking-tight">Reports</h1>
        <p className="text-slate-500 text-sm mt-1">Financial statements and analyses · Accrual or Cash basis · PDF-ready</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {REPORTS.map(r => {
          const Icon = r.icon;
          return (
            <Link key={r.key} to={`/reports/${r.key}`}
                  data-testid={`${TID.reportTile}-${r.key}`}
                  className="group rounded-xl border bg-white p-5 hover:border-slate-400 transition">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-md flex items-center justify-center" style={{ background: r.tint }}>
                  <Icon size={18} style={{ color: r.color }} />
                </div>
                <div>
                  <div className="font-heading font-semibold text-slate-900">{r.title}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{r.desc}</div>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
