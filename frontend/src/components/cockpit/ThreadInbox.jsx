/**
 * ThreadInbox
 *
 * Shared 2-column inbox view for the Waiting on Client + Client
 * Answers cards. Mirrors the Cockpit Communications layout from
 * screenshot 1: search bar + channel chips on top, thread list on
 * the left, focused thread detail panel on the right (opens on
 * click into the same row).
 *
 * Props:
 *   companyId        — the client we're rendering for
 *   endpoint         — backend endpoint (waiting-on-client | client-answers)
 *   mode             — "waiting" | "answers" — controls which action row shows
 *   companyName      — used to prefix the mini-chip like the screenshot
 *   onDataChange     — called after a mutation so the parent can refresh
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  MessageSquare, Mail, Video, Search, Send, X, Loader2, ExternalLink,
  RefreshCw, Inbox, ArrowRight, CheckCircle2,
} from "lucide-react";

const CHANNELS = [
  { key: "all",     label: "All",     icon: null },
  { key: "email",   label: "Email",   icon: <Mail size={11} /> },
  { key: "portal",  label: "Portal",  icon: <MessageSquare size={11} /> },
  { key: "meeting", label: "Meeting", icon: <Video size={11} /> },
];

const fmtDateTime = (iso) => {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const dateStr = d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
    const timeStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    return `${dateStr}, ${timeStr}`;
  } catch { return iso; }
};

const ageLabel = (d) => {
  if (typeof d !== "number") return "";
  if (d === 0) return "today";
  return `${d}d`;
};

export default function ThreadInbox({
  companyId,
  companyName = "This client",
  endpoint,
  mode = "waiting",
  onDataChange,
}) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [channel, setChannel] = useState("all");
  const [query, setQuery] = useState("");
  const [reviewState, setReviewState] = useState("needs_review");
  const [focusedId, setFocusedId] = useState(null);
  const [followup, setFollowup] = useState("");
  const [sending, setSending] = useState(false);
  const [ackBusy, setAckBusy] = useState(false);

  const load = useCallback(async () => {
    if (!companyId) return;
    setBusy(true);
    try {
      const params = { channel, q: query || undefined };
      if (mode === "answers") params.review_state = reviewState;
      const r = await api.get(`/companies/${companyId}/cockpit-cards/${endpoint}`, { params });
      setData(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load threads");
    } finally {
      setBusy(false);
    }
  }, [companyId, endpoint, channel, query, reviewState, mode]);

  useEffect(() => { load(); }, [load]);

  const threads = data?.threads || [];
  const focused = useMemo(
    () => threads.find(t => t.id === focusedId) || null,
    [threads, focusedId],
  );

  // Reset the focused pane when the list refreshes and the focused id
  // no longer exists (e.g. after a resolve).
  useEffect(() => {
    if (focusedId && !focused) setFocusedId(null);
  }, [focused, focusedId]);

  const sendFollowup = async () => {
    if (!focused || !followup.trim()) return;
    setSending(true);
    try {
      await api.post(
        `/companies/${companyId}/cockpit-cards/threads/${focused.id}/followup`,
        { message: followup.trim() },
      );
      toast.success("Follow-up sent.");
      setFollowup("");
      await load();
      onDataChange?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Send failed");
    } finally {
      setSending(false);
    }
  };

  const resendOnly = async () => {
    if (!focused) return;
    setSending(true);
    try {
      await api.post(`/cockpit/requests/${focused.id}/resend`);
      toast.success("Nudge sent.");
      await load();
      onDataChange?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Nudge failed");
    } finally {
      setSending(false);
    }
  };

  const markReviewed = async () => {
    if (!focused) return;
    setAckBusy(true);
    try {
      await api.post(`/cockpit/requests/${focused.id}/acknowledge`, {});
      toast.success("Marked reviewed.");
      await load();
      onDataChange?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Acknowledge failed");
    } finally {
      setAckBusy(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-3" data-testid="thread-inbox">
      {/* Left column — list */}
      <div className="lg:col-span-3">
        {/* Search + filters */}
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search subjects, bodies, contacts..."
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-full border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-slate-200"
              data-testid="thread-inbox-search"
            />
          </div>
          <div className="flex items-center gap-1" role="tablist">
            {CHANNELS.map(c => (
              <button
                key={c.key}
                onClick={() => setChannel(c.key)}
                className={`text-[11px] px-2.5 py-1 rounded-full border inline-flex items-center gap-1 ${
                  channel === c.key
                    ? "bg-indigo-600 text-white border-indigo-600"
                    : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                }`}
                data-testid={`thread-inbox-channel-${c.key}`}
              >
                {c.icon} {c.label}
              </button>
            ))}
          </div>
          <div className="text-[11px] text-slate-500 flex items-center gap-1 px-2 py-1 rounded-full border border-slate-200 bg-white">
            <span className="truncate max-w-[140px]">{companyName}</span>
            <span className="font-mono-num px-1 rounded bg-slate-200 text-slate-800">{threads.length}</span>
          </div>
          <button
            onClick={load}
            disabled={busy}
            className="text-slate-500 hover:text-slate-800 p-1 rounded disabled:opacity-40"
            title="Refresh"
            data-testid="thread-inbox-refresh"
            aria-label="Refresh"
          >
            <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
          </button>
        </div>

        {mode === "answers" && (
          <div className="flex items-center gap-1 mb-2">
            {[
              { key: "needs_review", label: `Needs review · ${data?.counts?.needs_review ?? 0}` },
              { key: "reviewed",     label: `Reviewed · ${data?.counts?.reviewed ?? 0}` },
              { key: "all",          label: `All · ${data?.counts?.total ?? 0}` },
            ].map(c => (
              <button
                key={c.key}
                onClick={() => setReviewState(c.key)}
                className={`text-[10px] px-2 py-0.5 rounded-full border ${
                  reviewState === c.key
                    ? "bg-emerald-600 text-white border-emerald-600"
                    : "bg-white text-slate-600 border-slate-300 hover:bg-slate-50"
                }`}
                data-testid={`answers-review-state-${c.key}`}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}

        {/* Thread list */}
        <div className="border rounded-lg bg-white overflow-hidden">
          {busy && !data ? (
            <div className="flex items-center justify-center py-10 text-slate-400">
              <Loader2 size={16} className="animate-spin" />
            </div>
          ) : threads.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-400 flex flex-col items-center gap-2">
              <Inbox size={22} className="text-slate-300" />
              {mode === "waiting" ? "Inbox zero on client questions." : "No client answers yet."}
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 max-h-[420px] overflow-y-auto">
              {threads.map(t => (
                <li key={t.id} data-testid={`thread-row-${t.id}`}>
                  <button
                    onClick={() => setFocusedId(t.id === focusedId ? null : t.id)}
                    className={`w-full text-left px-3 py-2.5 flex items-start gap-2.5 transition ${
                      t.id === focusedId ? "bg-indigo-50/60" : "hover:bg-slate-50"
                    }`}
                  >
                    <span className={`shrink-0 mt-0.5 w-8 h-8 rounded flex items-center justify-center ${
                      t.channel === "email"   ? "bg-blue-100 text-blue-700" :
                      t.channel === "meeting" ? "bg-purple-100 text-purple-700" :
                                                "bg-emerald-100 text-emerald-700"
                    }`} aria-hidden>
                      {t.channel === "email" ? <Mail size={14} /> :
                       t.channel === "meeting" ? <Video size={14} /> :
                       <MessageSquare size={14} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider">
                        <span className="font-bold text-slate-500 truncate">{companyName}</span>
                        {mode === "waiting" ? (
                          <span className="px-1.5 py-0.5 rounded bg-amber-200/70 text-amber-900 font-semibold">
                            {t.status === "pending" ? "PENDING" : "SENT"}
                          </span>
                        ) : t.cpa_reviewed_at ? (
                          <span className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 font-semibold">REVIEWED</span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded bg-emerald-200/70 text-emerald-900 font-semibold">ANSWERED</span>
                        )}
                        <span className="text-slate-400 font-normal ml-auto shrink-0">
                          {fmtDateTime(t.sent_at || t.answered_at)}
                        </span>
                      </div>
                      <div className="text-sm text-slate-900 line-clamp-1 mt-0.5">
                        {t.subject || t.question || "(no subject)"}
                      </div>
                      <div className="text-[11px] text-slate-500 flex items-center gap-2 mt-0.5">
                        <span className="truncate">With: {t.to_email || t.from_email || "—"}</span>
                        {typeof t.age_days === "number" && (
                          <span className={`shrink-0 ${
                            t.age_days >= 7 ? "text-red-600" : t.age_days >= 3 ? "text-amber-600" : "text-slate-400"
                          }`}>
                            · {ageLabel(t.age_days)}
                          </span>
                        )}
                      </div>
                    </div>
                    <ArrowRight size={13} className="text-slate-300 shrink-0 mt-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Right column — focused detail */}
      <div className="lg:col-span-2">
        {focused ? (
          <div className="border rounded-lg bg-white p-3 space-y-3 sticky top-4" data-testid="thread-detail">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
                <span className={`w-6 h-6 rounded flex items-center justify-center ${
                  focused.channel === "email" ? "bg-blue-100 text-blue-700" :
                  focused.channel === "meeting" ? "bg-purple-100 text-purple-700" :
                  "bg-emerald-100 text-emerald-700"
                }`}>
                  {focused.channel === "email" ? <Mail size={12} /> :
                   focused.channel === "meeting" ? <Video size={12} /> :
                   <MessageSquare size={12} />}
                </span>
                {focused.channel}
              </div>
              <button
                onClick={() => setFocusedId(null)}
                className="text-slate-400 hover:text-slate-900 p-1"
                aria-label="Close"
                data-testid="thread-detail-close"
              >
                <X size={14} />
              </button>
            </div>
            <div className="text-sm font-semibold text-slate-900">{companyName}</div>
            <div className="text-sm text-slate-900">{focused.subject || focused.question}</div>
            <div className="text-[11px] text-slate-500">
              With: {focused.to_email || focused.from_email || "—"}
              <div>{fmtDateTime(focused.sent_at || focused.answered_at)}</div>
            </div>

            {mode === "answers" && focused.answer && (
              <div className="rounded-md border-l-4 border-emerald-400 bg-emerald-50 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-emerald-800 font-semibold mb-1">
                  Client's answer
                </div>
                <div className="text-sm text-slate-800 whitespace-pre-wrap">{focused.answer}</div>
                {focused.ai_confidence && (
                  <div className="text-[11px] text-slate-600 mt-2">
                    AI proposal:
                    <b className="ml-1">
                      {focused.ai_proposal?.account_code} · {focused.ai_proposal?.account_name}
                    </b>
                    <span className="ml-1 text-slate-500">
                      ({Math.round((focused.ai_confidence || 0) * 100)}% confident)
                    </span>
                  </div>
                )}
              </div>
            )}

            {mode === "waiting" && (
              <div className="space-y-2">
                <textarea
                  value={followup}
                  onChange={(e) => setFollowup(e.target.value)}
                  placeholder="Type your follow-up. Client sees it in the portal + gets an email."
                  className="w-full text-sm border rounded-md p-2 min-h-[80px] focus:outline-none focus:ring-2 focus:ring-slate-200"
                  data-testid="thread-detail-followup-text"
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={sendFollowup}
                    disabled={sending || !followup.trim()}
                    className="text-xs px-3 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-500 inline-flex items-center gap-1 disabled:opacity-40"
                    data-testid="thread-detail-send"
                  >
                    {sending ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
                    Send
                  </button>
                  <button
                    onClick={() => { setFollowup(""); setFocusedId(null); }}
                    className="text-xs px-3 py-1 rounded border border-slate-300 text-slate-700 hover:bg-slate-50"
                    data-testid="thread-detail-cancel"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={resendOnly}
                    disabled={sending}
                    className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-40 inline-flex items-center gap-1"
                    data-testid="thread-detail-nudge"
                    title="Re-send the original email without adding a message"
                  >
                    <RefreshCw size={10} /> Nudge only
                  </button>
                </div>
              </div>
            )}

            {mode === "answers" && !focused.cpa_reviewed_at && (
              <button
                onClick={markReviewed}
                disabled={ackBusy}
                className="text-xs px-3 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-500 inline-flex items-center gap-1 disabled:opacity-40"
                data-testid="thread-detail-mark-reviewed"
              >
                {ackBusy ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
                Mark reviewed
              </button>
            )}

            <div className="pt-2 border-t flex flex-wrap gap-2 text-[11px]">
              <Link
                to={`/cockpit/communications?company_ids=${companyId}`}
                className="px-2 py-1 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
                data-testid="thread-detail-portal-link"
              >
                <MessageSquare size={10} /> Portal thread
              </Link>
              <Link
                to={`/cockpit/communications?company_ids=${companyId}&focus=${focused.id}`}
                className="px-2 py-1 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1"
                data-testid="thread-detail-open-in-client"
              >
                Open in client <ExternalLink size={10} />
              </Link>
            </div>
          </div>
        ) : (
          <div className="border rounded-lg bg-slate-50/40 border-dashed p-6 text-center text-xs text-slate-400 flex flex-col items-center gap-2 min-h-[220px] justify-center">
            <MessageSquare size={22} className="text-slate-300" />
            Pick a thread on the left to preview + reply.
          </div>
        )}
      </div>
    </div>
  );
}
