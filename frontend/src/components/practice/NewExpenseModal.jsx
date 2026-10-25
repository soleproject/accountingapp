import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, X, Check, Move, Paperclip, ChevronDown } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ContactPicker } from "@/components/practice/ContactPicker";
import { MatterPicker } from "@/components/practice/MatterPicker";
import { SearchSelect } from "@/components/practice/SearchSelect";
import { toISO } from "@/components/practice/DateTimePicker";
import { ExpenseCategoriesModal } from "@/components/practice/ExpenseCategoriesModal";

const inp = "w-full h-9 rounded border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-[#1E88E5] placeholder:text-slate-400";
const Row = ({ label, required, help, sub, children }) => (
  <div className="grid grid-cols-[160px_1fr] items-start gap-3 py-1.5">
    <div className="text-[12px] font-semibold uppercase tracking-wide text-slate-800 pt-2 flex items-center gap-1">
      {help && <span className="h-3.5 w-3.5 rounded-full bg-slate-400 text-white text-[9px] font-bold grid place-items-center">?</span>}{label}{sub && <span className="text-[10px] text-slate-500 normal-case">({sub})</span>}{required && <span className="text-red-500">*</span>}
    </div>
    <div>{children}</div>
  </div>
);
const Toggle = ({ value, onChange, testId }) => (
  <button type="button" onClick={() => onChange(!value)} data-testid={testId}
          className={`h-7 w-14 rounded border text-xs font-semibold flex items-center ${value ? "bg-[#1E88E5] border-[#1E88E5] text-white justify-start pl-2" : "bg-white border-slate-300 text-slate-700 justify-end pr-2"}`}>{value ? "Yes" : "No"}</button>
);
const Card = ({ title, children }) => <section className="rounded border border-slate-200 bg-white px-5 py-4">{title && <h3 className="text-base font-bold uppercase tracking-wide text-slate-800 mb-2">{title}</h3>}{children}</section>;

const COST_TYPES = [
  { id: "Soft Cost", desc: "Intangible expenses for your clients (travel costs, envelopes, faxes, etc...)" },
  { id: "Hard Cost", desc: "Expenses you need to pay a third-party vendor for (court filing fees, private investigators, mediators, etc...)" },
];

