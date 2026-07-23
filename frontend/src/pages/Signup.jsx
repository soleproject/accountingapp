import { useEffect, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";
import { Loader2, Sparkles } from "lucide-react";

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
  const [params] = useSearchParams();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);

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

  // Already signed in — no need to see the signup form.
  useEffect(() => {
    if (user) nav(user.role === "superadmin" ? "/admin" : user.role === "pro" ? "/pro/clients" : "/dashboard", { replace: true });
  }, [user, nav]);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || password.length < 6) {
      toast.error("Name, email, and 6+ char password required");
      return;
    }
    setBusy(true);
    try {
      const r = await api.post("/auth/signup", {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        password,
        role: "client",  // organic signups are always client-role
        ref: ref || undefined,
      });
      localStorage.setItem("axiom_token", r.data.token);
      localStorage.setItem("axiom_user", JSON.stringify(r.data.user));
      setUser(r.data.user);
      toast.success("Account created — welcome!");
      nav("/dashboard");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Signup failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-[#F5F6F8] p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5" data-testid="signup-form">
        <div className="flex items-center gap-2 mb-6">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
            <Sparkles size={16} className="text-white" />
          </div>
          <div className="font-heading font-bold">SmartBooks</div>
        </div>

        <div>
          <h1 className="text-2xl font-heading font-bold text-slate-900">Create your account</h1>
          <p className="text-sm text-slate-500 mt-1">
            Free to start — you can upgrade any time.
          </p>
        </div>

        {ref && (
          <div className="text-xs text-cyan-700 bg-cyan-50 border border-cyan-100 rounded-md px-3 py-2" data-testid="signup-ref-badge">
            Referred by <span className="font-mono font-medium">{ref}</span>
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
          className="w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-md bg-slate-900 text-white text-sm hover:bg-slate-800 disabled:opacity-50"
          data-testid="signup-submit"
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          Create account
        </button>

        <div className="text-xs text-slate-500 text-center">
          Already have an account? <Link to="/login" className="text-cyan-700 hover:underline">Sign in</Link>
        </div>
      </form>
    </div>
  );
}
