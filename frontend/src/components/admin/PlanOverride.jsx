import { useEffect, useState } from "react";
import { Loader2, Save, Eraser, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { PLAN_LABELS } from "@/lib/entitlements";

const LABEL = { ...PLAN_LABELS, essentials: "Essentials (legacy)", plus: "Plus (legacy)" };
const PAYER_HELP = { client_email: "client pays (email invoice)", client_card: "client pays (card)", enterprise: "enterprise pays → full access", free_spot: "pro's free spot → full access" };
const STATUS_HELP = { active: "paid → gated by plan", trialing: "trial → full access", past_due: "gated + grace flag", canceled: "falls back to Core", pending: "not paid yet → gated by plan" };

const Sel = ({ label, value, onChange, options, help, testid }) => (
  <label className="block text-xs">
    <span className="font-semibold text-slate-600">{label}</span>
    <select value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full h-9 rounded-lg border border-slate-300 px-2 text-sm bg-white" data-testid={testid}>
      <option value="">— leave as is —</option>
      {options.map((o) => <option key={o} value={o}>{LABEL[o] || o}{help?.[o] ? ` · ${help[o]}` : ""}</option>)}
    </select>
  </label>
);

export function PlanOverride({ initialCompanyId, onSaved, onClose }) {
  const [meta, setMeta] = useState(null);
  const [cid, setCid] = useState(initialCompanyId || "");
  const [q, setQ] = useState("");
  const [plan, setPlan] = useState("");
  const [payer, setPayer] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.get("/admin/entitlements/companies").then((r) => setMeta(r.data)).catch(() => toast.error("Couldn't load companies")); }, []);

  const filtered = (meta?.companies || []).filter((c) => !q || (c.name || "").toLowerCase().includes(q.toLowerCase()) || (c.owner_email || "").toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  const selected = meta?.companies?.find((c) => c.id === cid);

  const save = async (clear = false) => {
    if (!cid) { toast.error("Pick a company first"); return; }
    setBusy(true);
    try {
      const body = clear ? { clear: true } : { billing_product: plan || null, billing_payer: payer || null, sub_status: status || null };
      const r = (await api.patch(`/admin/entitlements/companies/${cid}/billing`, body)).data;
      toast.success(clear ? "Plan fields cleared — company is back to 'no plan on file'" : "Plan override saved");
      if (r.warning) toast.warning(r.warning, { duration: 8000 });
      onSaved?.();
    } catch (e) { toast.error(e.response?.data?.detail || "Couldn't save"); }
    finally { setBusy(false); }
  };

  return (
    <div className="rounded-xl border border-slate-900/10 bg-slate-50 p-4 space-y-3" data-testid="plan-override">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Set a company's plan for testing</div>
          <div className="text-xs text-slate-500 mt-0.5">Writes the same fields Stripe would. Superadmins always get full access — log in as that company's <b>client</b> user to see the gates.</div>
        </div>
        {onClose && <button onClick={onClose} className="text-slate-400 hover:text-slate-700" data-testid="plan-override-close"><X size={16} /></button>}
      </div>

      <div className="grid md:grid-cols-[1.4fr_1fr_1fr_1fr] gap-3">
        <div className="text-xs relative">
          <span className="font-semibold text-slate-600">Company</span>
          {selected ? (
            <div className="mt-1 h-9 rounded-lg border border-slate-300 bg-white px-2 flex items-center justify-between text-sm" data-testid="plan-override-selected">
              <span className="truncate">{selected.name}{selected.owner_email ? <span className="text-slate-400"> · {selected.owner_email}</span> : null}</span>
              <button onClick={() => { setCid(""); setQ(""); }} className="text-slate-400 hover:text-slate-700 ml-2" data-testid="plan-override-change-company">change</button>
            </div>
          ) : (
            <>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by company or owner email…" className="mt-1 w-full h-9 rounded-lg border border-slate-300 px-2 text-sm" data-testid="plan-override-search" />
              {q && (
                <div className="absolute z-20 mt-1 w-full rounded-lg border border-slate-200 bg-white shadow-lg max-h-60 overflow-auto">
                  {filtered.length === 0 && <div className="px-3 py-2 text-slate-500">No match</div>}
                  {filtered.map((c) => (
                    <button key={c.id} onClick={() => { setCid(c.id); setQ(""); }} className="w-full text-left px-3 py-2 hover:bg-slate-50 text-sm" data-testid={`plan-override-pick-${c.id}`}>
                      <div className="truncate">{c.name}</div>
                      <div className="text-[11px] text-slate-500 truncate">{c.owner_email || "—"}{c.billing_product ? ` · ${LABEL[c.billing_product] || c.billing_product}` : " · no plan"}</div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <Sel label="Plan" value={plan} onChange={setPlan} options={meta?.plans || []} testid="plan-override-plan" />
        <Sel label="Payer" value={payer} onChange={setPayer} options={meta?.payers || []} help={PAYER_HELP} testid="plan-override-payer" />
        <Sel label="Status" value={status} onChange={setStatus} options={meta?.statuses || []} help={STATUS_HELP} testid="plan-override-status" />
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={() => save(false)} disabled={busy || !cid} className="h-9 px-3 rounded-lg bg-slate-900 text-white text-sm inline-flex items-center gap-1.5 disabled:opacity-50" data-testid="plan-override-save">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save override
        </button>
        <button onClick={() => save(true)} disabled={busy || !cid} className="h-9 px-3 rounded-lg border border-slate-300 text-sm inline-flex items-center gap-1.5 disabled:opacity-50" data-testid="plan-override-clear" title="Remove plan/payer/status so the company is 'no plan on file' (full access)">
          <Eraser size={14} /> Clear plan fields
        </button>
      </div>
    </div>
  );
}
