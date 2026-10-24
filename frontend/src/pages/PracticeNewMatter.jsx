import { useEffect, useState } from "react";
import { useNavigate, useSearchParams, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Briefcase, X, Check, ChevronDown } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { Row, input, Toggle, Section } from "@/components/practice/forms";
import { RichNotes } from "@/components/practice/RichNotes";

const LW = "210px";
const W = "max-w-xl";

const DateInput = ({ value, onChange, testId }) => (
  <input type="date" className={input} value={value} onChange={onChange} data-testid={testId} />
);

const EMPTY = {
  contact_id: "", name: "", notes: "", matter_rate: "User Hourly Rate", custom_rate: "", invoice_template: "", evergreen_retainer: false,
  additional_invoice_recipients: "", statute_of_limitations: "", open_date: "", close_date: "",
  assigned_to: "", originating_attorney: "", tags: "", status: "Open", matter_number: "",
};

export default function PracticeNewMatter() {
  const nav = useNavigate();
  const { user } = useAuth();
  const { id } = useParams();
  const [params] = useSearchParams();
  const [contacts, setContacts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ ...EMPTY, assigned_to: user?.name || "", contact_id: params.get("contact") || "" });
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e?.target ? e.target.value : e }));

  useEffect(() => {
    api.get("/practice/contacts", { params: { status: "All" } }).then(r => setContacts(r.data)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!id) return;
    api.get(`/practice/matters/${id}`).then(r => {
      const m = r.data;
      setF({ ...EMPTY, ...Object.fromEntries(Object.entries(m).filter(([k]) => k in EMPTY).map(([k, v]) => [k, v ?? ""])),
             tags: (m.tags || []).join(", "), matter_number: m.matter_number || "" });
    }).catch(() => { toast.error("Matter not found"); nav("/practice/matters"); });
  }, [id, nav]);

  const save = async (addNew) => {
    if (!f.contact_id) return toast.error("Select a contact.");
    if (!f.name.trim()) return toast.error("Matter name is required.");
    setBusy(true);
    try {
      const payload = {
        ...f, custom_rate: f.custom_rate === "" ? null : Number(f.custom_rate), matter_number: f.matter_number || null,
        statute_of_limitations: f.statute_of_limitations || null, open_date: f.open_date || null, close_date: f.close_date || null,
        tags: f.tags.split(",").map(t => t.trim()).filter(Boolean),
      };
      const r = id ? await api.put(`/practice/matters/${id}`, payload) : await api.post("/practice/matters", payload);
      toast.success("Matter saved");
      if (addNew) { setF({ ...EMPTY, assigned_to: user?.name || "" }); if (id) nav("/practice/matters/new"); }
      else nav(`/practice/matters/${r.data.id}`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not save matter");
    } finally { setBusy(false); }
  };

  return (
    <PracticeShell>
      <div className="space-y-4" data-testid="practice-new-matter">
        <div className="flex items-center gap-3">
          <Briefcase size={30} className="text-slate-600" strokeWidth={1.5} />
          <h1 className="text-3xl font-bold text-slate-800">{id ? "Edit Matter" : "New Matter"}</h1>
        </div>
        <Section title="About" testId="practice-matter-about-card">
          <div className={W}>
            <Row label="Contact" required labelWidth={LW}>
              <select className={input} value={f.contact_id} onChange={set("contact_id")} data-testid="practice-matter-contact">
                <option value="">Select Contact...</option>
                {contacts.map(c => <option key={c.id} value={c.id}>{c.display_name}</option>)}
              </select>
            </Row>
            <Row label="Matter Name" required labelWidth={LW}><input className={input} placeholder="Add Name..." value={f.name} onChange={set("name")} data-testid="practice-matter-name" /></Row>
            <Row label="Notes" labelWidth={LW}><RichNotes key={id || "new"} value={f.notes} onChange={set("notes")} testId="practice-matter-notes" /></Row>
          </div>
        </Section>
        <Section title="Custom Fields">
          <div className={W}>
            <Row label="Custom Fields" help labelWidth={LW}>
              <button type="button" className={`${input} flex items-center justify-between text-slate-400`} data-testid="practice-matter-custom-fields">Add custom fields... <ChevronDown size={14} /></button>
            </Row>
          </div>
        </Section>
        <Section title="Billing">
          <div className={W}>
            <Row label="Matter Rate" labelWidth={LW}>
              <select className={input} value={f.matter_rate} onChange={set("matter_rate")} data-testid="practice-matter-rate">
                {["User Hourly Rate", "Custom Hourly Rate", "Flat Fee", "Contingency", "Non-Billable"].map(o => <option key={o}>{o}</option>)}
              </select>
            </Row>
            {(f.matter_rate === "Custom Hourly Rate" || f.matter_rate === "Flat Fee") && (
              <Row label={f.matter_rate === "Flat Fee" ? "Flat Fee Amount" : "Hourly Rate (USD)"} labelWidth={LW}>
                <input type="number" step="0.01" className={input} value={f.custom_rate} onChange={set("custom_rate")} placeholder="0.00" data-testid="practice-matter-custom-rate" />
              </Row>
            )}
            <Row label="Invoice Template" help labelWidth={LW}>
              <select className={input} value={f.invoice_template} onChange={set("invoice_template")} data-testid="practice-matter-invoice-template">
                <option value="">Select Invoice Template</option><option>Default</option><option>Flat Fee</option><option>Hourly</option>
              </select>
            </Row>
            <Row label="Evergreen Retainer" help labelWidth={LW}><Toggle value={f.evergreen_retainer} onChange={set("evergreen_retainer")} testId="practice-matter-evergreen" /></Row>
            <Row label="Additional Invoice Recipient(s)" labelWidth={LW}><input className={input} placeholder="Select Contacts..." value={f.additional_invoice_recipients} onChange={set("additional_invoice_recipients")} data-testid="practice-matter-invoice-recipients" /></Row>
          </div>
        </Section>
        <Section title="Dates">
          <div className={W}>
            <Row label="Statute of Limitations" help labelWidth={LW}><DateInput value={f.statute_of_limitations} onChange={set("statute_of_limitations")} testId="practice-matter-sol" /></Row>
            <Row label="Open Date" labelWidth={LW}><DateInput value={f.open_date} onChange={set("open_date")} testId="practice-matter-open-date" /></Row>
            <Row label="Close Date" labelWidth={LW}><DateInput value={f.close_date} onChange={set("close_date")} testId="practice-matter-close-date" /></Row>
          </div>
        </Section>
        <Section>
          <div className={W}>
            <Row label="Assigned To" help required labelWidth={LW}>
              <div className={`${input} flex items-center`}>
                {f.assigned_to ? (
                  <span className="inline-flex items-center gap-1.5 text-sm text-slate-700" data-testid="practice-matter-assigned-chip">{f.assigned_to}
                    <button type="button" onClick={() => set("assigned_to")("")} data-testid="practice-matter-assigned-remove"><X size={12} /></button></span>
                ) : <button type="button" className="text-sm text-[#1E88E5]" onClick={() => set("assigned_to")(user?.name || "")} data-testid="practice-matter-assign-me">Assign to me</button>}
              </div>
            </Row>
            <Row label="Originating Attorney" help labelWidth={LW}>
              <select className={input} value={f.originating_attorney} onChange={set("originating_attorney")} data-testid="practice-matter-originating">
                <option value="">Select User...</option><option>{user?.name}</option>
              </select>
            </Row>
            <Row label="Tags" help labelWidth={LW}><input className={input} value={f.tags} onChange={set("tags")} data-testid="practice-matter-tags" /></Row>
            <Row label="Status" help required labelWidth={LW}>
              <select className={input} value={f.status} onChange={set("status")} data-testid="practice-matter-status"><option>Open</option><option>Pending</option><option>Closed</option></select>
            </Row>
            <Row label="Matter Number" help labelWidth={LW}><input type="number" className={input} placeholder="Add number..." value={f.matter_number} onChange={set("matter_number")} data-testid="practice-matter-number" /></Row>
          </div>
        </Section>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => save(false)} disabled={busy} data-testid="practice-matter-save-btn"
                  className="inline-flex items-center gap-1.5 rounded bg-[#43A047] px-4 py-2 text-sm font-semibold text-white hover:bg-[#388E3C] disabled:opacity-60"><Check size={14} /> Save</button>
          <button type="button" onClick={() => save(true)} disabled={busy} data-testid="practice-matter-save-add-btn"
                  className="inline-flex items-center gap-1.5 rounded bg-[#43A047] px-4 py-2 text-sm font-semibold text-white hover:bg-[#388E3C] disabled:opacity-60"><Check size={14} /> Save & Add New</button>
          <button type="button" onClick={() => nav(id ? `/practice/matters/${id}` : "/practice/matters")} data-testid="practice-matter-cancel-btn"
                  className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"><X size={14} /> Cancel</button>
        </div>
      </div>
    </PracticeShell>
  );
}
