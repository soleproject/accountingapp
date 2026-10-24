import { useNavigate } from "react-router-dom";
import {
  Scale, Wallet, BadgeDollarSign, Receipt, UserPlus, Briefcase, CalendarDays,
  ClipboardList, FileText, Phone, MessageSquare, Clock, FileSignature,
  FileInput, CreditCard, CircleCheck, Circle,
} from "lucide-react";

const TILES = [
  { label: "Trust", bg: "#1E88E5", icon: Scale },
  { label: "Paid", bg: "#43A047", icon: Wallet },
  { label: "Due", bg: "#E53935", icon: BadgeDollarSign },
  { label: "Billable", bg: "#FFA726", icon: Receipt },
];

export const PracticeStatTiles = () => (
  <div className="grid grid-cols-2 lg:grid-cols-4 gap-6" data-testid="practice-stat-tiles">
    {TILES.map(t => {
      const Icon = t.icon;
      return (
        <div key={t.label} data-testid={`practice-tile-${t.label.toLowerCase()}`}
             className="rounded-md text-white px-5 py-3.5 flex items-center gap-4 shadow-sm"
             style={{ backgroundColor: t.bg }}>
          <Icon size={30} strokeWidth={1.6} className="opacity-90" />
          <div>
            <div className="text-[11px] uppercase tracking-wider font-semibold opacity-90">{t.label}</div>
            <div className="text-lg font-bold leading-tight">$0.00 <span className="text-xs font-semibold">USD</span></div>
          </div>
        </div>
      );
    })}
  </div>
);

const QUICK = [
  ["New Contact", UserPlus, "/practice/contacts/new"], ["New Matter", Briefcase], ["New Event", CalendarDays],
  ["New Task", ClipboardList], ["New Note", FileText], ["New Call", Phone],
  ["Send Message", MessageSquare], ["Track Time", Clock], ["Add Expense", Wallet],
  ["New Intake", FileSignature], ["New Invoice", FileInput], ["New Payment", CreditCard],
  ["New Flat Fee", Receipt],
];

export const PracticeQuickCreate = () => {
  const nav = useNavigate();
  return (
  <section className="rounded-md border border-slate-200 bg-white p-4" data-testid="practice-quick-create">
    <h2 className="text-xs font-bold uppercase tracking-wider text-slate-600 mb-3">Quick Create</h2>
    <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 xl:grid-cols-[repeat(13,minmax(0,1fr))] gap-2">
      {QUICK.map(([label, Icon, to]) => (
        <button key={label} type="button" data-testid={`practice-quick-${label.toLowerCase().replace(/\s+/g, "-")}`}
                onClick={() => to && nav(to)}
                className="flex flex-col items-center justify-center gap-2 rounded border border-slate-200 bg-white py-4 px-1 text-[11px] font-medium text-slate-700 hover:border-[#1E88E5] hover:text-[#1E88E5] transition-colors">
          <Icon size={30} strokeWidth={1.4} className="text-slate-800" />
          <span className="whitespace-nowrap">{label}</span>
        </button>
      ))}
    </div>
  </section>
  );
};

const STEPS = [
  { label: "Setup your profile", done: true, to: "/practice/settings" }, { label: "Add your logo" }, { label: "Create a matter" },
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
