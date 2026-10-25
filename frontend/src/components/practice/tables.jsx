import { useState } from "react";
import { Play } from "lucide-react";
import { money, billableMoney, Avatar, ListToolbar, ListHead, ListFooter, HoverPill } from "@/components/practice/listParts";
import { fromISO } from "@/components/practice/DateTimePicker";
import { timer, showRail } from "@/components/practice/timerStore";
import { GenerateInvoiceModal } from "@/components/practice/GenerateInvoiceModal";

const link = "text-[#1E88E5] hover:underline";
const titleLink = "font-semibold text-[#1E88E5] hover:underline text-[15px]";
const act = "hover:text-[#1E88E5]";

const CONTACT_COLS = ["Name", "Status", "Trust", "Operating", "Invoices Due", "Billable", "Assigned To", "Tags"];

export function ContactsTable({ rows, nav }) {
  const [q, setQ] = useState("");
  const shown = rows.filter(r => (r.display_name + " " + (r.company_name || "")).toLowerCase().includes(q.toLowerCase()));
  return (
    <div data-testid="practice-contacts-table">
      <ListToolbar q={q} setQ={setQ} placeholder="Search Contacts..." testId="practice-contacts-search" />
      <table className="w-full text-sm">
        <ListHead cols={CONTACT_COLS} sortCol="Name" />
        <tbody>
          {shown.map(r => (
            <tr key={r.id} className="group relative border-t border-slate-200 hover:bg-slate-100" data-testid={`practice-contact-row-${r.id}`}>
              <td className="px-4 py-4"><input type="checkbox" className="h-4 w-4" /></td>
              <td className="px-2 py-4 relative">
                <button type="button" onClick={() => nav(`/practice/contacts/${r.id}`)} className={titleLink} data-testid={`practice-contact-link-${r.id}`}>{r.display_name}</button>
                <HoverPill testId={`practice-contact-actions-${r.id}`}>
                  <button type="button" onClick={() => nav(`/practice/contacts/${r.id}`)} className={act} data-testid={`practice-contact-row-edit-${r.id}`}>Edit</button>
                  <button type="button" onClick={() => nav(`/practice/matters/new?contact=${r.id}`)} className={act} data-testid={`practice-contact-row-new-matter-${r.id}`}>New Matter</button>
                  <span>Send Message</span><span>Mailsync</span>
                </HoverPill>
              </td>
              <td className="px-2 py-4 text-slate-700">{r.status}</td>
              <td className="px-2 py-4">{money(0)}</td>
              <td className="px-2 py-4">{money(0)}</td>
              <td className="px-2 py-4">{money(0)}</td>
              <td className="px-2 py-4">{billableMoney(r.billable)}</td>
              <td className="px-2 py-4"><Avatar name={r.assigned_to} /></td>
              <td className="px-2 py-4 text-slate-500">{(r.tags || []).join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ListFooter count={shown.length} />
    </div>
  );
}

const MATTER_COLS = ["Matter", "Contact", "Matter Rate", "Trust", "Operating", "Billable", "Assigned To", "Contact Tags", "Tags"];

export function MattersTable({ rows, nav, onTrackTime }) {
  const [q, setQ] = useState("");
  const shown = rows.filter(r => (r.name + " " + r.contact_name).toLowerCase().includes(q.toLowerCase()));
  return (
    <div data-testid="practice-matters-table">
      <ListToolbar q={q} setQ={setQ} placeholder="Search Matters..." testId="practice-matters-search" />
      <table className="w-full text-sm">
        <ListHead cols={MATTER_COLS} />
        <tbody>
          {shown.map(r => (
            <tr key={r.id} className="group relative border-t border-slate-200 hover:bg-slate-100" data-testid={`practice-matter-row-${r.id}`}>
              <td className="px-4 py-4"><input type="checkbox" className="h-4 w-4" /></td>
              <td className="px-2 py-4 relative">
                <button type="button" onClick={() => nav(`/practice/matters/${r.id}`)} className={titleLink} data-testid={`practice-matter-link-${r.id}`}>{r.name}</button>
                <HoverPill testId={`practice-matter-actions-${r.id}`}>
                  <button type="button" onClick={() => nav(`/practice/matters/${r.id}/edit`)} className={act} data-testid={`practice-matter-row-edit-${r.id}`}>Edit</button>
                  <button type="button" onClick={() => onTrackTime?.(r)} className={act} data-testid={`practice-matter-row-track-time-${r.id}`}>Track Time</button>
                  <button type="button" onClick={() => { timer.start({ contact_id: r.contact_id, matter_id: r.id }); showRail(); }} className={act} data-testid={`practice-matter-row-start-timer-${r.id}`}>Start Timer</button>
                  {["Add Expense", "Invoice", "Enter Payment", "Mailsync"].map(a => <span key={a}>{a}</span>)}
                </HoverPill>
              </td>
              <td className="px-2 py-4"><button type="button" onClick={() => nav(`/practice/contacts/${r.contact_id}`)} className={link}>{r.contact_name}</button></td>
              <td className="px-2 py-4 text-slate-700">{r.matter_rate}</td>
              <td className="px-2 py-4">{money(0)}</td>
              <td className="px-2 py-4">{money(0)}</td>
              <td className="px-2 py-4">{billableMoney(r.billable)}</td>
              <td className="px-2 py-4"><Avatar name={r.assigned_to} /></td>
              <td className="px-2 py-4 text-slate-500">{(r.contact_tags || []).join(", ")}</td>
              <td className="px-2 py-4 text-slate-500">{(r.tags || []).join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ListFooter count={shown.length} />
    </div>
  );
}

const TE_COLS = ["Item", "Status", "Date", "Hrs.", "Rate", "Total", "Billed By", "Contact", "Matter"];
const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
const hrs = (h) => Number(h || 0).toFixed(2).replace(/\.00$/, "");
const mdy = (iso) => { const d = fromISO(iso); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; };

export function TimeEntriesTable({ rows, nav, onEdit, onStatus, onClone, q, setQ }) {
  const [localQ, setLocalQ] = useState("");
  const [invoiceFor, setInvoiceFor] = useState(null);
  const query = q ?? localQ, setQuery = setQ ?? setLocalQ;
  const shown = rows.filter(r => `${r.contact_name} ${r.matter_name} ${r.item} ${r.description}`.toLowerCase().includes(query.toLowerCase()));
  const sumH = shown.reduce((a, r) => a + (r.hours || 0), 0);
  const sumT = shown.reduce((a, r) => a + (r.billable ? r.total || 0 : 0), 0);
  return (
    <div data-testid="practice-te-table">
      <ListToolbar q={query} setQ={setQuery} placeholder="Search Time Entries..." testId="practice-te-search" />
      <table className="w-full text-sm">
        <ListHead cols={TE_COLS} sortCol="Date" />
        <tbody>
          {shown.map(r => (
            <tr key={r.id} className="group relative border-t border-slate-200 hover:bg-slate-100 align-top" data-testid={`practice-te-row-${r.id}`}>
              <td className="px-4 py-5"><input type="checkbox" className="h-4 w-4" /></td>
              <td className="px-2 py-5 max-w-xs relative">
                <div className="inline-flex items-center gap-1.5 font-semibold text-[#1E88E5] text-[15px]"><Play size={13} className="fill-[#1E88E5]" />{r.item || "Time"}</div>
                <div className="text-xs text-slate-500 whitespace-pre-line line-clamp-2">{r.description}</div>
                <HoverPill testId={`practice-te-actions-${r.id}`}>
                  <button type="button" onClick={() => onEdit(r)} className={act} data-testid={`practice-te-edit-${r.id}`}>Edit</button>
                  {r.billing_status === "Billable" && <button type="button" onClick={() => setInvoiceFor(r.contact_id)} className="text-[#1E88E5] hover:underline" data-testid={`practice-te-invoice-${r.id}`}>Invoice</button>}
                  {r.billing_status !== "Billed" && <button type="button" onClick={() => onStatus(r, "Billed")} className="text-[#43A047] hover:underline" data-testid={`practice-te-billed-${r.id}`}>Billed</button>}
                  {r.billing_status !== "Billable" && <button type="button" onClick={() => onStatus(r, "Billable")} className={act} data-testid={`practice-te-billable-${r.id}`}>Billable</button>}
                  {r.billing_status !== "Not Billable" && <button type="button" onClick={() => onStatus(r, "Not Billable")} className="text-[#1E88E5] hover:underline" data-testid={`practice-te-notbillable-${r.id}`}>Not Billable</button>}
                  <button type="button" onClick={() => onClone(r)} className={act} data-testid={`practice-te-clone-${r.id}`}>Clone</button>
                </HoverPill>
              </td>
              <td className="px-2 py-5">
                <span data-testid={`practice-te-status-${r.id}`} className={`inline-block min-w-[110px] rounded-full px-3 py-0.5 text-center text-[10px] font-bold uppercase tracking-wider ${
                  r.billing_status === "Billed" ? "bg-[#43A047] text-white" : r.billing_status === "Not Billable" ? "border border-slate-400 bg-white text-slate-700" : "bg-[#FFA726] text-white"}`}>{r.billing_status}</span>
              </td>
              <td className="px-2 py-5 text-slate-700">{mdy(r.date)}</td>
              <td className="px-2 py-5 text-slate-700">{hrs(r.hours)}</td>
              <td className="px-2 py-5 text-slate-700">{usd(r.hourly_rate)}</td>
              <td className="px-2 py-5 text-slate-700">{usd(r.billable ? r.total : 0)}</td>
              <td className="px-2 py-5"><button type="button" onClick={() => nav("/practice/users/me")} className={link} data-testid={`practice-te-billed-by-${r.id}`}>{r.billed_by}</button></td>
              <td className="px-2 py-5"><button type="button" onClick={() => nav(`/practice/contacts/${r.contact_id}`)} className={link}>{r.contact_name}</button></td>
              <td className="px-2 py-5"><button type="button" onClick={() => nav(`/practice/matters/${r.matter_id}`)} className={link}>{r.matter_name}</button></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-slate-200 bg-slate-50 font-semibold text-slate-800" data-testid="practice-te-totals-row">
            <td colSpan={4} /><td className="px-2 py-2">{sumH.toFixed(2)}</td><td /><td className="px-2 py-2">{usd(sumT)} <span className="text-[10px] font-normal">USD</span></td><td colSpan={3} />
          </tr>
        </tfoot>
      </table>
      <ListFooter count={shown.length} />
      {invoiceFor && <GenerateInvoiceModal contactId={invoiceFor} onClose={() => setInvoiceFor(null)} />}
    </div>
  );
}
