import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api } from "./api";
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

  return (
    <CompanyCtx.Provider value={{ companies, currentId, current, switchCompany, refresh, loading }}>
      {children}
    </CompanyCtx.Provider>
  );
}

export const useCompany = () => useContext(CompanyCtx);
