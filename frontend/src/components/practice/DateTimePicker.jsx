import { useEffect, useRef, useState } from "react";
import { Calendar, Clock } from "lucide-react";
import { MiniCalendar } from "@/components/practice/CalendarSidebar";

export const toISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const fromISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const fmtDate = (s) => { const d = fromISO(s); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; };
export const fmtTime = (t) => { if (!t) return ""; const [h, m] = t.split(":").map(Number); const ap = h >= 12 ? "PM" : "AM"; return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ap}`; };
const TIMES = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);

export const DateTimePicker = ({ date, time, allDay, onDate, onTime, testId = "practice-dtp" }) => {
  const [open, setOpen] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(null); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <div className="flex items-center h-9 rounded border border-slate-300 bg-white px-3 text-sm text-slate-700">
        <button type="button" onClick={() => setOpen(o => (o === "date" ? null : "date"))} className="flex-1 text-left" data-testid={`${testId}-value`}>
          {fmtDate(date)}{!allDay && time ? ` ${fmtTime(time)}` : ""}
        </button>
        <button type="button" onClick={() => setOpen(o => (o === "date" ? null : "date"))} className="text-slate-500 ml-2" data-testid={`${testId}-calendar-btn`}><Calendar size={14} /></button>
        {!allDay && <button type="button" onClick={() => setOpen(o => (o === "time" ? null : "time"))} className="text-slate-500 ml-2" data-testid={`${testId}-clock-btn`}><Clock size={14} /></button>}
      </div>
      {open === "date" && (
        <div className="absolute left-0 top-full mt-1 z-50 w-64 rounded border border-slate-300 bg-white p-2 shadow-lg" data-testid={`${testId}-calendar`}>
          <MiniCalendar selected={fromISO(date)} onSelect={(d) => { onDate(toISO(d)); setOpen(null); }} />
        </div>
      )}
      {open === "time" && (
        <div className="absolute left-0 top-full mt-1 z-50 w-40 max-h-40 overflow-y-auto rounded border border-slate-300 bg-white shadow-lg" data-testid={`${testId}-times`}>
          {TIMES.map(t => (
            <button key={t} type="button" onClick={() => { onTime(t); setOpen(null); }} data-testid={`${testId}-time-${t}`}
                    className={`block w-full px-3 py-1 text-left text-sm hover:bg-slate-100 ${t === time ? "text-[#1E88E5] font-semibold" : "text-slate-700"}`}>{fmtTime(t)}</button>
          ))}
        </div>
      )}
    </div>
  );
};
