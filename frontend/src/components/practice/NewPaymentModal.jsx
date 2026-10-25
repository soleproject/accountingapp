import { useNavigate } from "react-router-dom";
import { Plus, X, LogOut, Landmark, CreditCard } from "lucide-react";

const Tile = ({ icon: Icon, label, onClick, testId }) => (
  <button type="button" onClick={onClick} data-testid={testId}
          className="h-20 w-40 rounded-lg border border-slate-300 bg-white shadow-sm flex flex-col items-center justify-center gap-1.5 text-sm text-slate-700 hover:border-[#1E88E5] hover:text-[#1E88E5]">
    <Icon size={24} className="text-slate-600" />{label}
  </button>
);

export const NewPaymentModal = ({ invoice, onClose }) => {
  const nav = useNavigate();
  const q = `?contact=${invoice.contact_id}&matter=${invoice.matter_ids?.[0] || ""}&invoice=${invoice.id}`;
  const go = (to) => { onClose(); nav(to); };
  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-start justify-center overflow-y-auto py-10 px-4" data-testid="practice-new-payment-modal">
      <div className="w-full max-w-2xl rounded bg-white shadow-2xl">
        <div className="h-10 bg-[#1E88E5] rounded-t flex items-center justify-between px-4 text-white text-sm">
          <span className="inline-flex items-center gap-1 font-semibold"><Plus size={14} /> New Payment</span>
          <button type="button" onClick={onClose} data-testid="practice-new-payment-close"><X size={16} /></button>
        </div>
        <div className="bg-slate-50 px-6 py-8 space-y-6 text-center">
          <div className="flex justify-center gap-4">
            <Tile icon={LogOut} label="Withdrawal" onClick={() => go(`/practice/checks/new${q}`)} testId="practice-pay-withdrawal" />
            <Tile icon={Landmark} label="Payment Plan" onClick={() => go("/practice/settings?section=accept-online-payments")} testId="practice-pay-plan" />
          </div>
          <div className="text-lg font-bold uppercase tracking-wide text-slate-800">Payment Options:</div>
          <div className="flex justify-center gap-4">
            <Tile icon={CreditCard} label="Charge a Card" onClick={() => go("/practice/settings?section=accept-online-payments")} testId="practice-pay-card" />
            <Tile icon={Plus} label="Add a Payment" onClick={() => go(`/practice/payments/new${q}`)} testId="practice-pay-add" />
          </div>
        </div>
      </div>
    </div>
  );
};
