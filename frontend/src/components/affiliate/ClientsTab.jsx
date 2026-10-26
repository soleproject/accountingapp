import { useEffect, useState } from "react";
import { Plus, Loader2, Send, Pencil, Check, X, Users } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { fmtUsd } from "./tools";

const STATUS = {
  invited:   { label: "Invited",   cls: "bg-slate-100 text-slate-600" },
  signed_up: { label: "Signed up", cls: "bg-sky-50 text-sky-700" },
  trialing:  { label: "In trial",  cls: "bg-amber-50 text-amber-700" },
  paying:    { label: "Paying",    cls: "bg-emerald-50 text-emerald-700" },
  canceled:  { label: "Canceled",  cls: "bg-rose-50 text-rose-700" },
};

export function ClientsTab({ eligibility }) {
  const [data, setData] = useState(null);
  const [adding, setAdding] = useState(false);
  const floor = eligibility.floor_cents / 100;

  const load = () => api.get("/affiliate/custom-pricing/clients").then(r => setData(r.data)).catch(() => setData({ clients: [], summary: {} }));
  useEffect(() => { load(); }, []);

  if (!data) return <div className="py-10 text-center text-slate-400 text-sm"><Loader2 size={14} className="inline animate-spin mr-2" />Loading…</div>;

  return (
    <div data-testid="affiliate-clients-tab">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Your priced clients</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Set your own monthly price for the <b>{eligibility.tier_label}</b> plan (minimum {fmtUsd(eligibility.floor_cents)}/mo). You keep everything above {fmtUsd(eligibility.floor_cents)} — every month.
          </p>
        </div>
        <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800" data-testid="affiliate-add-client-btn">
          <Plus size={14} /> Add client
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-6">
        {[["Clients", data.summary.count || 0], ["Active", data.summary.active || 0], ["Your margin / mo", fmtUsd(data.summary.margin_month_cents || 0)]].map(([l, v]) => (
          <div key={l} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
            <div className="text-[10px] uppercase tracking-wider font-bold text-slate-400">{l}</div>
            <div className="font-mono text-lg font-semibold text-slate-900 mt-0.5">{v}</div>
          </div>
        ))}
      </div>

      {adding && <AddClientForm floor={floor} eligibility={eligibility} onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}

      {data.clients.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 py-12 text-center text-sm text-slate-500" data-testid="affiliate-clients-empty">
          <Users size={20} className="mx-auto mb-2 text-slate-300" />
          No clients yet. Add one and we'll email them a signup link at your price.
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-white divide-y divide-slate-100" data-testid="affiliate-clients-list">
          {data.clients.map(c => <ClientRow key={c.id} c={c} floor={floor} onChanged={load} />)}
        </div>
      )}
    </div>
  );
}

function AddClientForm({ floor, eligibility, onClose, onDone }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [price, setPrice] = useState(String(floor + 20));
  const [cadence, setCadence] = useState("monthly");
  const [trial, setTrial] = useState(true);
  const [busy, setBusy] = useState(false);
  const cents = Math.round(parseFloat(price || "0") * 100);
  const margin = Math.max(0, cents - eligibility.floor_cents);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || !/^\S+@\S+\.\S+$/.test(email)) { toast.error("Enter the client's name and a valid email"); return; }
    if (cents < eligibility.floor_cents) { toast.error(`Price must be at least $${floor}/mo`); return; }
    setBusy(true);
    try {
      const { data } = await api.post("/affiliate/custom-pricing/clients", { name, email, monthly_cents: cents, cadence, trial });
      if (data?.email_status === "sent") toast.success(`Invite sent to ${email}`);
      else toast.error(`Client added, but the invite email failed: ${data?.email_error || "unknown error"}. Use the resend button to try again.`);
      onDone();
    } catch (err) { toast.error(err?.response?.data?.detail || "Couldn't add client"); }
    finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} noValidate className="rounded-2xl border border-slate-200 bg-slate-50 p-5 mb-6 space-y-4" data-testid="affiliate-add-client-form">
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block"><span className="text-xs font-semibold text-slate-600">Client name</span>
          <input value={name} onChange={e => setName(e.target.value)} required minLength={2} className="mt-1 w-full h-10 rounded-lg border border-slate-300 px-3 text-sm bg-white" placeholder="Jamie Rivera" data-testid="add-client-name" /></label>
        <label className="block"><span className="text-xs font-semibold text-slate-600">Client email</span>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required className="mt-1 w-full h-10 rounded-lg border border-slate-300 px-3 text-sm bg-white" placeholder="jamie@business.com" data-testid="add-client-email" /></label>
      </div>
      <div className="grid sm:grid-cols-3 gap-3">
        <label className="block"><span className="text-xs font-semibold text-slate-600">Monthly price (min ${floor})</span>
          <div className="mt-1 flex items-center h-10 rounded-lg border border-slate-300 bg-white px-3">
            <span className="text-slate-400 text-sm">$</span>
            <input type="number" min={floor} step="1" value={price} onChange={e => setPrice(e.target.value)} className="flex-1 h-full outline-none px-1 text-sm font-mono" data-testid="add-client-price" />
            <span className="text-slate-400 text-xs">/mo</span>
          </div>
          <div className="text-[11px] mt-1 text-emerald-700" data-testid="add-client-margin">You keep {fmtUsd(margin)}/mo</div></label>
        <label className="block"><span className="text-xs font-semibold text-slate-600">Billing</span>
          <select value={cadence} onChange={e => setCadence(e.target.value)} className="mt-1 w-full h-10 rounded-lg border border-slate-300 px-3 text-sm bg-white" data-testid="add-client-cadence">
            <option value="monthly">Monthly</option>
            <option value="annual">Annual ({fmtUsd(cents * 10)}/yr · 2 months free)</option>
          </select></label>
        <label className="block"><span className="text-xs font-semibold text-slate-600">Plan</span>
          <div className="mt-1 h-10 rounded-lg border border-slate-200 bg-slate-100 px-3 text-sm flex items-center text-slate-700">{eligibility.tier_label}</div></label>
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={trial} onChange={e => setTrial(e.target.checked)} className="h-4 w-4 rounded border-slate-300" data-testid="add-client-trial" />
        Start with a {eligibility.trial_days}-day free trial (card collected, charged after trial)
      </label>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onClose} className="h-9 px-4 rounded-full border border-slate-300 text-sm bg-white" data-testid="add-client-cancel">Cancel</button>
        <button type="submit" disabled={busy} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-60" data-testid="add-client-submit">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send invite
        </button>
      </div>
    </form>
  );
}

