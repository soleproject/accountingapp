/**
 * NotificationSettings — /settings/notifications (Feb 2026, PWA Phase 1).
 *
 * One page combines:
 *   - Install-app CTA (via InstallPromptCard — hidden when installed)
 *   - Push permission state (grant / revoke)
 *   - Per-category mutes (task assigned, mention, bill due, anomaly, etc.)
 *   - Device count + test-send button
 *
 * The category list mirrors `_KINDS` in `routes/notifications.py`.
 */

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  getPushPermission, hasActiveSubscription, subscribeToPush,
  unsubscribeFromPush,
} from "@/lib/pwa";
import { InstallPromptCard } from "@/components/InstallPrompt";
import { Bell, BellOff, Send, Loader2, ShieldAlert, CheckCircle2 } from "lucide-react";

const CATEGORIES = [
  { key: "task_assigned",     label: "Tasks assigned to me",
    hint: "When a teammate assigns you a task or reassigns one you own." },
  { key: "mention",           label: "@mentions in chat",
    hint: "When someone mentions you in the AI chat, a deal note, or a client thread." },
  { key: "bill_due",          label: "Bills due soon or overdue",
    hint: "A vendor bill hits its due date or goes past due." },
  { key: "anomaly",           label: "Anomalies + large transactions",
    hint: "AI flags an unusual transaction, a duplicate, or a category that broke a rule." },
  { key: "timesheet_approval",label: "Timesheets needing approval",
    hint: "A staff member submits a timesheet you're the reviewer for." },
  { key: "stale_deal",        label: "Deals gone quiet",
    hint: "One of your open deals hasn't had activity in 14+ days." },
  { key: "system",            label: "Product announcements",
    hint: "Occasional platform news — new features, planned maintenance." },
];

