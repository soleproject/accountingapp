import { useEffect, useState } from "react";
import { useCompany } from "@/lib/company";
import { api, fmtMoney } from "@/lib/api";
import { toast } from "sonner";
import {
  Inbox, Settings as SettingsIcon, Mail, CheckCircle2, XCircle,
  MinusCircle, Send, RefreshCw, ExternalLink, Sparkles, Wand2, Loader2,
  MessageSquare, Bot, User as UserIcon, ChevronDown, ChevronRight, Search,
  Archive, ArchiveRestore,
} from "lucide-react";

const KIND_LABELS = {
  ai_ask_client:         { label: "AI Ask Client",      hint: "AI autonomously emails clients about unrecognized transactions (max 3/day per client, one txn per email)" },
  ask_client:            { label: "Pro Ask Client",     hint: "Pro manually asks the client about flagged transactions" },
  daily_pro_digest:      { label: "Daily digest",       hint: "Morning summary of your firm's Needs Attention" },
  dunning:               { label: "A/R dunning",        hint: "Reminders to customers about overdue invoices" },
  overdue_bill_client:   { label: "Overdue A/P",        hint: "Reminders to the client about overdue bills" },
  plaid_reauth:          { label: "Plaid re-auth",      hint: "Alert client when a bank connection expires" },
  onboarding_followup:   { label: "Onboarding nudge",   hint: "Reminder to finish onboarding" },
  month_close_signoff:   { label: "Month-close signoff",hint: "Ask client to sign off on a closed month" },
};

export default function Communications() {
  const { currentId } = useCompany();
  const [tab, setTab] = useState("inbox");

  return (
    <div className="space-y-4" data-testid="communications-page">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Communications</h1>
          <p className="text-sm text-slate-600 mt-1">
            Every email the platform sends is auditable here, and the switches on <b>Settings</b> control which flows are live.
          </p>
        </div>
      </div>

      <div className="border-b flex items-center gap-1">
        <TabBtn active={tab === "inbox"} onClick={() => setTab("inbox")} testid="tab-inbox">
          <Inbox size={14} /> Inbox
        </TabBtn>
        <TabBtn active={tab === "aiaskclient"} onClick={() => setTab("aiaskclient")} testid="tab-aiaskclient">
          <Sparkles size={14} /> AI Ask Client
        </TabBtn>
        <TabBtn active={tab === "suggested"} onClick={() => setTab("suggested")} testid="tab-suggested">
          <Wand2 size={14} /> AI Suggestions
        </TabBtn>
        <TabBtn active={tab === "ailogs"} onClick={() => setTab("ailogs")} testid="tab-ailogs">
          <MessageSquare size={14} /> AI Logs
        </TabBtn>
        <TabBtn active={tab === "settings"} onClick={() => setTab("settings")} testid="tab-settings">
          <SettingsIcon size={14} /> Settings
        </TabBtn>
      </div>

      {tab === "inbox"       && <InboxTab cid={currentId} />}
      {tab === "aiaskclient" && <AiAskClientTab cid={currentId} />}
      {tab === "suggested"   && <SuggestedTab cid={currentId} />}
      {tab === "ailogs"      && <AiLogsTab cid={currentId} />}
      {tab === "settings"    && <SettingsTab />}
    </div>
  );
}