function CostTypeSelect({ value, onChange }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(v => !v)} className={`${inp} flex items-center justify-between text-left`} data-testid="practice-exp-cost-type">{value} <ChevronDown size={14} className="text-slate-500" /></button>
      {open && (
        <ul className="absolute left-0 right-0 top-full z-20 mt-1 rounded border border-slate-200 bg-white shadow-xl py-1" data-testid="practice-exp-cost-type-menu">
          {COST_TYPES.map(c => (
            <li key={c.id}><button type="button" onClick={() => { onChange(c.id); setOpen(false); }} data-testid={`practice-exp-cost-type-${c.id.toLowerCase().replace(" ", "-")}`}
                                   className={`w-full px-3 py-1.5 text-left text-xs ${value === c.id ? "bg-slate-100" : "hover:bg-slate-50"}`}><span className="font-bold text-slate-800">{c.id}</span> <span className="text-slate-600">{c.desc}</span></button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const NewExpenseModal = ({ expense, onSaved, onClose }) => {
  const { user } = useAuth();
  const [contacts, setContacts] = useState([]);
  const [matters, setMatters] = useState([]);
  const [cats, setCats] = useState([]);
  const [busy, setBusy] = useState(false);
  const [manage, setManage] = useState(false);
  const [f, setF] = useState(expense ? { ...expense } : {
    contact_id: "", matter_id: "", cost_type: "Soft Cost", date: toISO(new Date()), qty: 1, price: "", description: "", category: "",
    receipt_name: "", billable: true, billed_by: user?.name || "", private_notes: "", account: "", payee: "", payment_method: "Credit / Debit Card", payment_notes: "",
  });
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e?.target ? e.target.value : e }));
  useEffect(() => {
    api.get("/practice/contacts", { params: { status: "All" } }).then(r => setContacts(r.data)).catch(() => {});
    api.get("/practice/matters", { params: { status: "All" } }).then(r => setMatters(r.data)).catch(() => {});
    api.get("/practice/expenses/categories").then(r => setCats(r.data)).catch(() => {});
  }, []);
  const total = (Number(f.qty) || 0) * (Number(f.price) || 0);
  const catOpts = cats.map(c => ({ id: c.name, label: c.code ? `${c.name} (${c.code})` : c.name }));

  const save = async () => {
    if (!f.contact_id) return toast.error("Select a contact.");
    if (!f.matter_id) return toast.error("Select a matter.");
    if (f.price === "" || Number(f.price) < 0) return toast.error("Enter a price.");
    setBusy(true);
    try {
      const body = { ...f, qty: Number(f.qty) || 1, price: Number(f.price) };
      const r = expense ? await api.put(`/practice/expenses/${expense.id}`, body) : await api.post("/practice/expenses", body);
      toast.success("Item saved successfully."); onSaved(r.data);
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not save expense"); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-start justify-center overflow-y-auto py-6 px-4" data-testid="practice-expense-modal">
      <div className="w-full max-w-xl rounded bg-white shadow-2xl">
        <div className="h-10 bg-[#1E88E5] rounded-t flex items-center justify-between px-4 text-white text-sm">
          <span className="inline-flex items-center gap-1 font-semibold"><Plus size={14} /> {expense ? "Edit Expense" : "New Expense"}</span>
          <span className="inline-flex items-center gap-3"><Move size={13} /><button type="button" onClick={onClose} data-testid="practice-expense-close"><X size={16} /></button></span>
        </div>
        <div className="p-4 bg-slate-50 space-y-3 rounded-b">
          <Card title="Linked To">
            <Row label="Contact" required><ContactPicker value={f.contact_id} onChange={(id) => setF(p => ({ ...p, contact_id: id, matter_id: "" }))} contacts={contacts} onCreated={(c) => setContacts(l => [c, ...l])} testId="practice-exp-contact" /></Row>
            <Row label="Matter" required>
              <MatterPicker value={f.matter_id} onChange={set("matter_id")} matters={matters} contactId={f.contact_id} contacts={contacts}
                            onCreated={(m) => setMatters(l => [m, ...l])} onContactChange={(id) => setF(p => ({ ...p, contact_id: id }))} testId="practice-exp-matter" />
            </Row>
          </Card>
          <Card title="Expense">
            <Row label="Cost Type" required><CostTypeSelect value={f.cost_type} onChange={set("cost_type")} /></Row>
            <Row label="Date" required><input type="date" className={inp} value={f.date} onChange={set("date")} data-testid="practice-exp-date" /></Row>
            <Row label="Qty"><input type="number" step="0.01" className={inp} value={f.qty} onChange={set("qty")} data-testid="practice-exp-qty" /></Row>
            <Row label="Price" sub="USD" required><input type="number" step="0.01" className={inp} placeholder="Enter Amount..." value={f.price} onChange={set("price")} data-testid="practice-exp-price" /></Row>
            <Row label="Total" sub="USD"><input readOnly className={`${inp} bg-slate-50`} value={total.toFixed(2)} data-testid="practice-exp-total" /></Row>
            <Row label="Description" help><textarea rows={4} className={`${inp} !h-auto py-2`} value={f.description} onChange={set("description")} data-testid="practice-exp-description" /></Row>
            <Row label="Category" help><SearchSelect value={f.category} onChange={set("category")} options={catOpts} placeholder="Select Category..." clearable newLabel="Manage Categories" onNew={() => setManage(true)} testId="practice-exp-category" /></Row>
          </Card>
          {f.cost_type === "Hard Cost" && (
            <Card title="Payment Details">
              <p className="-mt-1 mb-1 text-xs text-slate-600">Learn more about the <span className="text-[#1E88E5]">difference between paying expenses from the trust account</span> or operating account.</p>
              <Row label="Account" required help><select className={inp} value={f.account} onChange={set("account")} data-testid="practice-exp-account"><option value="">Select Account...</option><option>Operating Account</option><option>Trust Account</option></select></Row>
              <Row label="Payee" help><ContactPicker value={f.payee} onChange={set("payee")} contacts={contacts} onCreated={(c) => setContacts(l => [c, ...l])} testId="practice-exp-payee" /></Row>
              <Row label="Payment Method"><select className={inp} value={f.payment_method} onChange={set("payment_method")} data-testid="practice-exp-payment-method"><option>Credit / Debit Card</option><option>Check</option><option>Cash</option><option>Bank Transfer</option><option>Other</option></select></Row>
              <Row label="Notes"><input className={inp} placeholder="Add Notes..." value={f.payment_notes} onChange={set("payment_notes")} data-testid="practice-exp-payment-notes" /></Row>
            </Card>
          )}
          <Card>
            <Row label="Receipt" help>
              <div className="flex items-stretch gap-2">
                <input readOnly className={`${inp} flex-1`} value={f.receipt_name} placeholder="" data-testid="practice-exp-receipt-name" />
                <label className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-3 text-sm text-slate-700 cursor-pointer hover:bg-slate-50" data-testid="practice-exp-receipt-select">
                  <Paperclip size={13} /> Select File<input type="file" className="hidden" onChange={e => setF(p => ({ ...p, receipt_name: e.target.files?.[0]?.name || "" }))} />
                </label>
              </div>
            </Row>
            <Row label="Billable" help><Toggle value={f.billable} onChange={set("billable")} testId="practice-exp-billable" /></Row>
            <Row label="Billed By"><select className={inp} value={f.billed_by} onChange={set("billed_by")} data-testid="practice-exp-billed-by"><option>{user?.name}</option></select></Row>
            <Row label="Private Notes" help><input className={inp} placeholder="Add private notes..." value={f.private_notes} onChange={set("private_notes")} data-testid="practice-exp-private-notes" /></Row>
          </Card>
          <div className="flex items-center gap-2 pt-1 whitespace-nowrap">
            <button type="button" onClick={save} disabled={busy} data-testid="practice-exp-save-btn" className="inline-flex items-center gap-1.5 rounded bg-[#43A047] px-4 py-2 text-sm font-semibold text-white hover:bg-[#388E3C] disabled:opacity-60"><Check size={14} /> Save</button>
            <button type="button" onClick={onClose} data-testid="practice-exp-cancel-btn" className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"><X size={14} /> Cancel</button>
            <div className="flex-1" />
            <button type="button" className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50" data-testid="practice-exp-multiple-btn"><Plus size={14} /> Multiple Expenses</button>
          </div>
        </div>
      </div>
      {manage && <ExpenseCategoriesModal onClose={() => setManage(false)} onSaved={(c) => { setCats(c); if (f.category && !c.some(x => x.name === f.category)) setF(p => ({ ...p, category: "" })); }} />}
    </div>
  );
};
