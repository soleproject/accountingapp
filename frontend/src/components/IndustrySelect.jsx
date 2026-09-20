import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";

/**
 * IndustrySelect — richer 21-item industry picker for the onboarding
 * "Business profile" step.
 *
 * The backend only ships 5 GAAP-aware Chart-of-Accounts seed templates
 * (professional_services / restaurant / ecommerce / construction /
 * generic). The dropdown lets the owner pick a specific industry
 * (SaaS, Real Estate, Wholesale trade, …) and we map that label onto
 * one of those 5 slugs internally. The user-visible label is persisted
 * separately as `company.industry_label` so the trigger keeps showing
 * exactly what they picked on return visits.
 *
 * Contract mirrors <IndustryTemplatePicker/>:
 *   props: { companyId, label, slug, onChange }
 *     - label: current human label (e.g. "SaaS") — controls trigger text
 *     - slug:  current CoA template slug (fallback when label is empty)
 *     - onChange(): fired after a successful save so parents can refresh
 *
 * Behavior: click trigger → panel opens directly below (Puzzle-style),
 * click a row → POST /industry-template with { template: slug, label }
 * → onChange() → panel closes.
 */

// 21 industries. `slug` MUST be one of the 5 backend template keys.
export const INDUSTRY_OPTIONS = [
  { label: "Advertising",            slug: "professional_services" },
  { label: "Agriculture & farming",  slug: "generic" },
  { label: "Construction",           slug: "construction" },
  { label: "Ecommerce",              slug: "ecommerce" },
  { label: "Fintech",                slug: "professional_services" },
  { label: "Fintech — Crypto",       slug: "professional_services" },
  { label: "Healthcare",             slug: "professional_services" },
  { label: "Home Services",          slug: "construction" },
  { label: "Legal",                  slug: "professional_services" },
  { label: "Manufacturing",          slug: "generic" },
  { label: "Media & entertainment",  slug: "professional_services" },
  { label: "Professional services",  slug: "professional_services" },
  { label: "Retail",                 slug: "ecommerce" },
  { label: "Real Estate",            slug: "professional_services" },
  { label: "Restaurant",             slug: "restaurant" },
  { label: "SaaS",                   slug: "professional_services" },
  { label: "Transportation",         slug: "generic" },
  { label: "Wholesale trade",        slug: "ecommerce" },
  { label: "Virtual goods",          slug: "ecommerce" },
  { label: "Other",                  slug: "generic" },
  { label: "Not sure",               slug: "generic" },
];

// Fallback label when only a slug is known (e.g. legacy companies that
// picked via the old card picker and never re-selected). Keeps the
// trigger from reading as empty.
const SLUG_FALLBACK_LABEL = {
  professional_services: "Professional services",
  restaurant: "Restaurant",
  ecommerce: "Ecommerce",
  construction: "Construction",
  generic: "Other",
};

export function IndustrySelect({ companyId, label, slug, onChange }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef(null);
  const listRef = useRef(null);

  const currentLabel = useMemo(() => {
    if (label) return label;
    if (slug && SLUG_FALLBACK_LABEL[slug]) return SLUG_FALLBACK_LABEL[slug];
    return "";
  }, [label, slug]);

  // Close on outside click / Esc so the panel behaves like a proper
  // popover on the light-theme card.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // When the panel opens, scroll the currently-selected row into view
  // so returning users immediately see their previous choice.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector('[data-selected="true"]');
    if (el) el.scrollIntoView({ block: "center" });
  }, [open]);

  const pick = async (opt) => {
    if (!companyId) return;
    setSaving(true);
    try {
      await api.post(`/companies/${companyId}/industry-template`, {
        template: opt.slug,
        label: opt.label,
      });
      setOpen(false);
      onChange?.(opt);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't save industry — try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={rootRef} className="relative" data-testid="industry-select">
      <button
        type="button"
        data-testid="industry-select-trigger"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`w-full flex items-center justify-between rounded-lg border bg-white px-3.5 py-2.5 text-sm text-left transition
                    ${open ? "border-indigo-500 ring-2 ring-indigo-100" : "border-slate-300 hover:border-slate-400"}`}
      >
        <span className={currentLabel ? "text-slate-900" : "text-slate-400"}>
          {currentLabel || "Advertising, Construction, E-commerce, Legal, Professional…"}
        </span>
        <ChevronDown size={16} className={`text-slate-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          data-testid="industry-select-panel"
          className="absolute z-40 mt-1 w-full max-h-72 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg py-1"
        >
          {INDUSTRY_OPTIONS.map(opt => {
            const selected = opt.label === currentLabel;
            return (
              <button
                key={opt.label}
                type="button"
                role="option"
                aria-selected={selected}
                data-selected={selected ? "true" : "false"}
                data-testid={`industry-option-${opt.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                onClick={() => pick(opt)}
                disabled={saving}
                className={`w-full text-left px-3.5 py-2 text-sm flex items-center justify-between transition
                            ${selected
                              ? "bg-indigo-50 text-indigo-900 border-l-2 border-indigo-500 pl-3"
                              : "text-slate-700 hover:bg-slate-50 border-l-2 border-transparent pl-3"}
                            disabled:opacity-60 disabled:cursor-wait`}
              >
                <span>{opt.label}</span>
                {selected && <Check size={14} className="text-indigo-600" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default IndustrySelect;
