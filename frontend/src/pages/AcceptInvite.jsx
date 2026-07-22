/**
 * AcceptInvite — public magic-link landing page for team invitations.
 *
 * Route: `/invite/:token`. Mirror image of `SetPassword.jsx`, with an
 * additional preview panel showing WHAT the invitee is being granted
 * (role + company list) so they can decide before setting a password.
 */
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import axios from "axios";
import { toast } from "sonner";
import { UserPlus, Loader2, CheckCircle2, AlertTriangle, Building2 } from "lucide-react";

const BASE = process.env.REACT_APP_BACKEND_URL;

const ROLE_LABELS = {
  editor:     { label: "Editor",              hint: "Categorize, post JEs, and reconcile" },
  reviewer:   { label: "Reviewer",            hint: "Review & approve/reject entries" },
  viewer:     { label: "Viewer (read-only)",  hint: "View transactions and reports" },
  pro:        { label: "Accounting Professional", hint: "Full pro-level access to selected clients" },
  superadmin: { label: "Superadmin",          hint: "Platform-level access" },
};

export default function AcceptInvite() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState("checking");
  const [preview, setPreview] = useState(null); // {email, role, company_names, inviter_name, needs_password}
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    axios.get(`${BASE}/api/invites/${token}`)
      .then((r) => { setPreview(r.data); setStatus("ok"); })
      .catch((e) => {
        const code = e.response?.status;
        if (code === 410) {
          const detail = (e.response?.data?.detail || "").toLowerCase();
          if (detail.includes("expired")) setStatus("expired");
          else if (detail.includes("used")) setStatus("used");
          else if (detail.includes("revoked")) setStatus("revoked");
          else if (detail.includes("newer")) setStatus("superseded");
          else setStatus("used");
        } else setStatus("invalid");
      });
  }, [token]);

  const accept = async () => {
    if (preview?.needs_password) {
      if (password.length < 8) return toast.error("Password must be 8+ characters.");
      if (password !== confirm) return toast.error("Passwords don't match.");
    }
    setBusy(true);
    try {
      const body = preview?.needs_password
        ? { password, name: name || undefined }
        : { password: password || "existing-user-noop-placeholder", name: name || undefined };
      const r = await axios.post(`${BASE}/api/invites/${token}/accept`, body);
      localStorage.setItem("token", r.data.token);
      localStorage.setItem("user", JSON.stringify(r.data.user));
      toast.success("You're in — welcome to the team!");
      window.location.replace("/");
    } catch (e) {
      const detail = e.response?.data?.detail || "Couldn't accept the invitation.";
      toast.error(detail);
      if (e.response?.status === 410) setStatus("used");
    } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-slate-200 p-8">
        {status === "checking" && (
          <div className="text-center py-8" data-testid="invite-checking">
            <Loader2 size={28} className="animate-spin text-cyan-600 mx-auto" />
            <div className="text-sm text-slate-500 mt-3">Checking your invitation…</div>
          </div>
        )}

        {status === "ok" && preview && (
          <div data-testid="invite-form">
            <div className="flex items-center gap-2 text-cyan-700 mb-1">
              <UserPlus size={18} /> <span className="text-xs uppercase tracking-widest font-semibold">Invitation</span>
            </div>
            <h1 className="font-heading text-2xl font-semibold text-slate-900">
              You're invited to Axiom Ledger
            </h1>
            <p className="text-sm text-slate-600 mt-2">
              <b>{preview.inviter_name}</b> invited <b>{preview.email}</b> to join as{" "}
              <b>{ROLE_LABELS[preview.role]?.label || preview.role}</b>.
            </p>
            <p className="text-xs text-slate-500 mt-1">{ROLE_LABELS[preview.role]?.hint}</p>

            {preview.company_names?.length > 0 && (
              <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold flex items-center gap-1.5">
                  <Building2 size={11} /> Access to {preview.company_names.length} {preview.company_names.length === 1 ? "company" : "companies"}
                </div>
                <div className="mt-1.5 text-xs text-slate-800 space-y-0.5">
                  {preview.company_names.map((n) => <div key={n}>· {n}</div>)}
                </div>
              </div>
            )}

            <div className="mt-5 space-y-3">
              {preview.needs_password && (
                <div>
                  <label className="text-xs text-slate-600">Your name (optional)</label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    data-testid="invite-name"
                    className="w-full mt-1 border rounded-md px-3 py-2 text-sm"
                    placeholder="How your teammates will see you"
                  />
                </div>
              )}
              {preview.needs_password ? (
                <>
                  <div>
                    <label className="text-xs text-slate-600">Password</label>
                    <input
                      type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                      autoFocus data-testid="invite-password"
                      className="w-full mt-1 border rounded-md px-3 py-2 text-sm"
                      placeholder="8+ characters"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-600">Confirm password</label>
                    <input
                      type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") accept(); }}
                      data-testid="invite-confirm"
                      className="w-full mt-1 border rounded-md px-3 py-2 text-sm"
                    />
                  </div>
                </>
              ) : (
                <div className="text-xs text-slate-600 rounded-md bg-cyan-50 border border-cyan-200 p-3">
                  We recognized your email — sign in with your existing password after accepting.
                </div>
              )}
              <button
                onClick={accept}
                disabled={busy}
                data-testid="invite-accept"
                className="w-full mt-2 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-cyan-600 text-white text-sm font-semibold hover:bg-cyan-700 disabled:opacity-50"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                Accept &amp; join
              </button>
            </div>
          </div>
        )}

        {status !== "ok" && status !== "checking" && (
          <ErrorState status={status} onSignIn={() => navigate("/login")} />
        )}
      </div>
    </div>
  );
}

function ErrorState({ status, onSignIn }) {
  const map = {
    expired:    { title: "This invitation has expired", body: "For security, invitation links are valid for 14 days. Ask your inviter to send a fresh one." },
    used:       { title: "This invitation was already used", body: "If this wasn't you, contact your inviter right away. Otherwise, sign in with the password you set." },
    revoked:    { title: "This invitation was revoked", body: "The person who sent it has cancelled the invitation." },
    superseded: { title: "A newer invitation was sent", body: "Please check your inbox for a more recent invitation email — that's the one to use." },
    invalid:    { title: "This link is not valid", body: "It may have been mistyped, or the invitation was cancelled. Please contact your inviter." },
  };
  const { title, body } = map[status] || map.invalid;
  return (
    <div className="text-center py-2" data-testid="invite-error">
      <AlertTriangle size={32} className="text-amber-500 mx-auto" />
      <h1 className="font-heading text-lg font-semibold text-slate-900 mt-3">{title}</h1>
      <p className="text-sm text-slate-600 mt-2 max-w-xs mx-auto">{body}</p>
      {(status === "used" || status === "superseded") && (
        <button
          onClick={onSignIn}
          className="mt-4 px-4 py-2 rounded-md bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800"
          data-testid="invite-error-signin"
        >
          Go to sign-in
        </button>
      )}
    </div>
  );
}
