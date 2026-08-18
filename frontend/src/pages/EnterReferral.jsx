/**
 * Public referral landing page.
 *
 * URL pattern: `/refer/:slug` (or `/refer` without a slug for direct
 * visits). Sits between an affiliate's shared link and the paid
 * signup — captures name + email + role so we can drop the visitor
 * into a drip campaign even if they never complete signup.
 *
 * Once they submit, we forward to `/signup?ref=<slug>` so the
 * existing revenue-share attribution flow still fires. Superadmins
 * see the lead in `/admin/leads`.
 */
import { useEffect, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import axios from "axios";
import { toast } from "sonner";
import {
  Sparkles, Loader2, Building2, User, Briefcase, HelpCircle, ArrowRight,
} from "lucide-react";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";

const ROLE_OPTIONS = [
  {
    value: "accounting_pro",
    label: "Accounting professional",
    hint: "CPA, bookkeeper, or firm looking to bring clients onto the platform",
    icon: Briefcase,
  },
  {
    value: "business_owner",
    label: "Business owner",
    hint: "I run a business and need bookkeeping for myself",
    icon: User,
  },
  {
    value: "enterprise",
    label: "Enterprise / multi-firm",
    hint: "I represent a partner network, franchise, or 50+ client shop",
    icon: Building2,
  },
  {
    value: "other",
    label: "Something else",
    hint: "Investor, journalist, curious human — tell us in the notes",
    icon: HelpCircle,
  },
];

export default function EnterReferral() {
  const { slug: urlSlug } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();

  const [slug] = useState(urlSlug || params.get("ref") || "");
  const [referrer, setReferrer] = useState(null);
  const [role, setRole] = useState("accounting_pro");
  const [form, setForm] = useState({
    name: "", email: "", phone: "", company_name: "", notes: "",
  });
  const [submitting, setSubmitting] = useState(false);

  // Resolve referrer display name if a slug is present
  useEffect(() => {
    if (!slug) return;
    axios.get(`${API}/public/refer/${encodeURIComponent(slug)}`)
      .then(r => setReferrer(r.data?.referrer || null))
      .catch(() => setReferrer(null));
  }, [slug]);

  const update = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim() || !form.email.trim()) {
      toast.error("Name and email are required");
      return;
    }
    setSubmitting(true);
    try {
      await axios.post(`${API}/public/leads`, {
        name: form.name.trim(),
        email: form.email.trim(),
        role,
        ref_slug: slug || null,
        phone: form.phone.trim() || null,
        company_name: form.company_name.trim() || null,
        notes: form.notes.trim() || null,
      });
      toast.success("Thanks! We'll be in touch.");
      // Forward to signup, preserving referral attribution
      const q = slug ? `?ref=${encodeURIComponent(slug)}` : "";
      nav(`/signup${q}`, { replace: true });
    } catch (err) {
      const msg = err?.response?.data?.detail || "Something went wrong. Please try again.";
      toast.error(typeof msg === "string" ? msg : "Submission failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      data-testid="enter-referral-page"
      className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-cyan-50"
    >
      {/* Top brand strip */}
      <div className="border-b border-slate-200 bg-white/70 backdrop-blur">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center gap-3">
          <div className="h-8 w-8 rounded-md bg-gradient-to-br from-cyan-500 to-cyan-700 grid place-items-center text-white">
            <Sparkles size={16} />
          </div>
          <div>
            <div className="font-heading text-lg font-bold text-slate-900 leading-tight">
              Business Software
            </div>
            <div className="text-xs text-slate-500 -mt-0.5">
              AI-native accounting for firms and their clients
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-10">
        {/* Referrer badge */}
        {referrer && (
          <div
            data-testid="referrer-badge"
            className="mb-6 inline-flex items-center gap-2 rounded-full border border-cyan-200 bg-cyan-50 px-3 py-1.5 text-xs font-medium text-cyan-900"
          >
            <Sparkles size={12} className="text-cyan-600" />
            Referred by <span className="font-bold">{referrer}</span>
          </div>
        )}

        <h1 className="text-3xl sm:text-4xl font-heading font-bold text-slate-900 tracking-tight">
          Tell us who you are.
        </h1>
        <p className="mt-3 text-slate-600 max-w-2xl">
          Just a few details so we can point you at the right onboarding —
          and follow up if you're not ready to sign up today. No spam, no
          card required.
        </p>

        <form onSubmit={submit} className="mt-8 space-y-6">
          {/* Role selector */}
          <div>
            <label className="block text-sm font-semibold text-slate-800 mb-3">
              I'm a…
            </label>
            <div className="grid sm:grid-cols-2 gap-3">
              {ROLE_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const active = role === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    data-testid={`role-${opt.value}`}
                    onClick={() => setRole(opt.value)}
                    className={
                      "text-left p-4 rounded-lg border-2 transition-all " +
                      (active
                        ? "border-cyan-600 bg-cyan-50 shadow-sm"
                        : "border-slate-200 bg-white hover:border-slate-300")
                    }
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className={
                          "h-9 w-9 rounded-md grid place-items-center shrink-0 " +
                          (active ? "bg-cyan-600 text-white" : "bg-slate-100 text-slate-600")
                        }
                      >
                        <Icon size={16} />
                      </div>
                      <div>
                        <div className="text-sm font-bold text-slate-900">
                          {opt.label}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          {opt.hint}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Contact fields */}
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Your name *" testid="lead-name">
              <input
                type="text"
                required
                value={form.name}
                onChange={update("name")}
                data-testid="lead-name-input"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-cyan-500 focus:ring-2 focus:ring-cyan-200 outline-none"
              />
            </Field>
            <Field label="Email *" testid="lead-email">
              <input
                type="email"
                required
                value={form.email}
                onChange={update("email")}
                data-testid="lead-email-input"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-cyan-500 focus:ring-2 focus:ring-cyan-200 outline-none"
              />
            </Field>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Phone (optional)" testid="lead-phone">
              <input
                type="tel"
                value={form.phone}
                onChange={update("phone")}
                data-testid="lead-phone-input"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-cyan-500 focus:ring-2 focus:ring-cyan-200 outline-none"
              />
            </Field>
            <Field label={role === "accounting_pro" ? "Firm name (optional)" : "Business name (optional)"} testid="lead-company">
              <input
                type="text"
                value={form.company_name}
                onChange={update("company_name")}
                data-testid="lead-company-input"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-cyan-500 focus:ring-2 focus:ring-cyan-200 outline-none"
              />
            </Field>
          </div>

          <Field label="Anything we should know? (optional)" testid="lead-notes">
            <textarea
              rows={3}
              value={form.notes}
              onChange={update("notes")}
              data-testid="lead-notes-input"
              placeholder={
                role === "accounting_pro"
                  ? "How many clients are you managing today? What accounting stack are you using?"
                  : "Tell us a bit about your business or what you're looking for."
              }
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-cyan-500 focus:ring-2 focus:ring-cyan-200 outline-none resize-none"
            />
          </Field>

          <div className="pt-2 flex items-center gap-3">
            <button
              type="submit"
              disabled={submitting}
              data-testid="lead-submit-btn"
              className="inline-flex items-center gap-2 rounded-md bg-cyan-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-cyan-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? (
                <><Loader2 size={16} className="animate-spin" /> Sending…</>
              ) : (
                <>Continue to signup <ArrowRight size={16} /></>
              )}
            </button>
            <div className="text-xs text-slate-500">
              We'll take you to signup next. Free 14-day trial, no card required.
            </div>
          </div>
        </form>

        {/* Trust footer */}
        <div className="mt-16 pt-8 border-t border-slate-200 text-xs text-slate-500 flex flex-wrap gap-x-6 gap-y-2">
          <span>SOC 2 in progress</span>
          <span>UK GDPR compliant</span>
          <span>Bank-grade encryption</span>
          <span>No card required to trial</span>
        </div>
      </div>
    </div>
  );
}

function Field({ label, testid, children }) {
  return (
    <label className="block" data-testid={testid}>
      <span className="block text-sm font-semibold text-slate-800 mb-1.5">{label}</span>
      {children}
    </label>
  );
}
