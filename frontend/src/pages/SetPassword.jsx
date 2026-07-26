/**
 * SetPassword magic-link redemption page.
 *
 * Route: `/set-password/:token` (public). Reached from the "Set your
 * password" email sent to newly-invited clients. Validates the token on
 * mount so we can greet the user by email, then lets them pick a
 * password. On success the backend returns a JWT which is dropped into
 * the same localStorage slot login uses, so the user lands straight on
 * the dashboard already authenticated.
 */
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import axios from "axios";
import { toast } from "sonner";
import { KeyRound, Loader2, CheckCircle2, AlertTriangle, Sparkles } from "lucide-react";

const BASE = process.env.REACT_APP_BACKEND_URL;

export default function SetPassword() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState("checking"); // checking | ok | expired | invalid | used
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("welcome");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  // Firm branding — mirrors the same lookup Login.jsx does. When
  // `?firm=<slug>` is present on the URL (the Pro's welcome email
  // adds it for private-label firms), we swap the SmartBooks logo
  // above the form for the firm's logo + name so a brand-new client
  // never sees the SmartBooks platform brand.
  const [firm, setFirm] = useState(null);
  const firmSlug = new URLSearchParams(window.location.search).get("firm");

  useEffect(() => {
    if (!firmSlug) return;
    axios
      .get(`${BASE}/api/branding/by-subdomain/${encodeURIComponent(firmSlug.toLowerCase().trim())}`)
      .then((r) => setFirm(r.data))
      .catch(() => {});
  }, [firmSlug]);

  useEffect(() => {
    axios
      .get(`${BASE}/api/auth/password-set/${token}`)
      .then((r) => {
        setEmail(r.data.email || "");
        setName(r.data.name || "");
        setPurpose(r.data.purpose || "welcome");
        setStatus("ok");
      })
      .catch((e) => {
        const code = e.response?.status;
        if (code === 410) {
          const detail = (e.response?.data?.detail || "").toLowerCase();
          setStatus(detail.includes("used") ? "used" : "expired");
        } else {
          setStatus("invalid");
        }
      });
  }, [token]);

  const submit = async () => {
    if (password.length < 8) { toast.error("Pick a password 8+ chars long."); return; }
    if (password !== confirm) { toast.error("Passwords don't match."); return; }
    setBusy(true);
    try {
      const r = await axios.post(`${BASE}/api/auth/password-set/${token}`, { password });
      localStorage.setItem("token", r.data.token);
      localStorage.setItem("user", JSON.stringify(r.data.user));
      const brand = firm?.firm_name || "SmartBooks";
      // Persist firm slug so the login page keeps the firm brand if the
      // client logs out and back in (Login.jsx reads this as a fallback
      // when there's no ?firm= param and the hostname is the platform).
      if (firmSlug) {
        try { localStorage.setItem("axiom_firm_slug", firmSlug); } catch { /* quota / privacy mode */ }
      }
      toast.success(`You're in! Welcome to ${brand}.`);
      // Full reload so AuthProvider picks up the new token cleanly.
      window.location.replace("/");
    } catch (e) {
      const detail = e.response?.data?.detail || "Something went wrong. Please try again.";
      toast.error(detail);
      if (e.response?.status === 410) setStatus("used");
    } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-slate-200 p-8">
        {/* Firm branding header — shown when ?firm=<slug> is present on
            the URL and the /branding/by-subdomain lookup succeeded.
            Falls back to a light SmartBooks header for platform links. */}
        {firm ? (
          <div className="flex items-center gap-3 mb-5 pb-5 border-b border-slate-100" data-testid="setpw-firm-branding">
            {(firm.logos?.logo_light || firm.logos?.icon_light) ? (
              <img
                src={firm.logos.logo_light || firm.logos.icon_light}
                alt={firm.firm_name}
                className="h-9 max-w-[160px] object-contain"
              />
            ) : (
              <div className="w-9 h-9 rounded-lg bg-cyan-600 flex items-center justify-center">
                <Sparkles size={16} className="text-white" />
              </div>
            )}
            <div>
              <div className="font-heading font-bold text-slate-900 text-sm">{firm.firm_name}</div>
              <div className="text-[10px] text-slate-500 uppercase tracking-widest">Client onboarding</div>
            </div>
          </div>
        ) : !firmSlug ? (
          <div className="flex items-center gap-2 mb-5 pb-5 border-b border-slate-100">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
              <Sparkles size={16} className="text-white" />
            </div>
            <div className="font-heading font-bold text-slate-900 text-sm">SmartBooks</div>
          </div>
        ) : null}
        {status === "checking" && (
          <div className="text-center py-8" data-testid="setpw-checking">
            <Loader2 size={28} className="animate-spin text-cyan-600 mx-auto" />
            <div className="text-sm text-slate-500 mt-3">Checking your link…</div>
          </div>
        )}

        {status === "ok" && (
          <div data-testid="setpw-form">
            <div className="flex items-center gap-2 text-cyan-700 mb-1">
              <KeyRound size={18} /> <span className="text-xs uppercase tracking-widest font-semibold">
                {purpose === "reset" ? "Reset your password" : "Set your password"}
              </span>
            </div>
            <h1 className="font-heading text-2xl font-semibold text-slate-900">
              {purpose === "reset"
                ? "Pick a new password"
                : `Welcome${name ? `, ${name.split(" ")[0]}` : ""}!`}
            </h1>
            <p className="text-sm text-slate-600 mt-2">
              {purpose === "reset"
                ? <>Set a new password for <b>{email}</b> and we'll sign you in.</>
                : <>Pick a password for <b>{email}</b> and you'll be logged in.</>}
            </p>
            <div className="mt-5 space-y-3">
              <div>
                <label className="text-xs text-slate-600">New password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                  data-testid="setpw-input"
                  className="w-full mt-1 border rounded-md px-3 py-2 text-sm"
                  placeholder="8+ characters"
                />
              </div>
              <div>
                <label className="text-xs text-slate-600">Confirm password</label>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
                  data-testid="setpw-confirm"
                  className="w-full mt-1 border rounded-md px-3 py-2 text-sm"
                  placeholder="Type it again"
                />
              </div>
              <button
                onClick={submit}
                disabled={busy}
                data-testid="setpw-submit"
                className="w-full mt-2 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-cyan-600 text-white text-sm font-semibold hover:bg-cyan-700 disabled:opacity-50"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                Set password &amp; sign me in
              </button>
            </div>
          </div>
        )}

        {status === "expired" && (
          <ErrorState
            title="This link has expired"
            body="For security, set-password links are valid for 7 days. Ask your accountant to re-send the invite."
          />
        )}
        {status === "used" && (
          <ErrorState
            title="This link has already been used"
            body="If that wasn't you, please contact your accountant right away. Otherwise, sign in with the password you set."
            cta={{ label: "Go to sign-in", onClick: () => navigate("/login") }}
          />
        )}
        {status === "invalid" && (
          <ErrorState
            title="This link is not valid"
            body="It may have been mistyped, or the invite was cancelled. Please contact your accountant."
          />
        )}
      </div>
    </div>
  );
}

function ErrorState({ title, body, cta }) {
  return (
    <div className="text-center py-2" data-testid="setpw-error">
      <AlertTriangle size={32} className="text-amber-500 mx-auto" />
      <h1 className="font-heading text-lg font-semibold text-slate-900 mt-3">{title}</h1>
      <p className="text-sm text-slate-600 mt-2 max-w-xs mx-auto">{body}</p>
      {cta && (
        <button
          onClick={cta.onClick}
          className="mt-4 px-4 py-2 rounded-md bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800"
          data-testid="setpw-error-cta"
        >
          {cta.label}
        </button>
      )}
    </div>
  );
}
