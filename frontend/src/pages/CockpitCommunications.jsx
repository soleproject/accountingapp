import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  Mail, MessageSquare, Video, Search, Filter, RefreshCw, Loader2,
  ChevronRight, ExternalLink, Inbox, CheckCircle2, Clock, X, Sparkles,
} from "lucide-react";

// --------------------------------------------------------------------------
// Cockpit → Communications
// Unified cross-client feed of every email sent from SmartBooks, every
// portal Q&A magic-link thread, and every AI note-taker meeting recap
// across all clients the user has access to.
// --------------------------------------------------------------------------

const SOURCE_META = {
  email:   { label: "Email",   icon: Mail,          tone: "bg-blue-50 text-blue-700 border-blue-200" },
  portal:  { label: "Portal",  icon: MessageSquare, tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  meeting: { label: "Meeting", icon: Video,         tone: "bg-violet-50 text-violet-700 border-violet-200" },
};

const STATUS_TONE = {
  sent:      "bg-emerald-100 text-emerald-700",
  failed:    "bg-rose-100 text-rose-700",
  skipped:   "bg-slate-100 text-slate-600",
  pending:   "bg-amber-100 text-amber-700",
  answered:  "bg-emerald-100 text-emerald-700",
  archived:  "bg-slate-100 text-slate-600",
  recap:     "bg-violet-100 text-violet-700",
};

export default function CockpitCommunications() {
  const location = useLocation();
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({ email: 0, portal: 0, meeting: 0 });
  const [companies, setCompanies] = useState([]);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("all");
  // review-state chip: "all" | "needs-review" | "reviewed" — filters
  // portal answered items by whether the CPA has acknowledged them
  // (`meta.cpa_reviewed_at`). Applied client-side over `items`.
  const [reviewFilter, setReviewFilter] = useState("all");
  const [filterCids, setFilterCids] = useState([]);
  const [selected, setSelected] = useState(null);
  const [showNewAsk, setShowNewAsk] = useState(false);
  const [pendingOpenId, setPendingOpenId] = useState(null); // question_id from URL

  // Hydrate filters from URL params — Today deep-links here with
  // ?company_ids=<cid>&source=portal&question_id=<qid> so a partner lands
  // filtered to the client + thread they were nudged about and (if
  // question_id was passed) the detail panel opens automatically.
  useEffect(() => {
    const qp = new URLSearchParams(location.search);
    const cidsParam = qp.get("company_ids") || qp.get("company");
    const srcParam = qp.get("source");
    const qidParam = qp.get("question_id") || qp.get("token");
    if (cidsParam) {
      const cids = cidsParam.split(",").map(s => s.trim()).filter(Boolean);
      setFilterCids(cids);
    }
    if (srcParam && ["email", "portal", "meeting", "all"].includes(srcParam)) {
      setSource(srcParam);
    }
    if (qidParam) {
      setPendingOpenId(qidParam);
    }
    // Strip the params from the URL after hydration so a mid-session
    // filter clear isn't fought by a stale query string.
    if (cidsParam || srcParam || qidParam) {
      navigate(location.pathname, { replace: true });
    }
    /* eslint-disable-next-line */
  }, []);

  const nudgePortal = async (item, message) => {
    try {
      await api.post(`/cockpit/communications/portal/${item.meta?.token}/nudge`, { message });
      toast.success("Follow-up sent.");
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Send failed.");
      throw e;
    }
  };

  const createAskClient = async (payload) => {
    try {
      await api.post("/cockpit/communications/ask-client", payload);
      toast.success("Client question sent.");
      setShowNewAsk(false);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Send failed.");
      throw e;
    }
  };

  const acknowledgeAnswer = async (item, opts = {}) => {
    const qid = item?.meta?.question_id || item?.meta?.token;
    if (!qid) return;
    try {
      const r = await api.post(`/cockpit/requests/${qid}/acknowledge`, {
        save_rule: !!opts.saveRule,
        rule_pattern: opts.rulePattern || undefined,
      });
      const rule = r?.data?.rule_created;
      toast.success(rule
        ? `Marked reviewed · Saved rule "${rule.pattern}" → ${rule.account_code} · ${rule.account_name}`
        : "Marked reviewed.");
      // Optimistically stamp on the currently-selected item so the
      // button flips to "Reviewed" without waiting for the reload.
      setSelected((s) => (s ? { ...s, meta: { ...s.meta, cpa_reviewed_at: r.data.cpa_reviewed_at } } : s));
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to mark reviewed.");
    }
  };

  const acknowledgeAll = async () => {
    // Scope the sweep to the currently-selected client filter (if any)
    // so a partner can bulk-clear one client without affecting the rest
    // of the firm's queue.
    const scope = filterCids.length > 0 ? filterCids.join(",") : "";
    const params = scope ? { company_ids: scope } : {};
    const confirmMsg = scope
      ? "Mark every answered thread for the selected client(s) as reviewed?"
      : "Mark every answered thread across every client as reviewed? This will clear your entire backlog.";
    if (!window.confirm(confirmMsg)) return;
    try {
      const r = await api.post("/cockpit/requests/acknowledge-all", null, { params });
      const n = r?.data?.count ?? 0;
      toast.success(n === 0 ? "Nothing to acknowledge." : `Marked ${n} thread${n === 1 ? "" : "s"} reviewed.`);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to mark all reviewed.");
    }
  };

  const load = async () => {
    setBusy(true);
    try {
      const params = {};
      if (search.trim()) params.q = search.trim();
      if (source !== "all") params.source = source;
      if (filterCids.length > 0) params.company_ids = filterCids.join(",");
      const [r, c] = await Promise.all([
        api.get("/cockpit/communications", { params }),
        api.get("/cockpit/accessible-companies"),
      ]);
      setItems(r.data.items || []);
      setCounts(r.data.counts || {});
      setCompanies(c.data.companies || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load communications.");
    } finally { setBusy(false); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  // Debounced reload on filter changes.
  useEffect(() => {
    const t = setTimeout(() => load(), 250);
    return () => clearTimeout(t);
    /* eslint-disable-next-line */
  }, [search, source, filterCids.join("|")]);

  // Auto-open a thread when Today (or any deep link) passed its id.
  useEffect(() => {
    if (!pendingOpenId || items.length === 0) return;
    // question_id / token maps 1:1 to a client_questions doc, which we
    // expose as source=portal with meta.token = <qid>.  Never match on
    // emails — a portal thread and its outbound email row have the same
    // question id in related metadata but the *portal* row is what the
    // CPA wants to open.
    const match = items.find(it =>
      it.source === "portal" && (
        it.id === `portal-${pendingOpenId}` ||
        it.meta?.token === pendingOpenId
      )
    );
    if (match) {
      setSelected(match);
      setPendingOpenId(null);
    }
  }, [items, pendingOpenId]);

  const nameById = useMemo(() => {
    const m = {};
    for (const c of companies) m[c.id] = c.name;
    return m;
  }, [companies]);

  // Client-side review-state filter over the loaded items. Applies to
  // portal threads only (email/meeting don't have a "reviewed" state);
  // non-portal items pass through untouched so switching to "Reviewed"
  // doesn't hide the entire email column.
  const filteredItems = useMemo(() => {
    if (reviewFilter === "all") return items;
    return items.filter((it) => {
      if (it.source !== "portal") return true;
      const answered = it.status === "answered";
      const reviewed = !!it.meta?.cpa_reviewed_at;
      if (reviewFilter === "needs-review") return answered && !reviewed;
      if (reviewFilter === "reviewed") return answered && reviewed;
      return true;
    });
  }, [items, reviewFilter]);

  // Counts for the review chips — surface how many answered threads are
  // waiting on a CPA acknowledge vs. already done.
  const reviewCounts = useMemo(() => {
    let needs = 0, done = 0;
    for (const it of items) {
      if (it.source !== "portal" || it.status !== "answered") continue;
      if (it.meta?.cpa_reviewed_at) done += 1;
      else needs += 1;
    }
    return { needs, done };
  }, [items]);

  return (
    <div className="p-6 max-w-[1400px] mx-auto" data-testid="cockpit-communications-page">
      <div className="mb-5 flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">Cockpit</div>
          <h1 className="font-heading text-3xl font-bold tracking-tight text-slate-900">Communications</h1>
          <p className="text-sm text-slate-500 mt-1">
            Every email, portal message and meeting recap — one searchable stream.
          </p>
        </div>
        <button
          onClick={load}
          disabled={busy}
          className="text-sm px-3 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50"
          data-testid="cockpit-comms-refresh"
        >
          <RefreshCw size={14} className={busy ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        <StatCard label="Total items" value={items.length} tone="slate" />
        <StatCard label="Emails" value={counts.email || 0} tone="blue" icon={Mail} />
        <StatCard label="Portal threads" value={counts.portal || 0} tone="emerald" icon={MessageSquare} />
        <StatCard label="Meeting recaps" value={counts.meeting || 0} tone="violet" icon={Video} />
      </div>

      {/* Search + filters */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <div className="relative flex-1 min-w-[280px] max-w-lg">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search subjects, bodies, contacts…"
            className="w-full text-sm border border-slate-300 rounded-md pl-8 pr-3 py-1.5"
            data-testid="cockpit-comms-search"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
              data-testid="cockpit-comms-search-clear"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          {[
            { key: "all", label: "All" },
            { key: "email", label: "Email" },
            { key: "portal", label: "Portal" },
            { key: "meeting", label: "Meeting" },
          ].map(s => (
            <button
              key={s.key}
              onClick={() => setSource(s.key)}
              className={`text-xs px-2.5 py-1 rounded-full border ${source === s.key
                ? "bg-indigo-600 text-white border-indigo-600"
                : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"}`}
              data-testid={`cockpit-comms-source-${s.key}`}
            >{s.label}</button>
          ))}
        </div>
        {/* Review-state chips (portal only; only shown when there's at
            least one answered portal thread to filter over). */}
        {(reviewCounts.needs + reviewCounts.done) > 0 && (
          <div className="flex items-center gap-1" data-testid="cockpit-comms-review-chips">
            <span className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold mr-1">Review</span>
            {[
              { key: "all", label: "All" },
              { key: "needs-review", label: "Needs review", count: reviewCounts.needs, tone: "emerald" },
              { key: "reviewed", label: "Reviewed", count: reviewCounts.done, tone: "slate" },
            ].map(s => {
              const on = reviewFilter === s.key;
              return (
                <button
                  key={s.key}
                  onClick={() => setReviewFilter(s.key)}
                  className={`text-xs px-2.5 py-1 rounded-full border inline-flex items-center gap-1 ${on
                    ? (s.tone === "emerald"
                      ? "bg-emerald-600 text-white border-emerald-600"
                      : s.tone === "slate"
                        ? "bg-slate-800 text-white border-slate-800"
                        : "bg-indigo-600 text-white border-indigo-600")
                    : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"}`}
                  data-testid={`cockpit-comms-review-${s.key}`}
                >
                  {s.label}
                  {typeof s.count === "number" && (
                    <span className={`text-[10px] font-mono-num px-1 rounded ${on ? "bg-white/25 text-white" : "bg-slate-100 text-slate-600"}`}>
                      {s.count}
                    </span>
                  )}
                </button>
              );
            })}
            {reviewCounts.needs > 0 && (
              <button
                onClick={acknowledgeAll}
                className="text-xs px-2.5 py-1 rounded-full border border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 inline-flex items-center gap-1 ml-1"
                data-testid="cockpit-comms-mark-all-reviewed"
                title={filterCids.length > 0
                  ? "Clear the backlog for the selected client(s)"
                  : "Clear the backlog across every client"}
              >
                <CheckCircle2 size={11} />
                Mark all reviewed
              </button>
            )}
          </div>
        )}
        <CompanyDropdown
          companies={companies}
          selected={filterCids}
          onChange={setFilterCids}
        />
      </div>

      {/* Split pane */}
      <div className="grid gap-3 md:grid-cols-[1fr_360px]">
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          {busy && items.length === 0 ? (
            <div className="py-16 flex items-center justify-center text-slate-400">
              <Loader2 className="animate-spin" size={20} />
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="py-16 text-center">
              <Inbox size={40} className="mx-auto text-slate-300" />
              <div className="mt-3 font-semibold text-slate-800">
                {items.length === 0 ? "No communications found" : "Nothing matches this filter"}
              </div>
              <div className="text-sm text-slate-500 mt-1">
                {items.length === 0
                  ? "Try clearing filters or widening the search."
                  : reviewFilter === "reviewed"
                    ? "You haven't marked anything as reviewed yet."
                    : reviewFilter === "needs-review"
                      ? "Inbox zero on client answers — nice."
                      : "Try clearing filters or widening the search."}
              </div>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {filteredItems.map(it => {
                const meta = SOURCE_META[it.source] || SOURCE_META.email;
                const Icon = meta.icon;
                const active = selected?.id === it.id;
                return (
                  <button
                    key={it.id}
                    onClick={() => setSelected(it)}
                    className={`w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-slate-50 ${active ? "bg-indigo-50/60" : ""}`}
                    data-testid={`cockpit-comms-row-${it.id}`}
                  >
                    <div className={`w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 ${meta.tone}`}>
                      <Icon size={14} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] uppercase font-semibold text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">
                          {it.company_name}
                        </span>
                        {it.status && (
                          <span className={`text-[10px] uppercase font-semibold rounded-full px-2 py-0.5 ${STATUS_TONE[it.status] || "bg-slate-100 text-slate-600"}`}>
                            {it.status}
                          </span>
                        )}
                        <span className="text-[10px] text-slate-400 ml-auto">
                          {it.created_at ? new Date(it.created_at).toLocaleString() : ""}
                        </span>
                      </div>
                      <div className="font-semibold text-sm text-slate-900 mt-1 truncate">
                        {it.subject}
                      </div>
                      {it.contact && (
                        <div className="text-[11px] text-slate-500 mt-0.5 truncate">
                          {it.direction === "outbound" ? "To" : "With"}: {it.contact}
                        </div>
                      )}
                      {it.preview && (
                        <div className="text-xs text-slate-600 mt-1 line-clamp-2">
                          {it.preview}
                        </div>
                      )}
                    </div>
                    <ChevronRight size={16} className="text-slate-300 shrink-0 mt-2" />
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Detail panel */}
        <DetailPanel
          item={selected}
          onClose={() => setSelected(null)}
          onNudge={nudgePortal}
          onNewAskClient={() => setShowNewAsk(true)}
          onAcknowledge={acknowledgeAnswer}
        />
      </div>

      {showNewAsk && (
        <NewAskClientModal
          companies={companies}
          defaultCompanyId={selected?.company_id || filterCids[0]}
          onClose={() => setShowNewAsk(false)}
          onSubmit={createAskClient}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, tone = "slate", icon: Icon }) {
  const toneCls = {
    slate:   "border-slate-200 bg-white text-slate-900",
    blue:    "border-blue-200 bg-blue-50 text-blue-800",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
    violet:  "border-violet-200 bg-violet-50 text-violet-800",
  }[tone];
  return (
    <div className={`rounded-lg border ${toneCls} p-3 flex items-start justify-between`}>
      <div>
        <div className="text-[10px] uppercase font-semibold opacity-70">{label}</div>
        <div className="text-2xl font-bold tabular-nums mt-1">{value}</div>
      </div>
      {Icon && <Icon size={18} className="opacity-40" />}
    </div>
  );
}

function DetailPanel({ item, onClose, onNudge, onNewAskClient, onAcknowledge }) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [ackBusy, setAckBusy] = useState(false);
  const [rulePreview, setRulePreview] = useState(null); // {eligible, pattern, account_code, account_name, prior_count, recurring, already_exists}
  const [saveRule, setSaveRule] = useState(false);

  React.useEffect(() => { setReplyOpen(false); setReply(""); }, [item?.id]);

  // Fetch the rule preview whenever we select an answered portal
  // thread. Only makes sense once — no polling. The preview drives
  // whether we render the checkbox and whether it starts pre-checked
  // (recurring counterparty ⇒ pre-checked).
  React.useEffect(() => {
    setRulePreview(null);
    setSaveRule(false);
    const qid = item?.meta?.question_id;
    if (!qid || item?.source !== "portal" || item?.status !== "answered" || item?.meta?.cpa_reviewed_at) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get(`/cockpit/requests/${qid}/rule-preview`);
        if (cancelled) return;
        setRulePreview(r.data || null);
        if (r.data?.eligible && r.data?.recurring && !r.data?.already_exists) {
          setSaveRule(true);
        }
      } catch {
        // Soft-fail — no checkbox rather than a broken panel.
      }
    })();
    return () => { cancelled = true; };
  }, [item?.id, item?.meta?.question_id, item?.status, item?.source, item?.meta?.cpa_reviewed_at]);

  if (!item) {
    return (
      <div className="bg-white rounded-lg border border-slate-200 p-6" data-testid="cockpit-comms-empty-detail">
        <div className="text-center text-sm text-slate-400">
          <Inbox size={32} className="mx-auto text-slate-300 mb-2" />
          Pick a message on the left to view it.
        </div>
        <div className="mt-4 border-t border-slate-100 pt-4 text-center">
          <button
            onClick={onNewAskClient}
            className="text-[11px] px-2.5 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-700 inline-flex items-center gap-1"
            data-testid="cockpit-comms-new-ask-empty"
          >
            <Mail size={11} /> New ask-client email
          </button>
        </div>
      </div>
    );
  }
  const meta = SOURCE_META[item.source] || SOURCE_META.email;
  const Icon = meta.icon;

  const sendReply = async () => {
    if (!reply.trim()) return;
    setBusy(true);
    try {
      await onNudge(item, reply.trim());
      setReply("");
      setReplyOpen(false);
    } finally { setBusy(false); }
  };

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4 sticky top-4 self-start" data-testid="cockpit-comms-detail">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className={`w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 ${meta.tone}`}>
            <Icon size={14} />
          </div>
          <div>
            <div className="text-[10px] uppercase font-semibold text-slate-500">{meta.label}</div>
            <div className="font-semibold text-slate-900 leading-tight">{item.company_name}</div>
          </div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-700" data-testid="cockpit-comms-detail-close">
          <X size={16} />
        </button>
      </div>
      <div className="mt-3 text-sm font-semibold text-slate-900">{item.subject}</div>
      {item.contact && (
        <div className="text-[11px] text-slate-500 mt-0.5">
          {item.direction === "outbound" ? "To" : "With"}: {item.contact}
        </div>
      )}
      <div className="text-[11px] text-slate-400 mt-0.5">
        {item.created_at ? new Date(item.created_at).toLocaleString() : ""}
      </div>
      {item.preview && (
        <div className="mt-3 text-xs text-slate-700 whitespace-pre-wrap leading-relaxed">
          {item.preview}
        </div>
      )}

      {/* Client answer surface — only for portal threads that have been
          answered. Shows the client's own words + any AI proposal /
          auto-post + a one-click "Mark reviewed" so the CPA can clear
          it out of the Today queue even after auto-apply. */}
      {item.source === "portal" && item.status === "answered" && item.meta?.answer && (
        <div
          className={`mt-3 rounded-md border p-3 ${
            item.meta?.cpa_reviewed_at
              ? "border-slate-200 bg-slate-50"
              : "border-emerald-200 bg-emerald-50"
          }`}
          data-testid="cockpit-comms-answer-block"
        >
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-[10px] uppercase font-semibold text-emerald-800">
              Client answered
              {item.meta?.answered_at && (
                <span className="text-slate-500 font-normal ml-1.5">
                  · {new Date(item.meta.answered_at).toLocaleString()}
                </span>
              )}
            </div>
            {item.meta?.cpa_reviewed_at ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 flex items-center gap-1" data-testid="cockpit-comms-reviewed-badge">
                <CheckCircle2 size={10} /> Reviewed
              </span>
            ) : (
              <button
                onClick={async () => {
                  setAckBusy(true);
                  try {
                    await onAcknowledge(item, {
                      saveRule: saveRule && !!rulePreview?.eligible && !rulePreview?.already_exists,
                      rulePattern: rulePreview?.pattern,
                    });
                  }
                  finally { setAckBusy(false); }
                }}
                disabled={ackBusy}
                className="text-[11px] px-2 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1"
                data-testid="cockpit-comms-mark-reviewed"
              >
                {ackBusy ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
                Mark reviewed
              </button>
            )}
          </div>
          <div className="mt-2 text-sm text-slate-900 whitespace-pre-wrap leading-relaxed">
            “{item.meta.answer}”
          </div>
          {item.meta?.ai_proposal && item.meta.ai_proposal.account_code && item.meta.ai_proposal.account_code !== "9999" && (
            <div className="mt-2 text-[11px] text-slate-600 flex items-center gap-1">
              <Sparkles size={11} className="text-emerald-600" />
              {item.meta.ai_proposal.auto_applied ? (
                <span>
                  Auto-posted to <b className="text-slate-900">{item.meta.ai_proposal.account_code} · {item.meta.ai_proposal.account_name}</b>
                  {" "}({Math.round((item.meta.ai_proposal.confidence || 0) * 100)}% confidence)
                </span>
              ) : (
                <span>
                  AI suggests <b className="text-slate-900">{item.meta.ai_proposal.account_code} · {item.meta.ai_proposal.account_name}</b>
                  {" "}({Math.round((item.meta.ai_proposal.confidence || 0) * 100)}% confidence) — accept in Transactions
                </span>
              )}
            </div>
          )}
          {/* Save-as-rule offer — only for CPA-acknowledgeable items
              (still unreviewed) with a real proposal + valid pattern.
              Pre-checked when the counterparty is already recurring. */}
          {!item.meta?.cpa_reviewed_at && rulePreview?.eligible && (
            <label
              className={`mt-2.5 flex items-start gap-2 text-[11px] rounded border px-2 py-1.5 cursor-pointer ${
                rulePreview.already_exists
                  ? "border-slate-200 bg-white text-slate-500"
                  : "border-emerald-200 bg-white text-slate-700 hover:bg-emerald-50/40"
              }`}
              data-testid="cockpit-comms-save-rule"
            >
              <input
                type="checkbox"
                className="mt-0.5 accent-emerald-600"
                checked={saveRule && !rulePreview.already_exists}
                disabled={rulePreview.already_exists}
                onChange={(e) => setSaveRule(e.target.checked)}
                data-testid="cockpit-comms-save-rule-checkbox"
              />
              <span className="min-w-0">
                {rulePreview.already_exists ? (
                  <>Rule already exists for <b>"{rulePreview.pattern}"</b> — no need to save again.</>
                ) : (
                  <>
                    Save rule: <b>"{rulePreview.pattern}"</b> → <b>{rulePreview.account_code} · {rulePreview.account_name}</b>
                    {rulePreview.prior_count > 0 && (
                      <span className="text-slate-500">
                        {" · "}{rulePreview.prior_count} prior charge{rulePreview.prior_count === 1 ? "" : "s"}
                        {rulePreview.recurring ? " (recurring)" : ""}
                      </span>
                    )}
                  </>
                )}
              </span>
            </label>
          )}
        </div>
      )}

      {/* Compose actions */}
      <div className="mt-4 border-t border-slate-100 pt-3">
        {item.source === "portal" && item.meta?.token && (
          <div>
            {!replyOpen ? (
              <button
                onClick={() => setReplyOpen(true)}
                className="text-[11px] px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 flex items-center gap-1"
                data-testid="cockpit-comms-reply-btn"
              >
                <Mail size={11} /> Send follow-up
              </button>
            ) : (
              <div>
                <textarea
                  autoFocus
                  value={reply}
                  onChange={e => setReply(e.target.value)}
                  placeholder="Type your follow-up. Client sees it in the portal + gets an email."
                  rows={4}
                  className="w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
                  data-testid="cockpit-comms-reply-text"
                />
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={sendReply}
                    disabled={busy || !reply.trim()}
                    className="text-[11px] px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1"
                    data-testid="cockpit-comms-reply-send"
                  >
                    {busy ? <Loader2 size={11} className="animate-spin" /> : <Mail size={11} />}
                    Send
                  </button>
                  <button
                    onClick={() => { setReplyOpen(false); setReply(""); }}
                    className="text-[11px] px-2 py-1 rounded border border-slate-300 hover:bg-slate-50"
                    data-testid="cockpit-comms-reply-cancel"
                  >Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap mt-2">
          <button
            onClick={onNewAskClient}
            className="text-[11px] px-2 py-1 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 flex items-center gap-1"
            data-testid="cockpit-comms-new-ask"
          >
            <Mail size={11} /> New ask-client
          </button>
          {item.source === "portal" && item.meta?.token && (
            <a
              href={`/portal/${item.meta.token}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] px-2 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-50 flex items-center gap-1"
              data-testid="cockpit-comms-open-portal"
            >
              <ExternalLink size={11} /> Portal thread
            </a>
          )}
          {item.source === "meeting" && item.meta?.transcript_url && (
            <a
              href={item.meta.transcript_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] px-2 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-50 flex items-center gap-1"
              data-testid="cockpit-comms-open-transcript"
            >
              <ExternalLink size={11} /> Transcript
            </a>
          )}
          <a
            href={`/companies/${item.company_id}/communications`}
            className="text-[11px] px-2 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-50 flex items-center gap-1 ml-auto"
            data-testid="cockpit-comms-open-client"
          >
            Open in client <ChevronRight size={11} />
          </a>
        </div>
      </div>
    </div>
  );
}

function NewAskClientModal({ companies, defaultCompanyId, onClose, onSubmit }) {
  const [companyId, setCompanyId] = useState(defaultCompanyId || companies[0]?.id || "");
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!companyId) { toast.error("Pick a client."); return; }
    if (!subject.trim()) { toast.error("Subject is required."); return; }
    if (!body.trim()) { toast.error("Message is required."); return; }
    setBusy(true);
    try {
      await onSubmit({
        company_id: companyId,
        subject: subject.trim(),
        body: body.trim(),
        to: to.trim() || null,
      });
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-5"
        onClick={e => e.stopPropagation()}
        data-testid="cockpit-comms-new-ask-modal"
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="text-[10px] uppercase font-semibold text-slate-400">New ask-client</div>
            <div className="font-heading text-xl font-bold text-slate-900">Compose a client question</div>
            <div className="text-xs text-slate-500 mt-0.5">Sends a magic-link email; client replies inside their portal.</div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={18} /></button>
        </div>

        <label className="block text-xs uppercase font-semibold text-slate-600 mt-3">Client</label>
        <select
          value={companyId}
          onChange={e => setCompanyId(e.target.value)}
          className="mt-1 w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
          data-testid="cockpit-comms-new-ask-company"
        >
          <option value="">(Pick a client)</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        <label className="block text-xs uppercase font-semibold text-slate-600 mt-3">
          Override recipient email <span className="text-slate-400 normal-case">(optional)</span>
        </label>
        <input
          value={to}
          onChange={e => setTo(e.target.value)}
          placeholder="Leave blank to send to the company owner"
          className="mt-1 w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
          data-testid="cockpit-comms-new-ask-to"
        />

        <label className="block text-xs uppercase font-semibold text-slate-600 mt-3">Subject</label>
        <input
          value={subject}
          onChange={e => setSubject(e.target.value)}
          placeholder="e.g., Please confirm your 2025 W-9 details"
          className="mt-1 w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
          data-testid="cockpit-comms-new-ask-subject"
        />

        <label className="block text-xs uppercase font-semibold text-slate-600 mt-3">Message</label>
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          rows={6}
          placeholder="Hi — could you take a moment to…"
          className="mt-1 w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
          data-testid="cockpit-comms-new-ask-body"
        />

        <div className="flex items-center justify-end gap-2 mt-5">
          <button onClick={onClose} className="text-sm px-3 py-1.5 rounded-md border border-slate-300 hover:bg-slate-50">Cancel</button>
          <button
            onClick={submit}
            disabled={busy}
            className="text-sm px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1"
            data-testid="cockpit-comms-new-ask-submit"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Mail size={12} />}
            Send question
          </button>
        </div>
      </div>
    </div>
  );
}

function CompanyDropdown({ companies, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const wrapperRef = React.useRef(null);

  React.useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const toggle = (val) => onChange(selected.includes(val) ? selected.filter(v => v !== val) : [...selected, val]);
  const filtered = companies.filter(c => !search || (c.name || "").toLowerCase().includes(search.toLowerCase()));
  const label = selected.length === 0 ? "All clients"
    : selected.length === 1 ? (companies.find(c => c.id === selected[0])?.name || "1 client")
    : `${selected.length} clients`;

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        onClick={() => setOpen(v => !v)}
        className="text-sm px-3 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 flex items-center gap-1.5"
        data-testid="cockpit-comms-client-filter"
      >
        <Filter size={14} className="text-slate-500" />
        <span className="text-slate-700">{label}</span>
        {selected.length > 0 && (
          <span className="text-[10px] uppercase font-semibold text-indigo-700 bg-indigo-100 rounded-full px-1.5 py-0.5">
            {selected.length}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 w-72 bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden">
          <div className="p-2 border-b border-slate-100">
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search clients…"
              className="w-full text-sm border border-slate-300 rounded-md px-2 py-1"
            />
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="text-xs text-slate-400 px-3 py-2">No matches.</div>
            ) : (
              filtered.map(c => {
                const on = selected.includes(c.id);
                return (
                  <button
                    key={c.id}
                    onClick={() => toggle(c.id)}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 flex items-center gap-2 ${on ? "text-indigo-700 font-semibold" : "text-slate-700"}`}
                  >
                    <span className={`w-4 h-4 rounded border ${on ? "bg-indigo-600 border-indigo-600" : "border-slate-300"} flex items-center justify-center shrink-0`}>
                      {on && <CheckCircle2 size={12} className="text-white" />}
                    </span>
                    <span className="flex-1 min-w-0 truncate">{c.name}</span>
                  </button>
                );
              })
            )}
          </div>
          <div className="p-2 border-t border-slate-100 flex items-center justify-between">
            <button
              onClick={() => onChange([])}
              disabled={selected.length === 0}
              className="text-xs text-slate-600 hover:text-slate-900 disabled:opacity-40"
            >Clear</button>
            <button
              onClick={() => setOpen(false)}
              className="text-xs px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700"
            >Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
