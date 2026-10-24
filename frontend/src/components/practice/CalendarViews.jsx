import { sameDay, addDays, startOfWeek } from "@/components/practice/CalendarSidebar";

const HOURS = Array.from({ length: 16 }, (_, i) => i + 6);
const hourLabel = (h) => (h === 12 ? "12pm" : h < 12 ? `${h}am` : `${h - 12}pm`);
const short = (d) => d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });

export const MonthView = ({ date, selected, onPick }) => {
  const today = new Date();
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(startOfWeek(first), i));
  return (
    <div className="border border-slate-200" data-testid="practice-cal-month">
      <div className="grid grid-cols-7 text-center text-sm text-slate-700 border-b border-slate-200">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => <div key={d} className="py-1">{d}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((d, i) => {
          const out = d.getMonth() !== date.getMonth();
          return (
            <button key={i} type="button" onClick={() => onPick(d)} data-testid={`practice-cal-month-day-${d.toISOString().slice(0, 10)}`}
                    className={`h-[88px] border-b border-r border-slate-200 text-right px-2 pt-1 text-xs align-top ${
                      sameDay(d, today) ? "bg-[#FFFDE7]" : sameDay(d, selected) ? "bg-blue-50" : "bg-white hover:bg-slate-50"} ${out ? "text-slate-300" : "text-slate-700"}`}>
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export const TimeGrid = ({ days, userName }) => {
  const today = new Date();
  return (
    <div className="border border-slate-200 overflow-auto max-h-[640px]" data-testid="practice-cal-timegrid">
      <div className="grid sticky top-0 bg-white z-10 border-b border-slate-200" style={{ gridTemplateColumns: `56px repeat(${days.length}, 1fr)` }}>
        <div />
        {days.map(d => (
          <div key={d} className={`py-1 text-center text-sm font-semibold ${sameDay(d, today) ? "text-[#1E88E5]" : "text-slate-800"}`}>
            {days.length === 1 ? userName : `${d.toLocaleDateString("en-US", { weekday: "long" })} ${short(d)}`}
          </div>
        ))}
      </div>
      <div className="grid border-b border-slate-200" style={{ gridTemplateColumns: `56px repeat(${days.length}, 1fr)` }}>
        <div className="text-[11px] text-slate-500 px-1 py-2">all-day</div>
        {days.map(d => <div key={d} className="border-l border-slate-200 h-9" />)}
      </div>
      {HOURS.map(h => (
        <div key={h} className="grid" style={{ gridTemplateColumns: `56px repeat(${days.length}, 1fr)` }}>
          <div className="text-[11px] text-slate-600 text-right pr-2 -mt-2 h-12">{hourLabel(h)}</div>
          {days.map(d => <div key={d} className={`border-l border-b border-slate-200 h-12 ${sameDay(d, today) ? "bg-[#FFFDE7]" : ""}`} />)}
        </div>
      ))}
    </div>
  );
};

export const AgendaView = ({ start, end }) => (
  <div className="border border-slate-200 bg-white px-6 py-16 text-center text-sm text-slate-500" data-testid="practice-cal-agenda">
    No events or tasks between {short(start)} and {short(end)}.
  </div>
);
