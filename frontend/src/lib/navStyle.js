import { useEffect, useState } from "react";

/**
 * useNavStyle — localStorage-backed toggle between the two nav
 * layouts the app supports:
 *
 *   • "rail" (default) — thin 60px Product Rail on the far-left
 *     plus a product-specific sidebar (Accounting, CRM, Team, ...).
 *   • "menu" — no rail; the sidebar becomes the whole nav. When
 *     the user is on /home the sidebar shows a MODULES list with
 *     every product as a clickable item; on product pages it
 *     stays contextual (same as rail mode) so users don't lose
 *     their in-product tools.
 *
 * The preference is scoped to the browser (per-device) via
 * localStorage. Both nav components + the layout listen for the
 * `nav-style-change` custom event so the switch is instant without
 * a page reload.
 */
const STORAGE_KEY = "navStyle";
export const NAV_STYLE_EVENT = "nav-style-change";
export const NAV_STYLES = ["rail", "menu"];

function readInitial() {
  if (typeof window === "undefined") return "rail";
  const v = window.localStorage.getItem(STORAGE_KEY);
  return NAV_STYLES.includes(v) ? v : "rail";
}

export function getNavStyle() {
  return readInitial();
}

export function setNavStyle(next) {
  if (!NAV_STYLES.includes(next)) return;
  window.localStorage.setItem(STORAGE_KEY, next);
  window.dispatchEvent(new CustomEvent(NAV_STYLE_EVENT, { detail: next }));
}

export function useNavStyle() {
  const [style, setStyle] = useState(readInitial);
  useEffect(() => {
    const h = (e) => setStyle(e.detail || readInitial());
    window.addEventListener(NAV_STYLE_EVENT, h);
    return () => window.removeEventListener(NAV_STYLE_EVENT, h);
  }, []);
  return [style, setNavStyle];
}
