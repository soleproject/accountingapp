/**
 * CompletedActions — timeline of voice-driven actions the AI executed
 * on behalf of the user (Phase 1, Feb 2026).
 *
 * Route: /completed-actions (mounted globally, per-user)
 */
import { useEffect, useState } from "react";
import { CheckSquare, CalendarPlus, Undo2, Loader2, Sparkles,
         User, Clock } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";

const INTENT_META = {
  create_task:        { icon: CheckSquare,  label: "Task",         tone: "violet" },
  create_appointment: { icon: CalendarPlus, label: "Appointment",  tone: "amber"  },
};
const TONE_CLASS = {
  violet: "bg-violet-50 text-violet-600",
  amber:  "bg-amber-50 text-amber-600",
};

export default function CompletedActions() {
  const { currentId } = useCompany();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const r = await api.get("/voice/actions/completed",
                                { params: { company_id: currentId } });
      setRows(r.data.actions || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load");
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId]);

  const undo = async (id) => {
    try {
      await api.post(`/voice/actions/${id}/undo`);
      toast.success("Undone");
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Cannot undo");
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-6" data-testid="completed-actions">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-violet-100 text-violet-600 flex items-center justify-center">
          <Sparkles size={20}/>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-violet-600 font-semibold">
            AI Actions
          </div>
          <h1 className="font-heading text-2xl font-bold text-slate-900">
            Completed voice actions
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Every task and appointment your voice assistant created for you.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-16 text-slate-400">
          <Loader2 size={20} className="animate-spin mx-auto mb-2"/>
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          Nothing here yet. Try saying something like{" "}
          <em>"create a task for Alice to send the SOW by Friday"</em>.
        </div>
      ) : (
        <ol className="space-y-2">
          {rows.map((a) => {
            const meta = INTENT_META[a.intent] || { icon: CheckSquare, label: a.intent, tone: "violet" };
            const Icon = meta.icon;
            const isUndone = a.status === "undone";
            const canUndo = a.status === "completed"
              && a.undo_deadline
              && new Date(a.undo_deadline) > new Date();
            return (
              <li key={a.id}
                  data-testid={`completed-action-${a.id}`}
                  className={`flex items-start gap-3 rounded-lg border p-3 transition ${
                    isUndone
                      ? "border-slate-200 bg-slate-50 opacity-70"
                      : "border-slate-200 bg-white hover:border-slate-300"
                  }`}>
                <div className={`w-9 h-9 rounded-md flex items-center justify-center shrink-0 ${TONE_CLASS[meta.tone]}`}>
                  <Icon size={16}/>
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`text-sm font-medium ${isUndone ? "line-through text-slate-500" : "text-slate-900"}`}>
                    {a.summary || meta.label}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
                    <span className="uppercase tracking-widest text-slate-400 font-semibold">
                      {meta.label}
                    </span>
                    <span>·</span>
                    <span>{relTime(a.created_at)}</span>
                    {a.resolution?.assignee?.name && (
                      <>
                        <span>·</span>
                        <span className="inline-flex items-center gap-0.5">
                          <User size={9}/> {a.resolution.assignee.name}
                        </span>
                      </>
                    )}
                    {a.entities?.iso_datetime && (
                      <>
                        <span>·</span>
                        <span className="inline-flex items-center gap-0.5">
                          <Clock size={9}/> {new Date(a.entities.iso_datetime).toLocaleString()}
                        </span>
                      </>
                    )}
                    {isUndone && (
                      <span className="ml-1 text-[9px] uppercase tracking-widest text-rose-500 font-semibold">
                        Undone
                      </span>
                    )}
                  </div>
                  {a.original_text && (
                    <div className="text-[10px] italic text-slate-400 mt-1 truncate">
                      "{a.original_text}"
                    </div>
                  )}
                </div>
                {canUndo && (
                  <button onClick={() => undo(a.id)}
                          data-testid={`completed-action-undo-${a.id}`}
                          className="text-xs text-rose-600 hover:text-rose-700 inline-flex items-center gap-1">
                    <Undo2 size={11}/> Undo
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}


function relTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60)        return "just now";
    if (diff < 3600)      return `${Math.floor(diff/60)}m ago`;
    if (diff < 86400)     return `${Math.floor(diff/3600)}h ago`;
    if (diff < 30 * 86400) return `${Math.floor(diff/86400)}d ago`;
    return d.toLocaleDateString();
  } catch { return iso; }
}
