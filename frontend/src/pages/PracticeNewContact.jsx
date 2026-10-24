import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { UserPlus, Plus, X, ChevronDown, Check } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { Row, input, Toggle, GreenButton } from "@/components/practice/forms";
import { PersonCard, CompanyCard, EMPTY_PERSON } from "@/components/practice/ContactCards";

const PORTAL = [
  ["show_unpaid_invoices", "Show unpaid invoices?"], ["show_paid_invoices", "Show paid invoices?"],
  ["show_account_balances", "Show account balances?"], ["show_all_payments", "Show all payments?"],
  ["send_payment_reminders", "Send payment reminders?"],
];

function DetailsCard({ form, set, userName }) {
  const [portalOpen, setPortalOpen] = useState(false);
  const setPortal = (k) => (v) => set("portal_settings")({ ...form.portal_settings, [k]: v });
  return (
    <section className="rounded border border-slate-200 bg-white px-6 py-5" data-testid="practice-contact-details-card">
      <div className="max-w-2xl">
        <Row label="Address" help labelWidth="190px"><input className={input} placeholder="Add address..." value={form.address} onChange={set("address")} data-testid="practice-contact-address" /></Row>
        <Row label="Assigned To" help required labelWidth="190px">
          <div className={`${input} flex items-center`}>
            {form.assigned_to ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-slate-700" data-testid="practice-contact-assigned-chip">
                {form.assigned_to}
                <button type="button" onClick={() => set("assigned_to")("")} data-testid="practice-contact-assigned-remove"><X size={12} /></button>
              </span>
            ) : (
              <button type="button" className="text-sm text-[#1E88E5]" onClick={() => set("assigned_to")(userName)} data-testid="practice-contact-assign-me">Assign to me</button>
            )}
          </div>
        </Row>
        <Row label="Tags" help labelWidth="190px"><input className={input} value={form.tags} onChange={set("tags")} placeholder="" data-testid="practice-contact-tags" /></Row>
        <Row label="Status" required labelWidth="190px">
          <select className={input} value={form.status} onChange={set("status")} data-testid="practice-contact-status"><option>Active</option><option>Archived</option></select>
        </Row>
        <Row label="Number" help labelWidth="190px"><input type="number" className={input} placeholder="Add number..." value={form.number} onChange={set("number")} data-testid="practice-contact-number" /></Row>
        <Row label="Website" labelWidth="190px"><input className={input} placeholder="Add website..." value={form.website} onChange={set("website")} data-testid="practice-contact-website" /></Row>
        <Row label="Additional Invoice Recipient(s)" labelWidth="190px"><input className={input} placeholder="Select Contacts..." value={form.additional_invoice_recipients} onChange={set("additional_invoice_recipients")} data-testid="practice-contact-invoice-recipients" /></Row>
        <Row label="Invoice Template" help labelWidth="190px">
          <select className={input} value={form.invoice_template} onChange={set("invoice_template")} data-testid="practice-contact-invoice-template">
            <option value="">Select Invoice Template</option><option>Default</option><option>Flat Fee</option><option>Hourly</option>
          </select>
        </Row>
        <Row label="Client Portal Settings" help labelWidth="190px">
          <button type="button" className="text-sm font-semibold text-[#1E88E5] pt-2" onClick={() => setPortalOpen(v => !v)} data-testid="practice-contact-portal-toggle">
            {portalOpen ? "Change default settings" : "Client portal settings..."}
          </button>
          {portalOpen && (
            <div className="mt-2 space-y-2" data-testid="practice-contact-portal-settings">
              {PORTAL.map(([k, label]) => (
                <div key={k} className="grid grid-cols-[200px_auto] items-center justify-items-start gap-3 text-sm text-slate-700">
                  <span>{label}</span><Toggle value={form.portal_settings[k]} onChange={setPortal(k)} testId={`practice-portal-${k.replace(/_/g, "-")}`} />
                </div>
              ))}
            </div>
          )}
        </Row>
      </div>
    </section>
  );
}

