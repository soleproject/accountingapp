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
    // Fetch enriched /me (includes `enabled_products`, `show_home`,
    // `default_landing`) so the sidebar + guards have full context
    // on the very first render post-login.
    let full;
    try {
      const me = await api.get("/auth/me");
      full = me.data.user;
    } catch {
      full = r.data.user;
    }
    localStorage.setItem("axiom_user", JSON.stringify(full));
    setUser(full);
    return full;
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
