import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, X, LogOut, Landmark, CreditCard, FileText, LogIn, ChevronLeft, ChevronRight, Mail } from "lucide-react";
import { api } from "@/lib/api";
import { ContactPicker } from "@/components/practice/ContactPicker";
import { MatterPicker } from "@/components/practice/MatterPicker";

const Tile = ({ icon: Icon, label, onClick, active, title, testId }) => (
  <button type="button" onClick={onClick} title={title} data-testid={testId}
          className={`h-20 w-40 rounded-lg border shadow-sm flex flex-col items-center justify-center gap-1.5 text-sm ${active ? "bg-[#1E88E5] border-[#1E88E5] text-white" : "border-slate-300 bg-white text-slate-700 hover:border-[#1E88E5] hover:text-[#1E88E5]"}`}>
    <Icon size={24} className={active ? "text-white" : "text-slate-600"} />{label}
  </button>
);

export const NewPaymentModal = ({ invoice, onClose }) => {
  const nav = useNavigate();
  const [contacts, setContacts] = useState([]);
  const [matters, setMatters] = useState([]);
  const [link, setLink] = useState({ contact_id: invoice?.contact_id || "", matter_id: invoice?.matter_ids?.[0] || "" });
  const [step, setStep] = useState(invoice ? 2 : 1);
  const [mode, setMode] = useState(invoice ? "invoice" : "");
  const payInvoice = mode === "invoice", retainer = mode === "retainer";
  const toggle = (m) => setMode(v => (v === m ? "" : m));
  useEffect(() => {
    if (invoice) return;
    api.get("/practice/contacts", { params: { status: "All" } }).then(r => setContacts(r.data)).catch(() => {});
    api.get("/practice/matters", { params: { status: "All" } }).then(r => setMatters(r.data)).catch(() => {});
  }, [invoice]);
  const q = `?contact=${link.contact_id}&matter=${link.matter_id || ""}${invoice ? `&invoice=${invoice.id}` : ""}`;
  const go = (to) => { onClose(); nav(to); };
  const settings = "/practice/settings?section=accept-online-payments";
  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-start justify-center overflow-y-auto py-10 px-4" data-testid="practice-new-payment-modal">
      <div className="w-full max-w-2xl rounded bg-white shadow-2xl">
        <div className="h-10 bg-[#1E88E5] rounded-t flex items-center justify-between px-4 text-white text-sm">
          <span className="inline-flex items-center gap-1 font-semibold"><Plus size={14} /> New Payment</span>
          <button type="button" onClick={onClose} data-testid="practice-new-payment-close"><X size={16} /></button>
        </div>
        {step === 1 ? (
          <div className="bg-slate-50 px-4 py-4 space-y-4">
            <section className="rounded border border-slate-200 bg-white px-6 py-5">
              <h3 className="text-lg font-bold uppercase tracking-wide text-slate-800 mb-3">Linked To</h3>
              <div className="grid grid-cols-[200px_1fr] gap-y-3 items-center">
                <div className="text-[13px] font-semibold uppercase tracking-wide text-slate-800">Contact <span className="text-red-500">*</span></div>
                <ContactPicker value={link.contact_id} onChange={(id) => setLink({ contact_id: id, matter_id: "" })} contacts={contacts} onCreated={(c) => setContacts(l => [c, ...l])} testId="practice-np-contact" />
                <div className="text-[13px] font-semibold uppercase tracking-wide text-slate-800">Matter</div>
                <MatterPicker value={link.matter_id} onChange={(id) => setLink(l => ({ ...l, matter_id: id }))} matters={matters} contactId={link.contact_id} contacts={contacts} onCreated={(m) => setMatters(l => [m, ...l])} onContactChange={(id) => setLink(l => ({ ...l, contact_id: id }))} testId="practice-np-matter" />
              </div>
            </section>
            <div className="flex justify-end"><button type="button" disabled={!link.contact_id} onClick={() => setStep(2)} className="inline-flex items-center gap-1 rounded-full bg-[#43A047] px-5 py-2 text-sm font-semibold text-white disabled:opacity-50" data-testid="practice-np-next">Next <ChevronRight size={14} /></button></div>
          </div>
        ) : (
          <div className="bg-slate-50 px-6 py-6 space-y-6">
            <div className="grid grid-cols-2 gap-3 w-fit mx-auto">
              <Tile icon={FileText} label="Pay an Invoice" title="Pay an outstanding invoice." active={payInvoice} onClick={() => toggle("invoice")} testId="practice-pay-invoice" />
              <Tile icon={LogIn} label="Add a Retainer" title="Add money into your trust or operating account." active={retainer} onClick={() => toggle("retainer")} testId="practice-pay-retainer" />
              <Tile icon={LogOut} label="Withdrawal" onClick={() => go(`/practice/checks/new${q}`)} testId="practice-pay-withdrawal" />
              <Tile icon={Landmark} label="Payment Plan" onClick={() => go(settings)} testId="practice-pay-plan" />
            </div>
            {payInvoice && (
              <div className="text-center space-y-4" data-testid="practice-pay-options">
                <div className="text-lg font-bold uppercase tracking-wide text-slate-800">Payment Options:</div>
                <div className="flex justify-center gap-3">
                  <Tile icon={CreditCard} label="Charge a Card" onClick={() => go(settings)} testId="practice-pay-card" />
                  <Tile icon={Plus} label="Add a Payment" onClick={() => go(`/practice/payments/new${q}`)} testId="practice-pay-add" />
                </div>
              </div>
            )}
            {retainer && (
              <div className="text-center space-y-4" data-testid="practice-retainer-options">
                <div className="text-lg font-bold uppercase tracking-wide text-slate-800">Retainer Options:</div>
                <div className="flex justify-center gap-3">
                  <Tile icon={CreditCard} label="Charge a Card" onClick={() => go(settings)} testId="practice-retainer-card" />
                  <Tile icon={Mail} label="Request Payment" onClick={() => go(settings)} testId="practice-retainer-request" />
                  <Tile icon={Plus} label="Add a Payment" onClick={() => go(`/practice/payments/retainer${q}`)} testId="practice-retainer-add" />
                </div>
              </div>
            )}
            {!invoice && <button type="button" onClick={() => setStep(1)} className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-700" data-testid="practice-np-back"><ChevronLeft size={14} /> Back</button>}
          </div>
        )}
      </div>
    </div>
  );
};