export const ContactForm = ({ onSaved, onCancel, compact = false }) => {
  const { user } = useAuth();
  const [withCompany, setWithCompany] = useState(false);
  const [showMore, setShowMore] = useState(!compact);
  const [people, setPeople] = useState([{ ...EMPTY_PERSON }]);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    company_name: "", company_notes: "", address: "", assigned_to: user?.name || "", tags: "", status: "Active",
    number: "", website: "", additional_invoice_recipients: "", invoice_template: "",
    portal_settings: { show_unpaid_invoices: true, show_paid_invoices: true, show_account_balances: false, show_all_payments: true, send_payment_reminders: true },
  });
  const set = (k) => (e) => setForm(p => ({ ...p, [k]: e?.target ? e.target.value : e }));
  const setPerson = (i) => (p) => setPeople(arr => arr.map((x, j) => (j === i ? p : x)));

  const save = async () => {
    setBusy(true);
    try {
      const payload = {
        ...form, company_name: withCompany ? form.company_name : "", company_notes: withCompany ? form.company_notes : "",
        contacts: withCompany ? people : [people[0]], number: form.number || null,
        tags: form.tags.split(",").map(t => t.trim()).filter(Boolean),
      };
      const r = await api.post("/practice/contacts", payload);
      toast.success("Contact saved");
      onSaved(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not save contact");
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4" data-testid="practice-contact-form">
      {!withCompany && (
        <GreenButton onClick={() => setWithCompany(true)} testId="practice-add-company-btn" className="!py-1 !text-xs"><Plus size={12} /> Add a company</GreenButton>
      )}
      {withCompany && <CompanyCard form={form} set={set} />}
      {(withCompany ? people : [people[0]]).map((p, i) => (
        <PersonCard key={i} idx={i} person={p} onChange={setPerson(i)} narrow={compact}
                    title={!withCompany ? "Contact" : i === 0 ? "Primary Contact" : `Contact ${i + 1}`} />
      ))}
      {withCompany && (
        <GreenButton onClick={() => setPeople(a => [...a, { ...EMPTY_PERSON }])} testId="practice-add-another-contact-btn" className="!py-1 !text-xs">
          <Plus size={12} /> Add another contact to this company
        </GreenButton>
      )}
      {showMore ? <DetailsCard form={form} set={set} userName={user?.name || ""} /> : (
        <button type="button" onClick={() => setShowMore(true)} className="text-sm font-semibold text-[#1E88E5] hover:underline" data-testid="practice-contact-show-more">Show more information...</button>
      )}
      <div className="flex items-center gap-2">
        <div className="inline-flex rounded overflow-hidden">
          <button type="button" onClick={save} disabled={busy} data-testid="practice-contact-save-btn"
                  className="inline-flex items-center gap-1.5 bg-[#43A047] px-4 py-2 text-sm font-semibold text-white hover:bg-[#388E3C] disabled:opacity-60">
            <Check size={14} /> {busy ? "Saving…" : "Save"}
          </button>
          {!compact && <button type="button" className="bg-[#43A047] border-l border-white/40 px-2 text-white" data-testid="practice-contact-save-more-btn"><ChevronDown size={14} /></button>}
        </div>
        <button type="button" onClick={onCancel} data-testid="practice-contact-cancel-btn"
                className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
          <X size={14} /> Cancel
        </button>
      </div>
    </div>
  );
};

export default function PracticeNewContact() {
  const nav = useNavigate();
  return (
    <PracticeShell>
      <div className="space-y-4" data-testid="practice-new-contact">
        <div className="flex items-center gap-3">
          <UserPlus size={30} className="text-slate-600" strokeWidth={1.5} />
          <h1 className="text-3xl font-bold text-slate-800">New Contact</h1>
        </div>
        <ContactForm onSaved={() => nav("/practice/contacts")} onCancel={() => nav("/practice/contacts")} />
      </div>
    </PracticeShell>
  );
}
