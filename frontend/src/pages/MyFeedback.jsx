import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Inbox, Bug, Lightbulb, Loader2, Clock, CheckCircle2, XCircle, MessageCircle } from "lucide-react";
import FeedbackModal from "@/components/FeedbackModal";

const STATUS_META = {
  new:         { label: "New",         color: "bg-slate-100 text-slate-700 border-slate-200",   Icon: Clock },
  in_progress: { label: "In progress", color: "bg-amber-50 text-amber-700 border-amber-200",     Icon: Clock },
  completed:   { label: "Completed",   color: "bg-emerald-50 text-emerald-700 border-emerald-200", Icon: CheckCircle2 },
  wont_do:     { label: "Won't do",    color: "bg-slate-50 text-slate-500 border-slate-200",     Icon: XCircle },
};

function fmtWhen(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

/**
 * MyFeedback — a submitter's read-only inbox showing every ticket they've
 * filed with current status + any superadmin notes appended to it. Product
 * decision: no status-change emails (choice 3b) — this page is the truth.
 */
export default function MyFeedback() {
  const [rows, setRows] = useState(null);
  const [openNew, setOpenNew] = useState(false);

  const load = async () => {
    try {
      const r = await api.get("/feedback/mine");
      setRows(r.data.items || []);
    } catch {
      toast.error("Couldn't load your feedback.");
      setRows([]);
    }
  };
  useEffect(() => { load(); }, []);

  return (
    <div className="max-w-4xl mx-auto p-6" data-testid="my-feedback-page">
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 text-slate-500 text-sm mb-1">
            <Inbox size={14} /> My Feedback
          </div>
          <h1 className="text-2xl font-heading font-bold text-slate-900">
            Bugs & recommendations you've filed
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            We work through every item here — you'll see status updates
            reflected below as our team triages them.
          </p>
        </div>
        <button
          onClick={() => setOpenNew(true)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-cyan-600 text-white text-sm font-medium hover:bg-cyan-700"
          data-testid="my-feedback-new-btn"
        >
          <MessageCircle size={14} /> New feedback
        </button>
      </div>

      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        {rows === null ? (
          <div className="p-10 text-center text-slate-400 text-sm">
            <Loader2 size={16} className="inline animate-spin mr-2" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-slate-500">
            <Inbox size={24} className="mx-auto text-slate-300 mb-2" />
            <div className="text-sm">You haven't filed any feedback yet.</div>
            <button
              onClick={() => setOpenNew(true)}
              className="mt-3 text-sm text-cyan-700 hover:underline"
              data-testid="my-feedback-empty-create"
            >
              Report your first bug or idea →
            </button>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => {
              const meta = STATUS_META[r.status] || STATUS_META.new;
              const Icon = meta.Icon;
              const TypeIcon = r.type === "bug" ? Bug : Lightbulb;
              return (
                <li key={r.id} className="p-4 hover:bg-slate-50" data-testid={`my-feedback-row-${r.id}`}>
                  <div className="flex items-start gap-3">
                    <div className={`mt-0.5 shrink-0 p-1.5 rounded-md ${r.type === "bug" ? "bg-rose-50 text-rose-600" : "bg-cyan-50 text-cyan-600"}`}>
                      <TypeIcon size={14} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="font-medium text-slate-900 truncate">{r.title}</div>
                        <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${meta.color}`}>
                          <Icon size={10} /> {meta.label}
                        </span>
                        <span className="text-[11px] text-slate-400 uppercase tracking-widest">{r.type}</span>
                      </div>
                      {r.description && (
                        <div className="mt-1 text-sm text-slate-600 whitespace-pre-wrap line-clamp-3">
                          {r.description}
                        </div>
                      )}
                      <div className="mt-2 text-[11px] text-slate-400">
                        Filed {fmtWhen(r.created_at)}
                        {r.route ? <> · <code className="bg-slate-100 rounded px-1">{r.route}</code></> : null}
                      </div>
                      {Array.isArray(r.admin_notes) && r.admin_notes.length > 0 && (
                        <div className="mt-3 space-y-2">
                          {r.admin_notes.map((n) => (
                            <div key={n.id} className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded px-3 py-2">
                              <span className="font-semibold text-slate-700">{n.author_name || "Team"}:</span>{" "}
                              {n.note}
                              <div className="text-[10px] text-slate-400 mt-0.5">{fmtWhen(n.at)}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {openNew && <FeedbackModal onClose={() => { setOpenNew(false); load(); }} />}
    </div>
  );
}
