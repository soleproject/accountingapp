import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams, Link, useLocation } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCompany } from "@/lib/company";
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
  const { refresh: refreshCompanies, switchCompany } = useCompany();
  // Set once we start our own post-signup routing so the "already
  // signed in" redirect below doesn't hijack it.
  const routingRef = useRef(false);
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
  const [bizName, setBizName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [ref, setRef] = useState("");
  const [refWho, setRefWho] = useState(null);  // {name, firm_name} once resolved
  const [busy, setBusy] = useState(false);

  // White-label branding — same resolution chain as Login so a firm's
  // customers see the firm's logo + name on every entry point:
  //   ?firm=slug → subdomain slug (proactivebooks.accountingapp.ai)
  //   → server host resolver → cached slug (non-flagship hosts only).
  const [firm, setFirm] = useState(null);
  const [firmSlug, setFirmSlug] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const host = window.location.hostname.toLowerCase();
    const isFlagshipHost =
      host === "app.smartbookssoftware.ai" ||
      host === "smartbookssoftware.ai" ||
      host === "www.smartbookssoftware.ai" ||
      host === "localhost" ||
      host === "127.0.0.1" ||
      host.endsWith(".preview.emergentagent.com") ||
      host.endsWith(".emergentagent.com");
    const bySlug = (slug) =>
      api.get(`/branding/by-subdomain/${encodeURIComponent(slug)}`).then((r) => {
        if (cancelled) return;
        setFirm(r.data);
        setFirmSlug(slug);
        try { localStorage.setItem("axiom_firm_slug", slug); } catch { /* ignore */ }
      });
    const serverResolve = () =>
      api.get(`/branding/by-host?host=${encodeURIComponent(host)}`)
        .then((r) => {
          if (cancelled) return;
          if (r.data?.mode === "firm") { setFirm(r.data); setFirmSlug(r.data.slug || r.data.subdomain || host.split(".")[0]); return; }
          if (isFlagshipHost) return;
          const cached = (() => { try { return localStorage.getItem("axiom_firm_slug"); } catch { return null; } })();
          if (cached) bySlug(cached).catch(() => {});
        })
        .catch(() => { /* platform brand is the fallback */ });

    const q = new URLSearchParams(window.location.search).get("firm");
    if (q) {
      bySlug(q.toLowerCase().trim()).catch(() => {});
      return () => { cancelled = true; };
    }
    if (!isFlagshipHost) {
      const slug = host.split(".")[0];
      if (host.split(".").length >= 2 && !["api", "www", "app", "admin", "preview"].includes(slug)) {
        bySlug(slug).catch(serverResolve);
        return () => { cancelled = true; };
      }
    }
    serverResolve();
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
    if (!user || routingRef.current) return;
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
    const clientMode = !enterpriseMode && !affiliateMode;
    if (clientMode && !bizName.trim()) {
      toast.error("Business name is required");
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
        firm_slug: firmSlug || undefined,
      });
      routingRef.current = true;
      localStorage.setItem("axiom_token", r.data.token);
      localStorage.setItem("axiom_user", JSON.stringify(r.data.user));
      // Self-serve business owners get their first company right away so
      // the onboarding interview has something to attach to.
      if (clientMode) {
        const c = await api.post("/companies", { name: bizName.trim(), firm_slug: firmSlug || undefined });
        const cid = c.data?.company_id || c.data?.id;
        if (cid) { localStorage.setItem("axiom_company_id", cid); switchCompany?.(cid); }
      }
      setUser(r.data.user);
      await refreshCompanies?.();
      const successMsg =
        enterpriseMode ? "Your firm is live — welcome." :
        affiliateMode  ? "Affiliate account created — start sharing." :
                         "Account created — let's set up your books.";
      toast.success(successMsg);
      nav(
        enterpriseMode ? "/pro/clients" :
        affiliateMode  ? "/share"       :
                         "/onboarding"
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
          <span className="text-xs font-medium text-slate-600">Full name<span className="text-rose-500" aria-hidden="true"> *</span></span>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-slate-400"
            autoFocus
            autoComplete="name"
            required
            data-testid="signup-name"
          />
        </label>
        {enterpriseMode && (
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Firm / enterprise name<span className="text-rose-500" aria-hidden="true"> *</span></span>
            <input
              value={firmName}
              onChange={e => setFirmName(e.target.value)}
              placeholder="e.g. PriyaBooks, LLC"
              className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-slate-400"
              autoComplete="organization"
              required
              data-testid="signup-firm"
            />
            <span className="mt-1 block text-[11px] text-slate-500">
              Shown to your clients everywhere — you can change it in Settings.
              A private-label subdomain unlocks on the paid tier.
            </span>
          </label>
        )}
        {!enterpriseMode && !affiliateMode && (
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Business name<span className="text-rose-500" aria-hidden="true"> *</span></span>
            <input
              value={bizName}
              onChange={e => setBizName(e.target.value)}
              placeholder="e.g. Bright Beans Coffee Co."
              className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-slate-400"
              autoComplete="organization"
              required
              data-testid="signup-business"
            />
          </label>
        )}
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Work email<span className="text-rose-500" aria-hidden="true"> *</span></span>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-slate-400"
            autoComplete="email"
            required
            data-testid="signup-email"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Password (6+ chars)<span className="text-rose-500" aria-hidden="true"> *</span></span>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-slate-400"
            autoComplete="new-password"
            required
            minLength={6}
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
          ) : firm ? null : (
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
