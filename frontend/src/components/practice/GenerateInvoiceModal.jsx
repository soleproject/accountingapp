import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Plus, X, Check, ChevronDown } from "lucide-react";
import { api } from "@/lib/api";
import { Toggle, GreenButton } from "@/components/practice/forms";
import { toISO } from "@/components/practice/DateTimePicker";
import { SearchSelect } from "@/components/practice/SearchSelect";

const RANGES = ["All Time", "Today", "Yesterday", "Last 7 Days", "Last 30 Days", "This Month", "Last Month", "This Year", "Last Year", "Custom Range"];

export function rangeBounds(label, custom) {
  const t = new Date(); const d = (n) => { const x = new Date(t); x.setDate(x.getDate() + n); return toISO(x); };
  const y = t.getFullYear(), m = t.getMonth();
  switch (label) {
    case "Today": return [toISO(t), toISO(t)];
    case "Yesterday": return [d(-1), d(-1)];
    case "Last 7 Days": return [d(-6), toISO(t)];
    case "Last 30 Days": return [d(-29), toISO(t)];
    case "This Month": return [toISO(new Date(y, m, 1)), toISO(new Date(y, m + 1, 0))];
    case "Last Month": return [toISO(new Date(y, m - 1, 1)), toISO(new Date(y, m, 0))];
    case "This Year": return [`${y}-01-01`, `${y}-12-31`];
    case "Last Year": return [`${y - 1}-01-01`, `${y - 1}-12-31`];
    case "Custom Range": return [custom.from || null, custom.to || null];
    default: return [null, null];
  }
}

const Label = ({ children }) => <div className="text-[13px] font-semibold uppercase tracking-wide text-slate-800 pt-1.5">{children}</div>;
const Card = ({ children, testId }) => <section className="rounded border border-slate-200 bg-white px-6 py-5" data-testid={testId}>{children}</section>;
const Collapsible = ({ title, open, onToggle, children, testId }) => (
  <section className="rounded border border-slate-200 bg-white" data-testid={testId}>
    <button type="button" onClick={onToggle} className="w-full flex items-center gap-1 px-4 py-4 text-left text-lg font-bold uppercase tracking-wide text-slate-800" data-testid={`${testId}-toggle`}>
      {title} <ChevronDown size={16} className={`transition-transform ${open ? "rotate-180" : ""}`} />
    </button>
    {open && <div className="px-4 pb-4">{children}</div>}
  </section>
);

