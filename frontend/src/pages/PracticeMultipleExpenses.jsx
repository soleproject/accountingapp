import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Wallet, Plus, Check, X, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { GreenButton } from "@/components/practice/forms";
import { ContactPicker } from "@/components/practice/ContactPicker";
import { MatterPicker } from "@/components/practice/MatterPicker";
import { SearchSelect } from "@/components/practice/SearchSelect";
import { toISO } from "@/components/practice/DateTimePicker";

const inp = "w-full h-9 rounded border border-slate-300 bg-white px-2 text-sm text-slate-700 outline-none focus:border-[#1E88E5]";
const TH = ({ children, required, help }) => <th className="px-2 pb-2 text-left text-[13px] font-bold uppercase tracking-wide text-slate-800">{help && <span className="text-slate-400 mr-1">?</span>}{children}{required && <span className="text-red-500">*</span>}</th>;
let seq = 0;
const blank = (d, user) => ({ key: ++seq, contact_id: d.contact_id || "", matter_id: d.matter_id || "", date: d.date || toISO(new Date()), billable: true, category: d.category || "", billed_by: d.billed_by || user?.name || "", qty: "1.00", price: "0.00", description: "" });

export default function PracticeMultipleExpenses() {
  const nav = useNavigate();
  const { user } = useAuth();
  const [contacts, setContacts] = useState([]);
  const [matters, setMatters] = useState([]);
  const [cats, setCats] = useState([]);
  const [users, setUsers] = useState([]);
  const [defaults, setDefaults] = useState({ contact_id: "", matter_id: "", billed_by: "", category: "", date: "" });
  const [showDefaults, setShowDefaults] = useState(false);
  const [rows, setRows] = useState(() => [blank({}, user)]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get("/practice/contacts", { params: { status: "All" } }).then(r => setContacts(r.data)).catch(() => {});
    api.get("/practice/matters", { params: { status: "All" } }).then(r => setMatters(r.data)).catch(() => {});
    api.get("/practice/expenses/categories").then(r => setCats(r.data)).catch(() => {});
    api.get("/practice/users").then(r => setUsers(r.data)).catch(() => {});
  }, []);
  const catOpts = cats.map(c => ({ id: c.name, label: c.code ? `${c.name} (${c.code})` : c.name }));
  const userNames = users.length ? users.map(u => u.name) : [user?.name];
  const upd = (key, patch) => setRows(rs => rs.map(r => r.key === key ? { ...r, ...patch } : r));
  const applyDefaults = (d) => { setDefaults(d); setRows(rs => rs.map(r => ({ ...r, contact_id: r.contact_id || d.contact_id, matter_id: r.matter_id || d.matter_id, billed_by: d.billed_by || r.billed_by, category: r.category || d.category, date: d.date || r.date }))); };

  const save = async (more) => {
    const bad = rows.find(r => !r.contact_id || !r.matter_id || !r.date || Number(r.price) < 0);
    if (bad) return toast.error("Each expense needs a contact, matter, date and price.");
    setBusy(true);
    try {
      for (const r of rows) await api.post("/practice/expenses", { contact_id: r.contact_id, matter_id: r.matter_id, cost_type: "Soft Cost", date: r.date, qty: Number(r.qty) || 1, price: Number(r.price) || 0, description: r.description, category: r.category, billable: r.billable, billed_by: r.billed_by });
      toast.success(`${rows.length} expense${rows.length > 1 ? "s" : ""} saved.`);
      more ? setRows([blank(defaults, user)]) : nav("/practice/expenses");
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not save expenses"); } finally { setBusy(false); }
  };

  return (
    <PracticeShell withRail={false}>
      <div className="space-y-4" data-testid="practice-multiple-expenses">
        <div className="flex items-center gap-3"><Wallet size={30} className="text-slate-600" strokeWidth={1.5} /><h1 className="text-3xl font-bold text-slate-800">Multiple Expenses</h1></div>
        <section className="rounded border border-slate-200 bg-white px-8 py-6">
          <table className="w-full">
            <thead><tr><TH required>Contact</TH><TH required>Matter</TH><TH required>Date</TH><TH>Billable?</TH><TH>Category</TH><TH required>Billed By</TH><TH>Qty</TH><TH required>Price</TH><th /></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <RowGroup key={r.key} r={r} i={i} upd={upd} del={() => setRows(rs => rs.length > 1 ? rs.filter(x => x.key !== r.key) : rs)} contacts={contacts} matters={matters} setContacts={setContacts} setMatters={setMatters} catOpts={catOpts} userNames={userNames} />
              ))}
            </tbody>
          </table>
          {showDefaults && (
            <div className="mt-6 rounded border border-slate-200 p-6 grid grid-cols-[200px_480px] gap-y-3 items-center" data-testid="practice-me-defaults">
              <L>Contact</L><ContactPicker value={defaults.contact_id} onChange={(id) => applyDefaults({ ...defaults, contact_id: id, matter_id: "" })} contacts={contacts} onCreated={(c) => setContacts(l => [c, ...l])} testId="practice-me-default-contact" />
              <L>Matter</L><MatterPicker value={defaults.matter_id} onChange={(id) => applyDefaults({ ...defaults, matter_id: id })} matters={matters} contactId={defaults.contact_id} contacts={contacts} onCreated={(m) => setMatters(l => [m, ...l])} onContactChange={(id) => setDefaults(d => ({ ...d, contact_id: id }))} testId="practice-me-default-matter" />
              <L>User</L><select className={inp} value={defaults.billed_by} onChange={e => applyDefaults({ ...defaults, billed_by: e.target.value })} data-testid="practice-me-default-user"><option value="">Select User...</option>{userNames.map(n => <option key={n}>{n}</option>)}</select>
              <L help>Category</L><SearchSelect value={defaults.category} onChange={(v) => applyDefaults({ ...defaults, category: v })} options={catOpts} placeholder="Select Category..." clearable testId="practice-me-default-category" />
              <L>Date</L><input type="date" className={inp} value={defaults.date} onChange={e => applyDefaults({ ...defaults, date: e.target.value })} data-testid="practice-me-default-date" />
            </div>
          )}
          <div className="mt-6 flex items-center gap-2">
            <button type="button" onClick={() => setRows(rs => [...rs, blank(defaults, user)])} className="inline-flex items-center gap-1.5 rounded-full bg-[#1E88E5] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#1976D2]" data-testid="practice-me-add-row"><Plus size={14} /> New Expense</button>
            <button type="button" onClick={() => setShowDefaults(v => !v)} className="rounded-full bg-slate-100 px-4 py-1.5 text-sm text-slate-700 hover:bg-slate-200" data-testid="practice-me-set-defaults">Set Defaults</button>
          </div>
        </section>
        <div className="flex items-center gap-2">
          <GreenButton onClick={() => save(false)} testId="practice-me-save" className={busy ? "opacity-60 pointer-events-none" : ""}><Check size={14} /> Save</GreenButton>
          <GreenButton onClick={() => save(true)} testId="practice-me-save-more" className={busy ? "opacity-60 pointer-events-none" : ""}><Check size={14} /> Save &amp; Add More</GreenButton>
          <button type="button" onClick={() => nav("/practice/expenses")} className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-700 hover:bg-slate-50" data-testid="practice-me-cancel"><X size={14} /> Cancel</button>
        </div>
      </div>
    </PracticeShell>
  );
}

