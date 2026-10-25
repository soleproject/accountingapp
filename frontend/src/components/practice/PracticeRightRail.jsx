import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, Play, Pause, Check, X, Calculator, MessageSquare, Filter, ChevronDown, Users } from "lucide-react";
import { usePracticeTimer, timer, fmtClock } from "@/components/practice/timerStore";
import { NewTimeEntryModal } from "@/components/practice/NewTimeEntryModal";

export const PracticeRecentActivity = () => (
  <section className="rounded-md border border-slate-200 bg-white p-4" data-testid="practice-recent-activity">
    <h2 className="text-xs font-bold uppercase tracking-wider text-slate-600 mb-3">Recent Activity</h2>
    <div className="flex items-stretch gap-2">
      <label className="flex-1 flex items-center gap-2 rounded border border-slate-300 bg-white px-3">
        <MessageSquare size={16} className="text-slate-400" />
        <input placeholder="What's new?" data-testid="practice-activity-input"
               className="flex-1 h-9 text-sm outline-none bg-transparent text-slate-700" />
        <Filter size={14} className="text-slate-400" />
      </label>
      <button type="button" data-testid="practice-activity-save-btn"
              className="h-9 px-4 rounded bg-[#1E88E5] text-white text-sm font-semibold hover:bg-[#1976D2]">Save ›</button>
    </div>
    <div className="mt-3 flex items-center gap-3 text-[11px] uppercase tracking-wider font-semibold text-slate-500">
      <span className="text-slate-300">« ‹</span><span className="text-slate-700 text-sm border-b border-slate-400 px-2">0</span><span className="text-slate-300">› »</span>
      <span className="ml-3 inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-0.5 text-slate-700">10 <ChevronDown size={11} /></span>
      <span>Items per page</span>
      <span className="flex-1 text-right">No items to display</span>
    </div>
  </section>
);

