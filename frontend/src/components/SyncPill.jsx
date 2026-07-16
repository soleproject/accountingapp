import { CheckCircle2, Loader2, AlertTriangle } from "lucide-react";
import { TID } from "@/constants/testIds";

/** Human-friendly "5 minutes ago" without pulling in date-fns. */
function timeAgo(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const sec = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

const STAGE_LABEL = {
  downloading: "Downloading from bank",
  categorizing: "Categorizing",
};

/**
 * Compact pill for the Dashboard header. Shows one of three states:
 *   • syncing  — amber, spinner, "Categorizing 1,543 of ~1,900 · 82%"
 *   • idle     — green,  "All caught up · 2 min ago"
 *   • failed   — red,    "Last sync failed"
 * State is driven by GET /companies/{cid}/sync-status.
 */
export default function SyncPill({ status }) {
  if (!status) return null;

  if (status.status === "syncing") {
    const stage = STAGE_LABEL[status.stage] || "Syncing";
    const current = status.imported ?? 0;
    const total = status.target;
    const pct = status.percent;
    return (
      <div
        data-testid={TID.syncPill}
        data-state="syncing"
        className="inline-flex items-center gap-2 pl-2.5 pr-3 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-amber-800 text-xs font-medium"
      >
        <Loader2 size={13} className="animate-spin" />
        <span>
          {stage}
          {total
            ? <> <span className="font-mono-num text-amber-900">{current.toLocaleString()}</span> of ~<span className="font-mono-num text-amber-900">{total.toLocaleString()}</span></>
            : status.stage === "downloading"
              ? "…"
              : <> <span className="font-mono-num">{current.toLocaleString()}</span></>
          }
          {pct !== null && pct !== undefined && (
            <span className="text-amber-600"> · <span className="font-mono-num">{pct}%</span></span>
          )}
        </span>
      </div>
    );
  }

  if (status.status === "idle" && status.last_status === "failed") {
    return (
      <div
        data-testid={TID.syncPill}
        data-state="failed"
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-50 border border-red-200 text-red-700 text-xs font-medium"
      >
        <AlertTriangle size={13} />
        <span>Last sync failed · <span className="text-red-500">{timeAgo(status.last_sync_at)}</span></span>
      </div>
    );
  }

  const ago = timeAgo(status.last_sync_at);
  return (
    <div
      data-testid={TID.syncPill}
      data-state="idle"
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-medium"
    >
      <CheckCircle2 size={13} />
      <span>All caught up{ago ? <> · <span className="text-emerald-600">{ago}</span></> : null}</span>
    </div>
  );
}
