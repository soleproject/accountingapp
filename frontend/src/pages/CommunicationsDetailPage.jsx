/**
 * Communications thread detail — read-only playback of a client
 * review batch. Renders the same look as the client's magic-link
 * page, but strips all inputs / buttons / composer since this is an
 * audit-friendly transcript.
 */
import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { ArrowLeft, ExternalLink, Loader2, MessageSquare } from "lucide-react";

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function AttachmentChip({ a }) {
  return (
    <a
      href={a.data_url || "#"}
      target={a.data_url ? "_blank" : undefined}
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 bg-white text-xs text-slate-700 hover:bg-slate-50"
      data-testid={`comms-attachment-${a.id}`}
    >
      📎 {a.filename || "Attachment"}
      {a.data_url && <ExternalLink size={10} />}
    </a>
  );
}

function MessageBubble({ m }) {
  const isUser = m.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ${
        isUser
          ? "bg-slate-900 text-white rounded-br-sm"
          : "bg-white border border-slate-200 text-slate-800 rounded-bl-sm"
      }`}>
        {typeof m.content === "string" ? m.content : (m.content ?? "")}
      </div>
    </div>
  );
}

function ItemBlock({ item, index }) {
  const isAnswered = !!item.answered_at;
  const isDeferred = !!item.deferred;
  const status = isAnswered ? "answered" : isDeferred ? "deferred" : "open";
  const cfg = {
    answered: { pill: "bg-emerald-50 text-emerald-800 border-emerald-200", label: "Answered" },
    deferred: { pill: "bg-violet-50 text-violet-800 border-violet-200",   label: "Deferred to bookkeeper" },
    open:     { pill: "bg-amber-50 text-amber-800 border-amber-200",       label: "Open" },
  }[status];

  // Merge client-side bubbles (checklist / email draft) and LLM
  // messages into one linear transcript. Drop attachment sentinel
  // bubbles — attachments are shown in their own row.
  const messages = [
    ...(item.client_messages || []).filter((m) => !m.isTransition),
    ...(item.messages || []).map((m) => ({
      role: m.role,
      content: m.content,
    })),
  ];

  const ctxMeta = item?.context?.meta || {};
  const ctxTitle = item?.context?.title || item?.prompt || "Item";

  return (
    <section className="border border-slate-200 rounded-lg bg-white overflow-hidden" data-testid={`comms-item-${item.item_id}`}>
      <header className="px-4 py-2.5 border-b border-slate-200 bg-slate-50 flex items-center gap-3 flex-wrap">
        <span className="text-[11px] uppercase tracking-wide font-semibold text-slate-500 font-mono-num">
          Q{index + 1}
        </span>
        <span className="text-sm font-medium text-slate-800 truncate flex-1 min-w-0">
          {ctxTitle}
        </span>
        <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-mono-num rounded border ${cfg.pill}`}>
          {cfg.label}
        </span>
        {(item.answered_at || item.deferred_at) && (
          <span className="text-[11px] text-slate-500">
            {formatDate(item.answered_at || item.deferred_at)}
          </span>
        )}
      </header>
      <div className="p-4 space-y-3">
        {item.prompt && (
          <div className="text-sm text-slate-800 bg-slate-50 rounded-md p-3 border border-slate-200">
            {item.prompt}
          </div>
        )}
        {(item.attachments || []).length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {item.attachments.map((a) => <AttachmentChip key={a.id} a={a} />)}
          </div>
        )}
        {messages.length === 0 ? (
          <div className="text-xs text-slate-400 italic">No chat activity on this item.</div>
        ) : (
          <div className="space-y-2">
            {messages.map((m, i) => <MessageBubble key={i} m={m} />)}
          </div>
        )}
        {item.client_answer && (
          <div className="border-t border-slate-100 pt-2 text-xs text-slate-600">
            <span className="uppercase tracking-wide text-slate-500 font-semibold mr-1">Final answer:</span>
            {item.client_answer}
          </div>
        )}
        {item.deferred_note && (
          <div className="border-t border-slate-100 pt-2 text-xs text-slate-600">
            <span className="uppercase tracking-wide text-slate-500 font-semibold mr-1">Defer note:</span>
            {item.deferred_note}
          </div>
        )}
        {ctxMeta.contact_name && (
          <div className="text-[11px] text-slate-500 border-t border-slate-100 pt-2">
            Contact: <span className="font-medium text-slate-700">{ctxMeta.contact_name}</span>
          </div>
        )}
      </div>
    </section>
  );
}

export default function CommunicationsDetailPage() {
  const { threadId } = useParams();
  const navigate = useNavigate();
  const [thread, setThread] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError("");
      try {
        const r = await api.get(`/comms/threads/${threadId}`);
        if (!cancelled) setThread(r.data);
      } catch (e) {
        if (!cancelled) setError(e?.response?.data?.detail || "Couldn't load thread.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [threadId]);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto p-6 flex items-center gap-2 text-slate-500 text-sm">
        <Loader2 className="animate-spin" size={16} /> Loading thread…
      </div>
    );
  }
  if (error) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="border border-rose-200 bg-rose-50 rounded-lg p-4 text-sm text-rose-800">
          {error}
        </div>
      </div>
    );
  }
  if (!thread) return null;

  const items = thread.items || [];
  const answered = items.filter((i) => i.answered_at).length;
  const deferred = items.filter((i) => i.deferred).length;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-5" data-testid="communications-detail-page">
      <div className="flex items-center gap-2 text-sm">
        <button
          onClick={() => navigate(-1)}
          className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-900"
          data-testid="comms-back-btn"
        >
          <ArrowLeft size={14} /> Back
        </button>
        <span className="text-slate-300">/</span>
        <Link to="/communications" className="text-slate-500 hover:text-slate-900">Communications</Link>
      </div>

      <header className="border border-slate-200 rounded-lg p-4 bg-white">
        <div className="flex items-center gap-2 flex-wrap">
          <MessageSquare size={16} className="text-slate-500" />
          <h1 className="font-heading text-lg font-semibold text-slate-900">
            Batch review — {thread.company_name}
          </h1>
          {thread.status && (
            <span className="text-[10px] uppercase tracking-wider font-mono-num px-1.5 py-0.5 rounded ring-1 ring-slate-300 bg-slate-100 text-slate-700">
              {thread.status}
            </span>
          )}
        </div>
        <div className="mt-2 text-xs text-slate-500 flex flex-wrap gap-x-4 gap-y-1">
          <span>Client: {thread.client_email}</span>
          <span>Started {formatDate(thread.created_at)}</span>
          <span>Last activity {formatDate(thread.updated_at)}</span>
          <span>{answered}/{items.length} answered · {deferred} deferred</span>
        </div>
        {thread.status !== "expired" && thread.client_token && (
          <div className="mt-3">
            <Link
              to={`/client-review/${thread.client_token}`}
              className="inline-flex items-center gap-1 text-xs text-slate-700 hover:text-slate-900 underline"
              data-testid="comms-open-live-link"
            >
              Open the live magic link <ExternalLink size={12} />
            </Link>
          </div>
        )}
      </header>

      <div className="space-y-3">
        {items.map((it, idx) => <ItemBlock key={it.item_id} item={it} index={idx} />)}
      </div>
    </div>
  );
}