const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function MiniCalendar() {
  const today = new Date();
  const [view, setView] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const first = new Date(view.y, view.m, 1);
  const start = new Date(first); start.setDate(1 - first.getDay());
  const cells = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  const monthName = first.toLocaleString("en-US", { month: "long" }).toUpperCase();
  const shift = (n) => setView(v => { const d = new Date(v.y, v.m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const isToday = (d) => d.toDateString() === today.toDateString();

  return (
    <div className="rounded-md border border-slate-200 bg-white p-3" data-testid="practice-calendar">
      <div className="flex items-center justify-between text-xs font-bold text-slate-700 mb-2">
        <button type="button" onClick={() => shift(-1)} data-testid="practice-calendar-prev"><ChevronLeft size={14} /></button>
        <span>{monthName} {view.y}</span>
        <button type="button" onClick={() => shift(1)} data-testid="practice-calendar-next"><ChevronRight size={14} /></button>
      </div>
      <div className="grid grid-cols-7 text-center text-[11px] font-semibold text-slate-600 mb-1">{DOW.map(d => <span key={d}>{d}</span>)}</div>
      <div className="grid grid-cols-7 text-center text-xs">
        {cells.map((d, i) => (
          <span key={i} className={`py-1.5 ${d.getMonth() !== view.m ? "text-slate-300" : "text-slate-700"}`}>
            <span className={`inline-grid place-items-center h-6 w-6 rounded ${isToday(d) ? "bg-[#1E88E5] text-white font-bold" : ""}`}>{d.getDate()}</span>
          </span>
        ))}
      </div>
      <div className="mt-2 border-t border-slate-200 pt-2 text-center text-xs text-[#1E88E5] font-medium" data-testid="practice-calendar-today">
        {today.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
      </div>
    </div>
  );
}

const RECENT_KEY = "practice_recent";
export const pushRecent = (item) => {
  const cur = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]").filter(r => r.to !== item.to);
  localStorage.setItem(RECENT_KEY, JSON.stringify([item, ...cur].slice(0, 8)));
};

function RecentCard() {
  const nav = useNavigate();
  const items = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  if (!items.length) return null;
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4" data-testid="practice-recent-card">
      <div className="text-xs font-bold uppercase tracking-wider text-slate-700">Recent</div>
      <ul className="mt-3 space-y-1.5">
        {items.map(r => (
          <li key={r.to}>
            <button type="button" onClick={() => nav(r.to)} data-testid="practice-recent-item"
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#1E88E5] hover:underline">
              <Users size={12} className="text-slate-500" />{r.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TimerCard() {
  const { active, running, seconds, notes } = usePracticeTimer();
  const [confirm, setConfirm] = useState(false);
  const [save, setSave] = useState(false);
  return (
    <>
      {active && (
        <button type="button" data-testid="practice-start-another-timer-btn"
                className="w-full h-9 rounded-full bg-[#1E88E5] text-white text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-2 hover:bg-[#1976D2]">
          <Play size={11} className="fill-white" /> Start Another Timer
        </button>
      )}
      <div className="rounded-md border border-slate-200 bg-white p-4 text-center" data-testid="practice-timer-card">
        <div className="text-xs font-bold uppercase tracking-wider text-slate-700">Timer</div>
        <div className="mt-1 flex items-center justify-center gap-2 text-3xl font-light text-slate-700 tabular-nums">
          <button type="button" onClick={() => !active ? timer.start() : running ? timer.pause() : timer.resume()}
                  data-testid="practice-rail-timer-toggle" aria-label={running ? "Pause timer" : "Start timer"} className="text-[#1E88E5]">
            {running ? <Pause size={22} className="fill-[#1E88E5]" /> : <Play size={22} className="fill-[#1E88E5]" />}
          </button>
          <span data-testid="practice-rail-timer-clock">{fmtClock(seconds)}</span>
        </div>
        {active && (
          <div className="mt-4 text-left">
            <textarea value={notes} onChange={e => timer.setNotes(e.target.value)} placeholder="Add Notes..." data-testid="practice-rail-timer-notes"
                      className="w-full h-16 rounded border border-slate-300 px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#1E88E5] placeholder:text-slate-400 resize-none" />
            <div className="mt-2 flex justify-end gap-2">
              <button type="button" onClick={() => { timer.pause(); setSave(true); }} data-testid="practice-rail-timer-save"
                      className="inline-flex items-center gap-1.5 h-8 px-4 rounded-full bg-[#43A047] text-white text-sm font-semibold hover:bg-[#388E3C]"><Check size={14} /> Save</button>
              <button type="button" onClick={() => setConfirm(true)} data-testid="practice-rail-timer-cancel"
                      className="inline-flex items-center gap-1.5 h-8 px-4 rounded-full bg-slate-200 text-slate-700 text-sm font-semibold hover:bg-slate-300"><X size={14} /> Cancel</button>
            </div>
          </div>
        )}
      </div>
      {confirm && (
        <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center" data-testid="practice-timer-cancel-confirm">
          <div className="w-[300px] rounded bg-white shadow-xl">
            <div className="px-3 py-2.5 border-b border-slate-200 text-lg text-slate-800">Confirmation</div>
            <div className="px-3 py-3 text-sm text-slate-700">Are you sure you want to cancel this timer?</div>
            <div className="px-3 pb-3 flex gap-2">
              <button type="button" onClick={() => { timer.clear(); setConfirm(false); }} data-testid="practice-timer-cancel-yes"
                      className="inline-flex items-center gap-1.5 h-8 px-4 rounded-full bg-[#43A047] text-white text-sm font-semibold"><Check size={14} /> Yes</button>
              <button type="button" onClick={() => setConfirm(false)} data-testid="practice-timer-cancel-no"
                      className="inline-flex items-center gap-1.5 h-8 px-4 rounded-full bg-slate-200 text-slate-700 text-sm font-semibold"><X size={14} /> No</button>
            </div>
          </div>
        </div>
      )}
      {save && <NewTimeEntryModal timerSeconds={seconds} timerNotes={notes} onClose={() => { setSave(false); timer.resume(); }} onSaved={() => { setSave(false); timer.clear(); }} />}
    </>
  );
}

export const PracticeRightRail = ({ onHide }) => (
  <aside className="space-y-4" data-testid="practice-right-rail">
    <div className="text-right">
      <button type="button" onClick={onHide} data-testid="practice-hide-sidebar-btn"
              className="text-[11px] font-bold uppercase tracking-wider text-[#1E88E5] hover:underline">» Hide Sidebar</button>
    </div>
    <div className="rounded-md border border-slate-200 bg-white p-4 text-center relative overflow-hidden" data-testid="practice-refer-card">
      <div className="text-xs font-bold uppercase tracking-wide text-slate-800">Refer a friend, get rewarded!</div>
      <button type="button" data-testid="practice-refer-btn"
              className="mt-2 h-7 px-4 rounded-full bg-[#1E88E5] text-white text-xs font-semibold">Submit A Referral</button>
      <ChevronLeft size={16} className="absolute left-2 top-1/2 -translate-y-1/2 text-[#1E88E5]" />
      <ChevronRight size={16} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#1E88E5]" />
    </div>
    <TimerCard />
    <MiniCalendar />
    <button type="button" data-testid="practice-date-calculator-btn"
            className="w-full h-9 rounded-full bg-[#1E88E5] text-white text-sm font-semibold flex items-center justify-center gap-2 hover:bg-[#1976D2]">
      <Calculator size={15} /> Date Calculator
    </button>
    <div className="rounded-md border border-slate-200 bg-white p-4" data-testid="practice-agenda">
      <div className="text-xs font-bold uppercase tracking-wider text-slate-700">Your Agenda</div>
      <div className="mt-3 text-center text-xs font-bold uppercase tracking-wide text-slate-800">Nothing due this week.</div>
    </div>
    <RecentCard />
  </aside>
);
