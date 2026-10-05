// Client-side "Add new company" popup: company name + owner email
// (pre-filled with the signed-in user). A different owner email makes
// that person the Owner and the current user an Editor. On submit we
// jump straight into onboarding for the new company.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Loader2, Mail, X, Info } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCompany } from "@/lib/company";

// `mode="upgrade"`: affiliate → full account. Flips the role first
// (keeps referral slug + earnings), then creates the company as usual.
export default function AddCompanyModal({ open, onClose, mode = "add" }) {
  const { user, setUser } = useAuth();
  const upgrade = mode === "upgrade";
  const { refresh, switchCompany } = useCompany();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState(user?.email || "");
  const [busy, setBusy] = useState(false);
  const nameRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setOwnerEmail(user?.email || "");
    setTimeout(() => nameRef.current?.focus(), 40);
  }, [open, user?.email]);

  if (!open) return null;
  const delegated = ownerEmail.trim().toLowerCase() !== (user?.email || "").toLowerCase();
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail.trim());
  const canSubmit = name.trim().length > 1 && emailOk && !busy;

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      if (upgrade) {
        const up = await api.post("/affiliate/upgrade");
        localStorage.setItem("axiom_token", up.data.token);
        localStorage.setItem("axiom_user", JSON.stringify(up.data.user));
        setUser(up.data.user);
      }
      const r = await api.post("/companies", { name: name.trim(), owner_email: ownerEmail.trim().toLowerCase() });
      const cid = r.data.company_id;
      await refresh();
      switchCompany(cid);
      toast.success(delegated
        ? `${name.trim()} created — ${ownerEmail.trim()} has been invited as the owner.`
        : `${name.trim()} created.`);
      onClose();
      navigate("/onboarding");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Couldn't create the company.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-slate-900/40 backdrop-blur-[2px]" data-testid="add-company-modal">
      <form onSubmit={submit} className="w-[min(480px,92vw)] rounded-2xl border border-slate-200 bg-white shadow-2xl p-6 relative">
        <button type="button" onClick={onClose} className="absolute top-3 right-3 p-1.5 rounded-md hover:bg-slate-100" aria-label="Close" data-testid="add-company-close">
          <X size={16} />
        </button>
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-indigo-600 font-semibold"><Building2 size={13} /> New business</div>
        <h3 className="text-lg font-semibold text-slate-900 mt-1">{upgrade ? "Upgrade to full platform" : "Add another company"}</h3>
        <p className="text-sm text-slate-500 mt-1">We'll set up the books and walk you through onboarding next.</p>

        <label className="block mt-5 text-xs font-medium text-slate-600">Company name</label>
        <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Blue Door Bakery LLC"
               className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
               data-testid="add-company-name" />

        <label className="block mt-4 text-xs font-medium text-slate-600">Owner email</label>
        <div className="relative mt-1">
          <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)}
                 className="w-full rounded-md border border-slate-200 pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
                 data-testid="add-company-owner-email" />
        </div>
        <div className={`mt-2 flex items-start gap-1.5 text-[12px] leading-relaxed rounded-md px-2.5 py-2 ${delegated ? "bg-amber-50 text-amber-800 border border-amber-200" : "text-slate-500"}`} data-testid="add-company-owner-hint">
          <Info size={13} className="mt-0.5 shrink-0" />
          {delegated
            ? <span><b>{ownerEmail.trim()}</b> will be the owner and get an invite email. You'll be added as an <b>Editor</b> so you can keep working on the books.</span>
            : <span>You'll be the owner of this company.</span>}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-full border border-slate-200 bg-white text-sm text-slate-600 hover:text-slate-900 hover:border-slate-300">Cancel</button>
          <button type="submit" disabled={!canSubmit}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-slate-900 hover:bg-slate-800 text-white text-sm font-semibold disabled:opacity-50"
                  data-testid="add-company-submit">
            {busy ? <Loader2 size={14} className="animate-spin" /> : null} Create &amp; start onboarding
          </button>
        </div>
      </form>
    </div>
  );
}
