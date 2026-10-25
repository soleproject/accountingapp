import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Clock, Pencil, Trash2, ChevronDown } from "lucide-react";
import { api } from "@/lib/api";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { NewTimeEntryModal } from "@/components/practice/NewTimeEntryModal";
import { fromISO } from "@/components/practice/DateTimePicker";

const usd = (n) => `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const mdy = (iso) => { const d = fromISO(iso); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; };
const Section = ({ title, children, testId }) => (
  <section className="rounded border border-slate-200 bg-white px-8 py-6" data-testid={testId}>
    <h2 className="text-lg font-bold uppercase tracking-wide text-slate-800 mb-3">{title}</h2>
    <dl className="grid grid-cols-[230px_1fr] gap-y-4 text-[15px]">{children}</dl>
  </section>
);
const Row = ({ label, sub, children }) => (
  <>
    <dt className="text-[13px] font-semibold uppercase tracking-wide text-slate-800">{label}{sub && <span className="ml-1 text-[11px] font-normal text-slate-500 normal-case">({sub})</span>}</dt>
    <dd className="text-slate-700">{children}</dd>
  </>
);
const Link = ({ onClick, children, testId }) => <button type="button" onClick={onClick} className="text-[#1E88E5] hover:underline" data-testid={testId}>{children}</button>;

export default function PracticeTimeEntryDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [te, setTe] = useState(null);
  const [edit, setEdit] = useState(false);
  const load = () => api.get(`/practice/time-entries/${id}`).then(r => setTe(r.data)).catch(() => { toast.error("Time entry not found"); nav("/practice/time-entries"); });
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const del = async () => {
    if (!window.confirm("Delete this time entry?")) return;
    try { await api.delete(`/practice/time-entries/${id}`); toast.success("Time entry deleted."); nav("/practice/time-entries"); } catch { toast.error("Could not delete"); }
  };
  if (!te) return <PracticeShell withRail={false}><div className="p-8 text-sm text-slate-500">Loading…</div></PracticeShell>;
  return (
    <PracticeShell withRail={false}>
      <div className="space-y-4" data-testid="practice-te-detail">
        <div className="flex items-center gap-3">
          <Clock size={30} className="text-slate-600" strokeWidth={1.5} />
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2" data-testid="practice-te-detail-title">
            <button type="button" onClick={() => nav(`/practice/contacts/${te.contact_id}`)} className="hover:text-[#1E88E5]">{te.contact_name}</button>
            <span className="text-slate-300 font-light">|</span>
            <button type="button" onClick={() => nav(`/practice/matters/${te.matter_id}`)} className="hover:text-[#1E88E5]">{te.matter_name}</button>
            <span className="text-slate-300 font-light">|</span>{te.item || "Time"}
          </h1>
          <button type="button" onClick={() => setEdit(true)} className="text-[#1E88E5]" data-testid="practice-te-detail-edit"><Pencil size={15} /></button>
          <button type="button" onClick={del} className="text-[#1E88E5]" data-testid="practice-te-detail-delete"><Trash2 size={15} /></button>
        </div>
        <Section title="Linked To" testId="practice-te-detail-linked">
          <Row label="Contact"><Link onClick={() => nav(`/practice/contacts/${te.contact_id}`)} testId="practice-te-detail-contact">{te.contact_name}</Link></Row>
          <Row label="Matter"><Link onClick={() => nav(`/practice/matters/${te.matter_id}`)} testId="practice-te-detail-matter">{te.matter_name}</Link></Row>
        </Section>
        <Section title="Time Entries" testId="practice-te-detail-time">
          <Row label="Hours">{Number(te.hours).toFixed(2)} Hours</Row>
          <Row label="Date">{mdy(te.date)}</Row>
          {te.description && <Row label="Description"><span className="whitespace-pre-line">{te.description}</span></Row>}
        </Section>
        <Section title="Billing" testId="practice-te-detail-billing">
          <Row label="Billable">{te.billable ? "Yes" : "No"}</Row>
          <Row label="Billed By"><Link onClick={() => nav("/practice/users/me")} testId="practice-te-detail-billed-by">{te.billed_by}</Link></Row>
          <Row label="Status">{te.billing_status}</Row>
          {te.invoice_id && <Row label="Invoice"><Link onClick={() => nav(`/practice/invoices/${te.invoice_id}`)} testId="practice-te-detail-invoice">I-{te.invoice_number}</Link></Row>}
          <Row label="Hourly Rate" sub="USD">{usd(te.hourly_rate)}</Row>
          <Row label="Total" sub="USD">{usd(te.billable ? te.total : 0)}</Row>
          {te.private_notes && <Row label="Private Notes">{te.private_notes}</Row>}
        </Section>
        <button type="button" className="w-full rounded border border-slate-200 bg-white px-4 py-3 text-left text-lg font-bold uppercase tracking-wide text-slate-800 flex items-center gap-1" data-testid="practice-te-detail-history">History <ChevronDown size={16} /></button>
      </div>
      {edit && <NewTimeEntryModal entry={te} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); load(); }} />}
    </PracticeShell>
  );
}
