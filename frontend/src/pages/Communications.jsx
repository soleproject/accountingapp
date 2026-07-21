import { useEffect, useState } from "react";
import { useCompany } from "@/lib/company";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  Inbox, Settings as SettingsIcon, Mail, CheckCircle2, XCircle,
  MinusCircle, Send, RefreshCw, ExternalLink, Sparkles,
} from "lucide-react";

const KIND_LABELS = {
  ask_client:            { label: "Ask client",         hint: "Pro asks the client about a transaction" },
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
        <TabBtn active={tab === "settings"} onClick={() => setTab("settings")} testid="tab-settings">
          <SettingsIcon size={14} /> Settings
        </TabBtn>
      </div>

      {tab === "inbox"    && <InboxTab cid={currentId} />}
      {tab === "settings" && <SettingsTab />}
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
