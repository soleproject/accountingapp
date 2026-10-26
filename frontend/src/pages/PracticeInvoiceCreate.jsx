import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Plus, FileText, LogIn, Landmark, ChevronDown, ChevronUp } from "lucide-react";
import { api } from "@/lib/api";
import { PracticeShell } from "@/components/practice/PracticeShell";

const Tile = ({ icon: Icon, label, primary, onClick, testId }) => (
  <button type="button" onClick={onClick} data-testid={testId}
          className={`h-20 w-40 rounded-xl border flex flex-col items-center justify-center gap-1.5 text-sm font-semibold transition-colors ${primary ? "bg-[#43A047] border-[#43A047] text-white hover:bg-[#388E3C]" : "bg-white border-slate-300 text-slate-700 hover:border-[#1E88E5]"}`}>
    <Icon size={24} strokeWidth={1.6} />{label}
  </button>
);

export default function PracticeInvoiceCreate() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const one = async () => {
    setBusy(true);
    try { const r = await api.post("/practice/invoices/blank", { contact_id: params.get("contact") || "", matter_id: params.get("matter") || "" }); nav(`/practice/invoices/${r.data.id}/new`); }
    catch { toast.error("Could not start invoice"); setBusy(false); }
  };
  return (
    <PracticeShell withRail={false}>
      <div className="space-y-4" data-testid="practice-invoice-create">
        <div className="flex items-center gap-3"><Plus size={28} className="text-slate-500" /><h1 className="text-3xl font-bold text-slate-800">New Invoice</h1></div>
        <section className="rounded border border-slate-200 bg-white py-8 flex flex-col items-center gap-4">
          <div className="flex items-center gap-3">
            <Tile icon={FileText} label="One Invoice" primary onClick={busy ? undefined : one} testId="practice-invoice-create-one" />
            <Tile icon={LogIn} label="Multiple Invoices" onClick={() => toast.info("Multiple Invoices is coming soon.")} testId="practice-invoice-create-multiple" />
            <Tile icon={Landmark} label="Payment Plan" onClick={() => nav("/practice/settings?section=accept-online-payments")} testId="practice-invoice-create-plan" />
          </div>
          <button type="button" onClick={() => setMore(v => !v)} className="inline-flex items-center gap-1 text-sm text-[#1E88E5] underline" data-testid="practice-invoice-create-more">More Options {more ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>
          {more && (
            <div className="flex items-center gap-3" data-testid="practice-invoice-create-more-options">
              <Tile icon={FileText} label="Trust Request" onClick={() => toast.info("Trust Request is coming soon.")} testId="practice-invoice-create-trust" />
              <Tile icon={FileText} label="Recurring Invoice" onClick={() => toast.info("Recurring Invoice is coming soon.")} testId="practice-invoice-create-recurring" />
            </div>
          )}
        </section>
      </div>
    </PracticeShell>
  );
}
