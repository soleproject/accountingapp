import { useState } from "react";
import axios from "axios";
import { toast } from "sonner";
import { Loader2, ArrowRight } from "lucide-react";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";

const inputCls = "w-full h-11 rounded-xl border border-slate-300 px-3 text-sm bg-white focus:border-slate-900 focus:ring-2 focus:ring-slate-200 outline-none";

function Field({ label, required, testid, children }) {
  return (
    <label className="block" data-testid={testid}>
      <span className="block text-xs font-semibold text-slate-700 mb-1.5">{label}{required && <b className="text-red-600"> *</b>}</span>
      {children}
    </label>
  );
}

function Select({ value, onChange, options, testid }) {
  return (
    <select value={value} onChange={onChange} data-testid={testid} className={inputCls + (value ? " text-slate-900" : " text-slate-400")}>
      <option value="">Choose…</option>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

export function LeadForm({ variant, copy, slug, firm, sourceTag, onDone }) {
  const [form, setForm] = useState({ first: "", last: "", email: "", phone: "", company: "", extra: "", extra2: "" });
  const [busy, setBusy] = useState(false);
  const set = k => e => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    if (!form.first.trim() || !form.email.trim() || !form.company.trim()) {
      toast.error(`First name, email and ${copy.companyLabel.toLowerCase()} are required`);
      return;
    }
    setBusy(true);
    try {
      const extra = {};
      if (variant.extra && form.extra) extra[variant.extra.key] = form.extra;
      if (variant.extra2 && form.extra2) extra[variant.extra2.key] = form.extra2;
      const r = await axios.post(`${API}/public/leads`, {
        name: `${form.first.trim()} ${form.last.trim()}`.trim(),
        email: form.email.trim(),
        role: variant.role,
        ref_slug: slug || null,
        phone: form.phone.trim() || null,
        company_name: form.company.trim(),
        variant: variant.key,
        source_tag: sourceTag || null,
        extra: Object.keys(extra).length ? extra : null,
      });
      onDone({ ...r.data, form: { ...form, name: `${form.first.trim()} ${form.last.trim()}`.trim() } });
    } catch (err) {
      const msg = err?.response?.data?.detail;
      toast.error(typeof msg === "string" ? msg : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 shadow-[0_12px_40px_rgba(15,23,42,.08)]" data-testid="lead-form">
      <h3 className="font-heading font-bold text-lg text-slate-900" data-testid="lead-form-title">{copy.formTitle}</h3>
      <p className="text-sm text-slate-500 mt-0.5">{copy.formSub}</p>
      <div className="h-px bg-slate-200 my-4" />
      <div className="grid grid-cols-2 gap-3">
        <Field label="First name" required testid="lead-first"><input value={form.first} onChange={set("first")} className={inputCls} data-testid="lead-first-input" autoComplete="given-name" /></Field>
        <Field label="Last name" testid="lead-last"><input value={form.last} onChange={set("last")} className={inputCls} data-testid="lead-last-input" autoComplete="family-name" /></Field>
      </div>
      <div className="mt-3"><Field label="Work email" required testid="lead-email"><input type="email" value={form.email} onChange={set("email")} className={inputCls} data-testid="lead-email-input" autoComplete="email" /></Field></div>
      <div className="mt-3"><Field label={copy.companyLabel} required testid="lead-company"><input value={form.company} onChange={set("company")} className={inputCls} data-testid="lead-company-input" autoComplete="organization" /></Field></div>
      <div className="mt-3"><Field label={<>Mobile <span className="text-slate-400 font-normal">(for a quick text, optional)</span></>} testid="lead-phone"><input type="tel" value={form.phone} onChange={set("phone")} className={inputCls} data-testid="lead-phone-input" autoComplete="tel" /></Field></div>
      {variant.extra && (
        <div className={"mt-3 grid gap-3 " + (variant.extra2 ? "grid-cols-2" : "")}>
          <Field label={variant.extra.label} testid="lead-extra"><Select value={form.extra} onChange={set("extra")} options={variant.extra.options} testid="lead-extra-select" /></Field>
          {variant.extra2 && <Field label={variant.extra2.label} testid="lead-extra2"><Select value={form.extra2} onChange={set("extra2")} options={variant.extra2.options} testid="lead-extra2-select" /></Field>}
        </div>
      )}
      <button type="submit" disabled={busy} data-testid="lead-submit-btn"
        className="mt-5 w-full h-12 rounded-full font-semibold text-white flex items-center justify-center gap-2 disabled:opacity-60 transition-transform active:scale-[.99]"
        style={{ background: firm?.color || "#0f172a" }}>
        {busy ? <Loader2 size={16} className="animate-spin" /> : <>{copy.cta} <ArrowRight size={16} /></>}
      </button>
      <p className="text-[11px] text-slate-500 text-center mt-2.5">{copy.fine}</p>
    </form>
  );
}
