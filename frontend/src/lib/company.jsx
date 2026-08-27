import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api, fmtMoney as _fmtMoneyBase, fmtDate as _fmtDateBase } from "./api";
import { useAuth } from "./auth";

const CompanyCtx = createContext(null);

export function CompanyProvider({ children }) {
  const { user } = useAuth();
  const [companies, setCompanies] = useState([]);
  const [currentId, setCurrentId] = useState(() => localStorage.getItem("axiom_company_id"));
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const r = await api.get("/companies");
      setCompanies(r.data.companies || []);
      if (r.data.companies?.length) {
        const stored = localStorage.getItem("axiom_company_id");
        const valid = r.data.companies.find(c => c.id === stored);
        if (!valid) {
          setCurrentId(r.data.companies[0].id);
          localStorage.setItem("axiom_company_id", r.data.companies[0].id);
        }
      }
    } finally { setLoading(false); }
  }, [user]);

  useEffect(() => { refresh(); }, [refresh]);

  const switchCompany = (id) => {
    setCurrentId(id);
    localStorage.setItem("axiom_company_id", id);
  };

  const current = companies.find(c => c.id === currentId) || null;

  // Two-tier UX toggle — `accounting_mode` on the company doc drives
  // whether the sidebar/transactions page surfaces QBO-entity ledgers
  // (Sales Receipts, Credit Memos, entity chip strip, QBO-shaped
  // editors). Defaults to "simple" if the field is missing (legacy
  // companies created before the toggle existed).
  const accountingMode = (current?.accounting_mode || "simple");
  const isAdvancedMode = accountingMode === "advanced";

  // Phase 2 advanced-features flags. All default OFF so a company
  // without the `features` sub-doc — or with any flag missing —
  // renders today's UX. See `/app/backend/advanced_features.py`.
  const features = current?.features || {};
  const classesEnabled  = !!features.classes_enabled;
  const projectsEnabled = !!features.projects_enabled;
  const budgetsEnabled  = !!features.budgets_enabled;

  // Region + derived display prefs. Every field US-defaults so legacy
  // companies (pre-Phase-0, no `region` on the doc) render identically
  // to how they always have. Phase 1 consumers pass these into
  // `fmtMoney(v, region)` / `fmtDate(s, region)` for UK companies.
  const region = current?.region || "US";
  const currency = current?.currency || "USD";
  const dateFormat = current?.date_format || "MM/DD/YYYY";

  return (
    <CompanyCtx.Provider value={{
      companies, currentId, current, switchCompany, refresh, loading,
      accountingMode, isAdvancedMode,
      classesEnabled, projectsEnabled, budgetsEnabled,
      region, currency, dateFormat,
    }}>
      {children}
    </CompanyCtx.Provider>
  );
}

export const useCompany = () => useContext(CompanyCtx);

/**
 * Region-aware money formatter. Drop-in replacement for `fmtMoney`
 * that reads the region off the currently-selected company, so a
 * UK company renders £1,234.50 and a US company renders $1,234.50
 * with zero call-site changes downstream.
 *
 * Usage inside any component that has access to CompanyProvider:
 *   const fmtMoney = useMoneyFmt();
 *   ...
 *   {fmtMoney(row.amount)}
 *
 * Falls back to US formatting if the hook is called outside the
 * provider (e.g. Storybook / test harness) — safe default.
 */
export const useMoneyFmt = () => {
  const ctx = useContext(CompanyCtx);
  const region = ctx?.region || "US";
  return (n) => _fmtMoneyBase(n, region);
};

/** Region-aware date formatter — same pattern as `useMoneyFmt`. */
export const useDateFmt = () => {
  const ctx = useContext(CompanyCtx);
  const region = ctx?.region || "US";
  return (s) => _fmtDateBase(s, region);
};
