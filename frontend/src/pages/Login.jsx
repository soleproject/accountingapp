import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import { TID } from "@/constants/testIds";
import { Sparkles, Loader2 } from "lucide-react";

// Resolve a firm subdomain from either `?firm=acme` (works everywhere) or
// the hostname's leftmost label if it looks like `acme.axiomledger.ai`.
// Anything on preview / localhost / bare axiomledger.ai returns null.
function detectFirmSubdomain() {
  try {
    const q = new URLSearchParams(window.location.search).get("firm");
    if (q) return q.toLowerCase().trim();
    const host = window.location.hostname;
    if (host.includes("axiomledger.ai")) {
      const first = host.split(".")[0];
      if (first && !["www", "app", "axiomledger"].includes(first)) return first;
    }
  } catch { /* fall through */ }
  return null;
}

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // Firm-branded login. `null` = default Axiom look; otherwise the payload
  // returned by `/api/branding/by-subdomain/:sub`.
  const [firm, setFirm] = useState(null);

  useEffect(() => {
    const sub = detectFirmSubdomain();
    if (!sub) return;
    api.get(`/branding/by-subdomain/${encodeURIComponent(sub)}`)
      .then(r => setFirm(r.data))
      .catch(() => setFirm(null));
  }, []);

  const submit = async (e) => {
    e?.preventDefault();
    setErr(""); setBusy(true);
    try {
      const u = await login(email, password);
      nav(u.role === "superadmin" ? "/admin" : u.role === "pro" ? "/pro/clients" : "/dashboard");
    } catch (e) {
      setErr(e.response?.data?.detail || "Login failed");
    } finally { setBusy(false); }
  };

  const demo = async (e, p, testid) => {
    setEmail(e); setPassword(p);
    setErr(""); setBusy(true);
    try {
      const u = await login(e, p);
      nav(u.role === "superadmin" ? "/admin" : u.role === "pro" ? "/pro/clients" : "/dashboard");
    } catch (err) { setErr("Demo login failed"); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen w-full flex bg-[#F5F6F8]">
      <div className="hidden lg:flex flex-1 relative overflow-hidden bg-gradient-to-br from-slate-900 to-slate-800 text-white p-12">
        <div className="absolute inset-0 opacity-[0.04]" style={{
          backgroundImage: "radial-gradient(circle at 30% 20%, white 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }} />
        <div className="relative z-10 flex flex-col justify-between max-w-xl">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center">
              <Sparkles size={16} className="text-slate-900" />
            </div>
            <div className="font-heading font-bold text-xl">Axiom Ledger</div>
          </div>
          <div className="space-y-6">
            <h1 className="font-heading text-5xl leading-[1.05] font-bold">
              The AI accountant<br/>your firm has been<br/>waiting for.
            </h1>
            <p className="text-slate-300 text-lg leading-relaxed max-w-md">
              GAAP-based categorization, auto-posted JEs, split &amp; linked transactions,
              and real CPA-grade reports — all before your morning coffee.
            </p>
            <div className="grid grid-cols-3 gap-3 max-w-md">
              {[
                ["Auto-posted", "JEs & GLs"],
                ["Rules from", "3 approvals"],
                ["PDF-ready", "reports"],
              ].map(([a, b]) => (
                <div key={a} className="rounded-lg bg-white/5 border border-white/10 px-3 py-2.5">
                  <div className="font-heading font-semibold text-sm">{a}</div>
                  <div className="text-xs text-slate-400">{b}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="text-xs text-slate-400">© Axiom Ledger, Inc.</div>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm space-y-5">
          {firm ? (
            <div className="flex items-center gap-3 mb-6" data-testid="login-firm-branding">
              {(firm.logos?.logo_light || firm.logos?.icon_light) ? (
                <img
                  src={firm.logos.logo_light || firm.logos.icon_light}
                  alt={firm.firm_name}
                  className="h-10 max-w-[180px] object-contain"
                />
              ) : (
                <div className="w-10 h-10 rounded-lg bg-slate-900 flex items-center justify-center">
                  <Sparkles size={18} className="text-white" />
                </div>
              )}
              <div>
                <div className="font-heading font-bold text-slate-900">{firm.firm_name}</div>
                <div className="text-[11px] text-slate-500">Powered by Axiom Ledger</div>
              </div>
            </div>
          ) : (
            <div className="lg:hidden flex items-center gap-2 mb-6">
              <div className="w-8 h-8 rounded-lg bg-slate-900 flex items-center justify-center">
                <Sparkles size={16} className="text-white" />
              </div>
              <div className="font-heading font-bold">Axiom Ledger</div>
            </div>
          )}
          <div>
            <h2 className="font-heading text-3xl font-bold tracking-tight">Sign in</h2>
            <p className="text-sm text-slate-500 mt-1">Welcome back. Let's get to the numbers.</p>
          </div>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-slate-600 uppercase tracking-wide">Email</label>
              <input
                data-testid={TID.loginEmail}
                type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:border-slate-500"
                required
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600 uppercase tracking-wide">Password</label>
              <input
                data-testid={TID.loginPassword}
                type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:border-slate-500"
                required
              />
            </div>
          </div>
          {err && <div data-testid={TID.loginError} className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">{err}</div>}
          <button
            data-testid={TID.loginSubmit}
            type="submit" disabled={busy}
            className="w-full h-10 rounded-md bg-slate-900 text-white font-medium text-sm flex items-center justify-center gap-2 hover:bg-slate-800 disabled:opacity-60"
          >
            {busy && <Loader2 size={14} className="animate-spin" />} Sign in
          </button>

          <div className="pt-4 border-t space-y-2">
            <div className="text-[11px] uppercase tracking-wider text-slate-500">Demo accounts</div>
            <button type="button" data-testid={TID.demoClient} onClick={() => demo("client@axiom.ai", "client123")}
                    className="w-full text-left rounded-md border px-3 py-2 text-sm hover:bg-slate-50">
              <span className="font-medium">Client</span> — Skyward Sparks, LLC
            </button>
            <button type="button" data-testid={TID.demoPro} onClick={() => demo("pro@axiom.ai", "pro123")}
                    className="w-full text-left rounded-md border px-3 py-2 text-sm hover:bg-slate-50">
              <span className="font-medium">Accounting Pro</span> — Northgate Advisory
            </button>
            <button type="button" data-testid={TID.demoAdmin} onClick={() => demo("admin@axiom.ai", "admin123")}
                    className="w-full text-left rounded-md border px-3 py-2 text-sm hover:bg-slate-50">
              <span className="font-medium">Superadmin</span> — Platform
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
