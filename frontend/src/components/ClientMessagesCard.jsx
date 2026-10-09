import { useMemo, useState } from "react";
import { ArrowLeft, MessageCircle, CheckCircle2, Search, X } from "lucide-react";
import { MessageThread, fmtDay, fmtWhen, topicOf, KIND_TAG } from "@/components/AskAccountantModal";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";

const PRO_QUICK_REPLIES = [
  "Got it, looking now.",
  "Can you send the receipt?",
  "Done — categorized and posted.",
  "Let's cover this on our next call.",
];

/** True when someone else wrote something after this user last opened the thread. */
export function isUnread(m, userId) {
  if (!userId) return false;
  const mine = [m.from_user_id === userId ? m.created_at : null, ...(m.replies || []).filter(r => r.by === userId).map(r => r.at)].filter(Boolean);
  const seen = [m.read_by?.[userId] || "", ...mine].sort().pop();
  const others = [m.from_user_id !== userId ? m.created_at : null, ...(m.replies || []).filter(r => r.by !== userId).map(r => r.at)].filter(Boolean);
  return others.some(t => t > seen);
}

function matches(m, q) {
  const hay = [m.company, m.company_name, m.from_name, m.from_email, m.subject, m.body, m.txn?.merchant, ...(m.replies || []).map(r => r.text)].filter(Boolean).join(" ").toLowerCase();
  return hay.includes(q);
}

/** Who spoke last on a thread — the opening message counts as the client. */
export function lastBy(m) {
  const r = (m.replies || [])[m.replies?.length - 1];
  return r ? (r.by_pro ? "pro" : "client") : "client";
}

/** Bucket a thread for a given perspective. Resolved is only ever set by the client. */
export function bucketOf(m, perspective) {
  if (m.status === "resolved") return "resolved";
  const waitingOn = lastBy(m) === "client" ? "pro" : "client";
  return waitingOn === perspective ? "outstanding" : "answered";
}

const TAB_HELP = {
  pro: {
    outstanding: "Threads where the client asked and you haven't replied yet.",
    answered: "You sent the last message — waiting on the client.",
    resolved: "The client marked these handled.",
  },
  client: {
    outstanding: "Your accountant sent the last message — your turn.",
    answered: "You sent the last message — waiting on your accountant.",
    resolved: "Threads you marked handled.",
  },
};

/**
 * Shared Client Messages card body — used by the pro Cockpit (perspective="pro")
 * and the client's My business → Messages tab (perspective="client").
 * Tabs: Outstanding / Answered / Resolved. Collapsed rows are inbox-style
 * (date · company · sender · topic + latest preview); clicking opens the chat thread.
 */
