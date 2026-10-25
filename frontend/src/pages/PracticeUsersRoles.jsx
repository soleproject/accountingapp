import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { UserPlus, KeyRound, Plus, Search, Settings, Check, X, Info } from "lucide-react";
import { api } from "@/lib/api";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { GreenButton, Toggle, input as inp } from "@/components/practice/forms";

const fmtAt = (iso) => iso ? new Date(iso).toLocaleString("en-US", { month: "numeric", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "-";
const TH = ({ children }) => <th className="px-3 py-3 text-left text-[13px] font-semibold uppercase tracking-wide text-slate-600">{children}</th>;
const Footer = ({ n }) => (
  <div className="flex items-center gap-3 px-3 py-2 border-t border-slate-200 text-xs text-slate-500">
    <span className="text-slate-300">« ‹</span><span className="text-slate-800 text-sm border-b border-slate-400 px-2">1</span><span className="text-slate-300">› »</span>
    <span className="ml-3 rounded-full border border-slate-300 px-2.5 py-0.5 text-slate-700">50 ▾</span><span className="uppercase tracking-wide font-semibold">Items per page</span>
    <span className="flex-1 text-right uppercase tracking-wide">1 - {n} of {n} items</span>
  </div>
);
const Panel = ({ icon: Icon, title, btn, children, testId }) => (
  <section className="rounded border border-slate-200 bg-white p-6" data-testid={testId}>
    <div className="flex items-center justify-between mb-3"><h2 className="inline-flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-800"><Icon size={16} className="text-slate-600" />{title}</h2>{btn}</div>
    <div className="rounded border border-slate-200 overflow-hidden">{children}</div>
  </section>
);
const SearchBar = ({ q, setQ, placeholder, testId }) => (
  <div className="flex items-center gap-3 px-3 py-2 border-b border-slate-200"><Search size={15} className="text-slate-400" /><input value={q} onChange={e => setQ(e.target.value)} placeholder={placeholder} data-testid={testId} className="flex-1 h-8 text-sm outline-none bg-transparent" /><span className="inline-flex items-center gap-1 text-sm text-slate-400"><Settings size={13} /> Choose Columns</span></div>
);

export function UsersPanel() {
  const nav = useNavigate();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  useEffect(() => { api.get("/practice/users").then(r => setRows(r.data)).catch(() => setRows([])); }, []);
  const shown = (rows || []).filter(u => `${u.name} ${u.email}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Panel icon={UserPlus} title="Users" testId="practice-users-panel" btn={<GreenButton onClick={() => nav("/practice/users/new")} testId="practice-users-new-btn"><Plus size={14} /> New User</GreenButton>}>
      <SearchBar q={q} setQ={setQ} placeholder="Users..." testId="practice-users-search" />
      <table className="w-full text-sm">
        <thead><tr className="border-b border-slate-200"><TH>Name</TH><TH>Email</TH><TH>Role</TH><TH>Last Login</TH><TH>Active</TH></tr></thead>
        <tbody>{shown.map((u, i) => (
          <tr key={u.id} className={i % 2 ? "" : "bg-slate-50"} data-testid={`practice-user-row-${u.id}`}>
            <td className="px-3 py-3"><button type="button" onClick={() => nav(u.is_owner ? "/practice/users/me" : "/practice/users/me")} className="font-semibold text-[#1E88E5] hover:underline text-[15px]">{u.name}</button></td>
            <td className="px-3 py-3 text-[#1E88E5]">{u.email}</td><td className="px-3 py-3 text-[#1E88E5]">{u.role_name}</td><td className="px-3 py-3 text-slate-700">{fmtAt(u.last_login)}</td>
            <td className="px-3 py-3"><span className={`inline-block min-w-[80px] rounded-full px-3 py-0.5 text-center text-[10px] font-bold text-white ${u.active ? "bg-[#43A047]" : "bg-slate-400"}`}>{u.active ? "YES" : "NO"}</span></td>
          </tr>))}</tbody>
      </table>
      <Footer n={shown.length} />
    </Panel>
  );
}

export function RolesPanel() {
  const nav = useNavigate();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  useEffect(() => { api.get("/practice/roles").then(r => setRows(r.data)).catch(() => setRows([])); }, []);
  const shown = (rows || []).filter(r => r.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-4">
      <div className="rounded border border-slate-200 bg-white px-6 py-4 text-sm text-slate-700" data-testid="practice-roles-info">Roles define how users access records and data, and what they can do within Practice. When you create users, you assign a role to each one. <span className="text-[#1E88E5]">Click here</span> to learn more.</div>
      <Panel icon={KeyRound} title="Roles & Access Levels" testId="practice-roles-panel" btn={<GreenButton onClick={() => nav("/practice/roles/new")} testId="practice-roles-new-btn"><Plus size={14} /> New Role</GreenButton>}>
        <SearchBar q={q} setQ={setQ} placeholder="Search Roles..." testId="practice-roles-search" />
        <table className="w-full text-sm">
          <thead><tr className="border-b border-slate-200"><TH>Name ↓</TH><TH>Users</TH><TH>Last Modified Date</TH><TH>Created Date</TH></tr></thead>
          <tbody>{shown.map((r, i) => (
            <tr key={r.id} className={i % 2 ? "" : "bg-slate-50"} data-testid={`practice-role-row-${r.id}`}>
              <td className="px-3 py-3"><button type="button" onClick={() => nav(`/practice/roles/${r.id}`)} className="font-semibold text-[#1E88E5] hover:underline text-[15px]" data-testid={`practice-role-link-${r.id}`}>{r.name}</button></td>
              <td className="px-3 py-3 text-slate-700">{r.users}</td><td className="px-3 py-3 text-slate-700">{fmtAt(r.updated_at)}</td><td className="px-3 py-3 text-slate-700">{fmtAt(r.created_at)}</td>
            </tr>))}</tbody>
        </table>
        <Footer n={shown.length} />
      </Panel>
    </div>
  );
}

const Section = ({ title, children, testId }) => <section className="rounded border border-slate-200 bg-white px-8 py-6" data-testid={testId}><h2 className="text-lg font-bold uppercase tracking-wide text-slate-800 mb-3">{title}</h2>{children}</section>;
const Row = ({ label, required, help, sub, children, wide }) => (
  <div className={`grid gap-4 items-center py-1.5 ${wide ? "grid-cols-[230px_1fr]" : "grid-cols-[230px_minmax(0,480px)]"}`}>
    <div className="text-[13px] font-semibold uppercase tracking-wide text-slate-800 flex items-center gap-1">{help && <span className="text-slate-400">?</span>}{label}{sub && <span className="text-[11px] font-normal text-slate-500 normal-case">({sub})</span>}{required && <span className="text-red-500">*</span>}</div>
    <div>{children}</div>
  </div>
);
const EMPTY_USER = { first_name: "", middle_name: "", last_name: "", email: "", hourly_rate: "0.00", round_time_entries: false, time_zone: "(UTC-08:00) Pacific Time (US & Canada)", role_id: "", job_title: "", notes: "", address: "", mobile: "", home: "", work: "", fax: "" };

export default function PracticeNewUser() {
  const nav = useNavigate();
  const [roles, setRoles] = useState([]);
  const [f, setF] = useState(EMPTY_USER);
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e?.target ? e.target.value : e }));
  useEffect(() => { api.get("/practice/roles").then(r => { setRoles(r.data); const a = r.data.find(x => x.name === "Admin") || r.data[0]; if (a) setF(p => ({ ...p, role_id: p.role_id || a.id })); }).catch(() => {}); }, []);
  const save = async (again) => {
    if (!f.email.trim()) return toast.error("Enter an email address.");
    try {
      await api.post("/practice/users", { ...f, hourly_rate: Number(f.hourly_rate) || 0 });
      toast.success("User added. An invitation email will be sent.");
      if (again) setF(p => ({ ...EMPTY_USER, role_id: p.role_id })); else nav("/practice/settings?section=users");
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not add user"); }
  };
  return (
    <PracticeShell withRail={false}>
      <div className="space-y-4" data-testid="practice-new-user">
        <div className="flex items-center gap-3"><UserPlus size={30} className="text-slate-600" strokeWidth={1.5} /><h1 className="text-3xl font-bold text-slate-800">New User</h1></div>
        <Section title="User" testId="practice-nu-user">
          <Row label="Name" wide><div className="grid grid-cols-3 gap-6"><input className={inp} placeholder="First" value={f.first_name} onChange={set("first_name")} data-testid="practice-nu-first" /><input className={inp} placeholder="M" value={f.middle_name} onChange={set("middle_name")} data-testid="practice-nu-middle" /><input className={inp} placeholder="Last" value={f.last_name} onChange={set("last_name")} data-testid="practice-nu-last" /></div></Row>
          <Row label="Email" required><input className={inp} placeholder="Add email address..." value={f.email} onChange={set("email")} data-testid="practice-nu-email" /><p className="mt-1 text-xs text-slate-500">The email address is used by the user to sign in and must be unique.</p></Row>
        </Section>
        <Section title="Personal Settings" testId="practice-nu-personal">
          <Row label="Hourly Rate" sub="USD" required help><input type="number" step="0.01" className={inp} value={f.hourly_rate} onChange={set("hourly_rate")} data-testid="practice-nu-rate" /></Row>
          <Row label="Round Time Entries?"><Toggle value={f.round_time_entries} onChange={set("round_time_entries")} testId="practice-nu-round" /></Row>
          <Row label="Time Zone" help><select className={inp} value={f.time_zone} onChange={set("time_zone")} data-testid="practice-nu-tz">{["(UTC-08:00) Pacific Time (US & Canada)", "(UTC-07:00) Mountain Time (US & Canada)", "(UTC-06:00) Central Time (US & Canada)", "(UTC-05:00) Eastern Time (US & Canada)"].map(t => <option key={t}>{t}</option>)}</select></Row>
          <Row label="Role" required>
            <select className={inp} value={f.role_id} onChange={set("role_id")} data-testid="practice-nu-role">{roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
            <p className="mt-1 text-xs text-slate-500">Roles are security settings that can limit a user's access to data. You can customize roles in Users -&gt; <button type="button" onClick={() => nav("/practice/settings?section=roles")} className="text-[#1E88E5] hover:underline" data-testid="practice-nu-manage-roles">Manage User Access &amp; Security</button></p>
          </Row>
          <Row label="Job Title"><select className={inp} value={f.job_title} onChange={set("job_title")} data-testid="practice-nu-job"><option value=""></option>{["Attorney", "Paralegal", "Legal Assistant", "Office Manager", "Bookkeeper", "Partner", "Associate", "Other"].map(t => <option key={t}>{t}</option>)}</select></Row>
          <Row label="Notes"><input className={inp} placeholder="Add Notes..." value={f.notes} onChange={set("notes")} data-testid="practice-nu-notes" /></Row>
        </Section>
        <Section title="Contact Info" testId="practice-nu-contact">
          {[["Address", "address", "Add address..."], ["Mobile #", "mobile", "Add a mobile number..."], ["Home #", "home", "Add a home number..."], ["Work #", "work", "Add an office number..."], ["Fax #", "fax", "Add a fax number..."]].map(([l, k, ph]) => (
            <Row key={k} label={l}><input className={inp} placeholder={ph} value={f[k]} onChange={set(k)} data-testid={`practice-nu-${k}`} /></Row>
          ))}
        </Section>
        <div className="rounded border border-[#B3E5FC] bg-[#E1F5FE] px-4 py-3 text-sm text-slate-700" data-testid="practice-nu-notice">Once added, this user will receive an email to login and create their password.</div>
        <div className="flex items-center gap-2">
          <GreenButton onClick={() => save(false)} testId="practice-nu-save"><Check size={14} /> Add a user</GreenButton>
          <GreenButton onClick={() => save(true)} testId="practice-nu-save-new"><Check size={14} /> Save &amp; Add New</GreenButton>
          <button type="button" onClick={() => nav(-1)} className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-700 hover:bg-slate-50" data-testid="practice-nu-cancel"><X size={14} /> Cancel</button>
        </div>
      </div>
    </PracticeShell>
  );
}

const PERMS = [["create", "Create"], ["view", "View"], ["edit", "Edit"], ["delete", "Delete"], ["archive", "Archive"], ["view_all", "View All"], ["edit_all", "Edit All"]];

export function PracticeRoleForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const [features, setFeatures] = useState([]);
  const [f, setF] = useState({ name: "New Role", permissions: {}, restrict_ip: false, restrict_past_time: false });
  useEffect(() => {
    api.get("/practice/roles/features").then(r => {
      setFeatures(r.data);
      if (!id) setF(p => ({ ...p, permissions: Object.fromEntries(r.data.map(x => [x.feature, Object.fromEntries(x.allowed.map(a => [a, !["Flat Fee", "Firm Payments", "Roles", "Users & User Groups"].includes(x.feature) || a === "view" || a === "view_all"]))])) }));
    }).catch(() => {});
    if (id) api.get(`/practice/roles/${id}`).then(r => setF(r.data)).catch(() => { toast.error("Role not found"); nav("/practice/settings?section=roles"); });
  }, [id, nav]);
  const toggle = (feat, perm) => setF(p => ({ ...p, permissions: { ...p.permissions, [feat]: { ...(p.permissions[feat] || {}), [perm]: !p.permissions[feat]?.[perm] } } }));
  const save = async () => {
    if (!f.name.trim()) return toast.error("Enter a role name.");
    const body = { name: f.name, permissions: f.permissions, restrict_ip: f.restrict_ip, restrict_past_time: f.restrict_past_time };
    try { id ? await api.put(`/practice/roles/${id}`, body) : await api.post("/practice/roles", body); toast.success("Role saved."); nav("/practice/settings?section=roles"); }
    catch (e) { toast.error(e?.response?.data?.detail || "Could not save role"); }
  };
  return (
    <PracticeShell withRail={false}>
      <div className="space-y-4" data-testid="practice-role-form">
        <div className="flex items-center gap-3"><Plus size={28} className="text-slate-600" /><h1 className="text-3xl font-bold text-slate-800" data-testid="practice-role-form-title">{id ? `Role - ${f.name}` : "New Role"}</h1></div>
        <div className="rounded border border-slate-200 bg-white px-6 py-3 text-sm text-slate-700 inline-flex items-center gap-2"><Info size={14} className="text-slate-400" />Edit each users profile to change their security role. <button type="button" onClick={() => nav("/practice/settings?section=users")} className="text-[#1E88E5] hover:underline">View All Users</button> or <span className="text-[#1E88E5]">learn more about security roles</span>.</div>
        <Section title="Role" testId="practice-role-name-section"><Row label="Name" required><input className={`${inp} max-w-xs`} value={f.name} onChange={e => setF(p => ({ ...p, name: e.target.value }))} data-testid="practice-role-name" /></Row></Section>
        <section className="rounded border border-slate-200 bg-white px-6 py-6" data-testid="practice-role-access">
          <h2 className="text-lg font-bold uppercase tracking-wide text-slate-800 mb-3">Role Access Levels</h2>
          <table className="w-full text-sm border border-slate-200">
            <thead>
              <tr className="text-left text-slate-700"><th className="px-3 py-2 border-b border-slate-200" /><th colSpan={5} className="px-3 py-2 border-b border-l border-slate-200 font-semibold">Settings for this user's contacts only</th><th colSpan={2} className="px-3 py-2 border-b border-l border-slate-200 font-semibold">Settings for all contacts</th></tr>
              <tr className="text-left text-xs font-semibold text-slate-700"><th className="px-3 py-2 border-b border-slate-200">Feature</th>{PERMS.map(([k, l]) => <th key={k} className="px-3 py-2 border-b border-l border-slate-200">{l} <span className="text-slate-400">?</span></th>)}</tr>
            </thead>
            <tbody>
              {features.map((x, i) => (
                <tr key={x.feature} className={i % 2 ? "" : "bg-slate-50"} data-testid={`practice-role-feature-${x.feature.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
                  <td className="px-3 py-2 text-slate-700 border-t border-slate-200">{x.feature}</td>
                  {PERMS.map(([k]) => (
                    <td key={k} className="px-3 py-2 border-t border-l border-slate-200">
                      {x.allowed.includes(k) && <input type="checkbox" className="h-4 w-4 accent-[#1E88E5]" checked={!!f.permissions[x.feature]?.[k]} onChange={() => toggle(x.feature, k)} data-testid={`practice-role-perm-${x.feature.toLowerCase().replace(/[^a-z]+/g, "-")}-${k}`} />}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <Section title="Access Restrictions" testId="practice-role-restrictions">
          <Row label="Restrict access by IP"><Toggle value={f.restrict_ip} onChange={v => setF(p => ({ ...p, restrict_ip: v }))} testId="practice-role-restrict-ip" /></Row>
          <Row label="Restrict revisions to past dated time entries" help><Toggle value={f.restrict_past_time} onChange={v => setF(p => ({ ...p, restrict_past_time: v }))} testId="practice-role-restrict-past" /></Row>
        </Section>
        <GreenButton onClick={save} testId="practice-role-save"><Check size={14} /> Save</GreenButton>
      </div>
    </PracticeShell>
  );
}
