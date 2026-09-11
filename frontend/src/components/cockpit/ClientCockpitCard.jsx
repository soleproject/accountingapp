/**
 * ClientCockpitCard
 *
 * Shared shell for the 4 new Client Cockpit cards. Renders a status
 * row (title + status pill + count + optional inline detail) that
 * expands inline to reveal a full-width panel — exact same pattern
 * as ReconciliationAccountsTile / ReorderAlertsTile on the
 * Responsibilities panel.
 */
import React from "react";
import { ChevronDown, RefreshCw, Loader2 } from "lucide-react";

const STATUS_TONES = {
  green:  "border-emerald-200 bg-emerald-50/40 text-emerald-900",
  amber:  "border-amber-200 bg-amber-50/40 text-amber-900",
  red:    "border-red-200 bg-red-50/40 text-red-900",
  blue:   "border-blue-200 bg-blue-50/40 text-blue-900",
  slate:  "border-slate-200 bg-white text-slate-700",
};

// Hover glow — tone-aware, matches the pattern on ResponsibilitiesPanel
// items so the whole Client Cockpit reads as one visual system.
const HOVER_TONES = {
  green:  "hover:border-emerald-400 hover:shadow-emerald-100 hover:text-emerald-950",
  amber:  "hover:border-amber-400   hover:shadow-amber-100   hover:text-amber-950",
  red:    "hover:border-red-400     hover:shadow-red-100     hover:text-red-950",
  blue:   "hover:border-blue-400    hover:shadow-blue-100    hover:text-blue-950",
  slate:  "hover:border-slate-400   hover:shadow-slate-200   hover:text-slate-950",
};

// Open state — soft ring anchors the expanded card while the user
// reads its inline body.
const OPEN_TONES = {
  green:  "ring-1 ring-emerald-300 shadow-md shadow-emerald-100",
  amber:  "ring-1 ring-amber-300   shadow-md shadow-amber-100",
  red:    "ring-1 ring-red-300     shadow-md shadow-red-100",
  blue:   "ring-1 ring-blue-300    shadow-md shadow-blue-100",
  slate:  "ring-1 ring-slate-300   shadow-md shadow-slate-200",
};

const PILL_TONES = {
  green:  "bg-emerald-100 text-emerald-800 border-emerald-200",
  amber:  "bg-amber-100 text-amber-800 border-amber-200",
  red:    "bg-red-100 text-red-800 border-red-200",
  blue:   "bg-blue-100 text-blue-800 border-blue-200",
  slate:  "bg-slate-100 text-slate-700 border-slate-200",
};

export default function ClientCockpitCard({
  testid,
  icon,
  title,
  subtitle,
  statusLabel,
  statusTone = "slate",
  count,
  countLabel,
  isOpen,
  onToggle,
  onRefresh,
  refreshing = false,
  disabled = false,
  children,
}) {
  return (
    <div
      data-open={isOpen ? "true" : "false"}
      className={[
        "cockpit-card rounded-lg border transition-all duration-200",
        !isOpen && "hover:shadow-md hover:-translate-y-0.5",
        STATUS_TONES[statusTone] || STATUS_TONES.slate,
        HOVER_TONES[statusTone] || HOVER_TONES.slate,
        isOpen && (OPEN_TONES[statusTone] || OPEN_TONES.slate),
      ].filter(Boolean).join(" ")}
      data-testid={testid}
    >
      <div className="p-3 flex items-center gap-3">
        <span className="shrink-0" aria-hidden>{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold flex flex-wrap items-center gap-2">
            <span className="truncate">{title}</span>
            {statusLabel && (
              <span
                className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border font-semibold ${PILL_TONES[statusTone] || PILL_TONES.slate}`}
                data-testid={`${testid}-status`}
              >
                {statusLabel}
              </span>
            )}
            {typeof count === "number" && count > 0 && (
              <span
                className="text-[10px] font-mono-num px-1.5 py-0.5 rounded bg-slate-900 text-white"
                data-testid={`${testid}-count`}
              >
                {count}
              </span>
            )}
          </div>
          {subtitle && (
            <div className="text-[11px] opacity-80 mt-0.5 line-clamp-1" data-testid={`${testid}-subtitle`}>
              {subtitle}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onRefresh && (
            <button
              onClick={onRefresh}
              disabled={refreshing}
              className="text-slate-500 hover:text-slate-900 p-1 rounded disabled:opacity-40"
              title="Refresh"
              data-testid={`${testid}-refresh`}
              aria-label="Refresh"
            >
              <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
            </button>
          )}
          <button
            onClick={onToggle}
            disabled={disabled}
            className="text-[11px] text-slate-700 hover:text-slate-900 inline-flex items-center gap-1 disabled:opacity-40 px-1.5 py-0.5"
            data-testid={`${testid}-toggle`}
          >
            {countLabel}
            {isOpen ? "Hide" : "Open"}
            <ChevronDown size={12} className={`transition-transform ${isOpen ? "rotate-180" : ""}`} />
          </button>
        </div>
      </div>
      {isOpen && (
        <div className="border-t bg-white px-3 py-3" data-testid={`${testid}-body`}>
          {refreshing && !children ? (
            <div className="flex items-center justify-center py-6 text-slate-400">
              <Loader2 size={18} className="animate-spin" />
            </div>
          ) : children}
        </div>
      )}
    </div>
  );
}
