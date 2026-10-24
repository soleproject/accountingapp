import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  Cog, User, Lock, Wrench, Info, Settings, PenLine, Tag, PenTool, Smartphone, Trash2,
  CreditCard, DollarSign, Mail, FileText, BellRing, Users, UsersRound, Shield,
  CalendarCheck, Folder, Landmark, AtSign, Gavel, Zap, Code, Camera, Upload, Check, X,
} from "lucide-react";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { Row, input, Toggle, Section } from "@/components/practice/forms";

const GROUPS = [
  { title: "Personal & Company", items: [
    ["Personal Settings", User], ["Security & Password", Lock], ["Company Settings", Wrench], ["Firm Logo & Info", Info],
    ["Client Portal, Logo & Colors", Settings], ["Custom Fields", PenLine], ["Tags", Tag], ["eSignature", PenTool],
    ["Text Messaging", Smartphone], ["Recycle Bin", Trash2],
  ]},
  { title: "Invoices & Payments", items: [
    ["Accept Online Payments", CreditCard], ["Custom Hourly Rates", DollarSign], ["Email Templates", Mail],
    ["Invoice Options", FileText], ["Invoice Reminders", BellRing],
  ]},
  { title: "User Settings", items: [["Users", Users], ["User Groups", UsersRound], ["Roles", Shield]] },
  { title: "Integrations", items: [
    ["Calendar, Tasks & Contacts", CalendarCheck], ["Email", Mail], ["Files & Documents", Folder], ["Accounting", Landmark],
    ["Mailchimp", AtSign], ["Court Rules", Gavel], ["Zapier", Zap], ["API", Code],
  ]},
];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function SettingsNav() {
  return (
    <nav className="space-y-4" data-testid="practice-settings-nav">
      {GROUPS.map(g => (
        <div key={g.title}>
          <div className="text-sm font-semibold text-slate-700 mb-1.5">{g.title}</div>
          <div className="rounded border border-slate-200 bg-white overflow-hidden">
            {g.items.map(([label, Icon]) => {
              const active = label === "Personal Settings";
              return (
                <button key={label} type="button" data-testid={`practice-settings-nav-${slug(label)}`}
                        className={`w-full flex items-center gap-4 px-4 py-2.5 text-sm text-left transition-colors ${
                          active ? "bg-[#1E88E5] text-white font-semibold" : "text-slate-700 hover:bg-slate-50"}`}>
                  <Icon size={15} className={active ? "text-white" : "text-[#1E88E5]"} />{label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div>
        <div className="text-sm font-semibold text-slate-700 mb-1.5">Mobile Apps</div>
        <div className="space-y-2">
          {["Google Play", "App Store"].map(s => (
            <div key={s} className="w-40 rounded-md bg-black text-white px-3 py-2 leading-tight" data-testid={`practice-settings-${slug(s)}-badge`}>
              <div className="text-[9px] uppercase">{s === "Google Play" ? "Android app on" : "Available on the"}</div>
              <div className="text-base font-semibold">{s}</div>
            </div>
          ))}
        </div>
      </div>
    </nav>
  );
}

const EMPTY = {
  first_name: "", middle_name: "", last_name: "", job_title: "", mobile: "", email: "",
  time_zone: "(UTC-08:00) Pacific Time (US & Canada)", home_phone: "", office_phone: "",
  hourly_rate: 0, round_time_entries: false, daily_agenda_email: true,
};

export default function PracticeSettings() {
  const [f, setF] = useState(EMPTY);
  const [saved, setSaved] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e?.target ? e.target.value : e }));

  useEffect(() => {
    api.get("/practice/profile").then(r => { const d = { ...EMPTY, ...r.data }; setF(d); setSaved(d); })
      .catch(() => toast.error("Could not load settings"));
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.put("/practice/profile", { ...f, hourly_rate: Number(f.hourly_rate) || 0 });
      const d = { ...EMPTY, ...r.data }; setF(d); setSaved(d);
      toast.success("Settings saved");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not save settings");
    } finally { setBusy(false); }
  };

  return (
    <PracticeShell>
      <div className="space-y-4" data-testid="practice-settings">
        <div className="flex items-center gap-3">
          <Cog size={32} className="text-slate-500" strokeWidth={1.5} />
          <h1 className="text-3xl font-bold text-slate-800">Settings</h1>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,31%)_1fr] gap-8 pt-1">
          <SettingsNav />
          <div className="space-y-5">
            <Section title="Personal Settings">
              <Row label="Profile Picture" required>
                <div className="inline-flex flex-col items-start gap-1.5">
                  <div className="h-40 w-52 rounded border border-slate-300 bg-slate-300 grid place-items-center" data-testid="practice-profile-picture">
                    <User size={110} className="text-white fill-white" />
                  </div>
                  <button type="button" data-testid="practice-upload-picture-btn"
                          className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 px-3 py-1 text-sm text-slate-700 hover:bg-slate-50">
                    <Camera size={13} /> Upload Picture
                  </button>
                </div>
              </Row>
              <Row label="Name">
                <div className="grid grid-cols-3 gap-2">
                  <input className={input} value={f.first_name} onChange={set("first_name")} placeholder="First" data-testid="practice-first-name" />
                  <input className={input} value={f.middle_name} onChange={set("middle_name")} placeholder="M" data-testid="practice-middle-name" />
                  <input className={input} value={f.last_name} onChange={set("last_name")} placeholder="Last" data-testid="practice-last-name" />
                </div>
              </Row>
              <Row label="Job Title" help>
                <select className={input} value={f.job_title} onChange={set("job_title")} data-testid="practice-job-title">
                  <option value=""></option>
                  {["Attorney", "Partner", "Associate", "Paralegal", "Legal Assistant", "Office Manager", "Bookkeeper"].map(t => <option key={t}>{t}</option>)}
                </select>
              </Row>
              <Row label="Mobile" hint="You can get SMS reminders for tasks or events (US & Canada Only).">
                <input className={input} value={f.mobile} onChange={set("mobile")} data-testid="practice-mobile" />
              </Row>
              <Row label="Email" required hint="The email address to sign in. This email can not be used for two accounts.">
                <input className={input} value={f.email} onChange={set("email")} data-testid="practice-email" />
              </Row>
              <Row label="Time Zone" hint="Each user can have their own time zone. All dates in the system will be adjusted accordingly.">
                <select className={input} value={f.time_zone} onChange={set("time_zone")} data-testid="practice-timezone">
                  {["(UTC-10:00) Hawaii", "(UTC-09:00) Alaska", "(UTC-08:00) Pacific Time (US & Canada)", "(UTC-07:00) Mountain Time (US & Canada)",
                    "(UTC-06:00) Central Time (US & Canada)", "(UTC-05:00) Eastern Time (US & Canada)"].map(t => <option key={t}>{t}</option>)}
                </select>
              </Row>
            </Section>
            <Section title="Contact Info">
              <Row label="Home"><input className={input} value={f.home_phone} onChange={set("home_phone")} data-testid="practice-home-phone" /></Row>
              <Row label="Office"><input className={input} value={f.office_phone} onChange={set("office_phone")} data-testid="practice-office-phone" /></Row>
            </Section>
            <Section title="Time Entries">
              <Row label="Hourly Rate (USD)" required hint="The amount you charge per hour when billing for your time. Each user can have their own rates.">
                <input type="number" step="0.01" className={input} value={f.hourly_rate} onChange={set("hourly_rate")} data-testid="practice-hourly-rate" />
              </Row>
              <Row label="Round Time Entries?" help><Toggle value={f.round_time_entries} onChange={set("round_time_entries")} testId="practice-round-toggle" /></Row>
            </Section>
            <Section title="Notification Emails">
              <Row label="Receive Daily Agenda Email?" help><Toggle value={f.daily_agenda_email} onChange={set("daily_agenda_email")} testId="practice-agenda-toggle" /></Row>
            </Section>
            <div className="flex items-center gap-2">
              <button type="button" onClick={save} disabled={busy} data-testid="practice-settings-save-btn"
                      className="inline-flex items-center gap-1.5 rounded bg-[#43A047] px-4 py-2 text-sm font-semibold text-white hover:bg-[#388E3C] disabled:opacity-60">
                <Check size={14} /> {busy ? "Saving…" : "Save"}
              </button>
              <button type="button" onClick={() => setF(saved)} data-testid="practice-settings-cancel-btn"
                      className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
                <X size={14} /> Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    </PracticeShell>
  );
}
