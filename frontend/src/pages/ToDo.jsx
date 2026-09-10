/**
 * To Do — the client-facing view of monthly responsibilities.
 *
 * Sibling of the Overview page under the Accounting product. Shows
 * every item where responsibility was assigned to `client` or `both`
 * at onboarding (or via the Responsibilities modal). Perpetual items
 * flow forward with live counts; month-scoped items filter per-period
 * when the month switcher moves.
 */
import React from "react";
import { useCompany } from "@/lib/company";
import ResponsibilitiesPanel from "@/components/ResponsibilitiesPanel";
import { Users } from "lucide-react";

export default function ToDo() {
  const { currentId, current } = useCompany();

  if (!currentId) {
    return (
      <div className="p-8 max-w-3xl mx-auto text-center" data-testid="todo-empty-no-company">
        <Users size={40} className="text-slate-300 mx-auto mb-3" />
        <div className="font-semibold text-slate-800">Pick a company first</div>
        <div className="text-sm text-slate-500 mt-1">Use the switcher up top to open a client.</div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4" data-testid="todo-page">
      <div>
        <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">
          Accounting · To Do
        </div>
        <div className="text-2xl font-bold text-slate-900">
          Your monthly items for {current?.name}
        </div>
        <p className="text-sm text-slate-500 mt-1">
          Everything on this page was assigned to you (or shared) at onboarding.
          Perpetual items (bills, invoices) stay live until cleared. Month-scoped
          items (recon, closing) reset each month — use the arrows to check what's
          still open from previous months.
        </p>
      </div>

      <div className="rounded-xl border bg-white p-4">
        <ResponsibilitiesPanel
          companyId={currentId}
          scope="client"
          emptyStateHint="No items assigned to you yet."
          returnLabel="Back to To Do"
          returnPath="/accounting/todo"
        />
      </div>
    </div>
  );
}
