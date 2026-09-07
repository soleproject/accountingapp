import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { TID } from "@/constants/testIds";
import {
  FileText, Scale, TrendingUp, Notebook, Percent, DollarSign,
  ClipboardList, Receipt, Package, BarChart3, LineChart, Users, Wallet, Search, X,
} from "lucide-react";
import { useCompany } from "@/lib/company";

/**
 * Every report tile is defined in a single array so:
 *   • the search filter is trivial (`title`/`desc`/`keywords` match)
 *   • adding a new report is a one-line change
 *   • gated reports (projects / budgets) can be excluded with a
 *     predicate rather than a bespoke JSX branch.
 *
 * `to` overrides the default `/reports/{key}` path — used when the
 * report lives at a bespoke route (aging, sales pivots, etc.).
 */
const REPORTS = [
  // Standard financial statements — QBO parity.
  { key: "trial-balance",   title: "Trial Balance",     desc: "Verify debits = credits across all accounts",           icon: Scale,          color: "#6366F1", tint: "#E0E7FF", keywords: "gl ledger debit credit" },
  { key: "balance-sheet",   title: "Balance Sheet",     desc: "Assets = Liabilities + Equity at a point in time",      icon: ClipboardList,  color: "#3B82F6", tint: "#DBEAFE", keywords: "assets liabilities equity" },
  { key: "income-statement", title: "Income Statement", desc: "Revenue, expenses, and net income for a period",        icon: TrendingUp,     color: "#10B981", tint: "#D1FAE5", keywords: "profit loss p&l pnl revenue expense" },
  { key: "general-ledger",  title: "General Ledger",    desc: "Drill into entries by account and date range",          icon: Notebook,       color: "#6366F1", tint: "#E0E7FF", keywords: "gl transactions detail" },
  { key: "cash-flow",       title: "Cash Flow",         desc: "Operating, investing, and financing cash movements",    icon: DollarSign,     color: "#10B981", tint: "#D1FAE5", keywords: "cashflow statement" },

  // A/R & A/P — dedicated standalone report pages.
  { key: "ar-aging",        title: "A/R Aging",         desc: "Outstanding customer invoices bucketed by days past due", icon: Users,        color: "#0891B2", tint: "#CFFAFE", keywords: "receivables collections overdue past due", to: "/reports/ar-aging" },
  { key: "ap-aging",        title: "A/P Aging · Bills to Pay", desc: "Outstanding vendor bills — plan cash outflow by bucket", icon: Wallet, color: "#DC2626", tint: "#FEE2E2", keywords: "payables bills unpaid overdue", to: "/reports/ap-aging" },

  // Tax + compliance.
  { key: "sales-tax",       title: "Sales Tax Liability", desc: "Sales tax collected vs. remitted and what you owe",    icon: Percent,        color: "#F97316", tint: "#FFEDD5", keywords: "sales tax remit gst vat" },
  { key: "sales-tax-report", title: "Sales Tax Report",   desc: "Taxable vs. non-taxable sales · weekly, monthly, quarterly, annually", icon: Percent, color: "#EA580C", tint: "#FFEDD5", keywords: "sales tax taxable nontaxable exempt period", to: "/reports/sales-tax-report" },
  { key: "1099-summary",    title: "1099 Summary",      desc: "Contractors paid ≥ $600 · W-9 status · 1099-NEC prep",  icon: Receipt,        color: "#3B82F6", tint: "#DBEAFE", keywords: "contractor 1099 nec w9 tax" },

  // Product / analysis tabs (own routes).
  { key: "sales",           title: "Sales Reports",     desc: "Revenue by item or by income category with share breakdown", icon: BarChart3, color: "#8B5CF6", tint: "#EDE9FE", keywords: "sales revenue item category", to: "/sales-reports" },
  { key: "purchases",       title: "Purchases Reports", desc: "Spend by item or by expense category — where the money's going", icon: BarChart3, color: "#F43F5E", tint: "#FFE4E6", keywords: "purchases spend expense vendor", to: "/sales-reports?mode=purchases" },
  { key: "inventory",       title: "Inventory Valuation", desc: "Current QOH · avg cost · total value + movement history", icon: Package, color: "#0EA5E9", tint: "#E0F2FE", keywords: "inventory stock qoh cogs valuation", to: "/inventory-management" },
];

// Feature-gated reports appended when the company enables the product.
const GATED = [
  { key: "estimates-vs-actuals", title: "Estimates vs Actuals", desc: "Commitment · paid · remaining per project · net cash position", icon: LineChart, color: "#0891B2", tint: "#CFFAFE", keywords: "project job eva estimate actual", to: "/reports/estimates-vs-actuals", requires: "projectsEnabled" },
  { key: "budget-vs-actuals",    title: "Budget vs Actuals",    desc: "Monthly variance per P&L account · positive is always good",    icon: BarChart3, color: "#7C3AED", tint: "#EDE9FE", keywords: "budget variance forecast bva",              to: "/reports/budget-vs-actuals",    requires: "budgetsEnabled" },
];

export default function Reports() {
  const flags = useCompany();
  const [q, setQ] = useState("");

  const visible = useMemo(() => {
    const all = [
      ...REPORTS,
      ...GATED.filter(g => flags[g.requires]),
    ];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(r => {
      const hay = `${r.title} ${r.desc} ${r.keywords || ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [q, flags]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-3xl font-bold tracking-tight">Reports</h1>
        <p className="text-slate-500 text-sm mt-1">Financial statements and analyses · Accrual or Cash basis · PDF-ready</p>
      </div>

      {/* Search — filter the tile list live. */}
      <div className="relative max-w-md">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search reports — try “aging”, “tax”, “budget”…"
          className="w-full pl-8 pr-8 py-2 rounded-md border bg-white text-sm placeholder:text-slate-400 focus:border-slate-500 focus:ring-1 focus:ring-slate-500 outline-none"
          data-testid="reports-search"
        />
        {q && (
          <button
            onClick={() => setQ("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            data-testid="reports-search-clear"
            aria-label="Clear search"
          ><X size={14} /></button>
        )}
      </div>

      {visible.length === 0 && (
        <div className="rounded-xl border bg-white p-8 text-center text-slate-500 text-sm">
          No reports match “<b>{q}</b>”. Try a broader term.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {visible.map(r => {
          const Icon = r.icon;
          const href = r.to || `/reports/${r.key}`;
          return (
            <Link
              key={r.key}
              to={href}
              data-testid={`${TID.reportTile}-${r.key}`}
              className="group rounded-xl border bg-white p-5 hover:border-slate-400 transition"
            >
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
