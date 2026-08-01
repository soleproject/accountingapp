import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Mail, MailPlus, ChevronDown, ChevronRight, User, Clock } from "lucide-react";

/**
 * Per-invoice AI Follow-up timeline. Loads history from
 * `GET /companies/{cid}/invoices/{iid}/followup-history` and renders
 * newest-first, expandable rows with the full sent body so the pro can
 * prove they've been chasing before writing anything off.
 *
 * Rendered inline in InvoiceEditor next to Payment History.
 */
export default function FollowupHistoryBlock({ currentId, docId, docLabel }) {
  const [history, setHistory] = useState([]);
  const [lastAt, setLastAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({}); // entry.id -> bool

  useEffect(() => {
    if (!currentId || !docId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get(`/companies/${currentId}/invoices/${docId}/followup-history`);
        if (cancelled) return;
        setHistory(r.data?.history || []);
        setLastAt(r.data?.last_followup_at || null);
      } catch { /* silently show empty state */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [currentId, docId]);

  if (loading || history.length === 0) return null;

  const fmtSentAt = (iso) => {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      const now = new Date();
      const days = Math.floor((now - d) / 86400000);
      const nice = d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
      const rel = days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
      return { nice, rel };
    } catch { return { nice: iso, rel: "" }; }
  };

  return (
    <div className="px-6 py-5 border-t bg-white" data-testid="invoice-followup-history">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center">
            <Mail size={13} />
          </div>
          <div>
            <div className="font-heading font-semibold text-slate-800 text-sm">Follow-up history</div>
            <div className="text-[11px] text-slate-500">
              <span className="font-mono-num font-semibold text-slate-700">{history.length}</span> chase email{history.length === 1 ? "" : "s"} sent
              {lastAt && (
                <> · latest {fmtSentAt(lastAt).rel}</>
              )}
            </div>
          </div>
        </div>
      </div>
      <ol className="relative border-l-2 border-indigo-100 ml-3 pl-4 space-y-2" data-testid="invoice-followup-timeline">
        {history.map((e, idx) => {
          const isOpen = !!expanded[e.id];
          const { nice, rel } = fmtSentAt(e.sent_at);
          return (
            <li key={e.id || idx} className="relative" data-testid={`invoice-followup-entry-${idx}`}>
              <span className="absolute -left-[22px] top-3 h-3 w-3 rounded-full bg-indigo-500 ring-4 ring-white" />
              <button
                type="button"
                onClick={() => setExpanded(s => ({ ...s, [e.id || idx]: !isOpen }))}
                className="w-full text-left rounded-md border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/40 px-3 py-2 transition"
                data-testid={`invoice-followup-toggle-${idx}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {isOpen ? <ChevronDown size={13} className="text-slate-400 shrink-0" /> : <ChevronRight size={13} className="text-slate-400 shrink-0" />}
                    <MailPlus size={13} className="text-indigo-500 shrink-0" />
                    <span className="text-sm font-medium text-slate-800 truncate">{e.subject || "Follow-up email"}</span>
                  </div>
                  <span className="text-[11px] text-slate-500 shrink-0 inline-flex items-center gap-1">
                    <Clock size={10} /> {rel}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-3 text-[11px] text-slate-500 pl-6">
                  <span>To: <span className="font-mono-num text-slate-700">{e.to_email}</span></span>
                  {e.sent_by_user_name && (
                    <span className="inline-flex items-center gap-1"><User size={10} /> {e.sent_by_user_name}</span>
                  )}
                  <span className="font-mono-num">{nice}</span>
                </div>
              </button>
              {isOpen && (
                <div className="mt-2 ml-6 border border-indigo-100 bg-indigo-50/30 rounded-md px-3 py-2" data-testid={`invoice-followup-body-${idx}`}>
                  <pre className="whitespace-pre-wrap text-[12px] leading-relaxed text-slate-700 font-mono-num">{e.body || "(empty body)"}</pre>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
