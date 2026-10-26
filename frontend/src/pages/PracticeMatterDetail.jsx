import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Briefcase, Pencil, Trash2, Archive, Play, Plus, Star, ChevronDown, ChevronRight, Info } from "lucide-react";
import { api } from "@/lib/api";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { PracticeStatTiles } from "@/components/practice/PracticeDashboardBlocks";
import { pushRecent } from "@/components/practice/PracticeRightRail";

const TABS = ["Matter", "Contact", "Activities", "Notes", "Messages", "Invoices", "Payments", "Time Entries", "Expenses", "Flat Fees", "Relationships", "Intakes", "Files"];
const slug = (s) => s.toLowerCase().replace(/\s+/g, "-");

const Field = ({ label, help, children }) => (
  <div className="grid grid-cols-[210px_1fr] items-start gap-4 py-2 text-[15px]">
    <div className="text-[13px] font-semibold uppercase tracking-wide text-slate-800 flex items-center gap-1">{help && <span className="text-slate-400">?</span>}{label}</div>
    <div className="text-slate-700">{children}</div>
  </div>
);

const Card = ({ title, children }) => (
  <section className="rounded border border-slate-200 bg-white px-6 py-5">
    {title && <h2 className="text-lg font-bold uppercase tracking-wide text-slate-800 mb-2">{title}</h2>}
    {children}
  </section>
);

const Collapsible = ({ title, testId }) => {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded border border-slate-200 bg-white px-4 py-3" data-testid={testId}>
      <button type="button" onClick={() => setOpen(v => !v)} className="flex items-center gap-1 text-sm font-bold uppercase tracking-wide text-slate-800">
        {title} {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {open && <div className="pt-3 text-sm text-slate-500">Nothing here yet.</div>}
    </section>
  );
};

function MatterTab({ m, nav }) {
  return (
    <div className="space-y-4" data-testid="practice-matter-tab-matter-panel">
      <Card title="About">
        <Field label="Contact"><button type="button" onClick={() => nav(`/practice/contacts/${m.contact_id}`)} className="text-[#1E88E5] hover:underline" data-testid="practice-matter-contact-link">{m.contact_name}</button></Field>
        <Field label="Matter Name">{m.name}</Field>
        {m.notes && <Field label="Notes"><div className="prose prose-sm max-w-none text-slate-700" dangerouslySetInnerHTML={{ __html: m.notes }} /></Field>}
      </Card>
      <Card title="Billing">
        <Field label="Matter Rate">{m.matter_rate}{m.custom_rate != null && ` — $${Number(m.custom_rate).toFixed(2)}`}</Field>
        <Field label="Invoice Template" help><span className="inline-flex items-center gap-1"><Info size={13} className="text-slate-700" />{m.invoice_template || "Default Invoice Template"}</span></Field>
        <Field label="Evergreen Retainer">{m.evergreen_retainer ? "Yes" : "No"}</Field>
      </Card>
      {(m.statute_of_limitations || m.open_date || m.close_date) && (
        <Card title="Dates">
          {m.statute_of_limitations && <Field label="Statute of Limitations">{m.statute_of_limitations}</Field>}
          {m.open_date && <Field label="Open Date">{m.open_date}</Field>}
          {m.close_date && <Field label="Close Date">{m.close_date}</Field>}
        </Card>
      )}
      <Card>
        <Field label="Assigned To"><span className="text-[#1E88E5]">{m.assigned_to || "—"}</span></Field>
        {m.originating_attorney && <Field label="Originating Attorney">{m.originating_attorney}</Field>}
        <Field label="Status">{m.status}</Field>
        <Field label="Internal ID" help>{m.matter_number}</Field>
        {m.tags?.length > 0 && <Field label="Tags">{m.tags.join(", ")}</Field>}
      </Card>
      <Collapsible title="History" testId="practice-matter-history" />
      <Collapsible title="Recent Activity" testId="practice-matter-recent-activity" />
    </div>
  );
}

export default function PracticeMatterDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [m, setM] = useState(null);
  const [tab, setTab] = useState("Matter");

  useEffect(() => {
    api.get(`/practice/matters/${id}`).then(r => { setM(r.data); pushRecent({ label: `${r.data.contact_name} | ${r.data.name}`, to: `/practice/matters/${id}` }); })
      .catch(() => { toast.error("Matter not found"); nav("/practice/matters"); });
  }, [id, nav]);

  return (
    <PracticeShell>
      {!m ? <div className="p-8 text-sm text-slate-500">Loading…</div> : (
        <div className="space-y-4" data-testid="practice-matter-detail">
          <div className="flex items-center gap-3">
            <Briefcase size={30} className="text-slate-600" strokeWidth={1.5} />
            <h1 className="text-3xl font-bold text-slate-800" data-testid="practice-matter-detail-title">
              {m.contact_name} <span className="font-light text-slate-400">|</span> {m.name}
            </h1>
            <button type="button" title="Edit" onClick={() => nav(`/practice/matters/${id}/edit`)} className="text-[#1E88E5]" data-testid="practice-matter-edit-btn"><Pencil size={16} /></button>
            <button type="button" className="text-[#1E88E5]" data-testid="practice-matter-delete-btn"><Trash2 size={16} /></button>
            <button type="button" className="text-[#1E88E5]" data-testid="practice-matter-archive-btn"><Archive size={16} /></button>
            <div className="flex-1" />
            <Play size={14} className="text-[#1E88E5] fill-[#1E88E5]" />
            <button type="button" className="h-8 w-8 rounded-full border border-slate-300 bg-white grid place-items-center text-slate-700" data-testid="practice-matter-star-btn"><Star size={14} /></button>
            <button type="button" data-testid="practice-matter-new-btn"
                    className="inline-flex items-center gap-1 rounded-full bg-[#43A047] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#388E3C]"><Plus size={14} /> New <ChevronDown size={12} /></button>
          </div>
          <PracticeStatTiles values={m.financials} />
          <div className="flex flex-wrap border-b border-slate-200" data-testid="practice-matter-tabs">
            {TABS.map(t => {
              const n = { Activities: m.counts?.activities, "Time Entries": m.counts?.time }[t];
              return (
              <button key={t} type="button" onClick={() => setTab(t)} data-testid={`practice-matter-tab-${slug(t)}`}
                      className={`-mb-px px-3 py-2 text-sm border inline-flex items-center gap-1 ${tab === t ? "border-slate-200 border-b-white bg-white text-slate-900 font-medium rounded-t" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
                {t}{n > 0 && <span className="inline-grid h-4 min-w-4 place-items-center rounded-full border border-slate-400 px-1 text-[10px] text-slate-600">{n}</span>}
              </button>
            ); })}
          </div>
          {tab === "Matter" ? <MatterTab m={m} nav={nav} /> : tab === "Contact" ? (
            <Card title="Contact">
              <Field label="Contact"><button type="button" onClick={() => nav(`/practice/contacts/${m.contact_id}`)} className="text-[#1E88E5] hover:underline">{m.contact_name}</button></Field>
            </Card>
          ) : (
            <section className="rounded border border-slate-200 bg-white px-6 py-10 text-center text-sm text-slate-500" data-testid={`practice-matter-panel-${slug(tab)}`}>
              No {tab.toLowerCase()} for this matter yet.
            </section>
          )}
        </div>
      )}
    </PracticeShell>
  );
}
