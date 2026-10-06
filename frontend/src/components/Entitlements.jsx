import React from "react";
import { useNavigate } from "react-router-dom";
import { Lock, Sparkles, X, ChevronDown } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useCompany } from "@/lib/company";
import { useEntitlements, FEATURE_COPY, PLAN_LABELS } from "@/lib/entitlements";

export function UpgradeModal() {
  const { upgrade, closeUpgrade } = useEntitlements();
  const { user } = useAuth();
  const { current } = useCompany();
  const navigate = useNavigate();
  if (!upgrade) return null;
  const [title, blurb] = FEATURE_COPY[upgrade.feature] || ["This feature", ""];
  const isPro = ["pro", "partner", "enterprise", "superadmin"].includes(user?.role);
  const planLabel = upgrade.min_plan_label || PLAN_LABELS[upgrade.min_plan];
  return (
    <div className="fixed inset-0 z-[1100] bg-black/50 flex items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget) closeUpgrade(); }} data-testid="upgrade-modal">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 relative">
        <button onClick={closeUpgrade} className="absolute top-3 right-3 text-slate-400 hover:text-slate-700" data-testid="upgrade-modal-close"><X size={16} /></button>
        <div className="w-11 h-11 rounded-xl bg-slate-900 text-white grid place-items-center mb-4"><Lock size={18} /></div>
        <div className="text-[10px] uppercase tracking-widest font-bold text-slate-500">Included in {planLabel}</div>
        <h2 className="font-heading text-xl mt-1" data-testid="upgrade-modal-title">{title}</h2>
        <p className="text-sm text-slate-600 mt-2">{blurb}</p>
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
          {isPro ? (
            <><b>{current?.name || "This company"}</b> is on <b>{upgrade.current_plan_label || "Core"}</b>. Upgrade them to <b>{planLabel}</b> (${upgrade.min_plan_price}/mo) or sponsor a seat to unlock this.</>
          ) : (
            <>Your plan is <b>{upgrade.current_plan_label || "Core"}</b>. {title} is part of <b>{planLabel}</b> — ${upgrade.min_plan_price}/mo, 7-day free trial.</>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 mt-5">
          <button onClick={closeUpgrade} className="h-10 px-4 rounded-xl border border-slate-300 text-sm font-semibold text-slate-700" data-testid="upgrade-modal-later">Not now</button>
          <button onClick={() => { closeUpgrade(); navigate(isPro ? "/admin/client-payments" : "/pricing"); }}
                  className="h-10 px-4 rounded-xl bg-slate-900 text-white text-sm font-semibold inline-flex items-center gap-1.5" data-testid="upgrade-modal-cta">
            <Sparkles size={14} /> {isPro ? "Manage plan" : `Upgrade to ${planLabel}`}
          </button>
        </div>
      </div>
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
