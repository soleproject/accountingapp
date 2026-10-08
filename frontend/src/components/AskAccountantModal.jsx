import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { X, Send, Loader2, MessageSquare, Pencil, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";

const KIND_LABEL = { txn_question: "About a transaction", checkin_deferred: "From a check-in", ask_accountant: "Message" };

function fmtAmt(a) {
  if (a === null || a === undefined) return "";
  const n = Number(a);
  return (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Inline edit/delete controls for a message the current user authored. */
function OwnControls({ onEdit, onDelete, testid }) {
  return (
    <span className="inline-flex items-center gap-1 ml-2 align-middle">
      <button onClick={onEdit} className="p-0.5 text-slate-400 hover:text-slate-800" title="Edit" data-testid={`${testid}-edit`}><Pencil size={11} /></button>
      <button onClick={onDelete} className="p-0.5 text-slate-400 hover:text-red-600" title="Delete" data-testid={`${testid}-delete`}><Trash2 size={11} /></button>
    </span>
  );
}

function InlineEditor({ initial, onSave, onCancel, testid }) {
  const [v, setV] = useState(initial);
  return (
    <div className="mt-1" data-testid={`${testid}-editor`}>
      <textarea value={v} onChange={e => setV(e.target.value)} rows={2} className="w-full rounded-lg border border-slate-300 p-2 text-[13px] focus:border-slate-900 outline-none" data-testid={`${testid}-editor-input`} />
      <div className="flex gap-2 mt-1">
        <button onClick={() => v.trim() && onSave(v.trim())} className="h-7 px-3 rounded-md bg-slate-900 text-white text-[11px] font-semibold" data-testid={`${testid}-editor-save`}>Save</button>
        <button onClick={onCancel} className="h-7 px-3 rounded-md border border-slate-300 text-[11px] font-semibold" data-testid={`${testid}-editor-cancel`}>Cancel</button>
      </div>
    </div>
  );
}

export function MessageThread({ m, onReply, canReply, replyLabel = "Reply", hideResolve = false, maxReplies = null, onChanged }) {
  const { user } = useAuth();
  const replies = m.replies || [];
  const hidden = maxReplies !== null && replies.length > maxReplies ? replies.length - maxReplies : 0;
  const shown = hidden ? replies.slice(replies.length - maxReplies) : replies;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null); // "body" | reply id
  const send = async (resolve) => {
    if (!text.trim()) return;
    setBusy(true);
    try { await onReply(m, text.trim(), resolve); setText(""); } finally { setBusy(false); }
  };
  const run = async (fn, ok) => {
    try { await fn(); toast.success(ok); setEditing(null); onChanged?.(); }
    catch (e) { toast.error(e?.response?.data?.detail || "Couldn't update"); }
  };
  const editBody = (t) => run(() => api.patch(`/client-messages/${m.id}/body`, { text: t }), "Message updated");
  const deleteThread = () => window.confirm("Delete this whole thread? This can't be undone.") && run(() => api.delete(`/client-messages/${m.id}`), "Thread deleted");
  const editReply = (r, t) => run(() => api.patch(`/client-messages/${m.id}/replies/${r.id}`, { text: t }), "Reply updated");
  const deleteReply = (r) => window.confirm("Delete this reply?") && run(() => api.delete(`/client-messages/${m.id}/replies/${r.id}`), "Reply deleted");
  const mine = (id) => !!user?.id && id === user.id;
  const rootMine = mine(m.from_user_id);
  const ctx = [KIND_LABEL[m.kind] || "Message", m.txn && `${m.txn.date} · ${m.txn.merchant} · ${fmtAmt(m.txn.amount)}${m.txn.category ? ` · ${m.txn.category}` : ""}`].filter(Boolean).join(" — ");
  return (
    <div className="py-3" data-testid={`client-message-${m.id}`}>
      <div className="flex items-center justify-center gap-2 mb-2 flex-wrap">
        <span className="text-[10px] text-slate-500 bg-slate-50 border border-slate-200 rounded-full px-2.5 py-0.5 font-mono-num truncate max-w-full" data-testid={`client-message-context-${m.id}`}>{ctx}</span>
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${m.status === "resolved" ? "bg-emerald-50 text-emerald-700" : m.status === "replied" ? "bg-sky-50 text-sky-700" : "bg-amber-50 text-amber-700"}`}>{m.status}</span>
      </div>
      {m.item?.prompt && <div className="text-[11px] text-slate-500 italic text-center mb-2 truncate">Check-in asked: {m.item.prompt}</div>}
      <div className="space-y-2" data-testid={`client-message-bubbles-${m.id}`}>
        <Bubble mine={rootMine} name={m.from_name || m.from_email || "Client"} at={m.created_at} edited={!!m.edited_at} text={m.body}
          editing={editing === "body"} onEdit={() => setEditing("body")} onDelete={deleteThread} onSave={editBody} onCancel={() => setEditing(null)} testid={`client-message-${m.id}`} />
        {hidden > 0 && <div className="text-center text-[11px] text-slate-400 py-1" data-testid={`client-message-hidden-${m.id}`}>… {hidden} earlier repl{hidden === 1 ? "y" : "ies"} — open the thread to see all</div>}
        {shown.map(r => (
          <Bubble key={r.id} mine={mine(r.by)} name={r.by_name} at={r.at} edited={!!r.edited_at} text={r.text}
            editing={editing === r.id} onEdit={() => setEditing(r.id)} onDelete={() => deleteReply(r)} onSave={(t) => editReply(r, t)} onCancel={() => setEditing(null)} testid={`client-message-reply-${r.id}`} />
        ))}
      </div>
      {canReply && m.status !== "resolved" && (
        <div className="mt-3 flex items-center gap-2">
          <input value={text} onChange={e => setText(e.target.value)} placeholder="Type a message…" className="flex-1 h-10 rounded-full border border-slate-300 bg-white px-4 text-[13px] focus:border-sky-500 focus:ring-2 focus:ring-sky-100 outline-none" data-testid={`client-message-reply-input-${m.id}`}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(false); } }} />
          <button onClick={() => send(false)} disabled={busy || !text.trim()} title={replyLabel} className="h-10 w-10 shrink-0 rounded-full bg-sky-500 hover:bg-sky-600 text-white flex items-center justify-center disabled:opacity-40 transition-colors" data-testid={`client-message-reply-send-${m.id}`}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          </button>
          {replyLabel === "Reply" && !hideResolve && <button onClick={() => send(true)} disabled={busy || !text.trim()} className="h-10 px-3 rounded-full border border-slate-300 text-xs font-semibold disabled:opacity-50 whitespace-nowrap" data-testid={`client-message-reply-resolve-${m.id}`}>Reply &amp; resolve</button>}
        </div>
      )}
    </div>
  );
}

function fmtWhen(at) {
  const d = new Date(at);
  if (isNaN(d)) return "";
  const today = new Date().toDateString() === d.toDateString();
  const t = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return today ? t : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${t}`;
}

/** One chat bubble — mine on the right in light blue, theirs on the left in gray with an avatar initial. */
function Bubble({ mine, name, at, edited, text, editing, onEdit, onDelete, onSave, onCancel, testid }) {
  const initial = (name || "?").trim().charAt(0).toUpperCase();
  return (
    <div className={`group flex items-end gap-2 ${mine ? "flex-row-reverse" : ""}`} data-testid={testid} data-mine={mine ? "true" : "false"}>
      {!mine && <div className="h-7 w-7 shrink-0 rounded-full bg-slate-200 text-slate-700 text-[11px] font-bold flex items-center justify-center" data-testid={`${testid}-avatar`}>{initial}</div>}
      <div className={`max-w-[78%] min-w-0 flex flex-col ${mine ? "items-end" : "items-start"}`}>
        {editing
          ? <div className="w-full min-w-[220px]"><InlineEditor initial={text} onSave={onSave} onCancel={onCancel} testid={testid} /></div>
          : <div className={`px-3.5 py-2 text-[13px] leading-snug whitespace-pre-wrap break-words rounded-2xl ${mine ? "bg-sky-100 text-sky-950 rounded-br-md" : "bg-slate-100 text-slate-900 rounded-bl-md"}`} data-testid={`${testid}-text`}>{text}</div>}
        <div className={`mt-0.5 flex items-center gap-1 text-[10px] text-slate-400 ${mine ? "flex-row-reverse" : ""}`}>
          <span>{mine ? "You" : name} · {fmtWhen(at)}{edited ? " · edited" : ""}</span>
          {mine && !editing && <span className="opacity-70 sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100 transition-opacity"><OwnControls onEdit={onEdit} onDelete={onDelete} testid={testid} /></span>}
        </div>
      </div>
    </div>
  );
}

/** Client-side "Ask my accountant" — compose (optionally about a transaction) + history for this company. */
export default function AskAccountantModal({ open, onClose, txn = null, companyId = null }) {
  const { currentId } = useCompany();
  const cid = companyId || currentId;
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState(null);

  const load = () => cid && api.get(`/companies/${cid}/client-messages`).then(r => setData(r.data)).catch(() => setData({ messages: [], pro: null }));
  useEffect(() => { if (open) { load(); setBody(""); } }, [open, cid]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null;

  const send = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await api.post(`/companies/${cid}/client-messages`, { body: body.trim(), txn_id: txn?.id || null, kind: txn ? "txn_question" : "ask_accountant" });
      toast.success(data?.pro?.name ? `Sent to ${data.pro.name}` : "Sent to your accountant");
      setBody("");
      load();
      if (txn) onClose?.();
    } catch (e) { toast.error(e?.response?.data?.detail || "Couldn't send"); }
    finally { setBusy(false); }
  };
  const reply = async (m, text) => { await api.post(`/client-messages/${m.id}/reply`, { text }); load(); };

  return (
    <div className="fixed inset-0 z-[1200] bg-slate-900/50 flex items-end sm:items-center justify-center p-0 sm:p-6" onClick={onClose} data-testid="ask-accountant-modal">
      <div className="bg-white w-full sm:max-w-xl rounded-t-2xl sm:rounded-2xl p-5 shadow-xl max-h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-heading font-bold text-lg flex items-center gap-2"><MessageSquare size={16} /> Ask my accountant</h3>
            <p className="text-xs text-slate-500 mt-0.5">{data?.pro?.name ? `Goes straight to ${data.pro.name}'s Cockpit — they'll reply here and by email.` : "Your accounting professional will see this in their Cockpit and reply."}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100" data-testid="ask-accountant-close"><X size={16} /></button>
        </div>
        {txn && (
          <div className="mt-3 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-700 font-mono-num" data-testid="ask-accountant-txn">
            {txn.date} · {txn.merchant || txn.description} · {fmtAmt(txn.amount)}{txn.category_name ? ` · ${txn.category_name}` : ""}
          </div>
        )}
        <textarea value={body} onChange={e => setBody(e.target.value)} rows={3} autoFocus
          placeholder={txn ? "What's your question about this transaction?" : "What do you need help with?"}
          className="mt-3 w-full rounded-xl border border-slate-300 p-3 text-sm focus:border-slate-900 focus:ring-2 focus:ring-slate-200 outline-none" data-testid="ask-accountant-body" />
        <div className="mt-2 flex justify-end">
          <button onClick={send} disabled={busy || body.trim().length < 2} className="h-10 px-4 rounded-full bg-slate-900 text-white text-sm font-semibold flex items-center gap-2 disabled:opacity-50" data-testid="ask-accountant-send">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send
          </button>
        </div>
        {!txn && (
          <div className="mt-4 border-t border-slate-200 pt-3 overflow-auto min-h-0" data-testid="ask-accountant-history">
            <div className="text-[11px] font-bold tracking-[.12em] uppercase text-slate-500 mb-1">Your messages</div>
            {!data ? <div className="text-xs text-slate-400 py-3">Loading…</div>
              : data.messages.length === 0 ? <div className="text-xs text-slate-400 py-3">No messages yet.</div>
              : <div className="divide-y divide-slate-100">{data.messages.slice(0, 5).map(m => <MessageThread key={m.id} m={m} onReply={reply} canReply={m.status !== "resolved"} replyLabel="Reply back" compact hideResolve maxReplies={1} onChanged={load} />)}
                  {data.messages.length > 0 && <Link to="/owner/messages" onClick={onClose} className="block text-center text-xs font-medium text-slate-700 underline py-2" data-testid="ask-accountant-see-all">See all messages →</Link>}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
