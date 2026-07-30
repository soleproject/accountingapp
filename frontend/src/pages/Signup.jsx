import { useEffect, useState } from "react";
import { useNavigate, useSearchParams, Link, useLocation } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";
import { Loader2, Sparkles, DollarSign, Building2 } from "lucide-react";
import PlanComparisonCard from "@/components/PlanComparisonCard";

/**
 * Public signup page. Captures `?ref=<slug>` from the URL AND persists it
 * as a cookie (`sb_ref`) so a click that bounces to Stripe and back still
 * credits the referrer when the user finally lands here to finish signup.
 *
 * The Stripe → user-creation webhook (next session) will bypass this page
 * entirely by minting the user server-side; this page is for organic
 * signups (free-tier / trial / manual).
 */
const REF_COOKIE = "sb_ref";
const COOKIE_TTL_DAYS = 30;

function setRefCookie(slug) {
  const expires = new Date(Date.now() + COOKIE_TTL_DAYS * 86400 * 1000).toUTCString();
  document.cookie = `${REF_COOKIE}=${encodeURIComponent(slug)}; expires=${expires}; path=/; SameSite=Lax`;
}
function readRefCookie() {
  const m = document.cookie.match(new RegExp(`(?:^|; )${REF_COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : "";
}

export default function Signup() {
  const { user, setUser } = useAuth();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [params] = useSearchParams();

  // Three modes share this page: the default client signup, an
  // "affiliate-only" variant reached via `/signup/affiliate`, and an
  // "enterprise" signup at `/signup/enterprise` that creates a Pro
  // firm-owner + auto-spawns their Enterprise record.
  const affiliateMode  = pathname.startsWith("/signup/affiliate");
  const enterpriseMode = pathname.startsWith("/signup/enterprise");

  const [name, setName] = useState("");
  const [firmName, setFirmName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [ref, setRef] = useState("");
  const [refWho, setRefWho] = useState(null);  // {name, firm_name} once resolved
  const [busy, setBusy] = useState(false);

  // White-label branding — when the visitor lands on {firm}.accountingapp.ai,
  // hit /branding/by-host and swap the SmartBooks header for the firm's
  // logo + name. Mirrors the Login page behavior so a Pro's affiliates,
  // customers, and enterprise recruits all see the same brand.
  const [firm, setFirm] = useState(null);
  useEffect(() => {
    let cancelled = false;
    // 1. `?firm=acme` explicit override wins — same pattern as Login,
    //    so previewers can test any firm's brand from the platform host.
    const q = new URLSearchParams(window.location.search).get("firm");
    if (q) {
      api.get(`/branding/by-subdomain/${encodeURIComponent(q.toLowerCase().trim())}`)
        .then(r => { if (!cancelled) setFirm(r.data); })
        .catch(() => { /* unknown firm → platform brand */ });
      return () => { cancelled = true; };
    }
    // 2. Server-resolved from the current hostname — same endpoint
    //    Login uses, so a Pro's affiliates, customers, and enterprise
    //    recruits all see the same brand on every entry point.
    api.get(`/branding/by-host?host=${encodeURIComponent(window.location.hostname)}`)
      .then(r => {
        if (cancelled) return;
        if (r.data.mode === "firm") setFirm(r.data);
      })
      .catch(() => { /* platform brand is the fallback */ });
    return () => { cancelled = true; };
  }, []);

  // Capture ?ref=... on first mount and stash a cookie so it survives an
  // out-and-back detour through Stripe Checkout or a marketing page.
  useEffect(() => {
    const q = (params.get("ref") || "").trim();
    if (q) {
      setRef(q);
      setRefCookie(q);
    } else {
      const c = readRefCookie();
      if (c) setRef(c);
    }
  }, [params]);

  // Resolve the slug to a display name so the banner reads "Referred by
  // Priya Patel (PriyaBooks)" instead of the raw slug. 404s silently
  // hide the banner rather than showing broken attribution.
  useEffect(() => {
    if (!ref) { setRefWho(null); return; }
    let cancelled = false;
    api.get(`/share/lookup?ref=${encodeURIComponent(ref)}`)
      .then(r => { if (!cancelled) setRefWho(r.data); })
      .catch(() => { if (!cancelled) setRefWho(null); });
    return () => { cancelled = true; };
  }, [ref]);

  // Already signed in — no need to see the signup form.
  useEffect(() => {
    if (!user) return;
    const dest =
      user.role === "superadmin" ? "/admin"
      : user.role === "pro"       ? "/pro/clients"
      : user.role === "affiliate" ? "/share"
      :                             "/dashboard";
    nav(dest, { replace: true });
  }, [user, nav]);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || password.length < 6) {
      toast.error("Name, email, and 6+ char password required");
      return;
    }
    if (enterpriseMode && !firmName.trim()) {
      toast.error("Firm / enterprise name is required");
      return;
    }
    setBusy(true);
    try {
      const r = await api.post("/auth/signup", {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        password,
        role: enterpriseMode ? "pro" : affiliateMode ? "affiliate" : "client",
        enterprise_name: enterpriseMode ? firmName.trim() : undefined,
        ref: ref || undefined,
      });
      localStorage.setItem("axiom_token", r.data.token);
      localStorage.setItem("axiom_user", JSON.stringify(r.data.user));
      setUser(r.data.user);
      const successMsg =
        enterpriseMode ? "Your firm is live — welcome." :
        affiliateMode  ? "Affiliate account created — start sharing." :
                         "Account created — welcome!";
      toast.success(successMsg);
      nav(
        enterpriseMode ? "/pro/clients" :
        affiliateMode  ? "/share"       :
                         "/dashboard"
      );
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Signup failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={
      "min-h-screen w-full flex items-center justify-center bg-[#F5F6F8] p-6 " +
      (enterpriseMode ? "py-10" : "")
    }>
      <div className={"w-full " + (enterpriseMode ? "max-w-3xl space-y-6" : "max-w-sm")}>
        {enterpriseMode && (
          <PlanComparisonCard variant="card" loggedIn={false} />
        )}
        <form onSubmit={submit} className={
          "w-full space-y-5 " + (enterpriseMode ? "max-w-sm mx-auto bg-white rounded-xl border p-6 shadow-sm" : "")
        } data-testid="signup-form">
        {firm ? (
          <div
            className="flex flex-col items-center text-center gap-3 mb-6"
            data-testid="signup-firm-branding"
          >
            {(firm.logos?.logo_light || firm.logos?.icon_light) ? (
              <img
                src={firm.logos.logo_light || firm.logos.icon_light}
                alt={firm.firm_name}
                className="h-16 max-h-20 max-w-[280px] object-contain"
              />
            ) : (
              <div className={
                "w-16 h-16 rounded-lg flex items-center justify-center " +
                (enterpriseMode ? "bg-indigo-600" :
                 affiliateMode  ? "bg-emerald-600" :
                                  "bg-blue-600")
              }>
                {enterpriseMode ? <Building2 size={28} className="text-white" />
                 : affiliateMode ? <DollarSign size={28} className="text-white" />
                 :                 <Sparkles   size={28} className="text-white" />}
              </div>
            )}
            <div className="font-heading font-bold text-lg text-slate-900">
              {firm.firm_name}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 mb-6">
            <div className={
              "w-8 h-8 rounded-lg flex items-center justify-center " +
              (enterpriseMode ? "bg-indigo-600" :
               affiliateMode  ? "bg-emerald-600" :
                                "bg-blue-600")
            }>
              {enterpriseMode
                ? <Building2 size={16} className="text-white" />
                : affiliateMode
                  ? <DollarSign size={16} className="text-white" />
                  : <Sparkles   size={16} className="text-white" />}
            </div>
            <div className="font-heading font-bold">SmartBooks</div>
          </div>
        )}

        <div>
          <h1 className="text-2xl font-heading font-bold text-slate-900">
            {enterpriseMode ? "Start your firm on SmartBooks"
             : affiliateMode  ? "Become an affiliate"
             :                  "Create your account"}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {enterpriseMode
              ? "Full firm dashboard, unlimited team members, and AI-powered books for every client. No card required to start."
              : affiliateMode
                ? "No subscription required. Share your link, earn on every paying signup — for as long as they pay."
                : "Free to start — you can upgrade any time."}
          </p>
        </div>

        {ref && (
          <div
            className="text-xs text-cyan-800 bg-cyan-50 border border-cyan-100 rounded-md px-3 py-2 leading-relaxed"
            data-testid="signup-ref-badge"
          >
            {refWho ? (
              <>
                Referred by <span className="font-semibold">{refWho.name}</span>
                {refWho.firm_name ? <> from <span className="font-semibold">{refWho.firm_name}</span></> : null}.
                <span className="block text-cyan-700/80 mt-0.5">
                  They'll get credit on your subscription — no cost to you.
                </span>
              </>
            ) : (
              <>Referred by <span className="font-mono font-medium">{ref}</span></>
            )}
          </div>
        )}

        <label className="block">
          <span className="text-xs font-medium text-slate-600">Full name</span>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-slate-400"
            autoFocus
            autoComplete="name"
            data-testid="signup-name"
          />
        </label>
        {enterpriseMode && (
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Firm / enterprise name</span>
            <input
              value={firmName}
              onChange={e => setFirmName(e.target.value)}
              placeholder="e.g. PriyaBooks, LLC"
              className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-slate-400"
              autoComplete="organization"
              data-testid="signup-firm"
            />
            <span className="mt-1 block text-[11px] text-slate-500">
              Shown to your clients everywhere — you can change it in Settings.
              A private-label subdomain unlocks on the paid tier.
            </span>
          </label>
        )}
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Work email</span>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-slate-400"
            autoComplete="email"
            data-testid="signup-email"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Password (6+ chars)</span>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-slate-400"
            autoComplete="new-password"
            data-testid="signup-password"
          />
        </label>

        <button
          type="submit"
          disabled={busy}
          className={
            "w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-md text-white text-sm disabled:opacity-50 " +
            (enterpriseMode ? "bg-indigo-600 hover:bg-indigo-700" :
             affiliateMode  ? "bg-emerald-600 hover:bg-emerald-700" :
                              "bg-slate-900 hover:bg-slate-800")
          }
          data-testid="signup-submit"
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          {enterpriseMode ? "Start my firm"
           : affiliateMode  ? "Start earning"
           :                  "Create account"}
        </button>

        <div className="text-xs text-slate-500 text-center space-y-1">
          <div>
            Already have an account? <Link to="/login" className="text-cyan-700 hover:underline">Sign in</Link>
          </div>
          {enterpriseMode ? (
            <div>
              Solo bookkeeper or client? <Link to="/signup" className="text-cyan-700 hover:underline">Sign up as a customer</Link>
              {" · "}
              <Link to="/signup/affiliate" className="text-emerald-700 hover:underline">Become an affiliate</Link>
            </div>
          ) : affiliateMode ? (
            <div>
              Not an affiliate? <Link to="/signup" className="text-cyan-700 hover:underline">Sign up as a customer</Link>
              {" · "}
              <Link to="/signup/enterprise" className="text-indigo-700 hover:underline">Start a firm</Link>
            </div>
          ) : (
            <div>
              Running a firm? <Link to="/signup/enterprise" className="text-indigo-700 hover:underline">Start on the enterprise plan</Link>
              {" · "}
              <Link to="/signup/affiliate" className="text-emerald-700 hover:underline">Become an affiliate</Link>
            </div>
          )}
        </div>
        </form>
      </div>
    </div>
  );
}
