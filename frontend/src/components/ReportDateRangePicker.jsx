import { useState, useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";

/**
 * Preset-driven date-range picker for the Reports pages.
 *
 * Mirrors QBO's own report-date UX so bookkeepers switching between
 * Axiom and QBO don't have to relearn. Two report shapes are handled:
 *
 * * `period` (P&L, Cash Flow, GL): start + end presets like
 *   "This Month", "YTD", "Last 12 Months".
 * * `point-in-time` (Balance Sheet): end-only presets like "Today",
 *   "End of Last Month", "End of Last Year".
 *
 * Custom stays available as the last option; picking it reveals
 * the raw date inputs. Feb 28 2026.
 */

const iso = (d) => d.toISOString().slice(0, 10);
const startOf = {
  month: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); },
  quarter: () => {
    const d = new Date();
    return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1);
  },
  year: () => { const d = new Date(); return new Date(d.getFullYear(), 0, 1); },
};
const endOf = {
  lastMonth: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 0); },
  lastQuarter: () => {
    const d = new Date();
    const q = Math.floor(d.getMonth() / 3);
    return new Date(d.getFullYear(), q * 3, 0);
  },
  lastYear: () => new Date(new Date().getFullYear(), 0, 0),
};

/** Period presets: return `{start, end}` for the given key. */
const PERIOD_PRESETS = {
  "this-month":      () => ({ start: iso(startOf.month()),                     end: iso(new Date()) }),
  "last-month":      () => {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last = new Date(now.getFullYear(), now.getMonth(), 0);
    return { start: iso(first), end: iso(last) };
  },
  "this-quarter":    () => ({ start: iso(startOf.quarter()),                   end: iso(new Date()) }),
  "last-quarter":    () => {
    const now = new Date();
    const q = Math.floor(now.getMonth() / 3);
    const first = new Date(now.getFullYear(), (q - 1) * 3, 1);
    const last = new Date(now.getFullYear(), q * 3, 0);
    return { start: iso(first), end: iso(last) };
  },
  "this-year":       () => ({ start: iso(startOf.year()),                      end: iso(new Date()) }),
  "last-year":       () => {
    const y = new Date().getFullYear() - 1;
    return { start: `${y}-01-01`, end: `${y}-12-31` };
  },
  "last-12-months":  () => {
    const now = new Date();
    return { start: iso(new Date(now.getFullYear(), now.getMonth() - 11, 1)),
              end: iso(now) };
  },
  "all-time":        () => ({ start: "2000-01-01", end: iso(new Date()) }),
};

/** Point-in-time (Balance Sheet) presets: return `{end}` only. */
const POINT_PRESETS = {
  "today":                     () => ({ end: iso(new Date()) }),
  "end-of-last-month":         () => ({ end: iso(endOf.lastMonth()) }),
  "end-of-last-quarter":       () => ({ end: iso(endOf.lastQuarter()) }),
  "end-of-last-year":          () => ({ end: iso(endOf.lastYear()) }),
};

const PERIOD_LABELS = [
  ["this-month",     "This Month"],
  ["last-month",     "Last Month"],
  ["this-quarter",   "This Quarter"],
  ["last-quarter",   "Last Quarter"],
  ["this-year",      "This Year (YTD)"],
  ["last-year",      "Last Year"],
  ["last-12-months", "Last 12 Months"],
  ["all-time",       "All Time"],
];
const POINT_LABELS = [
  ["today",                "Today"],
  ["end-of-last-month",    "End of Last Month"],
  ["end-of-last-quarter",  "End of Last Quarter"],
  ["end-of-last-year",     "End of Last Year"],
];

/** Best-effort reverse lookup: does the current {start, end} pair
 *  match a known preset? If yes we'll show its label; otherwise we
 *  show "Custom". Callers pass their `mode` so we don't compare
 *  period-preset dates on a BS view. */
function detectPreset(mode, start, end) {
  const presets = mode === "point" ? POINT_PRESETS : PERIOD_PRESETS;
  for (const key of Object.keys(presets)) {
    const p = presets[key]();
    if (mode === "point") {
      if (p.end === end) return key;
    } else if (p.start === start && p.end === end) {
      return key;
    }
  }
  return "custom";
}

export default function ReportDateRangePicker({
  mode = "period",     // "period" | "point"
  start, end, onChange, // onChange({start?, end}) — start only for period
  testId = "report-date-range",
}) {
  const isPoint = mode === "point";
  const options = isPoint ? POINT_LABELS : PERIOD_LABELS;
  const presets = isPoint ? POINT_PRESETS : PERIOD_PRESETS;

  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(() => detectPreset(mode, start, end));
  const ref = useRef(null);

  // Re-detect when parent's dates change externally (URL param,
  // programmatic navigation, etc.). Keeps the label truthful.
  useEffect(() => {
    setSelected(detectPreset(mode, start, end));
  }, [mode, start, end]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const pick = (key) => {
    setSelected(key);
    setOpen(false);
    if (key === "custom") return;  // Reveal raw inputs; leave dates untouched.
    const p = presets[key]();
    onChange(p);
  };

  const labelFor = (key) => {
    if (key === "custom") return "Custom";
    return (options.find(([k]) => k === key) || [])[1] || "Custom";
  };

  return (
    <div className="inline-flex items-center gap-2" ref={ref}>
      {/* Preset dropdown */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((s) => !s)}
          data-testid={`${testId}-preset`}
          className="inline-flex items-center gap-1.5 border rounded px-2.5 py-1 text-xs bg-white hover:bg-slate-50 min-w-[9rem] justify-between"
        >
          <span>{labelFor(selected)}</span>
          <ChevronDown size={12} className="text-slate-500" />
        </button>
        {open && (
          <div
            className="absolute z-20 mt-1 w-52 rounded-md border border-slate-200 bg-white shadow-lg py-1"
            role="listbox"
          >
            {options.map(([key, label]) => (
              <button
                key={key}
                onClick={() => pick(key)}
                data-testid={`${testId}-option-${key}`}
                className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 ${selected === key ? "text-slate-900 font-medium bg-slate-50" : "text-slate-700"}`}
              >
                {label}
              </button>
            ))}
            <div className="my-1 border-t border-slate-100" />
            <button
              onClick={() => pick("custom")}
              data-testid={`${testId}-option-custom`}
              className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 ${selected === "custom" ? "text-slate-900 font-medium bg-slate-50" : "text-slate-700"}`}
            >
              Custom…
            </button>
          </div>
        )}
      </div>

      {/* Custom mode: reveal raw inputs. Balance Sheet is
          point-in-time (only `end` drives the report), but users
          still expect a start/end pair — it lets them think in
          "period" terms and keeps the UX identical across all
          report types. The BS engine safely ignores `start` when
          computing the point-in-time snapshot. Feb 28 2026. */}
      {selected === "custom" && (
        <>
          <input
            type="date"
            value={start || ""}
            data-testid={`${testId}-custom-start`}
            onChange={(e) => onChange({ start: e.target.value, end })}
            className="border rounded px-2 py-1 text-xs"
          />
          <input
            type="date"
            value={end || ""}
            data-testid={`${testId}-custom-end`}
            onChange={(e) => onChange({ start, end: e.target.value })}
            className="border rounded px-2 py-1 text-xs"
          />
        </>
      )}
    </div>
  );
}
