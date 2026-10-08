import { useMemo, useState } from "react";
import { ArrowLeft, MessageCircle } from "lucide-react";
import { MessageThread, fmtDay, fmtWhen, topicOf, KIND_TAG } from "@/components/AskAccountantModal";
import { useAuth } from "@/lib/auth";

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
  const [tab, setTab] = useState("outstanding");
  const [focus, setFocus] = useState(null);
  const buckets = useMemo(() => {
    const b = { outstanding: [], answered: [], resolved: [] };
    for (const m of messages || []) b[bucketOf(m, perspective)].push(m);
    return b;
  }, [messages, perspective]);
  const focused = focus ? (messages || []).find(m => m.id === focus) : null;
  const onChangedWrap = () => { onChanged?.(); };
  const replyLabel = perspective === "pro" ? "Reply" : "Reply back";

  if (focused) {
    return (
      <div data-testid={`${testidPrefix}-thread-focus`}>
        <button onClick={() => setFocus(null)} className="text-[12px] text-slate-600 hover:text-slate-900 flex items-center gap-1 mb-2" data-testid={`${testidPrefix}-thread-back`}>
          <ArrowLeft size={13} /> All threads
        </button>
        <ThreadHeader m={focused} perspective={perspective} onResolve={onResolve} onOpenCompany={onOpenCompany} testid={`${testidPrefix}-focus`} />
        <MessageThread m={focused} onReply={onReply} canReply={focused.status !== "resolved"} replyLabel={replyLabel} hideResolve onChanged={onChangedWrap} />
      </div>
    );
  }

  const list = buckets[tab];
  return (
    <div>
      <div className="flex gap-1 border-b border-slate-200 mb-3" data-testid={`${testidPrefix}-tabs`}>
        {[["outstanding", "Outstanding"], ["answered", "Answered"], ["resolved", "Resolved"]].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} data-testid={`${testidPrefix}-tab-${k}`}
            className={`text-[12px] font-medium px-3 py-2 -mb-px border-b-2 transition-colors ${tab === k ? "border-slate-900 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
            {l}
            {buckets[k].length > 0 && <span className={`ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold ${tab === k ? "bg-slate-900 text-white" : "bg-slate-200 text-slate-600"}`}>{buckets[k].length}</span>}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-slate-500 mb-1" data-testid={`${testidPrefix}-tab-help`}>{TAB_HELP[perspective][tab]}</p>
      {list.length === 0 ? (
        <div className="text-sm text-slate-400 py-6 text-center" data-testid={`${testidPrefix}-empty`}>Nothing here.</div>
      ) : (
        <ul className="divide-y divide-slate-100" data-testid={`${testidPrefix}-list`}>
          {list.map((m, i) => (
            <InboxRow key={m.id} m={m} perspective={perspective} yourTurn={tab === "outstanding"} onOpen={() => setFocus(m.id)} testid={`${testidPrefix}-row-${i}`} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One collapsed thread: date · [company ·] sender — topic, then latest-message preview. */
function InboxRow({ m, perspective, yourTurn, onOpen, testid }) {
  const { user } = useAuth();
  const sender = m.from_name || m.from_email || "Client";
  const last = (m.replies || [])[m.replies?.length - 1];
  const lastAuthorId = last ? last.by : m.from_user_id;
  const lastName = last ? last.by_name : sender;
  const lastText = last ? last.text : m.body;
  const who = user?.id && lastAuthorId === user.id ? "You" : (lastName || "").split(" ")[0];
  const count = (m.replies || []).length;
  return (
    <li data-testid={testid}>
      <button onClick={onOpen} className="w-full text-left flex items-start gap-3 py-2.5 px-1 -mx-1 rounded-lg hover:bg-slate-50 transition-colors" data-testid={`${testid}-open`}>
        <span className="hidden sm:block w-14 shrink-0 pt-0.5 text-[11px] text-slate-500 font-mono-num" data-testid={`${testid}-date`}>{fmtDay(m.created_at)}</span>
        <span className="h-7 w-7 shrink-0 rounded-full bg-slate-200 text-slate-700 text-[11px] font-bold flex items-center justify-center" data-testid={`${testid}-avatar`}>{sender.trim().charAt(0).toUpperCase()}</span>
        <span className="min-w-0 flex-1">
          <span className="sm:flex sm:items-baseline sm:gap-1.5 min-w-0">
            <span className="flex items-baseline gap-1.5 min-w-0 sm:shrink-0 sm:max-w-[55%]">
              {perspective === "pro" && <span className="text-[13px] font-semibold text-slate-900 min-w-0 truncate" data-testid={`${testid}-company`}>{m.company || m.company_name || "—"}</span>}
              <span className="text-[12px] text-slate-500 shrink-0 truncate max-w-[50%]" data-testid={`${testid}-sender`}>{perspective === "pro" ? "· " : ""}{sender}</span>
            </span>
            <span className="block sm:inline text-[13px] text-slate-900 truncate min-w-0" data-testid={`${testid}-topic`}><span className="hidden sm:inline">— </span>{topicOf(m)}</span>
          </span>
          <span className="flex items-center gap-1.5 mt-0.5 min-w-0">
            <span className="text-[10px] uppercase tracking-wide text-slate-500 bg-slate-100 rounded px-1.5 py-px shrink-0" data-testid={`${testid}-kind`}>{KIND_TAG[m.kind] || "Message"}</span>
            <span className="text-[12px] text-slate-500 truncate" data-testid={`${testid}-preview`}><span className="font-medium text-slate-600">{who}:</span> {lastText}</span>
          </span>
        </span>
        <span className="shrink-0 flex flex-col items-end gap-1 pt-0.5">
          <span className="sm:hidden text-[11px] text-slate-500 font-mono-num">{fmtDay(m.created_at)}</span>
          <span className="flex items-center gap-2">
            {count > 0 && <span className="text-[11px] text-slate-500 flex items-center gap-1" data-testid={`${testid}-count`}><MessageCircle size={12} /> {count}</span>}
            {yourTurn && <span className="h-2 w-2 rounded-full bg-sky-500" title="Your turn" data-testid={`${testid}-your-turn`} />}
          </span>
        </span>
      </button>
    </li>
  );
}

function ThreadHeader({ m, perspective, onResolve, onOpenCompany, testid }) {
  const sender = m.from_name || m.from_email || "Client";
  return (
    <div className="flex items-start justify-between gap-2 border-b border-slate-100 pb-2">
      <div className="min-w-0">
        {perspective === "pro"
          ? <button onClick={() => onOpenCompany?.(m)} className="text-[13px] font-semibold text-slate-900 hover:underline truncate block" data-testid={`${testid}-company`}>{m.company || m.company_name || "—"}</button>
          : <div className="text-[13px] font-semibold text-slate-900 truncate" data-testid={`${testid}-topic`}>{topicOf(m)}</div>}
        <div className="text-[11px] text-slate-500 truncate">Started by {sender} · {fmtWhen(m.created_at)}{perspective === "pro" ? ` — ${topicOf(m)}` : ""}</div>
      </div>
      {perspective === "client" && m.status !== "resolved" && (
        <button onClick={() => onResolve?.(m)} className="text-[11px] text-slate-500 hover:text-emerald-700 shrink-0" data-testid={`${testid}-resolve`}>Mark resolved</button>
      )}
    </div>
  );
}
