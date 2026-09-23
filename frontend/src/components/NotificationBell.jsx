import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  Bell, Loader2, CheckCheck, UserPlus, ClipboardCheck,
  TrendingDown, AtSign, Sparkles, AlertTriangle, PartyPopper,
} from "lucide-react";

import { api } from "@/lib/api";

/**
 * NotificationBell — unified top-bar inbox.
 *
 * Merges two backends into one bell so users don't have to check two
 * icons:
 *   - `GET /notifications`  — cross-product feed (task assigns,
 *     mentions, stale-deal nudges, etc). USER-scoped.
 *   - `GET /pro/alerts`     — high-priority operational alerts,
 *     currently emitted by the Stripe webhook when a client's payment
 *     fails. Silently 403s for non-pro users, which is fine — the
 *     Alerts section just stays hidden.
 *
 * Alerts render as a distinct top section (red accent) above the
 * general Notifications list. The bell's badge sums unread from both
 * feeds so nothing hides.
 */
const ICONS = {
  task_assigned:      UserPlus,
  timesheet_approval: ClipboardCheck,
  stale_deal:         TrendingDown,
  mention:            AtSign,
  system:             Sparkles,
  payment_received:   PartyPopper,
};
const TONES = {
  task_assigned:      "text-cyan-600 bg-cyan-50",
  timesheet_approval: "text-emerald-600 bg-emerald-50",
  stale_deal:         "text-amber-600 bg-amber-50",
  mention:            "text-violet-600 bg-violet-50",
  system:             "text-slate-500 bg-slate-100",
  payment_received:   "text-emerald-700 bg-emerald-100",
};

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [alerts, setAlerts] = useState([]);
  const [alertsUnread, setAlertsUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const btnRef = useRef(null);
  const popRef = useRef(null);

  const load = async () => {
    setLoading(true);
    // Fire both feeds in parallel. Pro-alerts 403s for client users —
    // we treat that as "no alerts" without noise.
    const [nR, aR] = await Promise.allSettled([
      api.get(`/notifications?limit=25`),
      api.get(`/pro/alerts`),
    ]);
    if (nR.status === "fulfilled") {
      setItems(nR.value.data?.notifications || []);
      setUnread(nR.value.data?.unread_count || 0);
    }
    if (aR.status === "fulfilled") {
      setAlerts(aR.value.data?.items || []);
      setAlertsUnread(aR.value.data?.unread || 0);
    } else {
      setAlerts([]); setAlertsUnread(0);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!open) return;
    const h = (e) => {
      if (popRef.current?.contains(e.target)) return;
      if (btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const markRead = async (n) => {
    if (n.virtual || n.read) return;
    setItems(cur => cur.map(x => x.id === n.id ? { ...x, read: true } : x));
    setUnread(u => Math.max(0, u - 1));
    try { await api.post(`/notifications/${n.id}/read`); } catch { /* silent */ }
  };
  const markAlertRead = async (a) => {
    if (!a.unread) return;
    setAlerts(cur => cur.map(x => x.id === a.id ? { ...x, unread: false } : x));
    setAlertsUnread(u => Math.max(0, u - 1));
    try { await api.post(`/pro/alerts/${a.id}/read`); } catch { load(); }
  };
  const markAllRead = async () => {
    // Fire both mark-all endpoints in parallel so one click clears
    // the combined badge.
    try {
      const calls = [];
      if (unread > 0)       calls.push(api.post(`/notifications/mark-all-read`));
      if (alertsUnread > 0) calls.push(api.post(`/pro/alerts/read-all`));
      await Promise.allSettled(calls);
      toast.success("All caught up");
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  const totalUnread = unread + alertsUnread;
  const isEmpty = !loading && items.length === 0 && alerts.length === 0;

  return (
    <div className="relative">
      <button ref={btnRef}
              onClick={() => setOpen(v => !v)}
              data-testid="notification-bell"
              title="Notifications"
              className="relative p-2 rounded-md hover:bg-slate-100 text-slate-600">
        <Bell size={16} />
        {totalUnread > 0 && (
          <span data-testid="notification-bell-badge"
                className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] rounded-full bg-rose-500 text-white text-[10px] font-semibold flex items-center justify-center px-1">
            {totalUnread > 99 ? "99+" : totalUnread}
          </span>
        )}
      </button>
      {open && (
        <div ref={popRef}
              data-testid="notification-panel"
              className="absolute right-0 top-full mt-2 w-96 rounded-lg border border-slate-200 bg-white shadow-xl z-[1001] max-h-[70vh] flex flex-col">
          <div className="px-4 py-3 border-b flex items-center justify-between">
            <div>
              <div className="font-heading font-bold text-sm text-slate-900">
                Notifications
              </div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">
                {totalUnread === 0 ? "All caught up" : `${totalUnread} unread`}
              </div>
            </div>
            {totalUnread > 0 && (
              <button onClick={markAllRead}
                      data-testid="notification-mark-all"
                      className="text-[11px] text-violet-600 hover:underline inline-flex items-center gap-1">
                <CheckCheck size={11} /> Mark all read
              </button>
            )}
          </div>
          <div className="overflow-y-auto flex-1">
            {loading && items.length === 0 && alerts.length === 0 && (
              <div className="flex justify-center py-8 text-slate-400">
                <Loader2 size={16} className="animate-spin" />
              </div>
            )}

            {alerts.length > 0 && (
              <div>
                <div className="px-4 py-1.5 bg-rose-50/60 border-b border-rose-100 flex items-center gap-1.5">
                  <AlertTriangle size={11} className="text-rose-600" />
                  <span className="text-[10px] uppercase tracking-wider font-semibold text-rose-700">
                    Alerts {alertsUnread > 0 && `· ${alertsUnread}`}
                  </span>
                </div>
                <div className="divide-y divide-slate-100">
                  {alerts.map(a => (
                    <AlertRow key={a.id} alert={a}
                              onRead={() => markAlertRead(a)}
                              onNavigate={() => setOpen(false)} />
                  ))}
                </div>
              </div>
            )}

            {items.length > 0 && (
              <div>
                {alerts.length > 0 && (
                  <div className="px-4 py-1.5 bg-slate-50 border-b border-slate-100">
                    <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-500">
                      Notifications
                    </span>
                  </div>
                )}
                <div className="divide-y divide-slate-100">
                  {items.map(n => (
                    <NotifRow key={n.id} n={n} onMark={markRead}
                              onNavigate={() => setOpen(false)} />
                  ))}
                </div>
              </div>
            )}

            {isEmpty && (
              <div className="text-center py-10 text-xs text-slate-400 italic">
                Nothing here yet. Get to work and this will fill up.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Notification row (also reused by the home widget) -------
export function NotifRow({ n, onMark, onNavigate, compact = false }) {
  const Icon = ICONS[n.kind] || Sparkles;
  const tone = TONES[n.kind] || TONES.system;
  const body = (
    <>
      <div className={`w-7 h-7 rounded-full ${tone} flex items-center justify-center shrink-0`}>
        <Icon size={12} />
      </div>
      <div className="flex-1 min-w-0">
        <div className={`text-xs ${n.read ? "text-slate-500" : "text-slate-800 font-medium"} line-clamp-2`}>
          {n.title}
        </div>
        {n.body && (
          <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-1">
            {n.body}
          </div>
        )}
        <div className="text-[10px] text-slate-400 mt-0.5">
          {relTime(n.created_at)}
          {n.virtual && " · auto"}
        </div>
      </div>
      {!n.read && !n.virtual && (
        <span className="w-1.5 h-1.5 rounded-full bg-violet-500 shrink-0 mt-2" />
      )}
    </>
  );
  const cls = `flex items-start gap-3 ${compact ? "py-2" : "px-4 py-3"} ${
    n.read ? "" : "bg-violet-50/40"
  } hover:bg-slate-50 transition cursor-pointer`;
  if (n.link) {
    return (
      <Link to={n.link}
            onClick={() => { onMark?.(n); onNavigate?.(); }}
            data-testid={`notification-${n.kind}-${n.id}`}
            className={cls}>
        {body}
      </Link>
    );
  }
  return (
    <div onClick={() => onMark?.(n)}
          data-testid={`notification-${n.kind}-${n.id}`}
          className={cls}>
      {body}
    </div>
  );
}

// ---- Alert row (Stripe payment-failed + friends) -------------
function AlertRow({ alert, onRead, onNavigate }) {
  const isFail = alert.kind === "payment_failed" || alert.kind === "enterprise_payment_failed";
  const href = "/pro/clients";
  return (
    <Link to={href}
          onClick={() => { onRead(); onNavigate(); }}
          data-testid={`pro-alert-row-${alert.id}`}
          className={`flex items-start gap-3 px-4 py-3 hover:bg-slate-50 transition ${alert.unread ? "bg-rose-50/40" : ""}`}>
      <div className={`w-7 h-7 rounded-full ${isFail ? "text-rose-600 bg-rose-50" : "text-cyan-600 bg-cyan-50"} flex items-center justify-center shrink-0`}>
        <AlertTriangle size={12} />
      </div>
      <div className="flex-1 min-w-0">
        <div className={`text-xs ${alert.unread ? "text-slate-800 font-medium" : "text-slate-500"} leading-snug line-clamp-2`}>
          {alert.message}
        </div>
        <div className="text-[10px] text-slate-400 mt-0.5">{relTime(alert.created_at)}</div>
      </div>
      {alert.unread && (
        <span className="w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0 mt-2" />
      )}
    </Link>
  );
}

function relTime(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Math.max(0, (Date.now() - t) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 30 * 86400) return `${Math.floor(diff / 86400)}d ago`;
  const mo = Math.floor(diff / (30 * 86400));
  return mo < 12 ? `${mo}mo ago` : `${Math.floor(mo / 12)}y ago`;
}