function TabBtn({ active, onClick, children, testid }) {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition
        ${active ? "border-cyan-600 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-800"}`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Inbox — audit log of every dispatched email for this company
// ---------------------------------------------------------------------------
function InboxTab({ cid }) {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [testTo, setTestTo] = useState("");
  const load = async () => {
    if (!cid) return;
    setBusy(true);
    try {
      const r = await api.get(`/companies/${cid}/communications?limit=200`);
      setRows(r.data?.items || []);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to load inbox");
    } finally { setBusy(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [cid]);

  const sendTest = async () => {
    if (!testTo.trim()) { toast.error("Enter an email address"); return; }
    setBusy(true);
    try {
      const r = await api.post(`/admin/test-email`, { to: testTo, subject: "Test from Axiom Ledger" });
      toast.success(`Sent — Resend id ${(r.data?.id || "").slice(0, 8)}…`);
      setTestTo("");
      setTimeout(load, 800);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Send failed");
    } finally { setBusy(false); }
  };

  const runAiAskClient = async () => {
    if (!cid) return;
    setBusy(true);
    try {
      const r = await api.post(`/communications/ai-ask-client/run?for_company_id=${cid}`);
      const s = r.data?.details?.[0] || {};
      if (s.status === "sent") toast.success("AI asked the client about a new flagged transaction.");
      else if (s.status === "no_candidates") toast.info("Nothing new to ask about right now.");
      else if (s.status === "daily_cap_reached") toast.info("Daily cap of 3 emails reached for this client.");
      else if (s.status === "pref_off") toast.info("AI Ask Client is off in Settings.");
      else if (s.status === "no_client_email") toast.error("No client email on file for this company.");
      else toast.info(`Result: ${s.status || "no-op"}`);
      setTimeout(load, 600);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Run failed");
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <input
            type="email"
            value={testTo}
            onChange={e => setTestTo(e.target.value)}
            placeholder="Send a test email to…"
            className="text-sm border rounded-md px-3 py-1.5 w-64"
            data-testid="test-email-input"
          />
          <button
            onClick={sendTest}
            disabled={busy || !testTo}
            data-testid="test-email-send"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-cyan-600 text-white hover:bg-cyan-700 disabled:opacity-40"
          >
            <Send size={13} /> Send test
          </button>
        </div>
        <button
          onClick={runAiAskClient}
          disabled={busy}
          data-testid="run-ai-ask-client"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-fuchsia-600 text-white hover:bg-fuchsia-700 disabled:opacity-40"
          title="Trigger the AI Ask Client scheduler for this company now (respects daily cap + pref)"
        >
          <Sparkles size={13} /> Run AI Ask Client now
        </button>
        <button
          onClick={load}
          disabled={busy}
          data-testid="inbox-refresh"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border hover:bg-slate-50"
        >
          <RefreshCw size={13} className={busy ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      <div className="rounded-xl border bg-white overflow-hidden">
        <table className="w-full text-sm" data-testid="inbox-table">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5">Kind</th>
              <th className="px-3 py-2.5">To</th>
              <th className="px-3 py-2.5">Subject</th>
              <th className="px-3 py-2.5">Sent</th>
              <th className="px-3 py-2.5">Resend id</th>
            </tr>
          </thead>
          <tbody>
            {!rows.length && (
              <tr><td colSpan={6} className="text-center py-10 text-slate-500">
                No communications yet for this company.
              </td></tr>
            )}
            {rows.map(r => (
              <tr key={r.id} className="border-b last:border-b-0" data-testid={`inbox-row-${r.id}`}>
                <td className="px-3 py-2.5"><StatusPill status={r.status} /></td>
                <td className="px-3 py-2.5 text-xs">
                  <span className="text-slate-900 font-medium">{KIND_LABELS[r.kind]?.label || r.kind}</span>
                </td>
                <td className="px-3 py-2.5 text-xs text-slate-700 font-mono-num">{r.to}</td>
                <td className="px-3 py-2.5 text-xs text-slate-700">{r.subject}</td>
                <td className="px-3 py-2.5 text-xs text-slate-500 font-mono-num">{(r.sent_at || "").replace("T", " ").slice(0, 16)}</td>
                <td className="px-3 py-2.5 text-xs text-slate-500 font-mono-num">{(r.resend_id || "").slice(0, 12)}{r.resend_id ? "…" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  if (status === "sent") return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
      <CheckCircle2 size={11} /> Sent
    </span>
  );
  if (status === "failed") return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200">
      <XCircle size={11} /> Failed
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
      <MinusCircle size={11} /> Skipped
    </span>
  );
}

// ---------------------------------------------------------------------------
// Settings — per-user toggles for every email kind (all default TRUE)
// ---------------------------------------------------------------------------
function SettingsTab() {
  const [prefs, setPrefs] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.get("/settings/communications").then(r => setPrefs(r.data)).catch(() => setPrefs({}));
  }, []);

  const patch = async (delta) => {
    setSaving(true);
    try {
      const r = await api.put("/settings/communications", delta);
      setPrefs(r.data);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to save");
    } finally { setSaving(false); }
  };

  if (!prefs) return <div className="text-sm text-slate-500 py-8">Loading preferences…</div>;
  return (
    <div className="space-y-3 max-w-2xl">
      <div className="rounded-xl border bg-white p-5 space-y-4">
        <div>
          <div className="text-sm font-semibold text-slate-900">Email flows</div>
          <div className="text-xs text-slate-500 mt-1">
            Turn any flow off to stop the platform from sending it. Attempts that
            were pref-blocked still appear in the Inbox tagged "Skipped".
          </div>
        </div>
        {Object.entries(KIND_LABELS).map(([kind, meta]) => (
          <label
            key={kind}
            data-testid={`pref-row-${kind}`}
            className="flex items-start justify-between gap-4 py-2 border-t first:border-t-0"
          >
            <div className="flex-1">
              <div className="text-sm text-slate-900 font-medium">{meta.label}</div>
              <div className="text-xs text-slate-500">{meta.hint}</div>
            </div>
            <Switch
              on={Boolean(prefs[kind])}
              disabled={saving}
              onChange={(v) => patch({ [kind]: v })}
              testid={`pref-toggle-${kind}`}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function Switch({ on, onChange, disabled, testid }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      data-testid={testid}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition
        ${on ? "bg-cyan-600" : "bg-slate-200"} ${disabled ? "opacity-50" : ""}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition
          ${on ? "translate-x-4" : "translate-x-0.5"}`}
      />
    </button>
  );
}


