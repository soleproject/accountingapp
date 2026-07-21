// Pro-firm branding: fetches the current pro's logos / theme once, applies
// CSS variables on the <html> element, and re-exposes the current branding
// via a React context for consumers that need the raw values (Sidebar).
//
// Only pros/superadmins have branding — client-users share the "default"
// look. We swallow 403s silently so the app renders normally for owners.

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

// Four presets seed the theme tokens; individual tokens can then be
// overridden via `theme_custom` in slice B.
const PRESETS = {
  default:  { primary: "#0F172A", accent: "#0891B2", sidebar_bg: "#FFFFFF", sidebar_active_bg: "#F1F5F9", topbar_bg: "#FFFFFF" },
  midnight: { primary: "#020617", accent: "#3B82F6", sidebar_bg: "#0F172A", sidebar_active_bg: "#1E293B", topbar_bg: "#0F172A" },
  forest:   { primary: "#052E16", accent: "#16A34A", sidebar_bg: "#052E16", sidebar_active_bg: "#14532D", topbar_bg: "#052E16" },
  violet:   { primary: "#2E1065", accent: "#7C3AED", sidebar_bg: "#2E1065", sidebar_active_bg: "#4C1D95", topbar_bg: "#2E1065" },
};

// Tokens exposed in the ProSettings custom-color picker. Order = display order.
export const THEME_TOKEN_META = [
  { key: "primary",           label: "Primary button" },
  { key: "accent",            label: "Accent / links" },
  { key: "sidebar_bg",        label: "Sidebar background" },
  { key: "sidebar_active_bg", label: "Sidebar active item" },
  { key: "topbar_bg",         label: "Top bar" },
];

const BrandingContext = createContext({
  branding: null,
  refresh: async () => {},
});

// Merge preset + optional per-token custom overrides into the final palette.
export function resolvePalette(preset, custom) {
  const base = PRESETS[preset] || PRESETS.default;
  return { ...base, ...(custom || {}) };
}

export function BrandingProvider({ children }) {
  const { user } = useAuth();
  const [branding, setBranding] = useState(null);

  const refresh = useCallback(async () => {
    if (!user) {
      setBranding(null);
      return;
    }
    // Every logged-in user hits the "effective" endpoint — pros see their
    // own; client-users transparently inherit their managing pro's look.
    try {
      const r = await api.get("/branding/effective");
      setBranding(r.data);
    } catch {
      setBranding(null);
    }
  }, [user]);

  useEffect(() => { refresh(); }, [refresh]);

  // Push palette values to CSS custom properties on <html> so any consumer
  // that reads `var(--brand-…)` picks them up. Kept side-effect-only so
  // components don't need to subscribe to the same tokens they render.
  useEffect(() => {
    const preset = branding?.theme_preset || "default";
    const p = resolvePalette(preset, branding?.theme_custom);
    const root = document.documentElement;
    root.style.setProperty("--brand-primary", p.primary);
    root.style.setProperty("--brand-accent", p.accent);
    root.style.setProperty("--brand-sidebar-bg", p.sidebar_bg);
    root.style.setProperty("--brand-sidebar-active-bg", p.sidebar_active_bg);
    root.style.setProperty("--brand-topbar-bg", p.topbar_bg);
  }, [branding]);

  return (
    <BrandingContext.Provider value={{ branding, refresh }}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBranding() {
  return useContext(BrandingContext);
}

export const THEME_PRESETS = PRESETS;
