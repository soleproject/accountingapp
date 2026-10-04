import React from "react";
import { Sparkles } from "lucide-react";

export const TONE = {
  ok:    "bg-emerald-50 text-emerald-700 border-emerald-200",
  warn:  "bg-amber-50 text-amber-700 border-amber-200",
  bad:   "bg-rose-50 text-rose-700 border-rose-200",
  mute:  "bg-slate-100 text-slate-600 border-slate-200",
  brand: "bg-primary/10 text-primary border-primary/20",
};

export function Pill({ tone = "mute", children, className = "", ...rest }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full border ${TONE[tone] || TONE.mute} ${className}`} {...rest}>
      {children}
    </span>
  );
}

export function Card({ eyebrow, title, tag, children, className = "", ...rest }) {
  return (
    <div className={`relative bg-white border border-slate-200 rounded-2xl p-6 ${className}`} {...rest}>
      {tag && <div className="absolute top-4 right-4">{tag}</div>}
      {eyebrow && <div className="text-[10px] tracking-[0.12em] uppercase text-slate-500 font-semibold mb-1.5">{eyebrow}</div>}
      {title && <h2 className="font-heading text-xl text-slate-900 mb-4 pr-36">{title}</h2>}
      {children}
    </div>
  );
}

export function Why({ children, testId }) {
  if (!children) return null;
  return (
    <div className="mt-4 flex gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-[13px] text-slate-700" data-testid={testId}>
      <span className="flex-none w-6 h-6 rounded-md bg-primary/10 text-primary grid place-items-center"><Sparkles size={13} /></span>
      <div>{children}</div>
    </div>
  );
}

export function Big({ children, tone, className = "", ...rest }) {
  const c = tone === "up" ? "text-emerald-600" : tone === "down" ? "text-rose-600" : "text-slate-900";
  return <div className={`font-mono-num text-[32px] leading-none font-medium tracking-tight ${c} ${className}`} {...rest}>{children}</div>;
}

export function Kpi({ label, value, tone }) {
  const c = tone === "up" ? "text-emerald-600" : tone === "down" ? "text-rose-600" : "text-slate-900";
  return (
    <div>
      <div className="text-[11px] text-slate-500 mb-0.5">{label}</div>
      <div className={`font-mono-num text-[17px] font-medium ${c}`}>{value}</div>
    </div>
  );
}

export function Button({ primary, children, className = "", ...rest }) {
  return (
    <button
      className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-40 ${primary ? "bg-slate-900 text-white border-slate-900 hover:bg-slate-800" : "bg-white border-slate-200 hover:bg-slate-50"} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export const fmtDay = (iso) => {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

export const fmtWhole = (fmtMoney, n) => fmtMoney(Math.round(n || 0)).replace(/\.00$/, "");
