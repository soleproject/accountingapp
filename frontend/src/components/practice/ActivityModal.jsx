import { useState } from "react";
import { ChevronDown, Plus, ClipboardList, CalendarDays, StickyNote, Phone } from "lucide-react";
import { NewTaskModal } from "@/components/practice/NewTaskModal";
import { NewEventModal } from "@/components/practice/NewEventModal";
import { NewNoteModal, NewCallModal } from "@/components/practice/NewNoteCallModals";
import { NewTimeEntryModal } from "@/components/practice/NewTimeEntryModal";
import { Can } from "@/components/practice/perms";

export const KINDS = [["task", "Task", ClipboardList], ["event", "Event", CalendarDays], ["note", "Note", StickyNote], ["call", "Call", Phone]];

export function NewActivityMenu({ onPick, align = "left", testId = "practice-ca-new" }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Can feature="Activities (Tasks, Events & Calls)" action="create">
        <button type="button" onClick={() => setOpen(v => !v)} className="inline-flex items-center gap-1.5 rounded-full bg-[#43A047] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#388E3C]" data-testid={testId}><Plus size={14} /> New <ChevronDown size={12} /></button>
      </Can>
      {open && <>
        <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
        <div className={`absolute ${align === "right" ? "right-0" : "left-0"} top-full z-30 mt-1 w-40 rounded border border-slate-200 bg-white py-1 shadow-xl text-sm`} data-testid={`${testId}-menu`}>
          {KINDS.map(([k, l, Icon]) => <button key={k} type="button" onClick={() => { setOpen(false); onPick(k); }} className="w-full px-3 py-1.5 text-left hover:bg-slate-50 inline-flex items-center gap-2" data-testid={`${testId}-${k}`}><Icon size={13} className="text-slate-500" /> {l}</button>)}
        </div>
      </>}
    </div>
  );
}

// modal: "task"|"event"|"note"|"call" (new), a row object (edit) or {logTime: row}
export function ActivityModal({ modal, defaults = {}, onClose, onSaved }) {
  if (!modal) return null;
  if (typeof modal === "string") {
    const P = { task: NewTaskModal, event: NewEventModal, note: NewNoteModal, call: NewCallModal }[modal];
    return <P defaults={defaults} onClose={onClose} onSaved={onSaved} />;
  }
  if (modal.logTime) return <NewTimeEntryModal task={modal.logTime} onClose={onClose} onSaved={onSaved} />;
  const k = modal.kind || "task";
  if (k === "event") return <NewEventModal event={modal} onClose={onClose} onSaved={onSaved} />;
  if (k === "note") return <NewNoteModal note={modal} onClose={onClose} onSaved={onSaved} />;
  if (k === "call") return <NewCallModal call={modal} onClose={onClose} onSaved={onSaved} />;
  return <NewTaskModal task={modal} onClose={onClose} onSaved={onSaved} />;
}
