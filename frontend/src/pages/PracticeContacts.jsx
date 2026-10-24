import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Users, User, Upload, Plus, ChevronDown, Tag, Columns3, Sparkles, Search, Settings, FileSpreadsheet, FileText, ArrowUp, MoreVertical } from "lucide-react";
import { api } from "@/lib/api";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { GreenButton } from "@/components/practice/forms";

const sel = "h-8 rounded border border-slate-300 bg-white px-2 text-sm text-slate-700 outline-none";

function Filters({ status, setStatus }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700" data-testid="practice-contacts-filters">
      <select className={`${sel} w-48`} defaultValue="Primary Contacts" data-testid="practice-contacts-type-filter">
        <option>Primary Contacts</option><option>All Contacts</option><option>Companies</option>
      </select>
      <span>Assigned To</span>
      <div className={`${sel} w-44 flex items-center gap-2`} data-testid="practice-contacts-assigned-filter">
        <span className="h-5 w-5 rounded-full bg-slate-300 grid place-items-center"><User size={12} className="text-white fill-white" /></span>
        <select className="flex-1 bg-transparent outline-none text-sm"><option>Any User</option></select>
      </div>
      <span>Status</span>
      <select className={`${sel} w-32`} value={status} onChange={e => setStatus(e.target.value)} data-testid="practice-contacts-status-filter">
        <option>Active</option><option>Archived</option><option>All</option>
      </select>
      <button type="button" className={`${sel} inline-flex items-center gap-1`} data-testid="practice-contacts-tags-filter"><Tag size={13} /> Tags <ChevronDown size={12} /></button>
      <span>Created Date</span>
      <button type="button" className={`${sel} rounded-full inline-flex items-center gap-1`} data-testid="practice-contacts-date-filter">All Time <ChevronDown size={12} /></button>
      <button type="button" className="p-1 text-[#1E88E5]" data-testid="practice-contacts-columns-btn"><Columns3 size={22} /></button>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="py-16 text-center" data-testid="practice-contacts-empty">
      <div className="relative inline-block mb-6">
        <Sparkles size={34} className="absolute -top-6 -left-10 text-[#1E88E5]" />
        <Sparkles size={22} className="absolute -top-2 right-[-40px] text-[#1E88E5]" />
        <div className="flex items-center gap-3 text-slate-700">
          <span className="h-0.5 w-28 bg-slate-500" /><Users size={72} strokeWidth={1.2} /><span className="h-0.5 w-28 bg-slate-500" />
        </div>
      </div>
      <p className="text-sm text-slate-700">A contact can be a lead, client or anyone you want.</p>
      <p className="text-sm text-slate-700">Click the green "New Contact" button on the top right.</p>
      <p className="text-sm text-slate-700 mt-1">You can also <span className="text-[#1E88E5]">import</span> or <span className="text-[#1E88E5]">sync</span> your contacts or read our <span className="text-[#1E88E5]">contacts tutorial</span>.</p>
    </div>
  );
}

const money = (v = 0) => (
  <span className="inline-block min-w-[140px] rounded-full border border-slate-300 px-3 py-0.5 text-center text-xs text-slate-700">
    ${Number(v).toFixed(2)} <span className="text-[10px]">USD</span>
  </span>
);

const initials = (n = "") => n.split(" ").filter(Boolean).map(s => s[0]).join("").slice(0, 2).toUpperCase();

const COLS = ["Name", "Status", "Trust", "Operating", "Invoices Due", "Billable", "Assigned To", "Tags"];

