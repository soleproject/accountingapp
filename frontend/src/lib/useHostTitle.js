// Dynamic <title> + <link rel="icon"> based on where the user is:
// SmartBooks on the platform host, the firm's name + icon on a private-
// label subdomain, and a generic "Accounting App" on the neutral root.
// Mounted once inside App and updates when logins land or the firm's
// branding changes (so a rename in Enterprise Settings takes effect
// without a page reload).
//
// Firm slug resolution priority (highest → lowest):
//   1. `?firm=` query param on the current URL (welcome-email deep links)
//   2. `axiom_firm_slug` cached in localStorage (sticky across logout)
//   3. `/branding/by-host` — resolves subdomain / private-label root
//   4. `useBranding()` from the authenticated user (overrides everything
//      once they're signed in so a rename shows instantly)
import { useEffect } from "react";
import { api } from "@/lib/api";
import { useBranding } from "@/lib/branding";

const NEUTRAL_TITLE = "Accounting App";
const PLATFORM_TITLE = "SmartBooks";

// Swap the browser's active favicon to `href` (a data URL or absolute
// URL). Removes any existing <link rel="icon"> tags first so the browser
// doesn't fall back to the old one. Safe to call repeatedly.
function setFavicon(href) {
  if (!href) return;
  const head = document.head;
  head.querySelectorAll("link[rel~='icon']").forEach((l) => l.remove());
  const link = document.createElement("link");
  link.rel = "icon";
  link.href = href;
  head.appendChild(link);
}

function extractIcon(firmLike) {
  if (!firmLike) return null;
  const logos = firmLike.logos || {};
  // Prefer the square icon variants so browsers get a crisp favicon;
  // fall back to the wide logo (some browsers still render it OK).
  return logos.icon_light || logos.icon_dark || logos.logo_light || logos.logo_dark || null;
}

async function fetchAndApplyFirm(slug) {
  if (!slug) return false;
  try {
    const r = await api.get(`/branding/by-subdomain/${encodeURIComponent(slug)}`);
    const d = r.data || {};
    if (d.firm_name) {
      document.title = d.firm_name;
      const icon = extractIcon(d);
      if (icon) setFavicon(icon);
      return true;
    }
  } catch {
    /* unknown slug — fall through to host resolver */
  }
  return false;
}

export function useHostTitle() {
  const { branding } = useBranding();

  // Priority chain: URL param → localStorage → host → default. Runs once
  // on mount; the branding-effect below rebrands on login.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      // 1. ?firm=<slug> beats everything else.
      const qSlug = new URLSearchParams(window.location.search).get("firm");
      if (qSlug) {
        if (await fetchAndApplyFirm(qSlug.toLowerCase().trim())) {
          try { localStorage.setItem("axiom_firm_slug", qSlug); } catch { /* quota */ }
          return;
        }
      }
      // 2. Sticky slug persisted by SetPassword or a prior firm login.
      let cached = null;
      try { cached = localStorage.getItem("axiom_firm_slug"); } catch { /* ignore */ }
      if (cached) {
        if (await fetchAndApplyFirm(cached)) return;
      }
      // 3. Backend host-based resolver (subdomain / private-label root).
      try {
        const r = await api.get(`/branding/by-host?host=${encodeURIComponent(window.location.hostname)}`);
        if (cancelled) return;
        const d = r.data || {};
        if (d.mode === "firm" && d.firm_name) {
          document.title = d.firm_name;
          const icon = extractIcon(d);
          if (icon) setFavicon(icon);
        } else if (d.mode === "platform") {
          document.title = PLATFORM_TITLE;
          // Platform brand — reset any inherited favicon back to the
          // default one bundled with the app. `/favicon.ico` is always
          // present in create-react-app's public/ folder.
          setFavicon("/favicon.ico");
        } else {
          document.title = NEUTRAL_TITLE;
          setFavicon("/favicon.ico");
        }
      } catch {
        if (!cancelled) document.title = NEUTRAL_TITLE;
      }
    })();

    return () => { cancelled = true; };
  }, []);

  // Once the signed-in user's branding lands, prefer THEIR firm name +
  // icon over the host-derived one — a client using acme.accountingapp.ai
  // should still see "Acme CPAs" if the owner renames the firm.
  useEffect(() => {
    if (!branding) return;
    const name = branding.firm_name || branding.name;
    if (name) document.title = name;
    const icon = extractIcon(branding);
    if (icon) setFavicon(icon);
  }, [branding]);
}
