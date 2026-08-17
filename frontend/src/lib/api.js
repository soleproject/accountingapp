import axios from "axios";

export const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const API = `${BACKEND_URL}/api`;

export const api = axios.create({ baseURL: API });

api.interceptors.request.use((cfg) => {
  const t = localStorage.getItem("axiom_token");
  // Guard against the literal string "undefined" that can end up in
  // localStorage if a prior login response was mis-shaped (setItem stores
  // any non-string as a stringified value). Only send the header on a
  // real JWT.
  if (t && t !== "undefined" && t !== "null") {
    cfg.headers.Authorization = `Bearer ${t}`;
  }
  return cfg;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem("axiom_token");
      localStorage.removeItem("axiom_user");
      // Pages that either bootstrap their own session (public demo,
      // set-password magic links, accept-invite) or are the login
      // page itself must NOT be interrupted by an auto-redirect on
      // 401 — otherwise the demo-visitor auto-login racing against
      // CompanyProvider's initial /companies fetch would boot the
      // visitor straight to /login before their token can install.
      const p = window.location.pathname;
      const isAuthlessPage =
        p === "/login" ||
        p.startsWith("/demo/") ||
        p.startsWith("/signup") ||
        p.startsWith("/set-password/") ||
        p.startsWith("/invite/") ||
        p.startsWith("/q/") ||
        p.startsWith("/billing/");
      if (!isAuthlessPage) {
        window.location.href = "/login";
      }
    }
    return Promise.reject(err);
  }
);

import { getRegion } from "./regions";

/**
 * Format a number as money. Region-aware but US-defaulting: callers
 * that omit the second arg get the exact same output as before
 * ("$1,234.50"), which preserves every existing US screen bit-for-bit.
 * A future Phase-1 caller can pass `region="UK"` and get "£1,234.50".
 */
export const fmtMoney = (n, region = "US") => {
  const v = Number(n || 0);
  const { currencySymbol } = getRegion(region);
  return `${v < 0 ? "-" : ""}${currencySymbol}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const fmtDate = (s, region = "US") => {
  if (!s) return "";
  try {
    // Bare `YYYY-MM-DD` strings (invoice.due_date, invoice.issue_date, etc.)
    // are date-only — no time, no timezone. `new Date("2026-08-06")` parses
    // those as midnight UTC, which renders as "Aug 5" in any timezone west
    // of UTC (e.g. America/New_York). Detect the bare date shape and build
    // a LOCAL Date so the displayed day always matches what the user picked.
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const d = m
      ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
      : new Date(s);
    // Locale-aware short date. Passing `undefined` uses the browser's
    // locale (matches today's US behavior); an explicit UK caller
    // gets the UK locale explicitly for DD/MM/YYYY ordering.
    const locale = region === "UK" ? "en-GB" : undefined;
    return d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
  } catch { return s; }
};
