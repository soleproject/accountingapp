import { X, User, Briefcase, MessageSquare, MapPin, Clock } from "lucide-react";
import { useNavigate } from "react-router-dom";

export const TaskPopover = ({ task, onClose, onLogTime, onEdit, onDelete, onComplete }) => {
  const nav = useNavigate();
  const act = "text-[10px] uppercase tracking-wider text-slate-500 hover:text-[#1E88E5] font-semibold";
  const desc = (task.description || "").replace(/<[^>]+>/g, "").trim();
  return (
    <div className="fixed inset-0 z-40" onClick={onClose} data-testid="practice-task-popover-backdrop">
      <div onClick={e => e.stopPropagation()} data-testid="practice-task-popover"
           className="absolute w-[400px] rounded border border-slate-300 bg-white shadow-xl p-3"
           style={{ left: Math.min(task._x, window.innerWidth - 420), top: Math.min(task._y, window.innerHeight - 200) }}>
        <div className="flex items-start justify-between">
          <h3 className="text-base font-bold text-[#1E88E5]" data-testid="practice-task-popover-title">{task.subject}</h3>
          <button type="button" onClick={onClose} className="text-[#1E88E5]" data-testid="practice-task-popover-close"><X size={14} /></button>
        </div>
        <div className="mt-1 flex items-center gap-3">
          <button type="button" className={act} onClick={onLogTime} data-testid="practice-task-log-time">Log Time</button>
          <button type="button" className={act} onClick={onEdit} data-testid="practice-task-edit">Edit</button>
          <button type="button" className={act} onClick={onDelete} data-testid="practice-task-delete">Delete</button>
          {task.kind !== "event" && task.status !== "Completed" && <button type="button" className={act} onClick={onComplete} data-testid="practice-task-complete">Complete</button>}
        </div>
        <div className="mt-2 space-y-1.5 text-sm">
          {task.kind === "event" && <div className="flex items-center gap-2 text-slate-800"><Clock size={13} className="text-slate-700" />{task.all_day ? "All day" : `${task.start_time} – ${task.end_time}`}{task.location && <span className="inline-flex items-center gap-1 ml-2 text-slate-600"><MapPin size={12} />{task.location}</span>}</div>}
          {task.contact_name && <button type="button" onClick={() => nav(`/practice/contacts/${task.contact_id}`)} className="flex items-center gap-2 text-[#1E88E5] hover:underline" data-testid="practice-task-popover-contact"><User size={13} className="text-slate-700 fill-slate-700" />{task.contact_name}</button>}
          {task.matter_name && <button type="button" onClick={() => nav(`/practice/matters/${task.matter_id}`)} className="flex items-center gap-2 text-[#1E88E5] hover:underline" data-testid="practice-task-popover-matter"><Briefcase size={13} className="text-slate-700" />{task.matter_name}</button>}
          {desc && <div className="flex items-start gap-2 text-slate-800"><MessageSquare size={13} className="text-slate-700 fill-slate-700 mt-0.5" /><span>{desc}</span></div>}
        </div>
      </div>
    </div>
  );
};
