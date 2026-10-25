import { User, ChevronDown, Tag, Search, Settings, FileSpreadsheet, FileText, MoreVertical, ArrowUp, Sparkles } from "lucide-react";

export const sel = "h-8 rounded border border-slate-300 bg-white px-2 text-sm text-slate-700 outline-none";

const fmt = (v) => `$${Number(v) < 0 ? "-" : ""}${Math.abs(Number(v || 0)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const money = (v = 0) => (
  <span className="inline-block min-w-[140px] rounded-full border border-slate-300 px-3 py-0.5 text-center text-xs text-slate-700">
    {fmt(v)} <span className="text-[10px]">USD</span>
  </span>
);
const filled = (v, bg) => (
  <span className={`inline-block min-w-[140px] rounded-full ${bg} px-3 py-0.5 text-center text-xs font-semibold text-white`}>
    {fmt(v)} <span className="text-[10px] font-normal">USD</span>
  </span>
);

export const billableMoney = (v = 0) => Number(v) > 0 ? filled(v, "bg-[#FFA726]") : money(v);
export const trustMoney = (v = 0) => Number(v) > 0 ? filled(v, "bg-[#1E88E5]") : money(v);
export const operatingMoney = (due = 0) => Number(due) > 0 ? filled(-due, "bg-[#E53935]") : money(0);

export const HoverPill = ({ children, testId }) => (
  <div className="absolute -bottom-2.5 left-2 z-10 hidden group-hover:inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-2.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-600 whitespace-nowrap shadow-sm" data-testid={testId}>
    {children}
  </div>
);

export const initials = (n = "") => n.split(" ").filter(Boolean).map(s => s[0]).join("").slice(0, 2).toUpperCase();

export const Avatar = ({ name }) => name ? (
  <span className="inline-grid h-8 w-8 place-items-center rounded-full border-2 border-[#1E88E5] text-xs font-bold text-slate-800" title={name}>{initials(name)}</span>
) : null;

export const UserFilter = ({ testId }) => (
  <div className={`${sel} w-44 flex items-center gap-2`} data-testid={testId}>
    <span className="h-5 w-5 rounded-full bg-slate-300 grid place-items-center"><User size={12} className="text-white fill-white" /></span>
    <select className="flex-1 bg-transparent outline-none text-sm"><option>Any User</option></select>
  </div>
);

export const PillFilter = ({ children, testId, icon }) => (
  <button type="button" className={`${sel} rounded-full inline-flex items-center gap-1`} data-testid={testId}>{icon}{children} <ChevronDown size={12} /></button>
);

export const TagsFilter = ({ testId }) => (
  <button type="button" className={`${sel} inline-flex items-center gap-1`} data-testid={testId}><Tag size={13} /> Tags <ChevronDown size={12} /></button>
);

export const CountCard = ({ label, value, testId, className = "" }) => (
  <div className={`flex items-center justify-between rounded border border-slate-200 bg-white px-3 py-3 ${className}`} data-testid={testId}>
    <span className="text-[11px] uppercase tracking-wider text-slate-600">{label}</span>
    <span className="text-lg text-slate-800">{value}</span>
  </div>
);

export const ListToolbar = ({ q, setQ, placeholder, testId }) => (
  <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-200">
    <Search size={16} className="text-slate-400" />
    <input value={q} onChange={e => setQ(e.target.value)} placeholder={placeholder} data-testid={testId}
           className="flex-1 h-9 text-sm outline-none bg-transparent text-slate-700 placeholder:text-slate-400" />
    <button type="button" className="inline-flex items-center gap-1 text-sm text-slate-500"><Settings size={14} /> Choose Columns</button>
    <button type="button" className="text-slate-500"><FileSpreadsheet size={16} /></button>
    <button type="button" className="text-slate-500"><FileText size={16} /></button>
  </div>
);

export const ListHead = ({ cols, sortCol }) => (
  <thead>
    <tr className="text-[13px] uppercase tracking-wide text-slate-600">
      <th className="px-4 py-3 w-10"><input type="checkbox" className="h-4 w-4" /></th>
      {cols.map(h => (
        <th key={h} className="px-2 py-3 text-left font-semibold">
          <span className="inline-flex items-center gap-2"><MoreVertical size={14} className="text-slate-400" />{h}{h === sortCol && <ArrowUp size={12} />}</span>
        </th>
      ))}
    </tr>
  </thead>
);

export const ListFooter = ({ count }) => (
  <div className="flex items-center gap-3 px-4 py-2 border-t border-slate-200 text-xs text-slate-500">
    <span className="text-slate-300">« ‹</span><span className="text-slate-800 text-sm border-b border-slate-400 px-2">1</span><span className="text-slate-300">› »</span>
    <span className="ml-3 inline-flex items-center gap-1 rounded-full border border-slate-300 px-2.5 py-0.5 text-slate-700">50 <ChevronDown size={11} /></span>
    <span className="uppercase tracking-wide font-semibold">Items per page</span>
    <span className="flex-1 text-right uppercase tracking-wide">1 - {count} of {count} items</span>
  </div>
);

export const EmptyIllustration = ({ icon: Icon, children, testId }) => (
  <div className="py-16 text-center" data-testid={testId}>
    <div className="relative inline-block mb-6">
      <Sparkles size={34} className="absolute -top-6 -left-10 text-[#1E88E5]" />
      <Sparkles size={22} className="absolute -top-2 right-[-40px] text-[#1E88E5]" />
      <div className="flex items-center gap-3 text-slate-700">
        <span className="h-0.5 w-28 bg-slate-500" /><Icon size={72} strokeWidth={1.2} /><span className="h-0.5 w-28 bg-slate-500" />
      </div>
    </div>
    {children}
  </div>
);
