// Pro-firm branding: fetches the current pro's logo / theme once, applies
// CSS variables on the <html> element, and re-exposes the current branding
// via a React context for consumers that need the raw values (Sidebar).
//
// Only pros/superadmins have branding — client-users share the "default"
// look. We swallow 403s silently so the app renders normally for owners.

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

// Four presets swap the primary accent color; the sidebar keeps its light
// look. Extending to sidebar-bg / topbar-bg is intentionally deferred to
// slice B so we don't ship a half-cooked theming layer.
const PRESETS = {
  default:  { primary: "#0F172A", accent: "#0891B2" }, // slate-900 + cyan-600
  midnight: { primary: "#020617", accent: "#3B82F6" }, // slate-950 + blue-500
  forest:   { primary: "#052E16", accent: "#16A34A" }, // green-950 + green-600
  violet:   { primary: "#2E1065", accent: "#7C3AED" }, // violet-950 + violet-600
};

const BrandingContext = createContext({
  branding: null,
  refresh: async () => {},
});

export function BrandingProvider({ children }) {
  const { user } = useAuth();
  const [branding, setBranding] = useState(null);

  const refresh = useCallback(async () => {
    if (!user || !["pro", "superadmin"].includes(user.role)) {
      setBranding(null);
      return;
    }
    try {
      const r = await api.get("/pro/branding");
      setBranding(r.data);
    } catch {
      setBranding(null);
    }
  }, [user]);

  useEffect(() => { refresh(); }, [refresh]);

  // Apply the theme preset as CSS variables on <html> so sitewide styles
  // (primary buttons, focused rings, etc.) can pick them up.
  useEffect(() => {
    const preset = branding?.theme_preset || "default";
    const p = PRESETS[preset] || PRESETS.default;
    document.documentElement.style.setProperty("--brand-primary", p.primary);
    document.documentElement.style.setProperty("--brand-accent", p.accent);
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
