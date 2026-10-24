import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, X, Check, Move } from "lucide-react";
import { api } from "@/lib/api";
import { SearchSelect } from "@/components/practice/SearchSelect";

const inp = "w-full h-9 rounded border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-[#1E88E5] placeholder:text-slate-400";
const Row = ({ label, required, help, sub, children }) => (
  <div className="grid grid-cols-[190px_1fr] items-start gap-3 py-1.5">
    <div className="text-[12px] font-semibold uppercase tracking-wide text-slate-800 pt-2 flex items-start gap-1 leading-tight">
      {help && <span className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full bg-slate-400 text-white text-[9px] font-bold grid place-items-center">?</span>}<span>{label}{sub && <span className="text-[10px] text-slate-500 normal-case"> ({sub})</span>}{required && <span className="text-red-500">*</span>}</span>
    </div>
    <div>{children}</div>
  </div>
);
const Toggle = ({ value, onChange, testId }) => (
  <button type="button" onClick={() => onChange(!value)} data-testid={testId}
          className={`h-7 w-14 rounded border text-xs font-semibold flex items-center ${value ? "bg-[#1E88E5] border-[#1E88E5] text-white justify-start pl-2" : "bg-white border-slate-300 text-slate-700 justify-end pr-2"}`}>{value ? "Yes" : "No"}</button>
);
const Card = ({ title, children }) => <section className="rounded border border-slate-200 bg-white px-5 py-4">{title && <h3 className="text-base font-bold uppercase tracking-wide text-slate-800 mb-2">{title}</h3>}{children}</section>;

const Shell = ({ title, z, onClose, children, testId }) => (
  <div className={`fixed inset-0 ${z} bg-black/40 flex items-start justify-center overflow-y-auto py-10 px-4`} data-testid={testId}>
    <div className="w-full max-w-xl rounded bg-white shadow-2xl">
      <div className="h-10 bg-[#1E88E5] rounded-t flex items-center justify-between px-4 text-white text-sm">
        <span className="inline-flex items-center gap-1 font-semibold"><Plus size={14} /> {title}</span>
        <span className="inline-flex items-center gap-3"><Move size={13} /><button type="button" onClick={onClose} data-testid={`${testId}-close`}><X size={16} /></button></span>
      </div>
      <div className="p-4 bg-slate-50 space-y-3 rounded-b">{children}</div>
    </div>
  </div>
);

const Actions = ({ onSave, onCancel, busy, testId }) => (
  <div className="flex items-center gap-2 pt-1">
    <button type="button" onClick={onSave} disabled={busy} data-testid={`${testId}-save`} className="inline-flex items-center gap-1.5 rounded bg-[#43A047] px-4 py-2 text-sm font-semibold text-white hover:bg-[#388E3C] disabled:opacity-60"><Check size={14} /> Save</button>
    <button type="button" onClick={onCancel} data-testid={`${testId}-cancel`} className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"><X size={14} /> Cancel</button>
  </div>
);

export const NewSalesTaxModal = ({ onSaved, onClose }) => {
  const [f, setF] = useState({ name: "", rate: "", description: "", compound: false });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e?.target ? e.target.value : e }));
  const save = async () => {
    if (!f.name.trim()) return toast.error("Name is required.");
    if (f.rate === "" || Number(f.rate) < 0) return toast.error("Tax rate is required.");
    setBusy(true);
    try { const r = await api.post("/practice/taxes", { ...f, rate: Number(f.rate) }); toast.success("Sales tax saved"); onSaved(r.data); }
    catch (e) { toast.error(e?.response?.data?.detail || "Could not save tax"); } finally { setBusy(false); }
  };
  return (
    <Shell title="New Sales Tax" z="z-[90]" onClose={onClose} testId="practice-new-tax-modal">
      <Card>
        <Row label="Name" required><input autoFocus className={inp} placeholder="Add Name..." value={f.name} onChange={set("name")} data-testid="practice-tax-name" /></Row>
        <Row label="Tax Rate" required><input type="number" step="0.001" className={inp} placeholder="0.000" value={f.rate} onChange={set("rate")} data-testid="practice-tax-rate" /></Row>
        <Row label="Description"><input className={inp} placeholder="Add description..." value={f.description} onChange={set("description")} data-testid="practice-tax-description" /></Row>
        <Row label="Compound Tax"><Toggle value={f.compound} onChange={set("compound")} testId="practice-tax-compound" /></Row>
      </Card>
      <Actions onSave={save} onCancel={onClose} busy={busy} testId="practice-tax" />
    </Shell>
  );
};

export const NewItemModal = ({ onSaved, onClose }) => {
  const [f, setF] = useState({ name: "", code: "", description: "", price: "", use_item_price: false, tax1_id: "", tax2_id: "" });
  const [taxes, setTaxes] = useState([]);
  const [taxFor, setTaxFor] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e?.target ? e.target.value : e }));
  useEffect(() => { api.get("/practice/taxes").then(r => setTaxes(r.data)).catch(() => {}); }, []);
  const taxOpts = taxes.map(t => ({ id: t.id, label: `${t.name} (${t.rate}%)` }));
  const save = async () => {
    if (!f.name.trim()) return toast.error("Name is required.");
    if (f.price === "") return toast.error("Price is required.");
    setBusy(true);
    try {
      const r = await api.post("/practice/items", { ...f, price: Number(f.price), tax1_id: f.tax1_id || null, tax2_id: f.tax2_id || null });
      toast.success("Item saved"); onSaved(r.data);
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not save item"); } finally { setBusy(false); }
  };
  return (
    <Shell title="New Item" z="z-[80]" onClose={onClose} testId="practice-new-item-modal">
      <Card title="Item">
        <Row label="Name" required><input autoFocus className={inp} placeholder="Add Name..." value={f.name} onChange={set("name")} data-testid="practice-item-name" /></Row>
        <Row label="Code" help><input className={inp} placeholder="Add Code..." value={f.code} onChange={set("code")} data-testid="practice-item-code" /></Row>
        <Row label="Description"><input className={inp} placeholder="Add description..." value={f.description} onChange={set("description")} data-testid="practice-item-description" /></Row>
      </Card>
      <Card title="Price">
        <Row label="Price" sub="USD" required><input type="number" step="0.01" className={inp} placeholder="0.00" value={f.price} onChange={set("price")} data-testid="practice-item-price" /></Row>
        <Row label="Use item price instead of hourly rate?" help><Toggle value={f.use_item_price} onChange={set("use_item_price")} testId="practice-item-use-price" /></Row>
        <Row label="Tax 1"><SearchSelect value={f.tax1_id} onChange={set("tax1_id")} options={taxOpts} placeholder="Select Tax..." newLabel="New Sales Tax" onNew={() => setTaxFor("tax1_id")} testId="practice-item-tax1" /></Row>
        <Row label="Tax 2"><SearchSelect value={f.tax2_id} onChange={set("tax2_id")} options={taxOpts} placeholder="Select Tax..." newLabel="New Sales Tax" onNew={() => setTaxFor("tax2_id")} testId="practice-item-tax2" /></Row>
      </Card>
      <Actions onSave={save} onCancel={onClose} busy={busy} testId="practice-item" />
      {taxFor && <NewSalesTaxModal onClose={() => setTaxFor(null)} onSaved={(t) => { setTaxes(l => [...l, t]); setF(p => ({ ...p, [taxFor]: t.id })); setTaxFor(null); }} />}
    </Shell>
  );
};
