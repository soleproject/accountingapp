import { useState } from "react";
import { toast } from "sonner";
import {
  Cog, User, Lock, Wrench, Info, Settings, PenLine, Tag, PenTool, Smartphone, Trash2,
  CreditCard, DollarSign, Mail, FileText, BellRing, Users, UsersRound, Shield,
  CalendarCheck, Folder, Landmark, AtSign, Gavel, Zap, Code, Camera, Upload, Check, X,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { PracticeShell } from "@/components/practice/PracticeShell";

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
    <nav className="space-y-3" data-testid="practice-settings-nav">
      {GROUPS.map(g => (
        <div key={g.title}>
          <div className="text-xs font-semibold text-slate-700 mb-1">{g.title}</div>
          <div className="rounded border border-slate-200 bg-white overflow-hidden">
            {g.items.map(([label, Icon]) => {
              const active = label === "Personal Settings";
              return (
                <button key={label} type="button" data-testid={`practice-settings-nav-${slug(label)}`}
                        className={`w-full flex items-center gap-3 px-3 py-1.5 text-xs text-left transition-colors ${
                          active ? "bg-[#1E88E5] text-white font-semibold" : "text-slate-700 hover:bg-slate-50"}`}>
                  <Icon size={12} className={active ? "text-white" : "text-[#1E88E5]"} />{label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div>
        <div className="text-xs font-semibold text-slate-700 mb-1">Mobile Apps</div>
        <div className="space-y-2">
          {["Google Play", "App Store"].map(s => (
            <div key={s} className="w-32 rounded-md bg-black text-white px-3 py-1.5 leading-tight" data-testid={`practice-settings-${slug(s)}-badge`}>
              <div className="text-[8px] uppercase">{s === "Google Play" ? "Android app on" : "Available on the"}</div>
              <div className="text-sm font-semibold">{s}</div>
            </div>
          ))}
        </div>
      </div>
    </nav>
  );
}

const Row = ({ label, required, hint, help, children }) => (
  <div className="grid grid-cols-[160px_1fr] items-start gap-3 py-2">
    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-700 pt-2 flex items-center gap-1">
      {help && <span className="text-slate-400">?</span>}{label}{required && <span className="text-red-500">*</span>}
    </div>
    <div>{children}{hint && <p className="mt-1 text-[11px] text-slate-500">{hint}</p>}</div>
  </div>
);

const input = "w-full h-8 rounded border border-slate-300 px-2.5 text-sm text-slate-700 outline-none focus:border-[#1E88E5]";

const Toggle = ({ value, onChange, testId }) => (
  <button type="button" onClick={() => onChange(!value)} data-testid={testId}
          className={`h-6 min-w-[48px] rounded px-2 text-xs font-semibold flex items-center ${value ? "bg-[#1E88E5] text-white justify-start" : "bg-slate-200 text-slate-700 justify-end"}`}>
    {value ? "Yes" : "No"}
  </button>
);

const Section = ({ title, children }) => (
  <section className="rounded border border-slate-200 bg-white px-5 py-4">
    <h2 className="text-sm font-bold uppercase tracking-wide text-slate-800 mb-2">{title}</h2>
    {children}
  </section>
);

export default function PracticeSettings() {
  const { user } = useAuth();
  const [first = "", ...rest] = (user?.name || "").split(" ");
  const [f, setF] = useState({
    first, middle: "", last: rest.join(" "), title: "", mobile: "", email: user?.email || "",
    tz: "(UTC-08:00) Pacific Time (US & Canada)", home: "", office: "", rate: "0.00", round: false, agenda: true,
  });
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e?.target ? e.target.value : e }));

  return (
    <PracticeShell>
      <div className="space-y-3" data-testid="practice-settings">
        <div className="flex items-center gap-3">
          <Cog size={26} className="text-slate-500" strokeWidth={1.5} />
          <h1 className="text-2xl font-bold text-slate-800">Settings</h1>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-5">
          <SettingsNav />
          <div className="space-y-4">
            <Section title="Personal Settings">
              <Row label="Profile Picture" required>
                <div className="inline-flex flex-col items-start gap-1.5">
                  <div className="h-24 w-24 rounded border border-slate-300 bg-slate-200 grid place-items-center" data-testid="practice-profile-picture">
                    <User size={56} className="text-white fill-white" />
                  </div>
                  <button type="button" data-testid="practice-upload-picture-btn"
                          className="inline-flex items-center gap-1 rounded-full border border-slate-300 px-2.5 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50">
                    <Camera size={11} /> Upload Picture
                  </button>
                </div>
              </Row>
              <Row label="Name">
                <div className="grid grid-cols-3 gap-2">
                  <input className={input} value={f.first} onChange={set("first")} placeholder="First" data-testid="practice-first-name" />
                  <input className={input} value={f.middle} onChange={set("middle")} placeholder="M" data-testid="practice-middle-name" />
                  <input className={input} value={f.last} onChange={set("last")} placeholder="Last" data-testid="practice-last-name" />
                </div>
              </Row>
              <Row label="Job Title" help>
                <select className={input} value={f.title} onChange={set("title")} data-testid="practice-job-title">
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
                <select className={input} value={f.tz} onChange={set("tz")} data-testid="practice-timezone">
                  {["(UTC-10:00) Hawaii", "(UTC-09:00) Alaska", "(UTC-08:00) Pacific Time (US & Canada)", "(UTC-07:00) Mountain Time (US & Canada)",
                    "(UTC-06:00) Central Time (US & Canada)", "(UTC-05:00) Eastern Time (US & Canada)"].map(t => <option key={t}>{t}</option>)}
                </select>
              </Row>
            </Section>
            <Section title="Contact Info">
              <Row label="Home"><input className={input} value={f.home} onChange={set("home")} data-testid="practice-home-phone" /></Row>
              <Row label="Office"><input className={input} value={f.office} onChange={set("office")} data-testid="practice-office-phone" /></Row>
            </Section>
            <Section title="Time Entries">
              <Row label="Hourly Rate (USD)" required hint="The amount you charge per hour when billing for your time. Each user can have their own rates.">
                <input type="number" step="0.01" className={input} value={f.rate} onChange={set("rate")} data-testid="practice-hourly-rate" />
              </Row>
              <Row label="Round Time Entries?" help><Toggle value={f.round} onChange={set("round")} testId="practice-round-toggle" /></Row>
            </Section>
            <Section title="Notification Emails">
              <Row label="Receive Daily Agenda Email?" help><Toggle value={f.agenda} onChange={set("agenda")} testId="practice-agenda-toggle" /></Row>
            </Section>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => toast.success("Settings saved")} data-testid="practice-settings-save-btn"
                      className="inline-flex items-center gap-1.5 rounded bg-[#43A047] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[#388E3C]">
                <Check size={14} /> Save
              </button>
              <button type="button" data-testid="practice-settings-cancel-btn"
                      className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
                <X size={14} /> Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    </PracticeShell>
  );
}
