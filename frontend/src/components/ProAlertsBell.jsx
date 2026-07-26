// ProAlertsBell — small bell icon in the top header (Pro / Superadmin
// only) that shows a red dot when the current user has unread alerts.
// Clicking opens a popover with the last 50 alerts and a "Mark all
// read" action. Backed by GET /api/pro/alerts (list + unread count).
//
// Emitted by /api/stripe/webhook when a client's payment fails — see
// _handle_invoice_payment_failed in routes/stripe_billing.py.
import { useEffect, useRef, useState } from "react";
import { Bell, CheckCheck, Loader2 } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";

const POLL_MS = 60_000; // once/min is plenty — alerts are rare

export default function ProAlertsBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef(null);
  const wrapRef = useRef(null);

  const fetchAlerts = async () => {
    try {
      const r = await api.get("/pro/alerts");
      setItems(r.data.items || []);
      setUnread(r.data.unread || 0);
    } catch {
      /* Silent — 403 for client roles is expected */
    }
  };

  useEffect(() => {
    fetchAlerts();
    timerRef.current = setInterval(fetchAlerts, POLL_MS);
    return () => timerRef.current && clearInterval(timerRef.current);
  }, []);

  // Close popover on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const markOne = async (id) => {
    setItems((prev) => prev.map((a) => (a.id === id ? { ...a, unread: false } : a)));
    setUnread((n) => Math.max(0, n - 1));
    try { await api.post(`/pro/alerts/${id}/read`); } catch { /* refetch on error */ fetchAlerts(); }
  };
  const markAll = async () => {
    setBusy(true);
    try {
      await api.post("/pro/alerts/read-all");
      setItems((prev) => prev.map((a) => ({ ...a, unread: false })));
      setUnread(0);
    } finally { setBusy(false); }
  };

  return (
    <div className="relative" ref={wrapRef} data-testid="pro-alerts-bell">
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative p-2 rounded-full hover:bg-slate-100 transition"
        title={unread > 0 ? `${unread} unread alert${unread === 1 ? "" : "s"}` : "Alerts"}
        data-testid="pro-alerts-trigger"
      >
        <Bell size={17} className="text-slate-600" />
        {unread > 0 && (
          <span
            className="absolute top-1 right-1 min-w-[16px] h-[16px] rounded-full bg-red-600 text-white text-[10px] font-semibold px-1 flex items-center justify-center"
            data-testid="pro-alerts-badge"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 w-96 max-w-[calc(100vw-32px)] rounded-lg border bg-white shadow-2xl z-50"
          data-testid="pro-alerts-panel"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b">
            <div>
              <div className="text-sm font-semibold text-slate-900">Alerts</div>
              <div className="text-[11px] text-slate-500">
                {unread > 0 ? `${unread} unread` : "You're all caught up"}
              </div>
            </div>
            {unread > 0 && (
              <button
                onClick={markAll}
                disabled={busy}
                data-testid="pro-alerts-mark-all"
                className="inline-flex items-center gap-1 text-[11px] font-medium text-cyan-700 hover:text-cyan-900 disabled:opacity-50"
              >
                {busy ? <Loader2 size={11} className="animate-spin" /> : <CheckCheck size={12} />}
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-slate-500">
                No alerts yet. When a client's payment fails or something needs your attention, it'll show up here.
              </div>
            ) : (
              items.map((a) => (
                <AlertRow key={a.id} alert={a} onRead={() => markOne(a.id)} onClose={() => setOpen(false)} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AlertRow({ alert, onRead, onClose }) {
  const isFail = alert.kind === "payment_failed" || alert.kind === "enterprise_payment_failed";
  const href = alert.company_id ? `/pro/clients` : "/pro/clients";
  const when = formatTimeAgo(alert.created_at);
  return (
    <Link
      to={href}
      onClick={() => { onRead(); onClose(); }}
      className={`block px-4 py-3 border-b last:border-b-0 hover:bg-slate-50 transition ${alert.unread ? "bg-red-50/40" : ""}`}
      data-testid={`pro-alert-row-${alert.id}`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${alert.unread ? (isFail ? "bg-red-500" : "bg-cyan-500") : "bg-slate-300"}`}
        />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-slate-900 leading-snug">
            {alert.message}
          </div>
          <div className="text-[10px] text-slate-500 mt-1">{when}</div>
        </div>
      </div>
    </Link>
  );
}

function formatTimeAgo(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return d.toLocaleDateString();
}
