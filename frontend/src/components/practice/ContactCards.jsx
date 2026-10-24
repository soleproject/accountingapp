import { User, Camera, ChevronDown } from "lucide-react";
import { Row as BaseRow, input, Toggle } from "@/components/practice/forms";

export const EMPTY_PERSON = {
  first_name: "", middle_name: "", last_name: "", home: "", mobile: "", office: "", fax: "",
  email: "", client_portal: false, notes: "", preferred_contact_method: "",
};

const LW = "170px";

export const PersonCard = ({ title, person, onChange, idx, narrow = false, showAll = true }) => {
  const set = (k) => (e) => onChange({ ...person, [k]: e?.target ? e.target.value : e });
  const tid = (k) => `practice-contact-${idx}-${k}`;
  const inp = narrow ? `${input} !h-9 !text-sm` : input;
  const text = (k, ph) => <input className={inp} placeholder={ph} value={person[k]} onChange={set(k)} data-testid={tid(k.replace(/_/g, "-"))} />;
  const rp = { dense: narrow, labelWidth: narrow ? "130px" : LW };
  const F = {
    first: <BaseRow {...rp} key="first" label="First Name">
      <div className="grid grid-cols-[1fr_110px] gap-2">
        <input className={inp} placeholder="First" value={person.first_name} onChange={set("first_name")} data-testid={tid("first-name")} />
        <input className={inp} placeholder="M" value={person.middle_name} onChange={set("middle_name")} data-testid={tid("middle-name")} />
      </div></BaseRow>,
    last: <BaseRow {...rp} key="last" label="Last Name">{text("last_name", "Last")}</BaseRow>,
    home: <BaseRow {...rp} key="home" label="Home">{text("home", "Add home number...")}</BaseRow>,
    mobile: <BaseRow {...rp} key="mobile" label="Mobile" help>{text("mobile", "Add mobile number...")}</BaseRow>,
    office: <BaseRow {...rp} key="office" label="Office">{text("office", "Add office number...")}</BaseRow>,
    fax: <BaseRow {...rp} key="fax" label="Fax">{text("fax", "Add fax number...")}</BaseRow>,
    email: <BaseRow {...rp} key="email" label="Email">{text("email", "Add email address...")}</BaseRow>,
    portal: <BaseRow {...rp} key="portal" label="Client Portal" help><Toggle value={person.client_portal} onChange={set("client_portal")} testId={tid("client-portal")} /></BaseRow>,
    notes: <BaseRow {...rp} key="notes" label="Contact Notes">{text("notes", "Add contact notes...")}</BaseRow>,
    preferred: <BaseRow {...rp} key="preferred" label="Preferred Contact Method">
      <select className={inp} value={person.preferred_contact_method} onChange={set("preferred_contact_method")} data-testid={tid("preferred-method")}>
        <option value="">Select Option...</option>{["Email", "Phone", "Text Message", "Mail"].map(o => <option key={o}>{o}</option>)}
      </select></BaseRow>,
    custom: <BaseRow {...rp} key="custom" label="Custom Fields" help>
      <button type="button" className={`${inp} flex items-center justify-between text-slate-400`} data-testid={tid("custom-fields")}>Add custom fields... <ChevronDown size={14} /></button></BaseRow>,
  };
  return (
    <section className={`rounded border border-slate-200 bg-white ${narrow ? "px-5 py-4" : "px-6 py-5"}`} data-testid={`practice-person-card-${idx}`}>
      <h2 className={`text-lg font-bold uppercase tracking-wide text-slate-800 ${narrow ? "mb-2" : "mb-4"}`}>{title}</h2>
      <div className={`grid grid-cols-1 gap-6 ${narrow ? "lg:grid-cols-[150px_1fr]" : "lg:grid-cols-[220px_1fr]"}`}>
        <div className="flex flex-col items-start gap-2">
          <div className={`rounded border border-slate-300 bg-slate-300 grid place-items-center ${narrow ? "h-24 w-32" : "h-32 w-40"}`}>
            <User size={narrow ? 64 : 90} className="text-white fill-white" />
          </div>
          <button type="button" data-testid={tid("upload-picture")}
                  className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 px-3 py-1 text-xs text-slate-700 hover:bg-slate-50">
            <Camera size={12} /> Upload Picture
          </button>
        </div>
        {narrow ? (
          <div>{showAll ? [F.first, F.last, F.home, F.mobile, F.office, F.fax, F.email, F.portal, F.notes, F.preferred, F.custom] : [F.first, F.last, F.home, F.mobile, F.office, F.fax, F.email]}</div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-10">
            <div>{[F.first, F.home, F.office, F.email, F.notes, F.preferred, F.custom]}</div>
            <div>{[F.last, F.mobile, F.fax, F.portal]}</div>
          </div>
        )}
      </div>
    </section>
  );
};

const Row = BaseRow;

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