function ClientRow({ c, floor, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [price, setPrice] = useState(String(c.monthly_cents / 100));
  const [busy, setBusy] = useState(false);
  const st = STATUS[c.status] || STATUS.invited;

  const save = async () => {
    const cents = Math.round(parseFloat(price || "0") * 100);
    setBusy(true);
    try {
      const r = await api.patch(`/affiliate/custom-pricing/clients/${c.id}`, { monthly_cents: cents });
      toast.success(r.data.proration === "create_prorations" ? "Price updated — Stripe will prorate the next invoice" : "Price updated");
      setEditing(false); onChanged();
    } catch (err) { toast.error(err?.response?.data?.detail || "Couldn't update price"); }
    finally { setBusy(false); }
  };
  const resend = async () => {
    setBusy(true);
    try { await api.post(`/affiliate/custom-pricing/clients/${c.id}/resend`); toast.success("Invite re-sent"); onChanged(); }
    catch (err) { toast.error(err?.response?.data?.detail || "Couldn't resend"); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid={`priced-client-${c.id}`}>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-slate-900 truncate">{c.name}</div>
        <div className="text-xs text-slate-500 truncate">{c.email}</div>
      </div>
      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${st.cls}`} data-testid={`priced-client-status-${c.id}`}>{st.label}</span>
      <div className="text-right w-36">
        {editing ? (
          <div className="flex items-center gap-1 justify-end">
            <span className="text-slate-400 text-xs">$</span>
            <input type="number" min={floor} step="1" value={price} onChange={e => setPrice(e.target.value)} className="w-20 h-8 rounded-md border border-slate-300 px-2 text-sm font-mono" data-testid={`priced-client-price-input-${c.id}`} />
            <button onClick={save} disabled={busy} className="h-8 w-8 grid place-items-center rounded-md bg-emerald-600 text-white" data-testid={`priced-client-save-${c.id}`}><Check size={13} /></button>
            <button onClick={() => { setEditing(false); setPrice(String(c.monthly_cents / 100)); }} className="h-8 w-8 grid place-items-center rounded-md border border-slate-300" data-testid={`priced-client-cancel-${c.id}`}><X size={13} /></button>
          </div>
        ) : (
          <>
            <div className="font-mono text-sm font-semibold text-slate-900">{fmtUsd(c.monthly_cents)}<span className="text-xs text-slate-400 font-normal">/mo{c.cadence === "annual" ? " · annual" : ""}</span></div>
            <div className="text-[11px] text-emerald-700">you keep {fmtUsd(c.margin_cents)}/mo</div>
          </>
        )}
      </div>
      {!editing && (
        <div className="flex items-center gap-1">
          <button onClick={() => setEditing(true)} disabled={busy || c.status === "canceled"} title="Change price" className="h-8 w-8 grid place-items-center rounded-md border border-slate-200 text-slate-600 hover:border-slate-400 disabled:opacity-40" data-testid={`priced-client-edit-${c.id}`}><Pencil size={13} /></button>
          {c.status === "invited" && (
            <button onClick={resend} disabled={busy} title="Resend invite" className="h-8 w-8 grid place-items-center rounded-md border border-slate-200 text-slate-600 hover:border-slate-400 disabled:opacity-40" data-testid={`priced-client-resend-${c.id}`}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
