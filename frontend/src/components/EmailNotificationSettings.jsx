import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";

export const EMAIL_KIND_LABELS = {
  ai_ask_client:         { label: "AI Ask Client",      hint: "AI autonomously emails clients about unrecognized transactions (max 3/day per client, one txn per email)" },
  ask_client:            { label: "Pro Ask Client",     hint: "Pro manually asks the client about flagged transactions" },
  daily_pro_digest:      { label: "Daily digest",       hint: "Morning summary of your firm's Needs Attention" },
  dunning:               { label: "A/R dunning",        hint: "Reminders to customers about overdue invoices" },
  overdue_bill_client:   { label: "Overdue A/P",        hint: "Reminders to the client about overdue bills" },
  plaid_reauth:          { label: "Plaid re-auth",      hint: "Alert client when a bank connection expires" },
  onboarding_followup:   { label: "Onboarding nudge",   hint: "Reminder to finish onboarding" },
  month_close_signoff:   { label: "Month-close signoff",hint: "Ask client to sign off on a closed month" },
};

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

// Firm-wide switches for every outbound email flow. Shared by the
// Accounting Settings "Email Notifications Settings" tab.
export const EmailNotificationSettings = () => {
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

  if (!prefs) return <div className="text-sm text-slate-500 py-8" data-testid="email-notif-loading">Loading preferences…</div>;
  return (
    <div className="space-y-3 max-w-2xl" data-testid="email-notification-settings">
      <div className="rounded-xl border bg-white p-5 space-y-4">
        <div>
          <div className="text-sm font-semibold text-slate-900">Email flows</div>
          <div className="text-xs text-slate-500 mt-1">
            Turn any flow off to stop the platform from sending it. Attempts that
            were pref-blocked still appear in the Email log tagged "Skipped".
          </div>
        </div>
        {Object.entries(EMAIL_KIND_LABELS).map(([kind, meta]) => (
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
};
