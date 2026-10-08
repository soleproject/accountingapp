import { useMemo, useState } from "react";
import { ArrowLeft, Maximize2 } from "lucide-react";
import { MessageThread } from "@/components/AskAccountantModal";

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
 * Tabs: Outstanding / Answered / Resolved. "Open thread" focuses one thread with
 * every message; "All threads" returns to the list.
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
  const canReply = (m) => m.status !== "resolved";
  const replyLabel = perspective === "pro" ? "Reply" : "Reply back";

  if (focused) {
    return (
      <div data-testid={`${testidPrefix}-thread-focus`}>
        <button onClick={() => setFocus(null)} className="text-[12px] text-slate-600 hover:text-slate-900 flex items-center gap-1 mb-2" data-testid={`${testidPrefix}-thread-back`}>
          <ArrowLeft size={13} /> All threads
        </button>
        <ThreadHeader m={focused} perspective={perspective} onResolve={onResolve} onOpenCompany={onOpenCompany} testid={`${testidPrefix}-focus`} />
        <MessageThread m={focused} onReply={onReply} canReply={canReply(focused)} replyLabel={replyLabel} hideResolve onChanged={onChangedWrap} />
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
        <ul className="divide-y divide-slate-100">
          {list.map((m, i) => (
            <li key={m.id} data-testid={`${testidPrefix}-row-${i}`}>
              <ThreadHeader m={m} perspective={perspective} onResolve={onResolve} onOpenCompany={onOpenCompany} onFocus={() => setFocus(m.id)} testid={`${testidPrefix}-row-${i}`} />
              <MessageThread m={m} onReply={onReply} canReply={canReply(m)} replyLabel={replyLabel} hideResolve maxReplies={2} onChanged={onChangedWrap} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ThreadHeader({ m, perspective, onResolve, onOpenCompany, onFocus, testid }) {
  return (
    <div className="flex items-center justify-between pt-3 -mb-2 gap-2">
      {perspective === "pro"
        ? <button onClick={() => onOpenCompany?.(m)} className="text-[13px] font-semibold text-slate-900 hover:underline truncate" data-testid={`${testid}-company`}>{m.company || m.company_name || "—"}</button>
        : <div className="text-[13px] font-semibold text-slate-900 truncate">{m.kind === "txn_question" ? "About a transaction" : m.kind === "checkin_deferred" ? "From a check-in" : "Question for your accountant"}</div>}
      <div className="flex items-center gap-3 shrink-0">
        {onFocus && <button onClick={onFocus} className="text-[11px] text-slate-500 hover:text-slate-900 flex items-center gap-1" data-testid={`${testid}-open`}><Maximize2 size={11} /> Open thread</button>}
        {perspective === "client" && m.status !== "resolved" && (
          <button onClick={() => onResolve?.(m)} className="text-[11px] text-slate-500 hover:text-emerald-700" data-testid={`${testid}-resolve`}>Mark resolved</button>
        )}
      </div>
    </div>
  );
}
