import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";

/**
 * useCrmSettings — cached-per-company hook that returns the current
 * CRM configuration (stage labels · activity kinds · lead sources).
 * Fallbacks to generic B2B defaults so consumers never see undefined.
 */
const DEFAULT = {
  stage_labels: {
    lead:        "Lead",
    qualified:   "Qualified",
    proposal:    "Proposal",
    negotiation: "Negotiation",
    won:         "Won",
    lost:        "Lost",
  },
  activity_kinds: ["note", "call", "email", "meeting"],
  lead_sources:   ["Referral", "Web", "Cold outreach"],
  preset: null,
};

// Trivial in-memory cache — no need for react-query for this.
const _cache = new Map();

export function useCrmSettings() {
  const { currentId } = useCompany();
  const [settings, setSettings] = useState(
    () => _cache.get(currentId) || DEFAULT);

  useEffect(() => {
    if (!currentId) return;
    if (_cache.has(currentId)) {
      setSettings(_cache.get(currentId));
    }
    // Always refresh in the background — CRM Settings edits don't
    // ripple through global state otherwise.
    (async () => {
      try {
        const r = await api.get(`/companies/${currentId}/crm-settings`);
        const merged = { ...DEFAULT, ...(r.data || {}) };
        _cache.set(currentId, merged);
        setSettings(merged);
      } catch { /* keep defaults */ }
    })();
  }, [currentId]);

  return settings;
}

/** Utility: convenience label lookup with fallback. */
export function stageLabel(settings, key) {
  return settings?.stage_labels?.[key] || DEFAULT.stage_labels[key] || key;
}

/** Invalidate cache — call after PATCH/apply-preset. */
export function invalidateCrmSettings(cid) {
  if (cid) _cache.delete(cid);
}
