import { Link } from "react-router-dom";
import { TID } from "@/constants/testIds";
import { FileText, Scale, TrendingUp, Notebook, Percent, DollarSign, ClipboardList, Receipt, Package, BarChart3 } from "lucide-react";

const REPORTS = [
  { key: "trial-balance", title: "Trial Balance", desc: "Verify debits = credits across all accounts", icon: Scale, color: "#6366F1", tint: "#E0E7FF" },
  { key: "balance-sheet", title: "Balance Sheet", desc: "Assets = Liabilities + Equity at a point in time", icon: ClipboardList, color: "#3B82F6", tint: "#DBEAFE" },
  { key: "income-statement", title: "Income Statement", desc: "Revenue, expenses, and net income for a period", icon: TrendingUp, color: "#10B981", tint: "#D1FAE5" },
  { key: "general-ledger", title: "General Ledger", desc: "Drill into entries by account and date range", icon: Notebook, color: "#6366F1", tint: "#E0E7FF" },
  { key: "cash-flow", title: "Cash Flow", desc: "Operating, investing, and financing cash movements", icon: DollarSign, color: "#10B981", tint: "#D1FAE5" },
  { key: "sales-tax", title: "Sales Tax Liability", desc: "Sales tax collected vs. remitted and what you owe", icon: Percent, color: "#F97316", tint: "#FFEDD5" },
  { key: "1099-summary", title: "1099 Summary", desc: "Contractors paid ≥ $600 · W-9 status · 1099-NEC prep", icon: Receipt, color: "#3B82F6", tint: "#DBEAFE" },
];

// Sales reports live on their own page (/sales-reports) so they can offer
// interactive item + category tabs with share bars. Linked from here for
// discoverability.
const SALES = { key: "sales", title: "Sales Reports", desc: "Revenue by item or by income category with share breakdown", icon: BarChart3, color: "#8B5CF6", tint: "#EDE9FE", to: "/sales-reports" };
const PURCHASES = { key: "purchases", title: "Purchases Reports", desc: "Spend by item or by expense category — where the money's going", icon: BarChart3, color: "#F43F5E", tint: "#FFE4E6", to: "/sales-reports?mode=purchases" };
const INVENTORY = { key: "inventory", title: "Inventory Valuation", desc: "Current QOH · avg cost · total value + movement history", icon: Package, color: "#0EA5E9", tint: "#E0F2FE", to: "/inventory-management" };

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
        <Link to={SALES.to}
              data-testid={`${TID.reportTile}-${SALES.key}`}
              className="group rounded-xl border bg-white p-5 hover:border-slate-400 transition">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-md flex items-center justify-center" style={{ background: SALES.tint }}>
              <SALES.icon size={18} style={{ color: SALES.color }} />
            </div>
            <div>
              <div className="font-heading font-semibold text-slate-900">{SALES.title}</div>
              <div className="text-xs text-slate-500 mt-0.5">{SALES.desc}</div>
            </div>
          </div>
        </Link>
        <Link to={PURCHASES.to}
              data-testid={`${TID.reportTile}-${PURCHASES.key}`}
              className="group rounded-xl border bg-white p-5 hover:border-slate-400 transition">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-md flex items-center justify-center" style={{ background: PURCHASES.tint }}>
              <PURCHASES.icon size={18} style={{ color: PURCHASES.color }} />
            </div>
            <div>
              <div className="font-heading font-semibold text-slate-900">{PURCHASES.title}</div>
              <div className="text-xs text-slate-500 mt-0.5">{PURCHASES.desc}</div>
            </div>
          </div>
        </Link>
        <Link to={INVENTORY.to}
              data-testid={`${TID.reportTile}-${INVENTORY.key}`}
              className="group rounded-xl border bg-white p-5 hover:border-slate-400 transition">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-md flex items-center justify-center" style={{ background: INVENTORY.tint }}>
              <INVENTORY.icon size={18} style={{ color: INVENTORY.color }} />
            </div>
            <div>
              <div className="font-heading font-semibold text-slate-900">{INVENTORY.title}</div>
              <div className="text-xs text-slate-500 mt-0.5">{INVENTORY.desc}</div>
            </div>
          </div>
        </Link>
      </div>
    </div>
  );
}
