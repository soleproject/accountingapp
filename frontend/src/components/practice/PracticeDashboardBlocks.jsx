import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ActivityModal } from "@/components/practice/ActivityModal";
import { NewTimeEntryModal } from "@/components/practice/NewTimeEntryModal";
import { NewExpenseModal } from "@/components/practice/NewExpenseModal";
import {
  Scale, Wallet, BadgeDollarSign, Receipt, UserPlus, Briefcase, CalendarDays,
  ClipboardList, FileText, Phone, MessageSquare, Clock, FileSignature,
  FileInput, CreditCard, CircleCheck, Circle,
} from "lucide-react";

const TILES = [
  { label: "Trust", bg: "#1E88E5", icon: Scale, to: "/practice/payments?account=Trust%20Account", tip: "This is the amount of money in your trust account right now." },
  { label: "Paid", bg: "#43A047", icon: Wallet, to: "/practice/payments?account=Operating%20Account", tip: "This is the total amount paid to your operating account minus any credit card debts during the selected date range." },
  { label: "Due", bg: "#E53935", icon: BadgeDollarSign, to: "/practice/invoices", tip: "This is the total balance due on all outstanding invoices." },
  { label: "Billable", bg: "#FFA726", icon: Receipt, to: "/practice/matters?status=Billable", tip: "This is the total amount of unbilled time, expenses and flat fees ready to be invoiced." },
];

