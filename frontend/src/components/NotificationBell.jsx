import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  Bell, Loader2, Check, CheckCheck, UserPlus, ClipboardCheck,
  Clock, TrendingDown, AtSign, Sparkles,
} from "lucide-react";

import { api } from "@/lib/api";

/**
 * NotificationBell — top-bar affordance for the cross-product feed.
 *
 * The feed is USER-scoped, not company-scoped, so a Pro who manages
 * multiple books gets one unified inbox. Server auto-computes stale
 * deal nudges live (no scheduler needed for MVP) — those are
 * "virtual" and can't be marked read: they just disappear once the
 * user touches the underlying deal.
 */
const ICONS = {
  task_assigned:      UserPlus,
  timesheet_approval: ClipboardCheck,
  stale_deal:         TrendingDown,
  mention:            AtSign,
  system:             Sparkles,
};
const TONES = {
  task_assigned:      "text-cyan-600 bg-cyan-50",
  timesheet_approval: "text-emerald-600 bg-emerald-50",
  stale_deal:         "text-amber-600 bg-amber-50",
  mention:            "text-violet-600 bg-violet-50",
  system:             "text-slate-500 bg-slate-100",
};

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const btnRef = useRef(null);
  const popRef = useRef(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get(`/notifications?limit=25`);
      setItems(r.data?.notifications || []);
      setUnread(r.data?.unread_count || 0);
    } catch { /* silent — bell shouldn't spam toasts */ }
    finally { setLoading(false); }
  };

  useEffect(() => {
    load();
    // Poll every 60s so pending approvals surface without a reload.
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  // Close on outside click.
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
    try {
      await api.post(`/notifications/${n.id}/read`);
    } catch { /* silent */ }
  };
  const markAllRead = async () => {
    try {
      await api.post(`/notifications/mark-all-read`);
      toast.success("All caught up");
      await load();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  return (
    <div className="relative">
      <button ref={btnRef}
              onClick={() => setOpen(v => !v)}
              data-testid="notification-bell"
              title="Notifications"
              className="relative p-2 rounded-md hover:bg-slate-100 text-slate-600">
        <Bell size={16} />
        {unread > 0 && (
          <span data-testid="notification-bell-badge"
                className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] rounded-full bg-rose-500 text-white text-[10px] font-semibold flex items-center justify-center px-1">
            {unread > 99 ? "99+" : unread}
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
                {unread === 0 ? "All caught up"
                  : `${unread} unread`}
              </div>
            </div>
            {unread > 0 && (
              <button onClick={markAllRead}
                      data-testid="notification-mark-all"
                      className="text-[11px] text-violet-600 hover:underline inline-flex items-center gap-1">
                <CheckCheck size={11} /> Mark all read
              </button>
            )}
          </div>
          <div className="overflow-y-auto flex-1 divide-y divide-slate-100">
            {loading && items.length === 0 && (
              <div className="flex justify-center py-8 text-slate-400">
                <Loader2 size={16} className="animate-spin" />
              </div>
            )}
            {!loading && items.length === 0 && (
              <div className="text-center py-10 text-xs text-slate-400 italic">
                Nothing here yet. Get to work and this will fill up.
              </div>
            )}
            {items.map(n => (
              <NotifRow key={n.id} n={n} onMark={markRead}
                        onNavigate={() => setOpen(false)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Row (also reused by the home widget) --------------------
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
