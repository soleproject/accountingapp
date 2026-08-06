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
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }
    return Promise.reject(err);
  }
);

export const fmtMoney = (n) => {
  const v = Number(n || 0);
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const fmtDate = (s) => {
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
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch { return s; }
};
