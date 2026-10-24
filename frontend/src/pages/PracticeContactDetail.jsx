import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Users, User, Pencil, Trash2, Archive, Play, Plus, Star, ChevronDown, ChevronRight, ArrowRightCircle } from "lucide-react";
import { api } from "@/lib/api";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { PracticeStatTiles } from "@/components/practice/PracticeDashboardBlocks";

const TABS = ["About", "Matters", "Activities", "Notes", "Messages", "Invoices", "Payments", "Time", "Expenses", "Flat Fees", "Relationships", "Intakes", "Files"];
const slug = (s) => s.toLowerCase().replace(/\s+/g, "-");

const Field = ({ label, help, children }) => (
  <div className="grid grid-cols-[210px_1fr] items-start gap-4 py-2 text-[15px]">
    <div className="text-[13px] font-semibold uppercase tracking-wide text-slate-800 flex items-center gap-1">{help && <span className="text-slate-400">?</span>}{label}</div>
    <div className="text-slate-700">{children}</div>
  </div>
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

function AboutTab({ c }) {
  const p = c.contacts?.[0] || {};
  return (
    <div className="space-y-4" data-testid="practice-contact-about">
      <section className="rounded border border-slate-200 bg-white px-6 py-5">
        <h2 className="text-lg font-bold uppercase tracking-wide text-slate-800 mb-4">Contact</h2>
        <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6">
          <div className="h-32 w-44 rounded border border-slate-300 bg-slate-300 grid place-items-center"><User size={90} className="text-white fill-white" /></div>
          <div>
            <Field label="Contact Name">{c.display_name}</Field>
            <Field label="Client Portal" help>{p.client_portal ? "Yes" : "No"}</Field>
            {p.email && <Field label="Email">{p.email}</Field>}
            {p.mobile && <Field label="Mobile">{p.mobile}</Field>}
            {c.company_name && <Field label="Company">{c.company_name}</Field>}
          </div>
        </div>
      </section>
      <section className="rounded border border-slate-200 bg-white px-6 py-5">
        <Field label="Assigned To"><span className="text-[#1E88E5]">{c.assigned_to || "—"}</span></Field>
        <Field label="Status">{c.status}</Field>
        <Field label="Internal ID" help>{c.internal_id ?? "—"}</Field>
        <Field label="Invoice Template">{c.invoice_template || "Default Invoice Template"}</Field>
        <Field label="Client Portal Settings"><span className="text-[#1E88E5]">Client Portal Settings</span></Field>
      </section>
      <Collapsible title="History" testId="practice-contact-history" />
      <Collapsible title="Recent Activity" testId="practice-contact-recent-activity" />
    </div>
  );
}

export default function PracticeContactDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [c, setC] = useState(null);
  const [tab, setTab] = useState("About");

  useEffect(() => {
    api.get(`/practice/contacts/${id}`).then(r => setC(r.data))
      .catch(() => { toast.error("Contact not found"); nav("/practice/contacts"); });
  }, [id, nav]);

  return (
    <PracticeShell>
      {!c ? <div className="p-8 text-sm text-slate-500">Loading…</div> : (
        <div className="space-y-4" data-testid="practice-contact-detail">
          <div className="flex items-center gap-3">
            <Users size={30} className="text-slate-600" strokeWidth={1.5} />
            <h1 className="text-3xl font-bold text-slate-800" data-testid="practice-contact-detail-name">{c.display_name}</h1>
            <button type="button" className="text-[#1E88E5]" data-testid="practice-contact-edit-btn"><Pencil size={16} /></button>
            <button type="button" className="text-[#1E88E5]" data-testid="practice-contact-delete-btn"><Trash2 size={16} /></button>
            <button type="button" className="text-[#1E88E5]" data-testid="practice-contact-archive-btn"><Archive size={16} /></button>
            <div className="flex-1" />
            <Play size={14} className="text-[#1E88E5] fill-[#1E88E5]" />
            <button type="button" data-testid="practice-contact-new-matter-btn"
                    className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
              New Matter <ArrowRightCircle size={14} />
            </button>
            <button type="button" className="h-8 w-8 rounded-full border border-slate-300 bg-white grid place-items-center text-slate-700" data-testid="practice-contact-star-btn"><Star size={14} /></button>
            <button type="button" data-testid="practice-contact-new-btn"
                    className="inline-flex items-center gap-1 rounded-full bg-[#43A047] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#388E3C]">
              <Plus size={14} /> New <ChevronDown size={12} />
            </button>
          </div>
          <PracticeStatTiles />
          <div className="flex flex-wrap border-b border-slate-200" data-testid="practice-contact-tabs">
            {TABS.map(t => (
              <button key={t} type="button" onClick={() => setTab(t)} data-testid={`practice-contact-tab-${slug(t)}`}
                      className={`-mb-px px-3 py-2 text-sm border ${tab === t
                        ? "border-slate-200 border-b-white bg-white text-slate-900 font-medium rounded-t"
                        : "border-transparent text-slate-500 hover:text-slate-700"}`}>
                {t}
              </button>
            ))}
          </div>
          {tab === "About" ? <AboutTab c={c} /> : (
            <section className="rounded border border-slate-200 bg-white px-6 py-10 text-center text-sm text-slate-500" data-testid={`practice-contact-panel-${slug(tab)}`}>
              No {tab.toLowerCase()} for {c.display_name} yet.
            </section>
          )}
        </div>
      )}
    </PracticeShell>
  );
}