function ContactsTable({ rows, onOpen }) {
  const [q, setQ] = useState("");
  const shown = rows.filter(r => (r.display_name + " " + (r.company_name || "")).toLowerCase().includes(q.toLowerCase()));
  return (
    <div data-testid="practice-contacts-table">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-200">
        <Search size={16} className="text-slate-400" />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search Contacts..." data-testid="practice-contacts-search"
               className="flex-1 h-9 text-sm outline-none bg-transparent text-slate-700 placeholder:text-slate-400" />
        <button type="button" className="inline-flex items-center gap-1 text-sm text-slate-500" data-testid="practice-contacts-choose-columns"><Settings size={14} /> Choose Columns</button>
        <button type="button" className="text-slate-500" data-testid="practice-contacts-export-xls"><FileSpreadsheet size={16} /></button>
        <button type="button" className="text-slate-500" data-testid="practice-contacts-export-pdf"><FileText size={16} /></button>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[13px] uppercase tracking-wide text-slate-600">
            <th className="px-4 py-3 w-10"><input type="checkbox" className="h-4 w-4" data-testid="practice-contacts-select-all" /></th>
            {COLS.map(h => (
              <th key={h} className="px-2 py-3 text-left font-semibold">
                <span className="inline-flex items-center gap-2"><MoreVertical size={14} className="text-slate-400" />{h}{h === "Name" && <ArrowUp size={12} />}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map(r => (
            <tr key={r.id} className="border-t border-slate-200 hover:bg-slate-50" data-testid={`practice-contact-row-${r.id}`}>
              <td className="px-4 py-4"><input type="checkbox" className="h-4 w-4" /></td>
              <td className="px-2 py-4">
                <button type="button" onClick={() => onOpen(r)} className="font-semibold text-[#1E88E5] hover:underline text-[15px]" data-testid={`practice-contact-link-${r.id}`}>{r.display_name}</button>
              </td>
              <td className="px-2 py-4 text-slate-700">{r.status}</td>
              <td className="px-2 py-4">{money(0)}</td>
              <td className="px-2 py-4">{money(0)}</td>
              <td className="px-2 py-4">{money(0)}</td>
              <td className="px-2 py-4">{money(0)}</td>
              <td className="px-2 py-4">
                {r.assigned_to && <span className="inline-grid h-8 w-8 place-items-center rounded-full border-2 border-[#1E88E5] text-xs font-bold text-slate-800" title={r.assigned_to}>{initials(r.assigned_to)}</span>}
              </td>
              <td className="px-2 py-4 text-slate-500">{(r.tags || []).join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-3 px-4 py-2 border-t border-slate-200 text-xs text-slate-500">
        <span className="text-slate-300">« ‹</span><span className="text-slate-800 text-sm border-b border-slate-400 px-2">1</span><span className="text-slate-300">› »</span>
        <span className="ml-3 inline-flex items-center gap-1 rounded-full border border-slate-300 px-2.5 py-0.5 text-slate-700">50 <ChevronDown size={11} /></span>
        <span className="uppercase tracking-wide font-semibold">Items per page</span>
        <span className="flex-1 text-right uppercase tracking-wide">1 - {shown.length} of {shown.length} items</span>
      </div>
    </div>
  );
}

export default function PracticeContacts() {
  const nav = useNavigate();
  const [status, setStatus] = useState("Active");
  const [rows, setRows] = useState(null);

  useEffect(() => {
    setRows(null);
    api.get("/practice/contacts", { params: { status } }).then(r => setRows(r.data))
      .catch(() => { setRows([]); toast.error("Could not load contacts"); });
  }, [status]);

  return (
    <PracticeShell>
      <div className="space-y-3" data-testid="practice-contacts">
        <div className="flex items-center gap-3">
          <Users size={30} className="text-slate-600" strokeWidth={1.5} />
          <h1 className="text-3xl font-bold text-slate-800">Contacts</h1>
          <div className="flex-1" />
          <button type="button" data-testid="practice-contacts-import-btn"
                  className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            <Upload size={14} /> Import
          </button>
          <GreenButton onClick={() => nav("/practice/contacts/new")} testId="practice-contacts-new-btn"><Plus size={14} /> New</GreenButton>
        </div>
        <Filters status={status} setStatus={setStatus} />
        {rows && rows.length > 0 && (
          <div className="inline-flex w-[440px] items-center justify-between rounded border border-slate-200 bg-white px-3 py-3 mt-2" data-testid="practice-contacts-count-card">
            <span className="text-[11px] uppercase tracking-wider text-slate-600">Contacts</span>
            <span className="text-lg text-slate-800">{rows.length}</span>
          </div>
        )}
        <div className="rounded border border-slate-200 bg-white overflow-hidden">
          {rows === null ? <div className="p-8 text-sm text-slate-500">Loading…</div>
            : rows.length === 0 ? <EmptyState /> : <ContactsTable rows={rows} onOpen={(r) => nav(`/practice/contacts/${r.id}`)} />}
        </div>
      </div>
    </PracticeShell>
  );
}
