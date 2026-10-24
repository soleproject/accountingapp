import { sameDay, addDays, startOfWeek } from "@/components/practice/CalendarSidebar";
import { toISO, fmtTime } from "@/components/practice/DateTimePicker";

const Chip = ({ t }) => (
  <div className={`truncate rounded px-1 py-px text-[11px] text-left ${t.status === "Completed" ? "bg-slate-200 text-slate-500 line-through" : "bg-[#1E88E5] text-white"}`}
       title={t.subject} data-testid={`practice-cal-task-${t.id}`}>
    {t.due_time ? `${fmtTime(t.due_time)} ` : ""}{t.subject}
  </div>
);
const forDay = (tasks, d) => tasks.filter(t => t.due_date === toISO(d));

const HOURS = Array.from({ length: 16 }, (_, i) => i + 6);
const hourLabel = (h) => (h === 12 ? "12pm" : h < 12 ? `${h}am` : `${h - 12}pm`);
const short = (d) => d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });

export const MonthView = ({ date, selected, onPick, tasks = [] }) => {
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
                    className={`h-[88px] border-b border-r border-slate-200 px-1 pt-1 text-xs align-top flex flex-col ${
                      sameDay(d, today) ? "bg-[#FFFDE7]" : sameDay(d, selected) ? "bg-blue-50" : "bg-white hover:bg-slate-50"} ${out ? "text-slate-300" : "text-slate-700"}`}>
              <span className="text-right pr-1">{d.getDate()}</span>
              <div className="space-y-0.5 overflow-hidden">{forDay(tasks, d).slice(0, 3).map(t => <Chip key={t.id} t={t} />)}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export const TimeGrid = ({ days, userName, tasks = [] }) => {
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
        {days.map(d => <div key={d} className="border-l border-slate-200 min-h-9 p-0.5 space-y-0.5">{forDay(tasks, d).filter(t => !t.due_time).map(t => <Chip key={t.id} t={t} />)}</div>)}
      </div>
      {HOURS.map(h => (
        <div key={h} className="grid" style={{ gridTemplateColumns: `56px repeat(${days.length}, 1fr)` }}>
          <div className="text-[11px] text-slate-600 text-right pr-2 -mt-2 h-12">{hourLabel(h)}</div>
          {days.map(d => <div key={d} className={`border-l border-b border-slate-200 h-12 p-0.5 space-y-0.5 overflow-hidden ${sameDay(d, today) ? "bg-[#FFFDE7]" : ""}`}>
            {forDay(tasks, d).filter(t => t.due_time && Number(t.due_time.split(":")[0]) === h).map(t => <Chip key={t.id} t={t} />)}
          </div>)}
        </div>
      ))}
    </div>
  );
};

export const AgendaView = ({ start, end, tasks = [] }) => (
  <div className="border border-slate-200 bg-white" data-testid="practice-cal-agenda">
    {tasks.length === 0 ? <div className="px-6 py-16 text-center text-sm text-slate-500">No events or tasks between {short(start)} and {short(end)}.</div> : (
      <ul className="divide-y divide-slate-200">
        {tasks.map(t => (
          <li key={t.id} className="flex items-center gap-4 px-4 py-2 text-sm" data-testid={`practice-cal-agenda-${t.id}`}>
            <span className="w-28 text-slate-600">{short(new Date(t.due_date + "T00:00:00"))}</span>
            <span className="w-20 text-slate-500">{t.due_time ? fmtTime(t.due_time) : "all-day"}</span>
            <span className="font-medium text-slate-800">{t.subject}</span>
            <span className="text-xs text-slate-500">{t.status}</span>
          </li>
        ))}
      </ul>
    )}
  </div>
);