const tileFmt = (v) => `$${Number(v) < 0 ? "-" : ""}${Math.abs(Number(v || 0)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const PracticeStatTiles = ({ values }) => {
  const nav = useNavigate();
  return (
  <div className="grid grid-cols-2 lg:grid-cols-4 gap-6" data-testid="practice-stat-tiles">
    {TILES.map(t => {
      const Icon = t.icon;
      const k = t.label.toLowerCase();
      const v = values ? (k === "due" ? -(values.due || 0) : values[k] || 0) : 0;
      return (
        <button type="button" key={t.label} data-testid={`practice-tile-${k}`} onClick={() => nav(t.to)}
             className="group relative hover:z-40 rounded-md text-white px-5 py-3.5 flex items-center gap-4 shadow-sm text-left hover:brightness-110 transition"
             style={{ backgroundColor: t.bg }}>
          <Icon size={30} strokeWidth={1.6} className="opacity-90" />
          <div>
            <div className="text-[11px] uppercase tracking-wider font-semibold opacity-90">{t.label}</div>
            <div className="text-lg font-bold leading-tight" data-testid={`practice-tile-${k}-value`}>{tileFmt(v)} <span className="text-xs font-semibold">USD</span></div>
          </div>
          <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 hidden w-72 -translate-x-1/2 rounded border border-slate-200 bg-white text-left shadow-xl group-hover:block" data-testid={`practice-tile-${k}-tip`}>
            <span className="block border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-800">{t.label}</span>
            <span className="block px-3 py-2 text-sm leading-snug text-slate-700">{t.tip}</span>
          </span>
        </button>
      );
    })}
  </div>
  );
};

const QUICK = [
  ["New Contact", UserPlus, "/practice/contacts/new", "Add a new person or company to your contacts."], ["New Matter", Briefcase, "/practice/matters/new", "Open a new case or matter for a contact."],
  ["New Event", CalendarDays, "event", "Create events, meetings, or deadlines. Add reminders by Email, Popup, or SMS."],
  ["New Task", ClipboardList, "task", "Create a new task for yourself, another team member, or even your clients."],
  ["New Note", FileText, "note", "Add a note about any contact or matter."], ["New Call", Phone, "call", "Log the details of an inbound or outbound call."],
  ["Send Message", MessageSquare], ["Track Time", Clock, "time", "Track your time against a contact and matter."], ["Add Expense", Wallet, "expense", "Add a hard or soft cost expense to a matter."],
  ["New Intake", FileSignature], ["New Invoice", FileInput, "/practice/invoices/create", "Create an invoice for a contact or matter."], ["New Payment", CreditCard],
  ["New Flat Fee", Receipt],
];
const GO = {
  event: (d) => ({ label: "Go to Calendar", to: "/practice/calendar" }), task: (d) => ({ label: "Go to Calendar", to: "/practice/calendar" }),
  note: (d) => ({ label: "Go to Activities", to: "/practice/activities?kind=note" }), call: (d) => ({ label: "Go to Activities", to: "/practice/activities?kind=call" }),
  time: (d) => ({ label: "Go to Time Entry", to: `/practice/time-entries/${d.id}` }),
  expense: (d) => ({ label: "Go to Expenses", to: "/practice/expenses" }),
};

export const PracticeQuickCreate = () => {
  const nav = useNavigate();
  const [modal, setModal] = useState(null);
  const saved = (kind) => (d) => {
    setModal(null);
    const g = GO[kind](d || {});
    toast.dismiss();
    toast.success("Item saved successfully.", { duration: 5000, position: "top-right", action: { label: g.label, onClick: () => nav(g.to) } });
  };
  return (
  <section className="rounded-md border border-slate-200 bg-white p-4" data-testid="practice-quick-create">
    <h2 className="text-xs font-bold uppercase tracking-wider text-slate-600 mb-3">Quick Create</h2>
    <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 xl:grid-cols-[repeat(13,minmax(0,1fr))] gap-2">
      {QUICK.map(([label, Icon, to, tip]) => (
        <button key={label} type="button" data-testid={`practice-quick-${label.toLowerCase().replace(/\s+/g, "-")}`}
                onClick={() => to && (to.startsWith("/") ? nav(to) : setModal(to))}
                className="group relative flex flex-col items-center justify-center gap-2 rounded border border-slate-200 bg-white py-4 px-1 text-[11px] font-medium text-slate-700 hover:border-[#1E88E5] hover:text-[#1E88E5] transition-colors">
          <Icon size={30} strokeWidth={1.4} className="text-slate-800" />
          <span className="whitespace-nowrap">{label}</span>
          {tip && <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 hidden w-44 -translate-x-1/2 rounded bg-slate-800 px-2.5 py-2 text-center text-[11px] font-medium leading-snug text-white shadow-lg group-hover:block">{tip}</span>}
        </button>
      ))}
    </div>
    {modal === "time" ? <NewTimeEntryModal onClose={() => setModal(null)} onSaved={saved("time")} />
      : modal === "expense" ? <NewExpenseModal onClose={() => setModal(null)} onSaved={saved("expense")} />
      : <ActivityModal modal={modal} onClose={() => setModal(null)} onSaved={modal ? saved(modal) : undefined} />}
  </section>
  );
};

const STEPS = [
  { label: "Setup your profile", done: true, to: "/practice/settings" }, { label: "Add your logo" }, { label: "Create a matter", to: "/practice/matters/new" },
  { label: "Track time" }, { label: "Generate an invoice" }, { label: "Create your first task" },
  { label: "Sync your calendar" }, { label: "Sync documents and files" }, { label: "Accept credit cards" },
];

export const PracticeGetStarted = () => {
  const nav = useNavigate();
  const pct = Math.round((STEPS.filter(s => s.done).length / STEPS.length) * 100);
  return (
    <section className="rounded-md border border-slate-200 bg-white p-4" data-testid="practice-get-started">
      <h2 className="text-xs font-bold uppercase tracking-wider text-slate-600 mb-3">Get Started</h2>
      <div className="h-6 rounded-full bg-slate-200 overflow-hidden mb-4" data-testid="practice-get-started-progress">
        <div className="h-full rounded-full bg-[#43A047] text-white text-xs font-bold grid place-items-center" style={{ width: `${pct}%` }}>{pct}%</div>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {STEPS.map(s => (
          <button key={s.label} type="button" data-testid={`practice-step-${s.label.toLowerCase().replace(/\s+/g, "-")}`}
                  onClick={() => s.to && nav(s.to)}
                  className="flex items-center gap-3 rounded border border-slate-300 bg-white px-4 py-3.5 text-left hover:border-[#1E88E5] transition-colors">
            {s.done ? <CircleCheck size={20} className="text-[#43A047] shrink-0" /> : <Circle size={20} className="text-slate-400 shrink-0" />}
            <span className={`text-[15px] font-semibold ${s.done ? "text-slate-800" : "text-[#1E88E5]"}`}>{s.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
};