export function RangePicker({ value, onChange, custom, setCustom, testId = "practice-range" }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-block">
      <button type="button" onClick={() => setOpen(v => !v)} data-testid={testId}
              className="h-8 rounded-full border border-slate-300 bg-white px-3 text-sm text-slate-700 inline-flex items-center gap-1">{value} <ChevronDown size={12} /></button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-20 flex rounded border border-slate-200 bg-white shadow-xl" data-testid={`${testId}-menu`}>
          <ul className="w-40 py-1">
            {RANGES.map(r => (
              <li key={r}><button type="button" onClick={() => { onChange(r); if (r !== "Custom Range") setOpen(false); }} data-testid={`${testId}-opt-${r.toLowerCase().replace(/\s+/g, "-")}`}
                                  className={`w-full px-3 py-1.5 text-left text-sm ${value === r ? "bg-[#1E88E5] text-white" : "text-slate-700 hover:bg-slate-50"}`}>{r}</button></li>
            ))}
          </ul>
          {value === "Custom Range" && (
            <div className="border-l border-slate-200 p-3 space-y-2 text-sm">
              <label className="block text-xs text-slate-500">From<input type="date" value={custom.from} onChange={e => setCustom(c => ({ ...c, from: e.target.value }))} data-testid={`${testId}-from`} className="block h-8 rounded border border-slate-300 px-2 text-sm text-slate-700" /></label>
              <label className="block text-xs text-slate-500">To<input type="date" value={custom.to} onChange={e => setCustom(c => ({ ...c, to: e.target.value }))} data-testid={`${testId}-to`} className="block h-8 rounded border border-slate-300 px-2 text-sm text-slate-700" /></label>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setCustom({ from: "", to: "" })} className="h-7 px-3 rounded-full border border-slate-300 text-xs text-slate-700">Clear</button>
                <button type="button" onClick={() => setOpen(false)} data-testid={`${testId}-apply`} className="h-7 px-3 rounded-full bg-[#1E88E5] text-xs font-semibold text-white">Apply</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const GenerateInvoiceModal = ({ contactId, onClose }) => {
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [sel, setSel] = useState({});
  const [range, setRange] = useState("All Time");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [items, setItems] = useState({ time: true, expenses: true, flat: true });
  const [tax, setTax] = useState({ tax1_id: "", tax2_id: "", tax_expenses: false });
  const [taxes, setTaxes] = useState([]);
  const [openItems, setOpenItems] = useState(false);
  const [openTax, setOpenTax] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get("/practice/invoices/preview", { params: { contact_id: contactId } }).then(r => setData(r.data)).catch(() => { toast.error("Could not load"); onClose(); });
    api.get("/practice/taxes").then(r => setTaxes(r.data)).catch(() => {});
  }, [contactId]); // eslint-disable-line react-hooks/exhaustive-deps

  const taxOpts = taxes.map(t => ({ id: t.id, label: `${t.name} (${t.rate}%)` }));
  const generate = async () => {
    const matter_ids = Object.keys(sel).filter(k => sel[k]);
    if (!matter_ids.length) return toast.error("Select at least one matter.");
    const [date_from, date_to] = rangeBounds(range, custom);
    setBusy(true);
    try {
      const r = await api.post("/practice/invoices/generate", { contact_id: contactId, matter_ids, date_from, date_to, add_time_entries: items.time, add_expenses: items.expenses, add_flat_fees: items.flat, ...tax });
      onClose(); nav(`/practice/invoices/${r.data.id}/new`);
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not generate invoice"); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-start justify-center overflow-y-auto py-6 px-4" data-testid="practice-generate-invoice-modal">
      <div className="w-full max-w-2xl rounded bg-white shadow-2xl">
        <div className="h-10 bg-[#1E88E5] rounded-t flex items-center justify-between px-4 text-white text-sm">
          <span className="inline-flex items-center gap-1 font-semibold"><Plus size={14} /> Generate Invoice</span>
          <button type="button" onClick={onClose} data-testid="practice-generate-invoice-close"><X size={16} /></button>
        </div>
        <div className="bg-slate-50 p-4 space-y-3">
          <Card testId="practice-gi-generated-for">
            <h3 className="text-lg font-bold uppercase tracking-wide text-slate-800 mb-3">Generated For</h3>
            <div className="grid grid-cols-[200px_1fr] gap-y-3">
              <Label>Contact</Label>
              <div className="pt-1.5 text-[15px] font-semibold text-[#1E88E5]">{data?.contact.display_name}</div>
              <Label>Matters</Label>
              <div className="space-y-2">
                {data?.matters.map(m => (
                  <div key={m.id} className="flex items-center gap-2" data-testid={`practice-gi-matter-${m.id}`}>
                    <Toggle value={!!sel[m.id]} onChange={v => setSel(s => ({ ...s, [m.id]: v }))} testId={`practice-gi-matter-toggle-${m.id}`} />
                    <span className="text-[15px] text-[#1E88E5]">{m.name}</span>
                    <span className="text-sm text-slate-600" data-testid={`practice-gi-matter-billable-${m.id}`}>${Number(m.billable).toFixed(2)} Billable</span>
                  </div>
                ))}
                {data && data.matters.length === 0 && <div className="text-sm text-slate-500">No matters for this contact.</div>}
              </div>
            </div>
          </Card>
          <Card testId="practice-gi-options">
            <h3 className="text-lg font-bold uppercase tracking-wide text-slate-800 mb-3">Invoice Options</h3>
            <div className="grid grid-cols-[200px_1fr] items-center">
              <Label>Select Date Range</Label>
              <div><RangePicker value={range} onChange={setRange} custom={custom} setCustom={setCustom} testId="practice-gi-range" /></div>
            </div>
          </Card>
          <Collapsible title="Billable Items" open={openItems} onToggle={() => setOpenItems(v => !v)} testId="practice-gi-billable-items">
            <div className="grid grid-cols-[200px_1fr] gap-y-3 items-center">
              <Label>Add Time Entries</Label><div><Toggle value={items.time} onChange={v => setItems(i => ({ ...i, time: v }))} testId="practice-gi-add-time" /></div>
              <Label>Add Expenses</Label><div><Toggle value={items.expenses} onChange={v => setItems(i => ({ ...i, expenses: v }))} testId="practice-gi-add-expenses" /></div>
              <Label>Add Flat Fees</Label><div><Toggle value={items.flat} onChange={v => setItems(i => ({ ...i, flat: v }))} testId="practice-gi-add-flat-fees" /></div>
            </div>
          </Collapsible>
          <Collapsible title="Sales Tax" open={openTax} onToggle={() => setOpenTax(v => !v)} testId="practice-gi-sales-tax">
            <div className="grid grid-cols-[200px_1fr] gap-y-3 items-center">
              <Label>Tax 1</Label><div><SearchSelect value={tax.tax1_id} onChange={v => setTax(t => ({ ...t, tax1_id: v }))} options={taxOpts} placeholder="Select Tax..." clearable testId="practice-gi-tax1" /></div>
              <Label>Tax 2</Label><div><SearchSelect value={tax.tax2_id} onChange={v => setTax(t => ({ ...t, tax2_id: v }))} options={taxOpts} placeholder="Select Tax..." clearable testId="practice-gi-tax2" /></div>
              <Label>Add Sales Tax to Expenses?</Label><div><Toggle value={tax.tax_expenses} onChange={v => setTax(t => ({ ...t, tax_expenses: v }))} testId="practice-gi-tax-expenses" /></div>
            </div>
          </Collapsible>
          <div className="flex items-center gap-2 pt-1">
            <GreenButton onClick={generate} testId="practice-gi-generate-btn" className={busy ? "opacity-60 pointer-events-none" : ""}><Check size={14} /> Generate Invoice</GreenButton>
            <button type="button" onClick={onClose} data-testid="practice-gi-cancel-btn" className="inline-flex items-center gap-1.5 rounded-full bg-slate-200 px-4 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-300"><X size={14} /> Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
};
