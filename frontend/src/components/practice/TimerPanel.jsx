import { useState } from "react";
import { Play, Pause, Check, X } from "lucide-react";
import { usePracticeTimer, timer, fmtClock } from "@/components/practice/timerStore";
import { NewTimeEntryModal } from "@/components/practice/NewTimeEntryModal";

export function TimerPanel({ idPrefix = "practice-rail-timer", onDone }) {
  const { active, running, seconds, notes, contact_id, matter_id } = usePracticeTimer();
  const [confirm, setConfirm] = useState(false);
  const [save, setSave] = useState(false);
  return (
    <>
      <div className="text-xs font-bold uppercase tracking-wider text-slate-700 text-center">Timer</div>
      <div className="mt-1 flex items-center justify-center gap-2 text-3xl font-light text-slate-700 tabular-nums">
        <button type="button" onClick={() => !active ? timer.start() : running ? timer.pause() : timer.resume()}
                data-testid={`${idPrefix}-toggle`} aria-label={running ? "Pause timer" : "Start timer"} className="text-[#1E88E5]">
          {running ? <Pause size={22} className="fill-[#1E88E5]" /> : <Play size={22} className="fill-[#1E88E5]" />}
        </button>
        <span data-testid={`${idPrefix}-clock`}>{fmtClock(seconds)}</span>
      </div>
      {active && (
        <div className="mt-4 text-left">
          <textarea value={notes} onChange={e => timer.setNotes(e.target.value)} placeholder="Add Notes..." data-testid={`${idPrefix}-notes`}
                    className="w-full h-16 rounded border border-slate-300 px-3 py-2 text-sm text-slate-700 outline-none focus:border-[#1E88E5] placeholder:text-slate-400 resize-none" />
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={() => { timer.pause(); setSave(true); }} data-testid={`${idPrefix}-save`}
                    className="inline-flex items-center gap-1.5 h-8 px-4 rounded-full bg-[#43A047] text-white text-sm font-semibold hover:bg-[#388E3C]"><Check size={14} /> Save</button>
            <button type="button" onClick={() => setConfirm(true)} data-testid={`${idPrefix}-cancel`}
                    className="inline-flex items-center gap-1.5 h-8 px-4 rounded-full bg-slate-200 text-slate-700 text-sm font-semibold hover:bg-slate-300"><X size={14} /> Cancel</button>
          </div>
        </div>
      )}
      {confirm && (
        <div className="fixed inset-0 z-[70] bg-black/40 grid place-items-center text-left" data-testid="practice-timer-cancel-confirm">
          <div className="w-[300px] rounded bg-white shadow-xl">
            <div className="px-3 py-2.5 border-b border-slate-200 text-lg text-slate-800">Confirmation</div>
            <div className="px-3 py-3 text-sm text-slate-700">Are you sure you want to cancel this timer?</div>
            <div className="px-3 pb-3 flex gap-2">
              <button type="button" onClick={() => { timer.clear(); setConfirm(false); onDone?.(); }} data-testid="practice-timer-cancel-yes"
                      className="inline-flex items-center gap-1.5 h-8 px-4 rounded-full bg-[#43A047] text-white text-sm font-semibold"><Check size={14} /> Yes</button>
              <button type="button" onClick={() => setConfirm(false)} data-testid="practice-timer-cancel-no"
                      className="inline-flex items-center gap-1.5 h-8 px-4 rounded-full bg-slate-200 text-slate-700 text-sm font-semibold"><X size={14} /> No</button>
            </div>
          </div>
        </div>
      )}
      {save && <NewTimeEntryModal task={contact_id ? { contact_id, matter_id } : undefined} timerSeconds={seconds} timerNotes={notes} onClose={() => { setSave(false); timer.resume(); }} onSaved={() => { setSave(false); timer.clear(); onDone?.(); }} />}
    </>
  );
}