const L = ({ children, help }) => <div className="text-[13px] font-bold uppercase tracking-wide text-slate-800">{help && <span className="text-slate-400 mr-1">?</span>}{children}</div>;

function RowGroup({ r, i, upd, del, contacts, matters, setContacts, setMatters, catOpts, userNames }) {
  const td = "px-2 py-1 align-top";
  return (
    <>
      <tr data-testid={`practice-me-row-${i}`}>
        <td className={`${td} w-[20%]`}><ContactPicker value={r.contact_id} onChange={(id) => upd(r.key, { contact_id: id, matter_id: "" })} contacts={contacts} onCreated={(c) => setContacts(l => [c, ...l])} testId={`practice-me-contact-${i}`} /></td>
        <td className={`${td} w-[20%]`}><MatterPicker value={r.matter_id} onChange={(id) => upd(r.key, { matter_id: id })} matters={matters} contactId={r.contact_id} contacts={contacts} onCreated={(m) => setMatters(l => [m, ...l])} onContactChange={(id) => upd(r.key, { contact_id: id })} testId={`practice-me-matter-${i}`} /></td>
        <td className={`${td} w-[9%]`}><input type="date" className={inp} value={r.date} onChange={e => upd(r.key, { date: e.target.value })} data-testid={`practice-me-date-${i}`} /></td>
        <td className={td}><button type="button" onClick={() => upd(r.key, { billable: !r.billable })} data-testid={`practice-me-billable-${i}`} className={`h-9 w-[70px] rounded border text-xs font-semibold flex items-center ${r.billable ? "bg-[#1E88E5] border-[#1E88E5] text-white justify-start pl-2.5" : "bg-white border-slate-300 text-slate-700 justify-end pr-2.5"}`}>{r.billable ? "Yes" : "No"}</button></td>
        <td className={`${td} w-[16%]`}><SearchSelect value={r.category} onChange={(v) => upd(r.key, { category: v })} options={catOpts} placeholder="Select Category..." clearable testId={`practice-me-category-${i}`} /></td>
        <td className={`${td} w-[11%]`}><select className={inp} value={r.billed_by} onChange={e => upd(r.key, { billed_by: e.target.value })} data-testid={`practice-me-billed-by-${i}`}>{userNames.map(n => <option key={n}>{n}</option>)}</select></td>
        <td className={`${td} w-[6%]`}><input type="number" step="0.01" className={inp} value={r.qty} onChange={e => upd(r.key, { qty: e.target.value })} data-testid={`practice-me-qty-${i}`} /></td>
        <td className={`${td} w-[7%]`}><input type="number" step="0.01" className={inp} value={r.price} onChange={e => upd(r.key, { price: e.target.value })} data-testid={`practice-me-price-${i}`} /></td>
        <td className={`${td} text-right`}><button type="button" onClick={del} className="mt-2 text-slate-500 hover:text-red-600" data-testid={`practice-me-delete-${i}`}><Trash2 size={14} /></button></td>
      </tr>
      <tr><td colSpan={9} className="px-2 pb-4"><textarea rows={2} placeholder="Enter description" value={r.description} onChange={e => upd(r.key, { description: e.target.value })} className={`${inp} !h-auto py-2`} data-testid={`practice-me-description-${i}`} /></td></tr>
    </>
  );
}
