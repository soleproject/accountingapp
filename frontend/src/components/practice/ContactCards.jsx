import { User, Camera, ChevronDown } from "lucide-react";
import { Row, input, Toggle } from "@/components/practice/forms";

export const EMPTY_PERSON = {
  first_name: "", middle_name: "", last_name: "", home: "", mobile: "", office: "", fax: "",
  email: "", client_portal: false, notes: "", preferred_contact_method: "",
};

const LW = "170px";

export const PersonCard = ({ title, person, onChange, idx }) => {
  const set = (k) => (e) => onChange({ ...person, [k]: e?.target ? e.target.value : e });
  const tid = (k) => `practice-contact-${idx}-${k}`;
  return (
    <section className="rounded border border-slate-200 bg-white px-6 py-5" data-testid={`practice-person-card-${idx}`}>
      <h2 className="text-lg font-bold uppercase tracking-wide text-slate-800 mb-4">{title}</h2>
      <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6">
        <div className="flex flex-col items-start gap-2">
          <div className="h-32 w-40 rounded border border-slate-300 bg-slate-300 grid place-items-center">
            <User size={90} className="text-white fill-white" />
          </div>
          <button type="button" data-testid={tid("upload-picture")}
                  className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 px-3 py-1 text-xs text-slate-700 hover:bg-slate-50">
            <Camera size={12} /> Upload Picture
          </button>
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-10">
          <div>
            <Row label="First Name" labelWidth={LW}>
              <div className="grid grid-cols-[1fr_110px] gap-2">
                <input className={input} placeholder="First" value={person.first_name} onChange={set("first_name")} data-testid={tid("first-name")} />
                <input className={input} placeholder="M" value={person.middle_name} onChange={set("middle_name")} data-testid={tid("middle-name")} />
              </div>
            </Row>
            <Row label="Home" labelWidth={LW}><input className={input} placeholder="Add home number..." value={person.home} onChange={set("home")} data-testid={tid("home")} /></Row>
            <Row label="Office" labelWidth={LW}><input className={input} placeholder="Add office number..." value={person.office} onChange={set("office")} data-testid={tid("office")} /></Row>
            <Row label="Email" labelWidth={LW}><input className={input} placeholder="Add email address..." value={person.email} onChange={set("email")} data-testid={tid("email")} /></Row>
            <Row label="Contact Notes" labelWidth={LW}><input className={input} placeholder="Add contact notes..." value={person.notes} onChange={set("notes")} data-testid={tid("notes")} /></Row>
            <Row label="Preferred Contact Method" labelWidth={LW}>
              <select className={input} value={person.preferred_contact_method} onChange={set("preferred_contact_method")} data-testid={tid("preferred-method")}>
                <option value="">Select Option...</option>{["Email", "Phone", "Text Message", "Mail"].map(o => <option key={o}>{o}</option>)}
              </select>
            </Row>
            <Row label="Custom Fields" help labelWidth={LW}>
              <button type="button" className={`${input} flex items-center justify-between text-slate-400`} data-testid={tid("custom-fields")}>Add custom fields... <ChevronDown size={14} /></button>
            </Row>
          </div>
          <div>
            <Row label="Last Name" labelWidth={LW}><input className={input} placeholder="Last" value={person.last_name} onChange={set("last_name")} data-testid={tid("last-name")} /></Row>
            <Row label="Mobile" help labelWidth={LW}><input className={input} placeholder="Add mobile number..." value={person.mobile} onChange={set("mobile")} data-testid={tid("mobile")} /></Row>
            <Row label="Fax" labelWidth={LW}><input className={input} placeholder="Add fax number..." value={person.fax} onChange={set("fax")} data-testid={tid("fax")} /></Row>
            <Row label="Client Portal" help labelWidth={LW}><Toggle value={person.client_portal} onChange={set("client_portal")} testId={tid("client-portal")} /></Row>
          </div>
        </div>
      </div>
    </section>
  );
};

export const CompanyCard = ({ form, set }) => (
  <section className="rounded border border-slate-200 bg-white px-6 py-5" data-testid="practice-company-card">
    <h2 className="text-lg font-bold uppercase tracking-wide text-slate-800 mb-3">Company</h2>
    <div className="max-w-xl">
      <Row label="Company" labelWidth={LW}><input className={input} placeholder="Add a company name..." value={form.company_name} onChange={set("company_name")} data-testid="practice-company-name" /></Row>
      <Row label="Notes" labelWidth={LW}><input className={input} placeholder="Add company notes..." value={form.company_notes} onChange={set("company_notes")} data-testid="practice-company-notes" /></Row>
      <Row label="Custom Fields" help labelWidth={LW}>
        <button type="button" className={`${input} flex items-center justify-between text-slate-400`} data-testid="practice-company-custom-fields">Add custom fields... <ChevronDown size={14} /></button>
      </Row>
    </div>
  </section>
);
