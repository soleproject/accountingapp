import React from "react";
import { useNavigate } from "react-router-dom";
import { Lock, Sparkles, X, ChevronDown, Users } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useCompany } from "@/lib/company";
import { useEntitlements, useQuota, FEATURE_COPY, PLAN_LABELS, QUOTA_COPY } from "@/lib/entitlements";

function QuotaBody({ upgrade, isPro, companyName }) {
  const [noun] = QUOTA_COPY[upgrade.kind] || ["items"];
  const nextLimit = upgrade.next_limit == null ? "unlimited" : upgrade.next_limit;
  const who = isPro ? <b>{companyName || "This company"}</b> : "You're";
  return (
    <>
      {who}{isPro ? " is" : ""} using <b>{upgrade.used} of {upgrade.limit}</b> {noun} included in <b>{upgrade.current_plan_label || "Core"}</b>.
      {upgrade.min_plan
        ? <> Upgrade to <b>{upgrade.min_plan_label}</b> (${upgrade.min_plan_price}/mo) for <b>{nextLimit}</b> {noun}.</>
        : <> Contact us to add more {noun} to this plan.</>}
    </>
  );
}

export function UpgradeModal() {
  const { upgrade, closeUpgrade } = useEntitlements();
  const { user } = useAuth();
  const { current } = useCompany();
  const navigate = useNavigate();
  if (!upgrade) return null;
  const isQuota = upgrade.code === "quota_exceeded";
  const [title, blurb] = isQuota ? [QUOTA_COPY[upgrade.kind]?.[1] || "Add more", FEATURE_COPY[upgrade.feature]?.[1] || ""] : (FEATURE_COPY[upgrade.feature] || ["This feature", ""]);
  const isPro = ["pro", "partner", "enterprise", "superadmin"].includes(user?.role);
  const planLabel = upgrade.min_plan_label || PLAN_LABELS[upgrade.min_plan];
  return (
    <div className="fixed inset-0 z-[1100] bg-black/50 flex items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget) closeUpgrade(); }} data-testid="upgrade-modal">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 relative">
        <button onClick={closeUpgrade} className="absolute top-3 right-3 text-slate-400 hover:text-slate-700" data-testid="upgrade-modal-close"><X size={16} /></button>
        <div className="w-11 h-11 rounded-xl bg-slate-900 text-white grid place-items-center mb-4">{isQuota ? <Users size={18} /> : <Lock size={18} />}</div>
        <div className="text-[10px] uppercase tracking-widest font-bold text-slate-500">{isQuota ? `${upgrade.current_plan_label || "Core"} plan limit reached` : `Included in ${planLabel}`}</div>
        <h2 className="font-heading text-xl mt-1" data-testid="upgrade-modal-title">{title}</h2>
        <p className="text-sm text-slate-600 mt-2">{blurb}</p>
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm" data-testid="upgrade-modal-body">
          {isQuota ? <QuotaBody upgrade={upgrade} isPro={isPro} companyName={current?.name} /> : isPro ? (
            <><b>{current?.name || "This company"}</b> is on <b>{upgrade.current_plan_label || "Core"}</b>. Upgrade them to <b>{planLabel}</b> (${upgrade.min_plan_price}/mo) or sponsor a seat to unlock this.</>
          ) : (
            <>Your plan is <b>{upgrade.current_plan_label || "Core"}</b>. {title} is part of <b>{planLabel}</b> — ${upgrade.min_plan_price}/mo, 7-day free trial.</>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 mt-5">
          <button onClick={closeUpgrade} className="h-10 px-4 rounded-xl border border-slate-300 text-sm font-semibold text-slate-700" data-testid="upgrade-modal-later">Not now</button>
          <button onClick={() => { closeUpgrade(); navigate(isPro ? "/admin/client-payments" : "/pricing"); }}
                  className="h-10 px-4 rounded-xl bg-slate-900 text-white text-sm font-semibold inline-flex items-center gap-1.5" data-testid="upgrade-modal-cta">
            <Sparkles size={14} /> {isPro ? "Manage plan" : planLabel ? `Upgrade to ${planLabel}` : "See plans"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Seat / connected-account meter. Renders nothing in shadow mode (quota not active).
export function QuotaNotice({ kind, className = "" }) {
  const { used, limit, active, atCap, over, openUpgrade } = useQuota(kind);
  const { ent } = useEntitlements();
  if (!active) return null;
  const [noun, cta] = QUOTA_COPY[kind] || ["items", "Add more"];
  const pct = Math.min(100, Math.round((used / Math.max(limit, 1)) * 100));
  const tone = over ? "border-rose-200 bg-rose-50" : atCap ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white";
  const bar = over ? "bg-rose-500" : atCap ? "bg-amber-500" : "bg-slate-900";
  return (
    <div className={`rounded-xl border p-3 ${tone} ${className}`} data-testid={`quota-notice-${kind}`} data-at-cap={atCap || undefined}>
      <div className="flex items-center gap-3 text-sm">
        <Users size={15} className="text-slate-500 shrink-0" />
        <div className="flex-1 min-w-0">
          <span className="font-semibold" data-testid={`quota-usage-${kind}`}>{used} of {limit}</span> {noun} on <b>{ent?.plan_label || "Core"}</b>
          {over && <span className="ml-2 text-rose-700 text-xs font-semibold">over the limit — existing ones keep working</span>}
          {atCap && !over && <span className="ml-2 text-amber-700 text-xs font-semibold">limit reached</span>}
        </div>
        <button onClick={openUpgrade} className="shrink-0 text-xs font-semibold text-slate-900 underline-offset-2 hover:underline" data-testid={`quota-upgrade-${kind}`}>{atCap ? cta : "Need more?"}</button>
      </div>
      <div className="h-1.5 rounded bg-slate-200/70 mt-2"><div className={`h-1.5 rounded ${bar}`} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

// Wrap any clickable/surface. mode="lock": clicks open the upgrade modal and
// children are dimmed. mode="replace": renders a full upgrade panel instead
// (use at route level). Renders children untouched when allowed.
export function Gate({ feature, mode = "lock", children, className = "" }) {
  const { can, openUpgrade } = useEntitlements();
  if (can(feature)) return children;
  if (mode === "hide") return null;
  if (mode === "replace") {
    const [title, blurb] = FEATURE_COPY[feature] || ["This feature", ""];
    return (
      <div className="max-w-md mx-auto mt-16 text-center px-6" data-testid={`gate-replace-${feature}`}>
        <div className="w-12 h-12 rounded-2xl bg-slate-900 text-white grid place-items-center mx-auto mb-4"><Lock size={20} /></div>
        <h1 className="font-heading text-2xl">{title}</h1>
        <p className="text-sm text-slate-600 mt-2">{blurb}</p>
        <button onClick={() => openUpgrade(feature)} className="mt-6 h-11 px-6 rounded-xl bg-slate-900 text-white text-sm font-semibold" data-testid={`gate-replace-cta-${feature}`}>See upgrade options</button>
      </div>
    );
  }
  return (
    <div className={`relative ${className}`} onClickCapture={(e) => { e.preventDefault(); e.stopPropagation(); openUpgrade(feature); }} data-testid={`gate-lock-${feature}`}>
      <div className="pointer-events-none opacity-60">{children}</div>
      <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-slate-900 text-white grid place-items-center shadow"><Lock size={10} /></span>
    </div>
  );
}

// Preview-only floating switcher (REACT_APP_PLAN_PREVIEW=true + backend PLAN_PREVIEW_SWITCHER=true).
export function PlanPreviewPill() {
  const { ent, preview, setPreview } = useEntitlements();
  const [open, setOpen] = React.useState(false);
  if (process.env.REACT_APP_PLAN_PREVIEW !== "true" || !ent?.preview_switcher) return null;
  const label = preview === "real" ? `Real (${ent.plan_label || "no plan"}${ent.all_access ? " · all access" : ""})` : preview === "free_spot" ? "Free spot" : PLAN_LABELS[preview];
  const choices = [["real", "Real plan"], ["simple_start", "Core · $38"], ["assistant", "AI Assistant · $79"], ["bookkeeper", "AI Bookkeeper · $99"], ["advanced", "Advanced · $149"], ["free_spot", "Free spot (sponsored)"]];
  return (
    <div className="fixed bottom-20 md:bottom-4 left-3 z-[1050]" data-testid="plan-preview-pill">
      <button onClick={() => setOpen((v) => !v)} className="h-9 px-3 rounded-full bg-amber-400 text-slate-900 text-xs font-bold shadow-lg inline-flex items-center gap-1.5" data-testid="plan-preview-toggle">
        Viewing as: {label} <ChevronDown size={12} />
      </button>
      {open && (
        <div className="absolute bottom-11 left-0 w-56 rounded-xl border bg-white shadow-2xl p-1.5" data-testid="plan-preview-menu">
          {choices.map(([k, l]) => (
            <button key={k} onClick={() => { setPreview(k); setOpen(false); }} className={`w-full text-left px-3 h-9 rounded-lg text-xs font-medium hover:bg-slate-50 ${preview === k ? "bg-slate-100" : ""}`} data-testid={`plan-preview-${k}`}>{l}</button>
          ))}
        </div>
      )}
    </div>
  );
}