// ---------------------------------------------------------------------------
// AI Ask Client — dedicated view of every autonomous AI-initiated
// conversation for this company, searchable and with a one-click "Run now"
// button so pros can force the scheduler to fire outside its business-hour
// window.
// ---------------------------------------------------------------------------
function AiAskClientTab({ cid }) {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all"); // all | pending | answered | archived
  const [expanded, setExpanded] = useState({});
  const load = async () => {
    if (!cid) return;
    setBusy(true);
    try {
      const r = await api.get(`/companies/${cid}/communications/ai-logs`);
      const rows = (r.data?.items || []).filter(x => x.flow_type === "ai_ask_client");
      setItems(rows);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to load AI Ask Client log");
    } finally { setBusy(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [cid]);

  const runNow = async () => {
    if (!cid) return;
    setRunning(true);
    try {
      const r = await api.post(`/communications/ai-ask-client/run?for_company_id=${cid}`);
      const s = r.data?.details?.[0] || {};
      if (s.status === "sent") toast.success("AI just emailed the client about a new flagged transaction.");
      else if (s.status === "no_candidates") toast.info("Nothing new for the AI to ask about right now.");
      else if (s.status === "daily_cap_reached") toast.info("Daily cap of 3 emails reached for this client.");
      else if (s.status === "pref_off") toast.info("AI Ask Client is turned off in Settings.");
      else if (s.status === "no_client_email") toast.error("No client email on file for this company.");
      else toast.info(`Result: ${s.status || "no-op"}`);
      setTimeout(load, 700);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Run failed");
    } finally { setRunning(false); }
  };

  const toggleArchive = async (log) => {
    const wasArchived = Boolean(log.archived);
    // Optimistic update — flip the flag right away, roll back on error.
    setItems(prev => prev.map(x => x.id === log.id ? { ...x, archived: !wasArchived } : x));
    try {
      await api.post(
        `/companies/${cid}/communications/questions/${log.id}/archive`,
        { archived: !wasArchived },
      );
      toast.success(wasArchived ? "Restored from archive." : "Archived.");
    } catch (e) {
      setItems(prev => prev.map(x => x.id === log.id ? { ...x, archived: wasArchived } : x));
      toast.error(e.response?.data?.detail || "Archive failed");
    }
  };

  const toggle = (id) => setExpanded(prev => ({ ...prev, [id]: !prev[id] }));

  // Filter semantics:
  //   all      → everything NOT archived (default clean view)
  //   pending  → status=pending, NOT archived
  //   answered → status=answered, NOT archived
  //   archived → ONLY archived (any status)
  const q = query.trim().toLowerCase();
  const filtered = items.filter(x => {
    if (statusFilter === "archived") {
      if (!x.archived) return false;
    } else {
      if (x.archived) return false;
      if (statusFilter !== "all" && x.status !== statusFilter) return false;
    }
    if (!q) return true;
    const hay = [
      x.counterparty_label, x.question, x.answer, x.to_email,
      ...(x.linked_txns || []).map(t => `${t.description} ${t.category_account_name || ""}`),
    ].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  });

  const activeItems = items.filter(x => !x.archived);
  const answered = activeItems.filter(x => x.status === "answered").length;
  const pending = activeItems.filter(x => x.status !== "answered").length;
  const archived = items.filter(x => x.archived).length;

  return (
    <div className="space-y-4" data-testid="aiaskclient-tab">
      <div className="rounded-xl border bg-fuchsia-50/50 border-fuchsia-200 p-4 flex items-start gap-3">
        <Sparkles size={18} className="text-fuchsia-700 mt-0.5" />
        <div className="flex-1">
          <div className="text-sm text-slate-900 font-medium">
            {activeItems.length} AI-initiated conversation{activeItems.length === 1 ? "" : "s"} for this client
            {activeItems.length > 0 && (
              <span className="text-slate-500 font-normal"> · {answered} answered · {pending} awaiting</span>
            )}
            {archived > 0 && (
              <span className="text-slate-500 font-normal"> · {archived} archived</span>
            )}
          </div>
          <div className="text-xs text-slate-600 mt-1">
            The AI autonomously emails this client about new flagged transactions each hour between 6am–8pm ET, max 3 emails per day, one focused transaction per email.
          </div>
        </div>
        <button
          onClick={runNow}
          disabled={running || busy}
          data-testid="aiaskclient-run-now"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-fuchsia-600 text-white hover:bg-fuchsia-700 disabled:opacity-40"
        >
          <Sparkles size={13} className={running ? "animate-pulse" : ""} /> {running ? "Running…" : "Run now"}
        </button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[240px]">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by vendor, question, answer, or email…"
            data-testid="aiaskclient-search"
            className="w-full text-sm border rounded-md pl-8 pr-3 py-1.5"
          />
        </div>
        <div className="flex items-center gap-1 rounded-md border bg-white p-0.5" data-testid="aiaskclient-status-filter">
          {["all", "pending", "answered", "archived"].map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              data-testid={`aiaskclient-filter-${s}`}
              className={`px-2.5 py-1 text-xs rounded capitalize transition
                ${statusFilter === s ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}
            >
              {s}
              {s === "archived" && archived > 0 && (
                <span className={`ml-1 text-[10px] ${statusFilter === s ? "opacity-80" : "text-slate-400"}`}>{archived}</span>
              )}
            </button>
          ))}
        </div>
        <button
          onClick={load}
          disabled={busy}
          data-testid="aiaskclient-refresh"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border hover:bg-slate-50"
        >
          <RefreshCw size={13} className={busy ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      <div className="space-y-2">
        {!filtered.length && !busy && (
          <div className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500" data-testid="aiaskclient-empty">
            {items.length === 0
              ? "No AI Ask Client conversations yet for this client. The scheduler will fire the next time a fresh flagged transaction appears."
              : statusFilter === "archived"
                ? "Nothing archived yet."
                : `No conversations match "${query || statusFilter}".`}
          </div>
        )}
        {filtered.map(log => (
          <AiLogRow
            key={log.id}
            log={log}
            open={expanded[log.id]}
            onToggle={() => toggle(log.id)}
            onArchive={() => toggleArchive(log)}
          />
        ))}
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// AI Suggestions — cluster flagged txns by counterparty and let the pro
// bulk-send one email per cluster.
// ---------------------------------------------------------------------------
function timeAgo(iso) {
  if (!iso) return "";
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

function SuggestedTab({ cid }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [edited, setEdited] = useState({});      // counterparty -> question override
  const [selected, setSelected] = useState({});  // counterparty -> boolean
  const [sending, setSending] = useState(false);

  const load = async ({ force = false } = {}) => {
    if (!cid) return;
    setLoading(true);
    try {
      const url = `/companies/${cid}/communications/ask-client/suggest${force ? "?force_refresh=true" : ""}`;
      const r = await api.post(url, {});
      setData(r.data);
      // Default: every suggestion pre-selected. The pro un-checks anything
      // they don't want to send.
      const s = {};
      (r.data?.suggestions || []).forEach(x => { s[x.counterparty] = true; });
      setSelected(s);
      setEdited({});
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to generate suggestions");
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [cid]);

  const sendOne = async (sug) => {
    setSending(true);
    try {
      const r = await api.post(`/companies/${cid}/communications/ask-client/batch`, {
        txn_ids: sug.txn_ids,
        question: (edited[sug.counterparty] ?? sug.draft_question).trim(),
        counterparty_label: sug.counterparty,
      });
      if (r.data?.status === "skipped_pref_off") {
        toast.info(`Ask-client is off in Settings. Question was recorded but not emailed.`);
      } else {
        toast.success(`Sent — 1 email covering ${sug.count} ${sug.counterparty} txn${sug.count === 1 ? "" : "s"}.`);
      }
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Send failed");
    } finally { setSending(false); }
  };

  const sendAllSelected = async () => {
    const picks = (data?.suggestions || []).filter(s => selected[s.counterparty]);
    if (!picks.length) { toast.error("Nothing selected"); return; }
    setSending(true);
    let ok = 0, fail = 0, skipped = 0;
    for (const sug of picks) {
      try {
        const r = await api.post(`/companies/${cid}/communications/ask-client/batch`, {
          txn_ids: sug.txn_ids,
          question: (edited[sug.counterparty] ?? sug.draft_question).trim(),
          counterparty_label: sug.counterparty,
        });
        if (r.data?.status === "skipped_pref_off") skipped++;
        else ok++;
      } catch {
        fail++;
      }
    }
    setSending(false);
    if (ok) toast.success(`Sent ${ok} email${ok === 1 ? "" : "s"}.${fail ? ` ${fail} failed.` : ""}${skipped ? ` ${skipped} pref-blocked.` : ""}`);
    else if (skipped) toast.info(`All ${skipped} skipped — Ask-client is off in Settings.`);
    else toast.error(`No emails sent — ${fail} failed.`);
    load();
  };

  if (loading) return (
    <div className="py-16 text-center text-sm text-slate-500" data-testid="suggested-loading">
      <Loader2 className="animate-spin mx-auto mb-2" size={20} /> Analyzing flagged transactions…
    </div>
  );
  const suggestions = data?.suggestions || [];
  const selectedCount = suggestions.filter(s => selected[s.counterparty]).length;
  const selectedTxns = suggestions.filter(s => selected[s.counterparty]).reduce((n, s) => n + s.count, 0);

  return (
    <div className="space-y-4" data-testid="suggested-tab">
      <div className="rounded-xl border bg-cyan-50/50 border-cyan-200 p-4 flex items-start gap-3">
        <Sparkles size={18} className="text-cyan-700 mt-0.5" />
        <div className="flex-1">
          <div className="text-sm text-slate-900 font-medium">
            {suggestions.length
              ? <>{suggestions.length} counterparty cluster{suggestions.length === 1 ? "" : "s"} · {data?.flagged_total || 0} flagged txns · {data?.already_asked_total || 0} already asked</>
              : <>No open questions to bundle right now.</>
            }
          </div>
          <div className="text-xs text-slate-600 mt-1">
            AI grouped your flagged transactions by counterparty and drafted a question for each. Edit anything, then send one email per cluster.
            {data?.cached_at && (
              <> · <span title={`Analyzed ${new Date(data.cached_at).toLocaleTimeString()}. Cached 5 min — click Refresh to re-run.`} className="text-slate-400">cached {timeAgo(data.cached_at)}</span></>
            )}
          </div>
        </div>
        <button
          onClick={() => load({ force: true })}
          disabled={loading}
          data-testid="suggested-refresh"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border bg-white hover:bg-slate-50"
          title="Bypass the 5-min cache and re-analyze flagged transactions"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {suggestions.length > 0 && (
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs text-slate-500">
            {selectedCount} of {suggestions.length} selected · {selectedTxns} txns covered
          </div>
          <button
            onClick={sendAllSelected}
            disabled={sending || !selectedCount}
            data-testid="suggested-send-all"
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm rounded-md bg-cyan-600 text-white hover:bg-cyan-700 disabled:opacity-50"
          >
            <Send size={13} /> {sending ? "Sending…" : `Send ${selectedCount} email${selectedCount === 1 ? "" : "s"}`}
          </button>
        </div>
      )}

      <div className="space-y-3">
        {suggestions.map(sug => (
          <SuggestionCard
            key={sug.counterparty}
            sug={sug}
            question={edited[sug.counterparty] ?? sug.draft_question}
            selected={Boolean(selected[sug.counterparty])}
            onToggle={(v) => setSelected(prev => ({ ...prev, [sug.counterparty]: v }))}
            onChangeQuestion={(v) => setEdited(prev => ({ ...prev, [sug.counterparty]: v }))}
            onSendNow={() => sendOne(sug)}
            sending={sending}
          />
        ))}
      </div>
    </div>
  );
}

function SuggestionCard({ sug, question, selected, onToggle, onChangeQuestion, onSendNow, sending }) {
  const [expanded, setExpanded] = useState(sug.count <= 3);
  return (
    <div
      className={`rounded-xl border bg-white p-4 ${selected ? "ring-1 ring-cyan-200" : ""}`}
      data-testid={`suggestion-${sug.counterparty}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 flex-1">
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onToggle(e.target.checked)}
            className="mt-1 accent-cyan-600"
            data-testid={`suggestion-check-${sug.counterparty}`}
          />
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold text-slate-900">{sug.counterparty}</div>
              <span className="text-xs text-slate-500">
                {sug.count} txn{sug.count === 1 ? "" : "s"} · <span className="font-mono-num">{fmtMoney(sug.total)}</span>
              </span>
            </div>
            <textarea
              value={question}
              onChange={(e) => onChangeQuestion(e.target.value)}
              rows={3}
              className="mt-2 w-full text-sm border rounded-md px-3 py-2 bg-slate-50"
              data-testid={`suggestion-question-${sug.counterparty}`}
            />
            <button
              onClick={() => setExpanded(v => !v)}
              className="mt-2 text-xs text-slate-500 hover:text-slate-800"
              data-testid={`suggestion-expand-${sug.counterparty}`}
            >
              {expanded ? "Hide" : "Show"} {sug.count} transaction{sug.count === 1 ? "" : "s"}
            </button>
            {expanded && (
              <div className="mt-2 rounded-md border bg-slate-50 divide-y">
                {sug.sample_txns.map(t => (
                  <div key={t.id} className="grid grid-cols-[110px_1fr_100px] items-center gap-3 px-3 py-1.5 text-xs">
                    <span className="text-slate-500 font-mono-num">{t.date}</span>
                    <span className="text-slate-800 truncate">{t.description}</span>
                    <span className={`text-right font-mono-num ${Number(t.amount) < 0 ? "text-slate-800" : "text-emerald-700 font-semibold"}`}>
                      {fmtMoney(t.amount)}
                    </span>
                  </div>
                ))}
                {sug.count > sug.sample_txns.length && (
                  <div className="px-3 py-1.5 text-xs text-slate-400 italic">
                    …plus {sug.count - sug.sample_txns.length} more
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <button
          onClick={onSendNow}
          disabled={sending}
          data-testid={`suggestion-send-${sug.counterparty}`}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap"
        >
          <Send size={12} /> Send this
        </button>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// AI Logs — every client-chat conversation, with full transcript and the
// transactions it was about. Each row is expandable to see the back-and-
// forth. Answered rows show the resulting category chip; pending rows show
// how long the client's been sitting on it.
// ---------------------------------------------------------------------------
function AiLogsTab({ cid }) {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState({});
  const load = async () => {
    if (!cid) return;
    setBusy(true);
    try {
      const r = await api.get(`/companies/${cid}/communications/ai-logs`);
      setItems(r.data?.items || []);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to load AI logs");
    } finally { setBusy(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [cid]);
  const toggle = (id) => setExpanded(prev => ({ ...prev, [id]: !prev[id] }));

  return (
    <div className="space-y-4" data-testid="ailogs-tab">
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-500">
          {items.length} client-chat conversation{items.length === 1 ? "" : "s"} · linked to transactions on the ledger
        </div>
        <button
          onClick={load}
          disabled={busy}
          data-testid="ailogs-refresh"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border hover:bg-slate-50"
        >
          <RefreshCw size={13} className={busy ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      <div className="space-y-2">
        {!items.length && !busy && (
          <div className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500">
            No conversations yet. Ask a client about a flagged transaction from the Transactions page.
          </div>
        )}
        {items.map(log => (
          <AiLogRow
            key={log.id}
            log={log}
            open={expanded[log.id]}
            onToggle={() => toggle(log.id)}
          />
        ))}
      </div>
    </div>
  );
}

function AiLogRow({ log, open, onToggle, onArchive }) {
  const isAnswered = log.status === "answered";
  const category = log.linked_txns.find(t => t.category_account_name)?.category_account_name;
  const total = log.linked_txns.reduce((s, t) => s + Number(t.amount || 0), 0);
  const isArchived = Boolean(log.archived);
  return (
    <div className={`rounded-xl border bg-white ${isArchived ? "opacity-70" : ""}`} data-testid={`ailog-${log.id}`}>
      <div className="flex items-center gap-1 pr-2">
        <button
          onClick={onToggle}
          className="flex-1 flex items-center gap-3 p-3 text-left hover:bg-slate-50 rounded-l-xl"
          data-testid={`ailog-toggle-${log.id}`}
        >
          {open ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-slate-900">{log.counterparty_label || "Client question"}</span>
              {log.flow_type === "ai_ask_client" ? (
                <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-fuchsia-50 text-fuchsia-800 border border-fuchsia-200" data-testid={`ailog-flow-ai-${log.id}`}>
                  <Sparkles size={10} /> AI Ask Client
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-cyan-50 text-cyan-800 border border-cyan-200" data-testid={`ailog-flow-pro-${log.id}`}>
                  Pro Ask Client
                </span>
              )}
              <span className="text-xs text-slate-500">· {log.txn_count} txn{log.txn_count === 1 ? "" : "s"}</span>
              <span className="text-xs text-slate-500 font-mono-num">· {fmtMoney(Math.abs(total))}</span>
              {isAnswered && category && (
                <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200">
                  <CheckCircle2 size={10} /> {category}
                </span>
              )}
              {!isAnswered && (
                <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">
                  Awaiting client
                </span>
              )}
              {isArchived && (
                <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                  <Archive size={10} /> Archived
                </span>
              )}
            </div>
            <div className="text-xs text-slate-500 mt-0.5 truncate">
              {log.question}
            </div>
          </div>
          <div className="text-xs text-slate-400 font-mono-num whitespace-nowrap">
            {(log.sent_at || "").replace("T", " ").slice(0, 16)}
          </div>
        </button>
        {onArchive && (
          <button
            onClick={(e) => { e.stopPropagation(); onArchive(); }}
            data-testid={`ailog-archive-${log.id}`}
            title={isArchived ? "Restore from archive" : "Archive"}
            className="p-2 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100"
          >
            {isArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          </button>
        )}
      </div>

      {open && (
        <div className="border-t px-4 py-4 space-y-4" data-testid={`ailog-expanded-${log.id}`}>
          <div className="text-xs text-slate-500">
            Asked by <b>{log.asked_by_name || "the pro"}</b> · sent to <span className="font-mono-num">{log.to_email}</span>
            {log.answered_at && <> · answered {log.answered_at.replace("T", " ").slice(0, 16)}</>}
          </div>

          {/* Linked transactions */}
          <div className="rounded-md border bg-slate-50">
            <div className="px-3 py-2 border-b text-xs text-slate-500">
              Linked transactions ({log.txn_count})
            </div>
            <div className="divide-y">
              {log.linked_txns.map(t => (
                <div key={t.id} className="grid grid-cols-[95px_1fr_140px_100px] items-center gap-3 px-3 py-1.5 text-xs">
                  <span className="text-slate-500 font-mono-num">{t.date}</span>
                  <span className="text-slate-800 truncate">{t.description}</span>
                  <span className="text-slate-600 truncate">
                    {t.category_account_name ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700">
                        <CheckCircle2 size={10} /> {t.category_account_name}
                      </span>
                    ) : <em className="text-slate-400">Uncategorized</em>}
                  </span>
                  <span className={`text-right font-mono-num ${Number(t.amount) < 0 ? "text-slate-800" : "text-emerald-700 font-semibold"}`}>
                    {fmtMoney(t.amount)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Chat transcript */}
          <div>
            <div className="text-xs text-slate-500 mb-2">Conversation</div>
            <div className="space-y-2">
              <TranscriptBubble role="ai" content={log.question} label="Original question" />
              {(log.chat_messages || []).map((m, i) => (
                <TranscriptBubble key={i} role={m.role} content={m.content} />
              ))}
              {isAnswered && log.answer && (
                <div className="rounded-md border-l-4 border-emerald-400 bg-emerald-50/50 px-3 py-2 text-xs mt-3">
                  <div className="text-slate-500 uppercase tracking-wide mb-0.5" style={{ fontSize: "10px" }}>Final answer recorded</div>
                  <div className="text-slate-800">{log.answer}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TranscriptBubble({ role, content, label }) {
  const isAi = role === "ai";
  return (
    <div className={`flex items-start gap-2 ${isAi ? "" : "flex-row-reverse"}`}>
      <div className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-white ${isAi ? "bg-cyan-600" : "bg-slate-500"}`}>
        {isAi ? <Bot size={11} /> : <UserIcon size={11} />}
      </div>
      <div
        className={`max-w-[78%] text-xs rounded-lg px-3 py-2 whitespace-pre-wrap leading-relaxed
          ${isAi ? "bg-slate-50 border border-slate-200 text-slate-800" : "bg-cyan-600 text-white"}`}
      >
        {label && <div className="text-[10px] uppercase tracking-wide opacity-70 mb-0.5">{label}</div>}
        {content}
      </div>
    </div>
  );
}

