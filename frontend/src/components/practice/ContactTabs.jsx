import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Plus, ChevronRight, ChevronDown, Mail, Workflow } from "lucide-react";
import { api } from "@/lib/api";
import { sel, UserFilter, PillFilter, TagsFilter, DateRangeFilter } from "@/components/practice/listParts";
import { MattersTable, TimeEntriesTable, ActivitiesTable } from "@/components/practice/tables";
import { InvoicesTable } from "@/pages/PracticeInvoices";
import { filterActivities } from "@/pages/PracticeActivities";
import { PaymentsTable, ActionsMenu } from "@/pages/PracticePaymentsPages";
import { NewPaymentModal } from "@/components/practice/NewPaymentModal";
import { NewActivityMenu, ActivityModal } from "@/components/practice/ActivityModal";
import { ApplyWorkflowModal } from "@/components/practice/ApplyWorkflowModal";
import { NewTimeEntryModal } from "@/components/practice/NewTimeEntryModal";
import { Can } from "@/components/practice/perms";

const green = "inline-flex items-center gap-1.5 rounded-full bg-[#43A047] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#388E3C]";
const white = "inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-700 hover:bg-slate-50";

const Bar = ({ children, testId }) => <div className="rounded border border-slate-200 bg-white px-4 py-3 flex items-center gap-2" data-testid={testId}>{children}</div>;
const Filters = ({ children, testId }) => <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700" data-testid={testId}>{children}</div>;
const Grid = ({ children, loading, empty, isEmpty }) => (
  <div className="rounded border border-slate-200 bg-white overflow-hidden">
    {loading ? <div className="p-8 text-sm text-slate-500">Loading…</div> : isEmpty ? <div className="px-6 py-10 text-center text-sm text-slate-500">{empty}</div> : children}
  </div>
);
export const RecentActivity = () => {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded border border-slate-200 bg-white px-4 py-3" data-testid="practice-contact-recent-activity">
      <button type="button" onClick={() => setOpen(v => !v)} className="flex items-center gap-1 text-sm font-bold uppercase tracking-wide text-slate-800">Recent Activity {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button>
      {open && <div className="pt-3 text-sm text-slate-500">Nothing here yet.</div>}
    </section>
  );
};

export function MattersTab({ contactId }) {
  const nav = useNavigate();
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get("/practice/matters", { params: { status: "All", contact_id: contactId } }).then(r => setRows(r.data)).catch(() => setRows([])); }, [contactId]);
  return (
    <div className="space-y-4" data-testid="practice-contact-matters">
      <Bar><Can feature="Matters" action="create"><button type="button" onClick={() => nav(`/practice/matters/new?contact=${contactId}`)} className={green} data-testid="practice-contact-matters-new"><Plus size={14} /> New Matter</button></Can></Bar>
      <Filters>
        <span>Assigned To</span><UserFilter testId="practice-cm-assigned" /><span>Originated By</span><UserFilter testId="practice-cm-originated" />
        <span>Status</span><select className={`${sel} w-32`} defaultValue="Any"><option>Any</option><option>Open</option><option>Closed</option></select>
        <TagsFilter testId="practice-cm-tags" /><PillFilter testId="practice-cm-created">Create...</PillFilter><PillFilter testId="practice-cm-range">All Time</PillFilter>
      </Filters>
      <Grid loading={rows === null} isEmpty={rows?.length === 0} empty="No matters yet."><MattersTable rows={rows || []} nav={nav} hideContact /></Grid>
      <RecentActivity />
    </div>
  );
}

