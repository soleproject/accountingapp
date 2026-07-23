import { createContext, useContext, useEffect, useState } from "react";
import { api } from "./api";

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem("axiom_user") || "null"); }
    catch { return null; }
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = localStorage.getItem("axiom_token");
    if (!t) { setLoading(false); return; }
    api.get("/auth/me").then(r => {
      setUser(r.data.user);
      localStorage.setItem("axiom_user", JSON.stringify(r.data.user));
    }).catch(() => {
      localStorage.removeItem("axiom_token");
      localStorage.removeItem("axiom_user");
      setUser(null);
    }).finally(() => setLoading(false));
  }, []);

  const login = async (email, password) => {
    const r = await api.post("/auth/login", { email, password });
    localStorage.setItem("axiom_token", r.data.token);
    localStorage.setItem("axiom_user", JSON.stringify(r.data.user));
    setUser(r.data.user);
    return r.data.user;
  };

  const logout = () => {
    localStorage.removeItem("axiom_token");
    localStorage.removeItem("axiom_user");
    localStorage.removeItem("axiom_company_id");
    setUser(null);
  };

  return <AuthCtx.Provider value={{ user, loading, login, logout, setUser }}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
