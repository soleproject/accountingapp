/**
 * useIsMobile — single source of truth for the mobile breakpoint.
 * Tracks window width in state so components re-render when the
 * user rotates their phone or resizes their browser window past
 * the breakpoint (dev/testing case).
 *
 * Breakpoint mirrors Tailwind's `md:` (>= 768px = desktop).
 */
import { useEffect, useState } from "react";

const MOBILE_MAX = 767;

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth <= MOBILE_MAX;
  });
  useEffect(() => {
    const on = () => setIsMobile(window.innerWidth <= MOBILE_MAX);
    window.addEventListener("resize", on);
    window.addEventListener("orientationchange", on);
    return () => {
      window.removeEventListener("resize", on);
      window.removeEventListener("orientationchange", on);
    };
  }, []);
  return isMobile;
}
