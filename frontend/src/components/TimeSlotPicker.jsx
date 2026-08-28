import { useMemo, useState, useRef, useEffect } from "react";
import { Clock } from "lucide-react";

/**
 * TimeSlotPicker — Google-Calendar-style time dropdown (Feb 2026).
 *
 * Renders 15-minute slots from 12:00am to 11:45pm in 12-hour
 * display format, but the value passed in/out is 24-hour "HH:MM"
 * (backend-friendly). Optionally shows duration hints next to each
 * slot ("6:30am (30 mins)") when an anchor time is passed — perfect
 * for an end-time picker that echoes Google's UX.
 */
export default function TimeSlotPicker({
  value,               // "HH:MM" 24h, or ""
  onChange,
  anchor = null,       // "HH:MM" — if set, show duration hints
  placeholder = "--",
  testId,
  className = "",
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const h = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const slots = useMemo(() => {
    const out = [];
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 15, 30, 45]) {
        out.push(fmt24(h, m));
      }
    }
    return out;
  }, []);

  const anchorMinutes = anchor ? toMinutes(anchor) : null;

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <button type="button"
              onClick={() => setOpen(v => !v)}
              data-testid={testId}
              className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm bg-white text-left flex items-center gap-1.5 hover:border-slate-400">
        <Clock size={11} className="text-slate-400" />
        <span className={value ? "text-slate-800 font-mono-num" : "text-slate-400"}>
          {value ? format12(value) : placeholder}
        </span>
      </button>
      {open && (
        <div className="absolute z-[120] mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg"
              role="listbox"
              data-testid={testId ? `${testId}-list` : undefined}>
          {slots.map(s => {
            const m = toMinutes(s);
            const dur = (anchorMinutes != null && m > anchorMinutes)
              ? m - anchorMinutes
              : null;
            const isSelected = value === s;
            return (
              <button key={s} type="button"
                      onClick={() => { onChange(s); setOpen(false); }}
                      role="option"
                      aria-selected={isSelected}
                      data-testid={testId ? `${testId}-slot-${s}` : undefined}
                      className={`w-full text-left px-3 py-1.5 text-xs font-mono-num flex items-center justify-between ${
                        isSelected
                          ? "bg-slate-900 text-white"
                          : "text-slate-800 hover:bg-slate-50"
                      }`}>
                <span>{format12(s)}</span>
                {dur != null && (
                  <span className={`text-[10px] ${isSelected ? "text-slate-300" : "text-slate-400"}`}>
                    ({formatDuration(dur)})
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// -------- formatting helpers --------
function fmt24(h, m) {
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
}

export function format12(hhmm) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const period = h < 12 ? "am" : "pm";
  const h12 = ((h + 11) % 12) + 1;
  return m === 0 ? `${h12}:00${period}` : `${h12}:${String(m).padStart(2,"0")}${period}`;
}

export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function formatDuration(mins) {
  if (mins < 60) return `${mins} mins`;
  const h = mins / 60;
  return Number.isInteger(h) ? `${h} ${h === 1 ? "hr" : "hrs"}` : `${h.toFixed(1)} hrs`;
}
