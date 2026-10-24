import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronDown, User } from "lucide-react";

export const sameDay = (a, b) => a.toDateString() === b.toDateString();
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const startOfWeek = (d) => addDays(d, -d.getDay());
export const fmtLong = (d) => d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export const MiniCalendar = ({ selected, onSelect, inRange }) => {
  const today = new Date();
  const [view, setView] = useState({ y: selected.getFullYear(), m: selected.getMonth() });
  useEffect(() => { setView({ y: selected.getFullYear(), m: selected.getMonth() }); }, [selected]);
  const first = new Date(view.y, view.m, 1);
  const start = startOfWeek(first);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const shift = (n) => setView(v => { const d = new Date(v.y, v.m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; });

  return (
    <div data-testid="practice-cal-mini">
      <div className="flex items-center justify-between text-sm text-slate-800 mb-2 px-1">
        <button type="button" onClick={() => shift(-1)} data-testid="practice-cal-mini-prev"><ChevronLeft size={14} /></button>
        <span>{first.toLocaleString("en-US", { month: "long" })} {view.y}</span>
        <button type="button" onClick={() => shift(1)} data-testid="practice-cal-mini-next"><ChevronRight size={14} /></button>
      </div>
      <div className="grid grid-cols-7 text-center text-[11px] text-slate-600 mb-1">{DOW.map(d => <span key={d}>{d}</span>)}</div>
      <div className="grid grid-cols-7 text-center text-xs">
        {cells.map((d, i) => {
          const out = d.getMonth() !== view.m;
          const sel = sameDay(d, selected);
          const isToday = sameDay(d, today);
          return (
            <button key={i} type="button" title={fmtLong(d)} onClick={() => onSelect(d)} data-testid={`practice-cal-mini-day-${d.toISOString().slice(0, 10)}`}
                    className={`py-1 ${out ? "text-slate-300" : "text-slate-700"}`}>
              <span className={`inline-grid place-items-center h-7 w-7 rounded-full ${sel ? "bg-[#1E88E5] text-white font-bold" : inRange?.(d) ? "bg-slate-100" : "hover:bg-slate-100"} ${isToday && !sel ? "text-[#1E88E5] font-bold" : ""}`}>{d.getDate()}</span>
            </button>
          );
        })}
      </div>
      <button type="button" onClick={() => { onSelect(today); setView({ y: today.getFullYear(), m: today.getMonth() }); }} data-testid="practice-cal-mini-today"
              className="mt-2 w-full border-t border-slate-200 pt-2 text-center text-xs text-[#1E88E5]">{fmtLong(today)}</button>
    </div>
  );
};

export const SidePanel = ({ title, children, testId }) => {
  const [open, setOpen] = useState(true);
  return (
    <section className="rounded border border-slate-200 bg-white px-4 py-3" data-testid={testId}>
      <button type="button" onClick={() => setOpen(v => !v)} className="flex items-center gap-1 text-base font-bold uppercase tracking-wide text-slate-800">
        {title} <ChevronDown size={16} className={`transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && <div className="pt-3">{children}</div>}
    </section>
  );
};

export const CalendarSidebar = ({ selected, onSelect, inRange, userName, calOn, setCalOn }) => (
  <aside className="space-y-3" data-testid="practice-cal-sidebar">
    <SidePanel title="Mini Calendar" testId="practice-cal-mini-panel"><MiniCalendar selected={selected} onSelect={onSelect} inRange={inRange} /></SidePanel>
    <SidePanel title="Calendars" testId="practice-cal-calendars-panel">
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={calOn} onChange={e => setCalOn(e.target.checked)} className="h-4 w-4" data-testid="practice-cal-user-toggle" />
        <span className="h-7 w-7 rounded-full bg-slate-300 grid place-items-center"><User size={16} className="text-white fill-white" /></span>{userName}
      </label>
    </SidePanel>
    <SidePanel title="User Groups" testId="practice-cal-groups-panel">
      <p className="text-sm text-slate-700">To create your first User Group, click <span className="text-[#1E88E5]">here!</span></p>
    </SidePanel>
  </aside>
);
