import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Banknote, Landmark, Printer, ChevronDown, Search, Check, Plus, X, Wrench, Columns3, Download, FileSpreadsheet, FileText, Settings, Pencil, Save, SearchX, CreditCard } from "lucide-react";
import { api } from "@/lib/api";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { sel, UserFilter, PillFilter, TagsFilter } from "@/components/practice/listParts";
import { fromISO } from "@/components/practice/DateTimePicker";
import { NewPaymentModal } from "@/components/practice/NewPaymentModal";

const usd = (n) => `${n < 0 ? "-" : ""}$${Math.abs(Number(n || 0)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const mdy = (iso) => { if (!iso) return "-"; const d = fromISO(iso); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; };
const link = "text-[#1E88E5] hover:underline";
const pill = "inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-700 hover:bg-slate-50";
const Neg = ({ v, trust }) => <span className={`inline-block rounded-full px-3 py-0.5 text-xs font-semibold text-white ${v < 0 ? "bg-[#E53935]" : trust ? "bg-[#1E88E5]" : "bg-[#43A047]"}`}>{usd(v)} <span className="text-[9px] font-normal">USD</span></span>;
const Stat = ({ label, value, sub, testId }) => (
  <div className="rounded border border-slate-200 bg-white px-3 py-3 flex items-center justify-between" data-testid={testId}>
    <span className="text-[11px] uppercase tracking-wider text-slate-600">{label}</span>
    <span className="text-xl text-slate-800">{value} <span className="text-[10px] text-slate-500">{sub}</span></span>
  </div>
);
const useLedger = () => {
  const [rows, setRows] = useState(null);
  const load = () => api.get("/practice/ledger").then(r => setRows(r.data)).catch(() => { setRows([]); toast.error("Could not load payments"); });
  useEffect(() => { load(); }, []);
  return [rows, load];
};
const AccountPicker = ({ accounts, value, onChange, rows, testId }) => {
  const bal = rows ? rows.filter(r => r.account === value).reduce((a, r) => a + r.amount, 0) : 0;
  return (
    <div className="relative inline-flex items-center gap-1 text-2xl text-[#1E88E5]">
      <select value={value} onChange={e => onChange(e.target.value)} className="appearance-none bg-transparent pr-6 outline-none cursor-pointer" data-testid={testId}>{accounts.map(a => <option key={a.id} value={a.name}>{a.name} : {usd(bal)}</option>)}</select>
      <ChevronDown size={18} className="absolute right-0 pointer-events-none" />
    </div>
  );
};
const DATE_PRESETS = ["All Time", "Today", "Yesterday", "Last 7 Days", "Last 30 Days", "This Month", "Last Month", "This Year", "Last Year", "This Quarter", "Last Quarter", "Custom"];
export const presetBounds = (label, custom = {}) => {
  const t = new Date(); const iso = (d) => d.toISOString().slice(0, 10); const d = (n) => { const x = new Date(t); x.setDate(x.getDate() + n); return iso(x); };
  const y = t.getFullYear(), m = t.getMonth(), qs = Math.floor(m / 3) * 3;
  switch (label) {
    case "Today": return [iso(t), iso(t)]; case "Yesterday": return [d(-1), d(-1)]; case "Last 7 Days": return [d(-6), iso(t)]; case "Last 30 Days": return [d(-29), iso(t)];
    case "This Month": return [iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))]; case "Last Month": return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
    case "This Year": return [`${y}-01-01`, `${y}-12-31`]; case "Last Year": return [`${y - 1}-01-01`, `${y - 1}-12-31`];
    case "This Quarter": return [iso(new Date(y, qs, 1)), iso(new Date(y, qs + 3, 0))]; case "Last Quarter": return [iso(new Date(y, qs - 3, 1)), iso(new Date(y, qs, 0))];
    case "Custom": return [custom.from || null, custom.to || null]; default: return [null, null];
  }
};
function FilterChip({ label, value, options, multi, date, onChange, testId }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState({ from: "", to: "" });
  const active = date ? value && value !== "All Time" : multi ? value.length > 0 : !!value;
  const text = date ? (value && value !== "All Time" ? `Date: ${value === "Custom" ? `${custom.from || "…"} – ${custom.to || "…"}` : value}` : label) : multi ? (value.length ? `${label}: ${value.join(", ")}` : label) : (value || label);
  const clear = (e) => { e.stopPropagation(); onChange(date ? "All Time" : multi ? [] : ""); };
  return (
    <div className="relative inline-block">
      <button type="button" onClick={() => setOpen(v => !v)} data-testid={testId} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm ${active ? "bg-[#1E88E5] text-white" : "border border-slate-300 text-slate-700 bg-white"}`}>
        {text}{active ? <span role="button" onClick={clear} data-testid={`${testId}-clear`}><X size={12} /></span> : <ChevronDown size={12} />}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 rounded border border-slate-200 bg-white shadow-xl text-sm" data-testid={`${testId}-menu`}>
          {date ? (
            <div className="flex">
              <ul className="w-36 py-1 max-h-80 overflow-y-auto">{DATE_PRESETS.map(o => <li key={o}><button type="button" onClick={() => { onChange(o, custom); if (o !== "Custom") setOpen(false); }} data-testid={`${testId}-opt-${o.toLowerCase().replace(/\s+/g, "-")}`} className={`w-full px-3 py-1.5 text-left text-xs ${value === o ? "bg-slate-100 font-semibold" : "hover:bg-slate-50"}`}>{o}</button></li>)}</ul>
              <div className="border-l border-slate-200 p-3 space-y-2 w-64">
                <label className="block text-xs text-slate-500">From<input type="date" value={custom.from} onChange={e => setCustom(c => ({ ...c, from: e.target.value }))} data-testid={`${testId}-from`} className="block w-full h-8 rounded border border-slate-300 px-2 text-sm" /></label>
                <label className="block text-xs text-slate-500">To<input type="date" value={custom.to} onChange={e => setCustom(c => ({ ...c, to: e.target.value }))} data-testid={`${testId}-to`} className="block w-full h-8 rounded border border-slate-300 px-2 text-sm" /></label>
                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={() => { onChange("All Time"); setOpen(false); }} className="px-2 text-xs text-slate-700">All Time</button>
                  <button type="button" onClick={() => setCustom({ from: "", to: "" })} className="h-7 px-3 rounded border border-slate-300 text-xs">Clear</button>
                  <button type="button" onClick={() => { onChange("Custom", custom); setOpen(false); }} data-testid={`${testId}-apply`} className="h-7 px-3 rounded bg-[#1E88E5] text-xs font-semibold text-white">Apply</button>
                </div>
              </div>
            </div>
          ) : (
            <ul className="min-w-[180px] py-1 max-h-72 overflow-y-auto">{options.map(o => (
              <li key={o}><button type="button" onClick={() => { if (multi) onChange(value.includes(o) ? value.filter(x => x !== o) : [...value, o]); else { onChange(o); setOpen(false); } }} data-testid={`${testId}-opt-${o.toLowerCase().replace(/[^a-z]+/g, "-")}`}
                                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-slate-50 ${!multi && value === o ? "bg-slate-100 font-semibold" : ""}`}>{multi && <input type="checkbox" readOnly checked={value.includes(o)} className="h-3.5 w-3.5" />}{o}</button></li>
            ))}</ul>
          )}
        </div>
      )}
      {open && <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />}
    </div>
  );
}
const TYPE_OF = (r) => r.type === "Payment" ? "Contact" : r.type === "Check" ? "Firm" : "Expense";
const METHOD_OF = (m) => m === "Credit / Debit Card" ? "Credit Card / Debit Card" : m === "Bank Transfer" ? "Transfer" : m;
const Chip = ({ children, active, onClear, testId }) => <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm ${active ? "bg-[#1E88E5] text-white" : "border border-slate-300 text-slate-700"}`} data-testid={testId}>{children}{active && onClear ? <button type="button" onClick={onClear}><X size={12} /></button> : !active && <ChevronDown size={12} />}</span>;

export function ActionsMenu({ nav, onContactPayment }) {
  const [open, setOpen] = useState(false);
  const items = [[CreditCard, "Contact Payment", onContactPayment], null, [Printer, "Print Checks", () => nav("/practice/payments/print-checks")], [Printer, "Deposit Slips", null], null, [Download, "Daily Report", null], [Download, "Monthly Report", null]];
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(v => !v)} className="inline-flex items-center gap-1.5 rounded-full bg-[#43A047] px-4 py-1.5 text-sm font-semibold text-white" data-testid="practice-payments-actions"><Wrench size={14} /> Actions <ChevronDown size={12} /></button>
      {open && <>
        <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
        <div className="absolute right-0 top-full z-30 mt-1 w-48 rounded border border-slate-200 bg-white py-1 shadow-xl" data-testid="practice-payments-actions-menu">
          {items.map((it, i) => it === null ? <div key={i} className="my-1 border-t border-slate-200" /> : (
            <button key={it[1]} type="button" disabled={!it[2]} onClick={() => { setOpen(false); it[2]?.(); }} data-testid={`practice-payments-action-${it[1].toLowerCase().replace(/\s+/g, "-")}`}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm ${it[2] ? "text-slate-700 hover:bg-slate-50" : "text-slate-400"}`}>{(() => { const I = it[0]; return <I size={13} />; })()}{it[1]}</button>
          ))}
        </div>
      </>}
    </div>
  );
}

export function PaymentsTable({ rows, nav, q, setQ, shown }) {
  return (
        <div className="rounded border border-slate-200 bg-white overflow-hidden">
          <div className="flex items-center gap-3 px-3 py-2 border-b border-slate-200"><Search size={15} className="text-slate-400" /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search Payments..." className="flex-1 h-8 text-sm outline-none" data-testid="practice-payments-search" /><span className="inline-flex items-center gap-1 text-sm text-slate-400"><Settings size={13} /> Choose Columns</span><FileSpreadsheet size={15} className="text-slate-400" /><FileText size={15} className="text-slate-400" /></div>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[12px] font-semibold uppercase tracking-wide text-slate-600"><th className="px-4 py-3"><input type="checkbox" className="h-4 w-4" /></th>{PAY_COLS.map(c => <th key={c} className="px-2 py-3">{c}</th>)}</tr></thead>
            <tbody>
              {shown.map(r => (
                <tr key={r.ref} className="border-t border-slate-200 hover:bg-slate-50" data-testid={`practice-payment-row-${r.ref}`}>
                  <td className="px-4 py-4"><input type="checkbox" className="h-4 w-4" /></td>
                  <td className="px-2 py-4"><button type="button" onClick={() => nav(`/practice/payments/${r.src}/${r.id}`)} className="font-semibold text-[#1E88E5] hover:underline text-[15px]" data-testid={`practice-payment-link-${r.ref}`}>{r.type} {r.ref}</button></td>
                  <td className="px-2 py-4"><button type="button" onClick={() => nav("/practice/payments/accounts")} className={link}>{r.account}</button></td>
                  <td className="px-2 py-4"><button type="button" onClick={() => nav(`/practice/contacts/${r.contact_id}`)} className={link}>{r.contact_name}</button></td>
                  <td className="px-2 py-4"><button type="button" onClick={() => nav(`/practice/matters/${r.matter_id}`)} className={link}>{r.matter_name}</button></td>
                  <td className="px-2 py-4" /><td className="px-2 py-4" />
                  <td className="px-2 py-4"><Neg v={r.amount} trust={r.account === "Trust Account"} /></td>
                  <td className="px-2 py-4 text-slate-700">$0.00 <span className="text-[10px] text-slate-500">USD</span></td>
                  <td className="px-2 py-4 text-slate-700">{mdy(r.date)}</td><td className="px-2 py-4 text-slate-700">{mdy(r.deposit_date)}</td><td className="px-2 py-4 text-slate-700">{r.method}</td>
                </tr>
              ))}
              {rows && shown.length === 0 && <tr><td colSpan={12} className="py-10 text-center text-sm text-slate-500">No payments yet.</td></tr>}
            </tbody>
            <tfoot><tr className="border-t border-slate-200 bg-slate-50 font-semibold text-slate-800"><td colSpan={7} /><td className="px-2 py-2">{usd(shown.reduce((a, r) => a + r.amount, 0))} <span className="text-[10px] font-normal">USD</span></td><td className="px-2 py-2">$0.00 <span className="text-[10px] font-normal">USD</span></td><td colSpan={3} /></tr></tfoot>
          </table>
          <div className="flex items-center gap-3 px-3 py-2 border-t border-slate-200 text-xs uppercase tracking-wider text-slate-500"><span className="text-slate-300">« ‹</span><span className="text-slate-800 text-sm border-b border-slate-400 px-2">1</span><span className="text-slate-300">› »</span><span className="ml-3 rounded-full border border-slate-300 px-2.5 py-0.5 normal-case text-slate-700">50 ▾</span><span>Items per page</span><span className="flex-1 text-right">1 - {shown.length} of {shown.length} items</span></div>
        </div>
  );
}
const PAY_COLS = ["Name", "Bank Account", "Contact", "Matter", "Email", "Company Name", "Amount", "Fees", "Date", "Deposit Date", "Payment Method"];

export function PracticePayments() {
  const nav = useNavigate();
  const [rows] = useLedger();
  const [q, setQ] = useState("");
  const [newPay, setNewPay] = useState(false);
  const all = rows || [];
  const shown = all.filter(r => `${r.ref} ${r.contact_name} ${r.matter_name} ${r.notes}`.toLowerCase().includes(q.toLowerCase()));
  const paid = all.filter(r => r.account !== "Trust Account").reduce((a, r) => a + r.amount, 0);
  const trust = all.filter(r => r.account === "Trust Account").reduce((a, r) => a + r.amount, 0);
  return (
    <PracticeShell withRail={false}>
      <div className="space-y-4" data-testid="practice-payments">
        <div className="flex items-center gap-3">
          <Banknote size={30} className="text-slate-600" strokeWidth={1.5} /><h1 className="text-3xl font-bold text-slate-800">Payments</h1><span className="text-sm text-[#1E88E5]">Switch to Modern Grid</span>
          <div className="flex-1" />
          <button type="button" className={pill}><CreditCard size={14} /> Get Paid Faster</button><button type="button" className={pill}><Printer size={14} /> Deposit Slips</button>
          <button type="button" onClick={() => nav("/practice/payments/print-checks")} className={pill} data-testid="practice-payments-print-checks"><Printer size={14} /> Print Checks</button>
          <ActionsMenu nav={nav} onContactPayment={() => setNewPay(true)} />
        </div>
        {newPay && <NewPaymentModal onClose={() => setNewPay(false)} />}
        <div className="space-y-2 text-sm text-slate-700" data-testid="practice-payments-filters">
          <div className="flex items-center gap-2"><span>Bank Account</span><select className={`${sel} w-56`} defaultValue=""><option value="">Select Bank Account...</option><option>Operating Account</option><option>Trust Account</option></select></div>
          <div className="flex flex-wrap items-center gap-2"><span>Payment Method</span><select className={`${sel} w-56`} defaultValue="Any method"><option>Any method</option><option>Cash</option><option>Check</option><option>Credit / Debit Card</option></select><span>Assigned To</span><select className={`${sel} w-24`} defaultValue="Contact"><option>Contact</option><option>Matter</option></select><UserFilter testId="practice-payments-user" /><TagsFilter testId="practice-payments-tags" /><span>Date Range</span><PillFilter testId="practice-payments-range">All Time</PillFilter></div>
        </div>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-6">
          <Stat label="# of Transactions" value={all.length} testId="practice-payments-count" /><Stat label="Paid" value={usd(paid)} sub="USD" testId="practice-payments-paid" /><Stat label="Trust" value={usd(trust)} sub="USD" testId="practice-payments-trust" /><Stat label="Unapplied" value="$0.00" sub="USD" testId="practice-payments-unapplied" />
        </div>
        <PaymentsTable rows={rows} nav={nav} q={q} setQ={setQ} shown={shown} />
      </div>
    </PracticeShell>
  );
}

export function PracticeBankAccounts() {
  const nav = useNavigate();
  const [accts, setAccts] = useState(null);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: "", type: "Operating Account" });
  const load = () => api.get("/practice/bank-accounts").then(r => setAccts(r.data)).catch(() => setAccts([]));
  useEffect(() => { load(); }, []);
  const save = async () => { try { await api.post("/practice/bank-accounts", f); toast.success("Account added."); setAdding(false); setF({ name: "", type: "Operating Account" }); load(); } catch (e) { toast.error(e?.response?.data?.detail || "Could not add"); } };
  return (
    <PracticeShell withRail={false}>
      <div className="space-y-4" data-testid="practice-bank-accounts">
        <div className="flex items-center gap-3"><Landmark size={30} className="text-slate-600" strokeWidth={1.5} /><h1 className="text-3xl font-bold text-slate-800">Bank Accounts &amp; Credit Cards</h1><div className="flex-1" />
          <button type="button" onClick={() => setAdding(true)} className="rounded bg-[#43A047] px-4 py-2 text-sm font-bold text-white hover:bg-[#388E3C]" data-testid="practice-accounts-new">+ NEW ACCOUNT</button></div>
        {adding && (
          <div className="rounded border border-slate-200 bg-white p-4 flex items-end gap-3" data-testid="practice-accounts-form">
            <label className="text-xs uppercase tracking-wide text-slate-600">Name<input className="block mt-1 h-9 w-64 rounded border border-slate-300 px-3 text-sm" value={f.name} onChange={e => setF(p => ({ ...p, name: e.target.value }))} data-testid="practice-accounts-name" /></label>
            <label className="text-xs uppercase tracking-wide text-slate-600">Type<select className="block mt-1 h-9 w-48 rounded border border-slate-300 px-2 text-sm" value={f.type} onChange={e => setF(p => ({ ...p, type: e.target.value }))} data-testid="practice-accounts-type"><option>Operating Account</option><option>Trust Account</option><option>Credit Card</option></select></label>
            <button type="button" onClick={save} className="inline-flex items-center gap-1 rounded-full bg-[#43A047] px-4 py-2 text-sm font-semibold text-white" data-testid="practice-accounts-save"><Check size={14} /> Save</button>
            <button type="button" onClick={() => setAdding(false)} className={pill}><X size={14} /> Cancel</button>
          </div>
        )}
        <div className="rounded border border-slate-200 bg-white px-3 py-4 min-h-[600px] flex flex-col">
          <div className="flex justify-end gap-6 text-xs font-semibold uppercase tracking-wide text-slate-500 px-2"><span className="inline-flex items-center gap-1"><Columns3 size={14} /> Columns</span><span className="inline-flex items-center gap-1"><Printer size={14} /> Print</span></div>
          <table className="w-full mt-8 text-sm">
            <thead><tr className="text-left text-[15px] font-semibold text-slate-800">{["Name", "Type", "Created D...", "Created By", "Status", "Account Balance", "Unreconciled Payments"].map(c => <th key={c} className={`px-3 pb-3 ${c === "Account Balance" ? "text-right" : ""}`}>{c}</th>)}</tr></thead>
            <tbody>
              {(accts || []).map(a => (
                <tr key={a.id} className="border-t border-slate-200 text-[15px]" data-testid={`practice-account-row-${a.id}`}>
                  <td className="px-3 py-4"><button type="button" onClick={() => nav(`/practice/payments/reconciliation?account=${encodeURIComponent(a.name)}`)} className={link}>{a.name}</button></td>
                  <td className="px-3 py-4 text-slate-700">{a.type} {a.default && <span className="ml-1 rounded-full border border-slate-300 px-2 py-0.5 text-xs">Default</span>}</td>
                  <td className="px-3 py-4 text-slate-700">{mdy(a.created_at.slice(0, 10))}</td>
                  <td className="px-3 py-4"><span className="inline-grid h-9 w-9 place-items-center rounded-full bg-[#BBDEFB] text-xs font-bold text-slate-700">{(a.created_by || "?").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase()}</span></td>
                  <td className="px-3 py-4"><span className="rounded-full bg-[#43A047] px-3 py-0.5 text-sm text-white">{a.status}</span></td>
                  <td className="px-3 py-4 text-right">{a.balance < 0 ? <span className="rounded-full border border-[#E53935] px-3 py-0.5 text-[#E53935]">{usd(a.balance)}</span> : <span className="text-slate-700">{usd(a.balance)}</span>}</td>
                  <td className="px-3 py-4 text-center text-slate-700">{a.unreconciled}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex-1" />
          <div className="flex justify-end items-center gap-6 text-sm text-slate-600 pt-4 border-t border-slate-200">Rows per page: 25 ▾ <span>1–{(accts || []).length} of {(accts || []).length}</span><span className="text-slate-300">‹ ›</span></div>
        </div>
      </div>
    </PracticeShell>
  );
}

const Sub = ({ children }) => <div className="text-[11px] uppercase tracking-wide text-slate-600">{children}</div>;
const Big = ({ children, note, neg }) => <div className={`text-xl font-semibold ${neg ? "text-[#E53935]" : "text-slate-800"}`}>{children} <span className="text-xs font-normal text-slate-600">{note}</span></div>;

export function PracticeReconciliation() {
  const nav = useNavigate();
  const [rows, load] = useLedger();
  const [accounts, setAccounts] = useState([]);
  const [account, setAccount] = useState(new URLSearchParams(window.location.search).get("account") || "Operating Account");
  const [status, setStatus] = useState("Not Reconciled");
  const [dateF, setDateF] = useState("Last 30 Days");
  const [customF, setCustomF] = useState({});
  const [types, setTypes] = useState([]);
  const [methods, setMethods] = useState([]);
  const [q, setQ] = useState("");
  const [sel2, setSel2] = useState({});
  useEffect(() => { api.get("/practice/bank-accounts").then(r => setAccounts(r.data)).catch(() => {}); }, []);
  const [from, to] = presetBounds(dateF, customF);
  const inAcct = (rows || []).filter(r => r.account === account);
  const shown = inAcct.filter(r => (!status || (status === "Reconciled") === !!r.reconciled) && (!from || r.date >= from) && (!to || r.date <= to)
    && (!types.length || types.includes(TYPE_OF(r))) && (!methods.length || methods.includes(METHOD_OF(r.method)))
    && `${r.ref} ${r.notes} ${r.contact_name} ${r.matter_name}`.toLowerCase().includes(q.toLowerCase()));
  const unrec = inAcct.filter(r => !r.reconciled), rec = inAcct.filter(r => r.reconciled);
  const scope = status === "Reconciled" ? rec : status === "Not Reconciled" ? unrec : inAcct;
  const scopeLabel = status === "Reconciled" ? "Reconciled" : status === "Not Reconciled" ? "Not Reconciled" : "Total";
  const sum = (l) => l.reduce((a, r) => a + r.amount, 0);
  const mark = async (r, v) => { try { await api.patch(`/practice/ledger/${r.src}/${r.id}`, { reconciled: v }); toast.success(v ? "Marked reconciled." : "Marked not reconciled."); load(); } catch { toast.error("Could not update"); } };
  const markSelected = async () => { for (const r of shown.filter(x => sel2[x.ref])) await api.patch(`/practice/ledger/${r.src}/${r.id}`, { reconciled: true }); setSel2({}); load(); };
  return (
    <PracticeShell withRail={false}>
      <div className="space-y-4" data-testid="practice-reconciliation">
        <div className="flex items-center gap-3 text-2xl"><button type="button" onClick={() => nav("/practice/payments/accounts")} className="text-[#1E88E5] font-semibold">Account Ledger</button><span className="text-[#1E88E5]">›</span><AccountPicker accounts={accounts} value={account} onChange={setAccount} rows={rows} testId="practice-recon-account" /><div className="flex-1" /><button type="button" className="h-9 w-9 rounded border border-slate-300 grid place-items-center text-slate-600"><Pencil size={14} /></button><button type="button" className="h-9 w-9 rounded border border-slate-300 grid place-items-center text-slate-600"><Save size={14} /></button></div>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
          <div className="rounded bg-slate-100 px-4 py-3" data-testid="practice-recon-unrec"><Sub>Total Not Reconciled</Sub><Big neg={sum(unrec) < 0} note={`from ${unrec.length} payment${unrec.length === 1 ? "" : "s"}`}>{usd(sum(unrec))} USD</Big></div>
          <div className="rounded bg-slate-100 px-4 py-3" data-testid="practice-recon-rec"><Sub>Total Reconciled</Sub><Big>{usd(sum(rec))} USD</Big></div>
          <div className="rounded bg-slate-100 px-4 py-3" data-testid="practice-recon-deposits"><Sub>{scopeLabel} Deposits</Sub><Big note={scope.filter(r => r.amount > 0).length ? `from ${scope.filter(r => r.amount > 0).length} payment${scope.filter(r => r.amount > 0).length === 1 ? "" : "s"}` : ""}>{usd(sum(scope.filter(r => r.amount > 0)))} USD</Big></div>
          <div className="rounded bg-slate-100 px-4 py-3" data-testid="practice-recon-withdrawals"><Sub>{scopeLabel} Withdrawals</Sub><Big neg={sum(scope.filter(r => r.amount < 0)) < 0} note={scope.filter(r => r.amount < 0).length ? `from ${scope.filter(r => r.amount < 0).length} payment${scope.filter(r => r.amount < 0).length === 1 ? "" : "s"}` : ""}>{usd(sum(scope.filter(r => r.amount < 0)))} USD</Big></div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <FilterChip label="Reconciled Status" value={status} options={["Reconciled", "Not Reconciled"]} onChange={setStatus} testId="practice-recon-chip-status" />
          <FilterChip label="Date" date value={dateF} onChange={(v, c) => { setDateF(v); if (c) setCustomF(c); }} testId="practice-recon-chip-date" />
          <FilterChip label="Type" multi value={types} options={["Contact", "Firm", "Refund", "Expense"]} onChange={setTypes} testId="practice-recon-chip-type" />
          <FilterChip label="Method" multi value={methods} options={["Cash", "Check", "Credit Card / Debit Card", "Other", "Practice Payments Credit / Debit Card", "Practice Payments eCheck", "Transfer", "Wire"]} onChange={setMethods} testId="practice-recon-chip-method" />
          {["Reconciled Date", "Deposit Date", "Amount"].map(c => <Chip key={c}>{c}</Chip>)}
          <button type="button" onClick={() => { setStatus(""); setDateF("All Time"); setTypes([]); setMethods([]); }} className="px-2 text-slate-700" data-testid="practice-recon-clear">Clear</button>
          <button type="button" onClick={() => { setStatus("Not Reconciled"); setDateF("Last 30 Days"); setTypes([]); setMethods([]); }} className="px-2 text-slate-700" data-testid="practice-recon-reset">Reset</button>
        </div>
        <div className="flex items-center gap-3"><div className="inline-flex items-center gap-2 h-10 w-[350px] rounded-full border border-slate-300 bg-white px-4 text-sm"><Search size={14} className="text-slate-400" /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search ID, Notes, Contacts or Matters" className="flex-1 outline-none" data-testid="practice-recon-search" /></div><div className="flex-1" />
          <span className="inline-flex items-center gap-1 text-sm text-slate-700"><Columns3 size={14} /> Columns</span><span className="inline-flex items-center gap-1 text-sm text-slate-700"><Printer size={14} /> Print</span><span className="inline-flex items-center gap-1 text-sm text-slate-700"><Download size={14} /> Export</span>
          <button type="button" onClick={markSelected} disabled={!shown.some(x => sel2[x.ref])} className="inline-flex items-center gap-1 rounded bg-slate-300 px-3 py-1.5 text-sm text-slate-700 disabled:opacity-60" data-testid="practice-recon-actions"><Wrench size={14} /> Actions</button></div>
        <div className="rounded border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-[15px]">
            <thead><tr className="text-left text-slate-800"><th className="px-3 py-3"><input type="checkbox" className="h-4 w-4" /></th><th /><th className="px-3 py-3">Reconciliation</th>{["ID", "Type", "Notes", "Date ↓", "Deposits", "Withdrawals", "Payment Method", "Contact", "Matter", "Payee / Payor", "Account"].map(c => <th key={c} className="px-3 py-3">{c}</th>)}</tr></thead>
            <tbody>
              {shown.map(r => (
                <tr key={r.ref} className="border-t border-slate-200" data-testid={`practice-recon-row-${r.ref}`}>
                  <td className="px-3 py-3"><input type="checkbox" className="h-4 w-4" checked={!!sel2[r.ref]} onChange={e => setSel2(s => ({ ...s, [r.ref]: e.target.checked }))} /></td><td className="text-slate-400">⋮</td>
                  <td className="px-3 py-3"><button type="button" onClick={() => mark(r, !r.reconciled)} className="inline-flex items-center gap-1 text-slate-800 hover:text-[#1E88E5]" data-testid={`practice-recon-mark-${r.ref}`}>{r.reconciled ? <><X size={14} /> Mark Not Reconciled</> : <><Check size={14} /> Mark Reconciled</>}</button></td>
                  <td className="px-3 py-3"><button type="button" onClick={() => nav(`/practice/payments/${r.src}/${r.id}`)} className="text-[#1E88E5] hover:underline">{r.ref}</button></td><td className="px-3 py-3 text-slate-700">{r.type}</td><td className="px-3 py-3 text-slate-700">{r.notes || "-"}</td><td className="px-3 py-3 text-slate-700">{mdy(r.date)}</td>
                  <td className="px-3 py-3 text-right text-slate-700">{r.amount > 0 ? usd(r.amount) : "-"}</td>
                  <td className="px-3 py-3 text-right">{r.amount < 0 ? <span className="rounded-full bg-[#E53935] px-3 py-0.5 text-sm text-white">{usd(r.amount)}</span> : "-"}</td>
                  <td className="px-3 py-3 text-slate-700">{r.method}</td>
                  <td className="px-3 py-3"><button type="button" onClick={() => nav(`/practice/contacts/${r.contact_id}`)} className={link}>{r.contact_name}</button></td>
                  <td className="px-3 py-3"><button type="button" onClick={() => nav(`/practice/matters/${r.matter_id}`)} className={link}>{r.matter_name}</button></td>
                  <td className="px-3 py-3 text-[#1E88E5]">{r.payee_name || "-"}</td><td className="px-3 py-3 text-[#1E88E5] truncate max-w-[140px]">{r.account}</td>
                </tr>
              ))}
              {rows && shown.length === 0 && <tr><td colSpan={14} className="py-10 text-center text-sm text-slate-500">No results found! Please try adjusting your filters.</td></tr>}
            </tbody>
            <tfoot><tr className="border-t border-slate-200 text-slate-700"><td colSpan={2} /><td className="px-3 py-3">Totals</td><td colSpan={4} /><td className="px-3 py-3 text-right">{usd(sum(shown.filter(r => r.amount > 0)))} USD</td><td className="px-3 py-3 text-right text-[#E53935]">{usd(sum(shown.filter(r => r.amount < 0)))} USD</td><td colSpan={5} /></tr></tfoot>
          </table>
        </div>
        <div className="flex justify-end items-center gap-6 text-sm text-slate-600">Rows per page: 100 ▾ <span>1–{shown.length} of {shown.length}</span><span className="text-slate-300">‹ ›</span></div>
      </div>
    </PracticeShell>
  );
}

export function PracticePrintChecks() {
  const nav = useNavigate();
  const [rows, load] = useLedger();
  const [accounts, setAccounts] = useState([]);
  const [account, setAccount] = useState("Operating Account");
  const [sel2, setSel2] = useState({});
  const [f, setF] = useState({ start: "100", type: "Voucher (1 Per Page)", first: "1" });
  useEffect(() => { api.get("/practice/bank-accounts").then(r => setAccounts(r.data)).catch(() => {}); }, []);
  const queue = (rows || []).filter(r => r.account === account && r.method === "Check" && r.print_queue);
  const chosen = queue.filter(r => sel2[r.ref]);
  const print = async () => {
    if (!chosen.length) return toast.error("Select checks to print.");
    try { await api.post("/practice/checks/print", { items: chosen.map(r => ({ src: r.src, id: r.id })), start_number: Number(f.start) || 100 }); toast.success(`${chosen.length} check${chosen.length > 1 ? "s" : ""} printed.`); setSel2({}); load(); window.print(); } catch { toast.error("Could not print"); }
  };
  return (
    <PracticeShell withRail={false}>
      <div className="space-y-4 min-h-[700px] flex flex-col" data-testid="practice-print-checks">
        <div className="flex items-center gap-3 text-2xl"><button type="button" onClick={() => nav("/practice/payments")} className="text-[#1E88E5] font-semibold">Payments</button><span className="text-[#1E88E5]">›</span><span className="text-slate-800 font-semibold">Print Checks</span><span className="text-[#1E88E5]">›</span><AccountPicker accounts={accounts} value={account} onChange={setAccount} rows={rows} testId="practice-pc-account" /></div>
        <div className="flex flex-wrap items-center gap-2 text-sm"><Chip active>Method: Check</Chip><Chip active>Print Queue: Yes</Chip><Chip>Date</Chip><span className="px-2 text-slate-700">Clear</span><span className="px-2 text-slate-700">Reset</span></div>
        <div className="flex items-center gap-3"><div className="inline-flex items-center gap-2 h-10 w-[350px] rounded-full border border-slate-300 bg-white px-4 text-sm text-slate-400"><Search size={14} /> Search ID, Notes, Contacts or Matters</div><div className="flex-1" /><span className="inline-flex items-center gap-1 text-sm text-slate-700"><Columns3 size={14} /> Columns</span><span className="inline-flex items-center gap-1 text-sm text-slate-700"><Download size={14} /> Export</span><span className="inline-flex items-center gap-1 text-sm text-slate-400"><X size={14} /> Remove from Print Queue</span></div>
        <div className="rounded border border-slate-200 bg-white overflow-hidden flex-1">
          <table className="w-full text-[15px]">
            <thead><tr className="text-left text-slate-800 border-b border-slate-200"><th className="px-3 py-3"><input type="checkbox" className="h-4 w-4" onChange={e => setSel2(Object.fromEntries(queue.map(r => [r.ref, e.target.checked])))} /></th>{["ID", "Type", "Notes", "Date ↓", "Amount", "Payment Method", "Payee", "Contact", "Matter", "Company Name", "Check No."].map(c => <th key={c} className="px-3 py-3">{c}</th>)}</tr></thead>
            <tbody>
              {queue.map(r => (
                <tr key={r.ref} className="border-t border-slate-200" data-testid={`practice-pc-row-${r.ref}`}>
                  <td className="px-3 py-3"><input type="checkbox" className="h-4 w-4" checked={!!sel2[r.ref]} onChange={e => setSel2(s => ({ ...s, [r.ref]: e.target.checked }))} data-testid={`practice-pc-select-${r.ref}`} /></td>
                  <td className="px-3 py-3 text-[#1E88E5]">{r.ref}</td><td className="px-3 py-3 text-slate-700">{r.type}</td><td className="px-3 py-3 text-slate-700">{r.notes || "-"}</td><td className="px-3 py-3 text-slate-700">{mdy(r.date)}</td>
                  <td className="px-3 py-3 text-right"><span className="rounded-full bg-[#E53935] px-3 py-0.5 text-sm text-white">{usd(r.amount)}</span></td><td className="px-3 py-3 text-slate-700">{r.method}</td>
                  <td className="px-3 py-3 text-[#1E88E5]">{r.payee_name}</td><td className="px-3 py-3 text-[#1E88E5]">{r.contact_name}</td><td className="px-3 py-3 text-[#1E88E5]">{r.matter_name}</td><td /><td className="px-3 py-3 text-slate-700">{r.check_no || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows && queue.length === 0 && (
            <div className="py-16 text-center" data-testid="practice-pc-empty"><div className="text-xl font-semibold text-slate-800">No results found!</div><div className="mt-1 text-sm text-slate-600">Please try adjusting your filters to get desired results.</div><SearchX size={120} strokeWidth={0.8} className="mx-auto mt-8 text-slate-300" /></div>
          )}
        </div>
        <div className="flex justify-end items-center gap-6 text-sm text-slate-600">Rows per page: 100 ▾ <span>{queue.length ? 1 : 0}–{queue.length} of {queue.length}</span><span className="text-slate-300">‹ ›</span></div>
        <div className="flex items-end justify-between">
          <div className="space-y-3 text-sm text-slate-800">
            {[["Starting Check Number", <input key="s" className="h-10 w-96 rounded border border-slate-300 px-3" value={f.start} onChange={e => setF(p => ({ ...p, start: e.target.value }))} data-testid="practice-pc-start" />],
              ["Type Of Check", <select key="t" className="h-10 w-96 rounded border border-slate-300 px-3" value={f.type} onChange={e => setF(p => ({ ...p, type: e.target.value }))} data-testid="practice-pc-type"><option>Voucher (1 Per Page)</option><option>Standard (3 Per Page)</option></select>],
              ["On First Page Print", <select key="f" disabled={f.type !== "Standard (3 Per Page)"} className="h-10 w-96 rounded border border-slate-300 px-3 disabled:bg-slate-100" value={f.first} onChange={e => setF(p => ({ ...p, first: e.target.value }))} data-testid="practice-pc-first"><option>1</option><option>2</option><option>3</option></select>],
            ].map(([l, el]) => <div key={l} className="grid grid-cols-[250px_1fr] items-center"><span>{l}<span className="text-[#E53935]">*</span></span>{el}</div>)}
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700" data-testid="practice-pc-summary">{chosen.length} items selected, Total: {usd(chosen.reduce((a, r) => a + Math.abs(r.amount), 0))}</span>
            <button type="button" onClick={() => nav("/practice/payments")} className="rounded bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-700">Cancel</button>
            <button type="button" onClick={print} disabled={!chosen.length} className="inline-flex items-center gap-1 rounded bg-slate-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" data-testid="practice-pc-print"><Printer size={14} /> Print</button>
          </div>
        </div>
      </div>
    </PracticeShell>
  );
}