export default function NotificationSettings() {
  const [permission, setPermission] = useState("default");
  const [subscribed, setSubscribed] = useState(false);
  const [prefs, setPrefs] = useState(null);
  const [deviceCount, setDeviceCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = async () => {
    setPermission(await getPushPermission());
    setSubscribed(await hasActiveSubscription());
    try {
      const r = await api.get("/pwa/preferences");
      setPrefs(r.data.categories);
      setDeviceCount(r.data.device_count || 0);
    } catch (e) {
      console.warn("prefs load failed", e);
    }
  };
  useEffect(() => { load(); }, []);

  const enable = async () => {
    setBusy(true);
    try {
      const r = await subscribeToPush();
      if (r.ok) toast.success("Push notifications enabled");
      else if (r.reason === "denied")
        toast.error("Notifications blocked — enable in your browser settings.");
      else toast.error(`Could not enable: ${r.reason}`);
      await load();
    } catch (e) {
      toast.error(e.message || "Failed to subscribe");
    } finally { setBusy(false); }
  };

  const disable = async () => {
    setBusy(true);
    try {
      await unsubscribeFromPush();
      toast.success("Push notifications disabled on this device");
      await load();
    } catch (e) {
      toast.error(e.message || "Failed to unsubscribe");
    } finally { setBusy(false); }
  };

  const toggleCategory = async (key, value) => {
    const next = { ...prefs, [key]: value };
    setPrefs(next);                                  // optimistic
    try {
      await api.patch("/pwa/preferences", { categories: { [key]: value } });
    } catch (e) {
      toast.error("Failed to save preference");
      setPrefs(prefs);                               // rollback
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const r = await api.post("/pwa/test");
      if (r.data.delivered > 0) {
        toast.success(`Test sent to ${r.data.delivered} device(s) — check your notification tray.`);
      } else {
        toast.info("No devices to send to yet. Enable push above first.");
      }
    } catch (e) {
      toast.error("Test send failed");
    } finally { setTesting(false); }
  };

  return (
    <div className="max-w-3xl space-y-6" data-testid="notification-settings">
      <div>
        <h1 className="font-heading text-2xl font-bold flex items-center gap-2">
          <Bell className="text-cyan-600" size={20} />
          Notifications
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Install the app on your phone and choose which alerts show up on your lock screen.
        </p>
      </div>

      <InstallPromptCard />

      {/* Push permission block. */}
      <div className="rounded-xl border bg-white p-5 space-y-3" data-testid="push-permission-block">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-heading font-semibold text-sm">Push notifications on this device</h2>
            <p className="text-xs text-slate-500 mt-0.5 leading-snug">
              {permission === "granted" && subscribed && `Enabled · ${deviceCount} device${deviceCount === 1 ? "" : "s"} total`}
              {permission === "granted" && !subscribed && "Permission granted but no active subscription. Click Enable to complete setup."}
              {permission === "default" && "Turn on to receive notifications when your bills are due, a task is assigned, or an anomaly is detected."}
              {permission === "denied" && "Blocked in browser settings. Click the lock icon in your address bar to allow."}
              {permission === "unsupported" && "This browser doesn't support push notifications."}
            </p>
          </div>
          <div>
            {subscribed ? (
              <button onClick={disable} disabled={busy}
                      data-testid="disable-push-btn"
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-slate-300 hover:bg-slate-50 text-xs font-medium disabled:opacity-50">
                {busy ? <Loader2 size={12} className="animate-spin" /> : <BellOff size={12} />}
                Disable
              </button>
            ) : (
              <button onClick={enable} disabled={busy || permission === "denied" || permission === "unsupported"}
                      data-testid="enable-push-btn"
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold disabled:opacity-40">
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Bell size={12} />}
                Enable
              </button>
            )}
          </div>
        </div>
        {permission === "denied" && (
          <div className="text-xs bg-amber-50 border border-amber-200 rounded-md p-2 flex items-start gap-2">
            <ShieldAlert size={14} className="text-amber-600 shrink-0 mt-0.5" />
            <span className="text-amber-800">To re-enable, click the lock icon in your browser's address bar → Notifications → Allow, then refresh this page.</span>
          </div>
        )}
        {subscribed && (
          <button onClick={sendTest} disabled={testing}
                  data-testid="send-test-btn"
                  className="text-xs inline-flex items-center gap-1 text-cyan-700 hover:text-cyan-900 font-medium disabled:opacity-50">
            {testing ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
            Send test notification
          </button>
        )}
      </div>

      {/* Category toggles. */}
      <div className="rounded-xl border bg-white p-5 space-y-2">
        <h2 className="font-heading font-semibold text-sm mb-2">What should notify me?</h2>
        {!prefs ? (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Loader2 size={12} className="animate-spin" /> Loading preferences…
          </div>
        ) : (
          <div className="divide-y">
            {CATEGORIES.map(c => (
              <label key={c.key}
                     data-testid={`pref-${c.key}`}
                     className="flex items-start justify-between gap-4 py-3 cursor-pointer">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-slate-900">{c.label}</div>
                  <div className="text-xs text-slate-500 mt-0.5 leading-snug">{c.hint}</div>
                </div>
                <Toggle checked={!!prefs[c.key]}
                        onChange={(v) => toggleCategory(c.key, v)}
                        testid={`toggle-${c.key}`} />
              </label>
            ))}
          </div>
        )}
        <div className="text-xs text-slate-400 mt-2 italic">
          Category mutes apply to both push (phone) and in-app (bell dropdown) notifications.
        </div>
      </div>
    </div>
  );
}

/* --- Tiny toggle switch used only here. ------------------------------ */

function Toggle({ checked, onChange, testid }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      data-testid={testid}
      role="switch"
      aria-checked={checked}
      className={`w-10 h-6 rounded-full transition-colors shrink-0 relative ${checked ? "bg-cyan-600" : "bg-slate-300"}`}
    >
      <span className={`block w-5 h-5 rounded-full bg-white shadow-md transition-transform absolute top-0.5 ${checked ? "translate-x-4" : "translate-x-0.5"}`} />
    </button>
  );
}
