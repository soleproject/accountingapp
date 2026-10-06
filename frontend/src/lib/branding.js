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
  default:  { primary: "#0F172A", accent: "#4F46E5", sidebar_bg: "#FFFFFF", sidebar_active_bg: "#F1F5F9", topbar_bg: "#FFFFFF" },
  midnight: { primary: "#020617", accent: "#3B82F6", sidebar_bg: "#0F172A", sidebar_active_bg: "#1E293B", topbar_bg: "#0F172A" },
  forest:   { primary: "#052E16", accent: "#16A34A", sidebar_bg: "#052E16", sidebar_active_bg: "#14532D", topbar_bg: "#052E16" },
  violet:   { primary: "#2E1065", accent: "#7C3AED", sidebar_bg: "#2E1065", sidebar_active_bg: "#4C1D95", topbar_bg: "#2E1065" },
};

const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
// Tailwind's canonical indigo ramp as [s, l] per shade — the brand hue is swapped in.
const INDIGO_SL = {
  50: [100, 97], 100: [100, 94], 200: [96, 89], 300: [94, 82], 400: [92, 74], 500: [84, 67],
  600: [76, 59], 700: [57, 51], 800: [55, 41], 900: [47, 34], 950: [47, 20],
};
const HUE_OFFSETS = { indigo: 0, violet: 24, fuchsia: 53 };

function hexToHsl(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || "")) return null;
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}

function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return `${f(0)} ${f(8)} ${f(4)}`;
}

function isDark(hex) {
  const hsl = hexToHsl(hex);
  return hsl ? hsl[2] < 55 : false;
}

// Re-tints the indigo/violet/fuchsia utility palettes around the brand accent.
// Shade 600 lands exactly on the brand color; lighter/darker shades follow
// Tailwind's indigo lightness curve relative to it.
function applyPaletteRamps(root, accentHex) {
  const hsl = hexToHsl(accentHex);
  const useDefault = !hsl || accentHex.toUpperCase() === PRESETS.default.accent;
  const [bh, bs, bl] = hsl || [0, 0, 0];
  const [s600, l600] = INDIGO_SL[600];
  for (const [name, off] of Object.entries(HUE_OFFSETS)) {
    for (const s of SHADES) {
      const prop = `--tw-${name}-${s}`;
      if (useDefault) { root.style.removeProperty(prop); continue; }
      const [cs, cl] = INDIGO_SL[s];
      const l = cl >= l600
        ? bl + ((cl - l600) / (97 - l600)) * (97 - bl)
        : bl - ((l600 - cl) / (l600 - 20)) * (bl * 0.66);
      const sat = Math.min(100, Math.max(0, bs * (cs / s600)));
      root.style.setProperty(prop, hslToRgb((bh + off) % 360, sat, l));
    }
  }
}

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
  // Public token pages (no login) push the company's resolved brand here so
  // the same palette/title logic applies.
  const [publicBrand, setPublicBrand] = useState(null);
  const effective = branding || publicBrand;

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
    const preset = effective?.theme_preset || "default";
    const p = resolvePalette(preset, effective?.theme_custom);
    const root = document.documentElement;
    root.style.setProperty("--brand-primary", p.primary);
    root.style.setProperty("--brand-accent", p.accent);
    root.style.setProperty("--brand-sidebar-bg", p.sidebar_bg);
    root.style.setProperty("--brand-sidebar-active-bg", p.sidebar_active_bg);
    root.style.setProperty("--brand-topbar-bg", p.topbar_bg);
    applyPaletteRamps(root, p.accent);
    const prim = hexToHsl(p.primary);
    if (prim) {
      const hslStr = `${Math.round(prim[0])} ${Math.round(prim[1])}% ${Math.round(prim[2])}%`;
      root.style.setProperty("--primary", hslStr);
      root.style.setProperty("--ring", hslStr);
      root.style.setProperty("--primary-foreground", prim[2] < 55 ? "0 0% 98%" : "222 47% 11%");
    }
    root.dataset.brandSidebar = isDark(p.sidebar_bg) ? "dark" : "light";
    root.dataset.brandTopbar = isDark(p.topbar_bg) ? "dark" : "light";
  }, [effective]);

  return (
    <BrandingContext.Provider value={{ branding: effective, refresh, setPublicBrand }}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBranding() {
  return useContext(BrandingContext);
}

export const THEME_PRESETS = PRESETS;
