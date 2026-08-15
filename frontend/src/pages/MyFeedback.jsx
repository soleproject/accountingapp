import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  Inbox, Bug, Lightbulb, Loader2, Clock, CheckCircle2, XCircle,
  MessageCircle, Send, Reply, User, Shield,
} from "lucide-react";
import FeedbackModal from "@/components/FeedbackModal";
import AttachmentPicker from "@/components/AttachmentPicker";

const STATUS_META = {
  new:         { label: "New",         color: "bg-slate-100 text-slate-700 border-slate-200",   Icon: Clock },
  in_progress: { label: "In progress", color: "bg-amber-50 text-amber-700 border-amber-200",     Icon: Clock },
  completed:   { label: "Completed",   color: "bg-emerald-50 text-emerald-700 border-emerald-200", Icon: CheckCircle2 },
  wont_do:     { label: "Won't do",    color: "bg-slate-50 text-slate-500 border-slate-200",     Icon: XCircle },
};
const STATUS_ORDER = ["new", "in_progress", "completed", "wont_do"];

function fmtWhen(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

/**
 * MyFeedback — every submitter's read/reply thread. Reporters can filter
 * by status or "unread only" (new replies from the team). Visiting this
 * page auto-marks everything as read.
 */
export default function MyFeedback() {
  const [rows, setRows] = useState(null);
  const [counts, setCounts] = useState({});
  const [unread, setUnread] = useState(0);
  const [statusFilter, setStatusFilter] = useState(null);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [openNew, setOpenNew] = useState(false);

  const load = async () => {
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      if (onlyUnread) params.only_unread = 1;
      const r = await api.get("/feedback/mine", { params });
      setRows(r.data.items || []);
      setCounts(r.data.counts || {});
      setUnread(r.data.unread || 0);
    } catch {
      toast.error("Couldn't load your feedback.");
      setRows([]);
    }
  };

  // On mount: fetch the list FIRST so unread badges paint, then mark-read
  // so the profile-menu badge clears on the next poll.
  useEffect(() => {
    (async () => {
      await load();
      api.post("/feedback/mine/mark-read").catch(() => {});
    })();
    // eslint-disable-next-line
  }, []);

  useEffect(() => {
    // Skip the very first mount (handled above); re-load when filters change.
    if (rows === null) return;
    load();
    // eslint-disable-next-line
  }, [statusFilter, onlyUnread]);

  const replaceRow = (updated) =>
    setRows((prev) => (prev || []).map((r) => (r.id === updated.id ? updated : r)));

  const totalAll = Object.values(counts).reduce((a, b) => a + b, 0);

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
            We work through every item here — reply below if we need more
            info or you have an update.
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

      {/* Filter pills */}
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <button
          onClick={() => setStatusFilter(null)}
          data-testid="mine-filter-all"
          className={`px-3 py-1.5 rounded-full text-xs font-medium border ${
            statusFilter === null
              ? "bg-slate-900 text-white border-slate-900"
              : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
          }`}
        >
          All <span className="opacity-70 ml-1">{totalAll}</span>
        </button>
        {STATUS_ORDER.map((s) => {
          const meta = STATUS_META[s];
          const active = statusFilter === s;
          const Icon = meta.Icon;
          return (
            <button
              key={s}
              onClick={() => setStatusFilter(active ? null : s)}
              data-testid={`mine-filter-status-${s}`}
              className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium border ${
                active
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
              }`}
            >
              <Icon size={11} /> {meta.label}
              <span className="opacity-70">{counts[s] || 0}</span>
            </button>
          );
        })}
        <div className="mx-1 h-5 w-px bg-slate-200" />
        <button
          onClick={() => setOnlyUnread((v) => !v)}
          data-testid="mine-filter-unread"
          className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium border ${
            onlyUnread
              ? "bg-rose-600 text-white border-rose-600"
              : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
          }`}
        >
          New replies
          <span className={`ml-1 min-w-[18px] px-1 rounded-full text-[10px] font-bold ${
            onlyUnread ? "bg-white text-rose-600" : "bg-rose-100 text-rose-700"
          }`}>
            {unread}
          </span>
        </button>
      </div>

      {rows === null ? (
        <div className="bg-white rounded-lg border border-slate-200 p-10 text-center text-slate-400 text-sm">
          <Loader2 size={16} className="inline animate-spin mr-2" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-lg border border-slate-200 p-10 text-center text-slate-500">
          <Inbox size={24} className="mx-auto text-slate-300 mb-2" />
          <div className="text-sm">
            {onlyUnread ? "No unread replies right now." :
             statusFilter ? `Nothing matches “${STATUS_META[statusFilter].label}.”` :
             "You haven't filed any feedback yet."}
          </div>
          {!statusFilter && !onlyUnread && (
            <button
              onClick={() => setOpenNew(true)}
              className="mt-3 text-sm text-cyan-700 hover:underline"
              data-testid="my-feedback-empty-create"
            >
              Report your first bug or idea →
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {rows.map((r) => (
            <TicketCard key={r.id} item={r} onUpdated={replaceRow} />
          ))}
        </div>
      )}

      {openNew && <FeedbackModal onClose={() => { setOpenNew(false); load(); }} />}
    </div>
  );
}

function TicketCard({ item, onUpdated }) {
  const meta = STATUS_META[item.status] || STATUS_META.new;
  const Icon = meta.Icon;
  const TypeIcon = item.type === "bug" ? Bug : Lightbulb;

  return (
    <div
      className={`bg-white rounded-lg border ${item.unread ? "border-rose-200 ring-1 ring-rose-100" : "border-slate-200"} overflow-hidden`}
      data-testid={`my-feedback-row-${item.id}`}
    >
      <div className="p-4 flex items-start gap-3">
        <div className={`mt-0.5 shrink-0 p-1.5 rounded-md ${item.type === "bug" ? "bg-rose-50 text-rose-600" : "bg-cyan-50 text-cyan-600"}`}>
          <TypeIcon size={14} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {item.unread && (
              <span
                className="w-2 h-2 rounded-full bg-rose-500"
                title="New reply from the team"
                data-testid={`my-feedback-unread-${item.id}`}
              />
            )}
            <div className="font-medium text-slate-900 truncate">{item.title}</div>
            <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${meta.color}`}>
              <Icon size={10} /> {meta.label}
            </span>
            <span className="text-[11px] text-slate-400 uppercase tracking-widest">{item.type}</span>
          </div>
          {item.description && (
            <div className="mt-1 text-sm text-slate-600 whitespace-pre-wrap">
              {item.description}
            </div>
          )}
          <div className="mt-2 text-[11px] text-slate-400">
            Filed {fmtWhen(item.created_at)}
            {item.route ? <> · <code className="bg-slate-100 rounded px-1">{item.route}</code></> : null}
          </div>
          {Array.isArray(item.attachments) && item.attachments.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {item.attachments.map((a) => (
                <a
                  key={a.id}
                  href={a.data_url}
                  target="_blank"
                  rel="noreferrer"
                  className="block border border-slate-200 rounded overflow-hidden hover:ring-2 hover:ring-cyan-300"
                  title={a.filename}
                >
                  <img src={a.data_url} alt={a.filename} className="w-20 h-20 object-cover" />
                </a>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Thread */}
      {Array.isArray(item.admin_notes) && item.admin_notes.length > 0 && (
        <div className="px-4 pb-3 space-y-2">
          {item.admin_notes.map((n) => {
            const fromReporter = (n.author_role || "superadmin") === "reporter";
            return (
              <div
                key={n.id}
                className={`text-sm border rounded p-3 ${fromReporter
                  ? "bg-slate-50 border-slate-200"
                  : "bg-cyan-50 border-cyan-200"}`}
                data-testid={`mine-note-${n.id}`}
              >
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest mb-1">
                  {fromReporter
                    ? <span className="inline-flex items-center gap-1 text-slate-600"><User size={10}/> You</span>
                    : <span className="inline-flex items-center gap-1 text-cyan-700"><Shield size={10}/> Team</span>}
                  <span className="text-slate-400">· {n.author_name}</span>
                </div>
                <div className="whitespace-pre-wrap text-slate-700">{n.note}</div>
                {Array.isArray(n.attachments) && n.attachments.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {n.attachments.map((a) => (
                      <a
                        key={a.id}
                        href={a.data_url}
                        target="_blank"
                        rel="noreferrer"
                        className="block border border-slate-200 rounded overflow-hidden hover:ring-2 hover:ring-cyan-300"
                        title={a.filename}
                      >
                        <img src={a.data_url} alt={a.filename} className="w-16 h-16 object-cover" />
                      </a>
                    ))}
                  </div>
                )}
                <div className="text-[10px] text-slate-500 mt-1">{fmtWhen(n.at)}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Compose reply */}
      <ReplyCompose item={item} onPosted={onUpdated} />
    </div>
  );
}

function ReplyCompose({ item, onPosted }) {
  const [note, setNote] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!note.trim()) return;
    setBusy(true);
    try {
      const payload = {
        note: note.trim(),
        attachments: attachments.map((a) => ({
          filename: a.filename, mime: a.mime, data_url: a.data_url,
        })),
      };
      const r = await api.post(`/feedback/${item.id}/reply`, payload);
      onPosted(r.data);
      setNote("");
      setAttachments([]);
      setOpen(false);
      toast.success("Reply posted — the team's been notified.");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't post reply");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="px-4 pb-4">
        <button
          onClick={() => setOpen(true)}
          data-testid={`reply-open-${item.id}`}
          className="inline-flex items-center gap-1.5 text-xs text-cyan-700 hover:text-cyan-800 hover:underline"
        >
          <Reply size={12} /> Reply to the team
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="px-4 pb-4 border-t border-slate-100 pt-3 space-y-3" data-testid={`reply-form-${item.id}`}>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
        maxLength={2000}
        autoFocus
        placeholder="Add more info, answer a question, or share an update…"
        className="w-full border border-slate-200 rounded-md p-2 text-sm focus:outline-none focus:border-slate-400 resize-none"
        data-testid={`reply-input-${item.id}`}
      />
      <AttachmentPicker
        value={attachments}
        onChange={setAttachments}
        testIdPrefix={`reply-attach-${item.id}`}
        emptyHint="Optional — add a screenshot to help the team."
        compact
      />
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => { setOpen(false); setNote(""); setAttachments([]); }}
          className="px-3 py-1.5 rounded-md text-xs text-slate-600 hover:bg-slate-100"
          data-testid={`reply-cancel-${item.id}`}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || !note.trim()}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-cyan-600 text-white text-xs font-medium hover:bg-cyan-700 disabled:opacity-50"
          data-testid={`reply-submit-${item.id}`}
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
          Send reply
        </button>
      </div>
    </form>
  );
}
