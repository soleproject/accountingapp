/**
 * ResponsibilitiesChecklist — the 11-item assignment grid.
 *
 * Rendered inside:
 *   • Onboarding step 7 (initial capture)
 *   • Responsibilities modal on To Do + Client Cockpit (edit later)
 *
 * Controlled component — parent owns `assignments` + `payrollFrequency`
 * state and passes onChange callbacks. Save orchestration also lives
 * in the parent so we can drive the right endpoint from each caller.
 */
import React from "react";

const ITEMS = [
  { key: "reviewing_transactions",  label: "Reviewing Transactions" },
  { key: "paying_bills",            label: "Paying bills" },
  { key: "following_up_invoices",   label: "Following up with invoices" },
  { key: "monitoring_inventory",    label: "Monitoring Inventory" },
  { key: "issuing_payroll",         label: "Issuing Payroll", hasFrequency: true },
  { key: "budget_vs_actual",        label: "Budget vs. actual analysis" },
  { key: "reconciling_accounts",    label: "Reconciling accounts" },
  { key: "paying_sales_tax",        label: "Paying Sales tax" },
  { key: "paying_payroll_liabilities", label: "Paying Payroll liabilities" },
  { key: "estimated_tax_payments", label: "Making Estimated Tax payments" },
  { key: "eom_closing",             label: "End of Month Closing" },
];

const OPTIONS = [
  { key: "accountant", label: "Accountant" },
  { key: "client",     label: "Client" },
  { key: "both",       label: "Both" },
];

const FREQ_OPTIONS = [
  { key: "weekly",       label: "Weekly" },
  { key: "biweekly",     label: "Bi-weekly" },
  { key: "semimonthly",  label: "Semi-monthly" },
  { key: "monthly",      label: "Monthly" },
];

export default function ResponsibilitiesChecklist({
  assignments,
  payrollFrequency,
  onAssignmentChange,
  onFrequencyChange,
}) {
  const payrollAssigned = !!assignments?.issuing_payroll;

  return (
    <div className="space-y-2" data-testid="responsibilities-checklist">
      <div className="grid grid-cols-[1fr_auto] gap-2 items-center text-[10px] uppercase tracking-widest text-slate-400 font-semibold px-2 pb-1 border-b">
        <div>Item</div>
        <div className="text-right pr-1">Responsibility</div>
      </div>

      {ITEMS.map(it => {
        const value = assignments?.[it.key] || null;
        return (
          <div key={it.key} className="grid grid-cols-[1fr_auto] gap-3 items-start py-2 border-b border-slate-100" data-testid={`resp-row-${it.key}`}>
            <div className="min-w-0">
              <div className="text-sm text-slate-900 font-medium">{it.label}</div>
              {it.hasFrequency && payrollAssigned && (
                <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-600">
                  <span className="text-slate-500">Frequency:</span>
                  <select
                    value={payrollFrequency || ""}
                    onChange={(e) => onFrequencyChange(e.target.value || null)}
                    className="text-[11px] px-1.5 py-0.5 border border-slate-300 rounded bg-white focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
                    data-testid="resp-payroll-frequency"
                  >
                    <option value="">Pick one…</option>
                    {FREQ_OPTIONS.map(f => (
                      <option key={f.key} value={f.key}>{f.label}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {OPTIONS.map(o => {
                const on = value === o.key;
                return (
                  <button
                    key={o.key}
                    onClick={() => onAssignmentChange(it.key, on ? null : o.key)}
                    className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${on
                      ? "bg-slate-900 text-white border-slate-900"
                      : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"}`}
                    data-testid={`resp-${it.key}-${o.key}`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