export function ClientMessagesCard({ messages, perspective, onReply, onResolve, onOpenCompany, onChanged, testidPrefix = "cm" }) {
  const { user } = useAuth();
  const [tab, setTab] = useState("outstanding");
  const [focus, setFocus] = useState(null);
  const [query, setQuery] = useState("");
  const [seen, setSeen] = useState(() => new Set());
  const q = query.trim().toLowerCase();
  const buckets = useMemo(() => {
    const b = { outstanding: [], answered: [], resolved: [] };
    for (const m of messages || []) if (!q || matches(m, q)) b[bucketOf(m, perspective)].push(m);
    return b;
  }, [messages, perspective, q]);
  const unread = (m) => !seen.has(m.id) && isUnread(m, user?.id);
  const focused = focus ? (messages || []).find(m => m.id === focus) : null;
  const onChangedWrap = () => { onChanged?.(); };
  const replyLabel = perspective === "pro" ? "Reply" : "Reply back";
  const openThread = (m) => {
    setFocus(m.id);
    if (unread(m)) {
      setSeen(s => new Set(s).add(m.id));
      api.post(`/client-messages/${m.id}/read`).then(() => onChanged?.()).catch(() => {});
    }
  };

  if (focused) {
    const canResolve = perspective === "client" && focused.status !== "resolved";
    return (
      <div data-testid={`${testidPrefix}-thread-focus`}>
        <div className="flex items-center gap-2 mb-3">
          <button onClick={() => setFocus(null)} className="h-8 px-3 rounded-full border border-slate-300 bg-white text-[12px] font-medium text-slate-700 hover:bg-slate-50 hover:border-slate-400 flex items-center gap-1.5 transition-colors" data-testid={`${testidPrefix}-thread-back`}>
            <ArrowLeft size={13} /> All threads
          </button>
          {canResolve && (
            <button onClick={() => onResolve?.(focused)} className="h-8 px-3 rounded-full border border-emerald-200 bg-emerald-50 text-[12px] font-medium text-emerald-700 hover:bg-emerald-100 hover:border-emerald-300 flex items-center gap-1.5 transition-colors" data-testid={`${testidPrefix}-focus-resolve`}>
              <CheckCircle2 size={13} /> Mark resolved
            </button>
          )}
        </div>
        <ThreadHeader m={focused} perspective={perspective} onOpenCompany={onOpenCompany} testid={`${testidPrefix}-focus`} />
        <MessageThread m={focused} onReply={onReply} canReply={focused.status !== "resolved"} replyLabel={replyLabel} hideResolve hideSubject onChanged={onChangedWrap}
          quickReplies={perspective === "pro" ? PRO_QUICK_REPLIES : null} />
      </div>
    );
  }

  const list = buckets[tab];
  const unreadCount = (k) => buckets[k].filter(unread).length;
  return (
    <div>
      {perspective === "pro" && (
        <div className="relative mb-2" data-testid={`${testidPrefix}-search-wrap`}>
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by client, sender or keyword…"
            className="w-full h-9 rounded-full border border-slate-200 bg-slate-50 pl-8 pr-8 text-[12px] focus:bg-white focus:border-slate-400 outline-none transition-colors" data-testid={`${testidPrefix}-search`} />
          {query && <button onClick={() => setQuery("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-700" data-testid={`${testidPrefix}-search-clear`}><X size={13} /></button>}
        </div>
      )}
      <div className="flex gap-1 border-b border-slate-200 mb-3" data-testid={`${testidPrefix}-tabs`}>
        {[["outstanding", "Outstanding"], ["answered", "Answered"], ["resolved", "Resolved"]].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} data-testid={`${testidPrefix}-tab-${k}`}
            className={`text-[12px] font-medium px-3 py-2 -mb-px border-b-2 transition-colors flex items-center ${tab === k ? "border-slate-900 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
            {l}
            {buckets[k].length > 0 && <span className={`ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold ${tab === k ? "bg-slate-900 text-white" : "bg-slate-200 text-slate-600"}`}>{buckets[k].length}</span>}
            {unreadCount(k) > 0 && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-sky-500" data-testid={`${testidPrefix}-tab-${k}-unread`} />}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-slate-500 mb-1" data-testid={`${testidPrefix}-tab-help`}>{TAB_HELP[perspective][tab]}</p>
      {list.length === 0 ? (
        <div className="text-sm text-slate-400 py-6 text-center" data-testid={`${testidPrefix}-empty`}>{q ? `No threads match “${query.trim()}”.` : "Nothing here."}</div>
      ) : (
        <ul className="divide-y divide-slate-100" data-testid={`${testidPrefix}-list`}>
          {list.map((m, i) => (
            <InboxRow key={m.id} m={m} perspective={perspective} unread={unread(m)} onOpen={() => openThread(m)} testid={`${testidPrefix}-row-${i}`} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One collapsed thread: date · [company ·] sender — topic, then latest-message preview. */
function InboxRow({ m, perspective, unread, onOpen, testid }) {
  const { user } = useAuth();
  const sender = m.from_name || m.from_email || "Client";
  const last = (m.replies || [])[m.replies?.length - 1];
  const lastAuthorId = last ? last.by : m.from_user_id;
  const lastName = last ? last.by_name : sender;
  const lastText = last ? last.text : m.body;
  const who = user?.id && lastAuthorId === user.id ? "You" : (lastName || "").split(" ")[0];
  const count = (m.replies || []).length;
  return (
    <li data-testid={testid} data-unread={unread ? "true" : "false"}>
      <button onClick={onOpen} className={`w-full text-left flex items-start gap-3 py-2.5 px-1 -mx-1 rounded-lg hover:bg-slate-50 transition-colors ${unread ? "bg-sky-50/40" : ""}`} data-testid={`${testid}-open`}>
        <span className="hidden sm:block w-14 shrink-0 pt-0.5 text-[11px] text-slate-500 font-mono-num" data-testid={`${testid}-date`}>{fmtDay(m.created_at)}</span>
        <span className="h-7 w-7 shrink-0 rounded-full bg-slate-200 text-slate-700 text-[11px] font-bold flex items-center justify-center" data-testid={`${testid}-avatar`}>{sender.trim().charAt(0).toUpperCase()}</span>
        <span className="min-w-0 flex-1">
          <span className="sm:flex sm:items-baseline sm:gap-1.5 min-w-0">
            <span className="flex items-baseline gap-1.5 min-w-0 sm:shrink-0 sm:max-w-[55%]">
              {perspective === "pro" && <span className="text-[13px] font-semibold text-slate-900 min-w-0 truncate" data-testid={`${testid}-company`}>{m.company || m.company_name || "—"}</span>}
              <span className={`text-[12px] text-slate-500 shrink-0 truncate ${perspective === "pro" ? "max-w-[50%]" : ""}`} data-testid={`${testid}-sender`}>{perspective === "pro" ? "· " : ""}{sender}</span>
            </span>
            <span className="block sm:inline text-[13px] text-slate-900 truncate min-w-0" data-testid={`${testid}-topic`}><span className="hidden sm:inline">— </span>{topicOf(m)}</span>
          </span>
          <span className="flex items-center gap-1.5 mt-0.5 min-w-0">
            <span className="text-[10px] uppercase tracking-wide text-slate-500 bg-slate-100 rounded px-1.5 py-px shrink-0" data-testid={`${testid}-kind`}>{KIND_TAG[m.kind] || "Message"}</span>
            <span className={`text-[12px] truncate ${unread ? "text-slate-800 font-medium" : "text-slate-500"}`} data-testid={`${testid}-preview`}><span className="font-medium text-slate-600">{who}:</span> {lastText}</span>
          </span>
        </span>
        <span className="shrink-0 flex flex-col items-end gap-1 pt-0.5">
          <span className="sm:hidden text-[11px] text-slate-500 font-mono-num">{fmtDay(m.created_at)}</span>
          <span className="flex items-center gap-2">
            {count > 0 && <span className="text-[11px] text-slate-500 flex items-center gap-1" data-testid={`${testid}-count`}><MessageCircle size={12} /> {count}</span>}
            {unread && <span className="h-2 w-2 rounded-full bg-sky-500" title="New messages" data-testid={`${testid}-unread`} />}
          </span>
        </span>
      </button>
    </li>
  );
}

function ThreadHeader({ m, perspective, onOpenCompany, testid }) {
  const sender = m.from_name || m.from_email || "Client";
  return (
    <div className="border-b border-slate-100 pb-2 min-w-0">
      {perspective === "pro"
        ? <button onClick={() => onOpenCompany?.(m)} className="text-[13px] font-semibold text-slate-900 hover:underline truncate block" data-testid={`${testid}-company`}>{m.company || m.company_name || "—"}</button>
        : <div className="text-[13px] font-semibold text-slate-900 truncate" data-testid={`${testid}-topic`}>{topicOf(m)}</div>}
      <div className="text-[11px] text-slate-500 truncate">Started by {sender} · {fmtWhen(m.created_at)}{perspective === "pro" ? ` — ${topicOf(m)}` : ""}</div>
    </div>
  );
}