export function ActivitiesTab({ contactId }) {
  const nav = useNavigate();
  const [rows, setRows] = useState(null);
  const [modal, setModal] = useState(null);
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("Any");
  const [assigned, setAssigned] = useState("");
  const [range, setRange] = useState({ preset: "All Time" });
  const load = () => api.get("/practice/activities", { params: { contact_id: contactId } }).then(r => setRows(r.data)).catch(() => setRows([]));
  useEffect(() => { load(); }, [contactId]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = () => { setModal(null); load(); };
  const users = [...new Set((rows || []).flatMap(r => r.assigned_users || []))].sort();
  const shown = filterActivities((rows || []).filter(r => !kind || r.kind === kind), { status, assigned, range });
  return (
    <div className="space-y-4" data-testid="practice-contact-activities">
      <Bar>
        <NewActivityMenu onPick={setModal} />
        <button type="button" className={white}><Mail size={14} /> MailSync</button>
        <Can feature="Activities (Tasks, Events & Calls)" action="create"><button type="button" onClick={() => setModal("apply")} className={white} data-testid="practice-ca-apply-workflow"><Workflow size={14} /> Apply Workflow</button></Can>
      </Bar>
      <Filters>
        <select className={`${sel} w-36 font-semibold`} value={kind} onChange={e => setKind(e.target.value)} data-testid="practice-ca-kind"><option value="">All Activities</option><option value="task">Tasks</option><option value="event">Events</option><option value="note">Notes</option><option value="call">Calls</option></select>
        <span>Status</span><select className={`${sel} w-32`} value={status} onChange={e => setStatus(e.target.value)} data-testid="practice-ca-status"><option>Any</option><option>Completed</option><option>Overdue</option><option>Not Completed</option><option>In Progress</option><option>Scheduled</option></select>
        <span>Assigned To</span><UserFilter testId="practice-ca-assigned" value={assigned} onChange={setAssigned} options={users} /><span>Created By</span><UserFilter testId="practice-ca-created-by" /><TagsFilter testId="practice-ca-tags" /><span>Date Range</span><DateRangeFilter value={range} onChange={setRange} testId="practice-ca-range" />
      </Filters>
      <Grid loading={rows === null} isEmpty={rows?.length === 0} empty="No activities yet."><ActivitiesTable rows={shown} nav={nav} onOpen={setModal} onLogTime={(r) => setModal({ logTime: r })} /></Grid>
      <RecentActivity />
      {modal === "apply" ? <ApplyWorkflowModal contactId={contactId} onClose={() => setModal(null)} onApplied={done} />
        : <ActivityModal modal={modal} defaults={{ contact_id: contactId }} onClose={() => setModal(null)} onSaved={done} />}
    </div>
  );
}

export function InvoicesTab({ contactId }) {
  const nav = useNavigate();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("Any");
  useEffect(() => { api.get("/practice/invoices", { params: { contact_id: contactId } }).then(r => setRows(r.data.rows)).catch(() => setRows([])); }, [contactId]);
  const shown = (rows || []).filter(r => status === "Any" || r.status === status).filter(r => `I-${r.number} ${r.matters.map(m => m.name).join(" ")}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-4" data-testid="practice-contact-invoices">
      <Bar><Can feature="Invoices" action="create"><button type="button" onClick={() => nav(`/practice/invoices/new?contact=${contactId}`)} className={green} data-testid="practice-ci-new"><Plus size={14} /> New Invoice</button></Can></Bar>
      <Filters>
        <select className={`${sel} w-32 font-semibold`} defaultValue="All Invoices"><option>All Invoices</option></select><PillFilter testId="practice-ci-bill-date">Bill Date</PillFilter><PillFilter testId="practice-ci-range">All Time</PillFilter>
        <span>Status</span><select className={`${sel} w-28`} value={status} onChange={e => setStatus(e.target.value)} data-testid="practice-ci-status"><option>Any</option><option>Saved</option><option>Sent</option><option>Paid</option></select>
      </Filters>
      <Grid loading={rows === null} isEmpty={rows?.length === 0} empty="No invoices yet."><InvoicesTable rows={shown} nav={nav} q={q} setQ={setQ} hideContact /></Grid>
      <RecentActivity />
    </div>
  );
}

export function PaymentsTab({ contactId }) {
  const nav = useNavigate();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [newPay, setNewPay] = useState(false);
  useEffect(() => { api.get("/practice/ledger", { params: { contact_id: contactId } }).then(r => setRows(r.data)).catch(() => setRows([])); }, [contactId]);
  const shown = (rows || []).filter(r => `${r.ref} ${r.matter_name} ${r.notes}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-4" data-testid="practice-contact-payments">
      <Bar><ActionsMenu nav={nav} onContactPayment={() => setNewPay(true)} /></Bar>
      <Filters>
        <span>Bank Account</span><select className={`${sel} w-56`} defaultValue=""><option value="">Select Bank Account...</option><option>Operating Account</option><option>Trust Account</option></select>
        <span>Payment Method</span><select className={`${sel} w-56`} defaultValue="Any method"><option>Any method</option><option>Cash</option><option>Check</option><option>Credit / Debit Card</option></select>
        <span>Date Range</span><PillFilter testId="practice-cp-range">All Time</PillFilter>
      </Filters>
      {rows === null ? <div className="rounded border border-slate-200 bg-white p-8 text-sm text-slate-500">Loading…</div> : <PaymentsTable rows={rows} nav={nav} q={q} setQ={setQ} shown={shown} />}
      <RecentActivity />
      {newPay && <NewPaymentModal contactId={contactId} onClose={() => setNewPay(false)} />}
    </div>
  );
}

export function TimeTab({ contactId }) {
  const nav = useNavigate();
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState("Any");
  const [modal, setModal] = useState(false);
  const [edit, setEdit] = useState(null);
  const load = () => api.get("/practice/time-entries/all", { params: { contact_id: contactId } }).then(r => setRows(r.data)).catch(() => setRows([]));
  useEffect(() => { load(); }, [contactId]); // eslint-disable-line react-hooks/exhaustive-deps
  const setStatus2 = async (r, st) => { try { await api.patch(`/practice/time-entries/${r.id}/status`, { status: st }); toast.success("Item saved successfully."); load(); } catch { toast.error("Could not update"); } };
  const clone = async (r) => { try { await api.post(`/practice/time-entries/${r.id}/clone`); toast.success("Item saved successfully."); load(); } catch { toast.error("Could not clone"); } };
  const shown = (rows || []).filter(r => status === "Any" || r.billing_status === status);
  return (
    <div className="space-y-4" data-testid="practice-contact-time">
      <Bar>
        <Can feature="Time Entries" action="create"><button type="button" onClick={() => setModal(true)} className={green} data-testid="practice-ct-new"><Plus size={14} /> New Time Entry</button></Can>
        <button type="button" className={white}><Plus size={14} /> Multiple Time Entries</button>
      </Bar>
      <Filters>
        <span>Billed By</span><UserFilter testId="practice-ct-billed-by" /><span>Status</span>
        <select className={`${sel} w-28`} value={status} onChange={e => setStatus(e.target.value)} data-testid="practice-ct-status"><option>Any</option><option>Billable</option><option>Billed</option><option>Not Billable</option></select>
        <span>Date Range</span><PillFilter testId="practice-ct-range">All Time</PillFilter>
      </Filters>
      <Grid loading={rows === null} isEmpty={rows?.length === 0} empty="No time entries yet."><TimeEntriesTable rows={shown} nav={nav} onEdit={setEdit} onStatus={setStatus2} onClone={clone} hideContact /></Grid>
      <RecentActivity />
      {modal && <NewTimeEntryModal task={{ contact_id: contactId }} onClose={() => setModal(false)} onSaved={() => { setModal(false); load(); }} />}
      {edit && <NewTimeEntryModal entry={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </div>
  );
}
