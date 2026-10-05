// Superadmin "Delete client" popup: purge each owned company (type the
// company name), then "Delete user" (type their email) which demotes the
// account to affiliate — referral link, earnings and /share stay intact.
import { useEffect, useState } from "react";
import { AlertTriangle, ArrowRightLeft, Building2, Check, Loader2, Lock, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

const norm = (s) => String(s || "").replace(/[\s\u00A0]+/g, " ").trim().toLowerCase();
const fmt = (n) => (n || 0).toLocaleString();

function CompanyRow({ uid, company, onDeleted }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = norm(typed) === norm(company.name);
  const top = Object.entries(company.data || {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const del = async () => {
    setBusy(true);
    try {
      await api.delete(`/admin/users/${uid}/companies/${company.id}`, { data: { confirm: typed } });
      toast.success(`${company.name} deleted`);
      onDeleted();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't delete company");
    } finally { setBusy(false); }
  };
  return (
    <div className="grid md:grid-cols-[1fr_auto] gap-3 items-start rounded-lg border border-slate-200 bg-white px-3 py-2.5" data-testid={`delete-client-company-${company.id}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 font-medium text-slate-900"><Building2 size={13} className="text-slate-400" /> {company.name}</div>
        <div className="text-[11px] text-slate-500 mt-0.5">
          {fmt(company.records)} records · {top.map(([k, v]) => `${k} ${fmt(v)}`).join(" · ")}
          {company.stripe_subscription_id && <span className="ml-1 text-amber-700">· has Stripe subscription</span>}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input
          value={typed}
          onChange={e => setTyped(e.target.value)}
          placeholder="Type company name to confirm"
          className={`w-60 h-9 px-3 rounded-md border text-sm font-mono focus:outline-none focus:ring-2 ${ok ? "border-rose-300 focus:ring-rose-200" : "border-slate-200 focus:ring-slate-200"}`}
          data-testid={`delete-client-company-input-${company.id}`}
        />
        <button
          type="button"
          disabled={!ok || busy}
          onClick={del}
          className="h-9 px-3 rounded-md bg-rose-600 text-white text-xs font-semibold hover:bg-rose-700 disabled:opacity-40 inline-flex items-center gap-1"
          data-testid={`delete-client-company-btn-${company.id}`}
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Delete
        </button>
      </div>
    </div>
  );
}

function TransferBlock({ userId, block, onDone }) {
  const [target, setTarget] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const isPartner = block.kind === "partner";
  const tgt = (block.targets || []).find(t => t.id === target);
  const ok = tgt && norm(typed) === norm(tgt.name);
  const summary = isPartner
    ? `${fmt(block.enterprises)} enterprise(s), ${fmt(block.companies)} companies, ${fmt(block.users)} users`
    : `${fmt(block.companies)} companies, ${fmt(block.users)} users, ${fmt(block.invoices)} invoice records`;
  const transfer = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/admin/users/${userId}/transfer-firm`, { target_id: target, confirm_name: typed });
      const m = r.data?.moved || {};
      toast.success(`Transferred to ${tgt.name} — ${fmt(m.companies)} companies, ${fmt(m.users)} users moved.`);
      onDone();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Transfer failed");
    } finally { setBusy(false); }
  };
  return (
    <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900" data-testid="delete-client-enterprise-block">
      <b>{isPartner ? "Partner" : "Enterprise"} owner — {block.name}</b> still has {summary} under it.
      Transfer them to another {isPartner ? "partner" : "enterprise"} to unlock Delete user.
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span>Transfer users to</span>
        <select
          value={target}
          onChange={e => { setTarget(e.target.value); setTyped(""); }}
          className="h-8 px-2 rounded-md border border-amber-300 bg-white text-xs text-slate-800"
          data-testid="delete-client-transfer-select"
        >
          <option value="">Choose {isPartner ? "a partner" : "an enterprise"}…</option>
          {(block.targets || []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        {tgt && (
          <>
            <input
              value={typed}
              onChange={e => setTyped(e.target.value)}
              placeholder={`Type "${tgt.name}" to confirm`}
              className="h-8 w-56 px-2 rounded-md border border-amber-300 bg-white text-xs font-mono text-slate-800 focus:outline-none focus:ring-2 focus:ring-amber-200"
              data-testid="delete-client-transfer-input"
            />
            <button
              type="button"
              disabled={!ok || busy}
              onClick={transfer}
              className="h-8 px-3 rounded-md bg-amber-600 text-white text-xs font-semibold hover:bg-amber-700 disabled:opacity-40 inline-flex items-center gap-1"
              data-testid="delete-client-transfer-btn"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <ArrowRightLeft size={12} />} Transfer
            </button>
          </>
        )}
      </div>
      {(block.targets || []).length === 0 && (
        <div className="mt-1.5 text-amber-800">No other {isPartner ? "partner" : "enterprise with an owner"} exists to transfer to — create one first.</div>
      )}
      <div className="mt-1.5 text-[11px] text-amber-800/80">
        Future {isPartner ? "partner" : "enterprise"} billing follows the target owner's Stripe customer. Their own {isPartner ? "Partner" : "Firm"} Books becomes a regular company you can delete below.
      </div>
    </div>
  );
}

export default function DeleteClientModal({ userId, onClose, onChanged }) {
  const [p, setP] = useState(null);
  const [emailTyped, setEmailTyped] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => api.get(`/admin/users/${userId}/deletion-preview`).then(r => setP(r.data)).catch(() => setP({ error: true }));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [userId]);

  if (!userId) return null;
  const u = p?.user || {};
  const block = p?.enterprise_block;
  const locked = !p || !p.can_delete_user;
  const emailOk = emailTyped.trim().toLowerCase() === (u.email || "").toLowerCase();

  const deleteUser = async () => {
    setBusy(true);
    try {
      await api.post(`/admin/users/${userId}/delete`, { confirm_email: emailTyped.trim() });
      toast.success(`${u.email} removed — their affiliate link and earnings are untouched.`);
      onChanged?.();
      onClose();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't delete user");
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-slate-900/40 backdrop-blur-[2px] p-4" data-testid="delete-client-modal">
      <div className="w-[min(760px,96vw)] max-h-[92vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-2xl p-6 relative">
        <button type="button" onClick={onClose} className="absolute top-3 right-3 p-1.5 rounded-md hover:bg-slate-100" aria-label="Close" data-testid="delete-client-close"><X size={16} /></button>
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-rose-600 font-semibold"><AlertTriangle size={13} /> Danger zone</div>
        <h3 className="text-lg font-semibold text-slate-900 mt-1">Delete client</h3>
        {!p ? (
          <div className="py-8 text-sm text-slate-400"><Loader2 size={14} className="inline animate-spin mr-2" /> Loading…</div>
        ) : p.error ? (
          <div className="py-6 text-sm text-rose-600">Couldn't load this user.</div>
        ) : (
          <>
            <p className="text-sm text-slate-500 mt-1">
              <b className="text-slate-800">{u.name || u.email}</b> · {u.email} · <span className="uppercase text-[10px] tracking-wider">{u.role}</span>
            </p>

            {/* Delete user — locked until no owned companies / no firm */}
            <div className={`mt-5 rounded-lg border px-3 py-3 ${locked ? "border-slate-200 bg-slate-50" : "border-rose-200 bg-rose-50/40"}`} data-testid="delete-client-user-row">
              <div className="grid md:grid-cols-[1fr_auto] gap-3 items-center">
                <div>
                  <div className="flex items-center gap-1.5 font-medium text-slate-900">
                    {locked ? <Lock size={13} className="text-slate-400" /> : <Trash2 size={13} className="text-rose-600" />} Delete user
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    Removes all company access and firm links. Keeps their sign-in, affiliate link
                    {p.referral?.slug ? <> (<span className="font-mono">{p.referral.slug}</span>)</> : null}
                    , {fmt(p.referral?.earnings)} commission records and Refer &amp; earn access.
                    {p.other_memberships > 0 && <> Also removes {p.other_memberships} seat{p.other_memberships === 1 ? "" : "s"} on other companies.</>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    value={emailTyped}
                    onChange={e => setEmailTyped(e.target.value)}
                    disabled={locked}
                    placeholder="Type user email to confirm"
                    className="w-60 h-9 px-3 rounded-md border border-slate-200 text-sm font-mono disabled:bg-slate-100 disabled:text-slate-400 focus:outline-none focus:ring-2 focus:ring-rose-200"
                    data-testid="delete-client-user-input"
                  />
                  <button
                    type="button"
                    disabled={locked || !emailOk || busy}
                    onClick={deleteUser}
                    className="h-9 px-3 rounded-md bg-rose-600 text-white text-xs font-semibold hover:bg-rose-700 disabled:opacity-40 inline-flex items-center gap-1"
                    data-testid="delete-client-user-btn"
                  >
                    {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Delete
                  </button>
                </div>
              </div>
              {block && (
                <TransferBlock userId={userId} block={block} onDone={() => { load(); onChanged?.(); }} />
              )}
              {!block && p.owned_companies.length > 0 && (
                <div className="mt-2 text-[11px] text-slate-500 inline-flex items-center gap-1"><Lock size={11} /> Unlocks once every company below is deleted.</div>
              )}
              {!locked && (
                <div className="mt-2 text-[11px] text-emerald-700 inline-flex items-center gap-1" data-testid="delete-client-user-unlocked"><Check size={11} /> No companies owned — user can be deleted.</div>
              )}
            </div>

            {/* Owned companies */}
            <div className="mt-5 text-[11px] uppercase tracking-widest text-slate-400 font-semibold">Companies owned ({p.owned_companies.length})</div>
            <div className="mt-2 space-y-2">
              {p.owned_companies.length === 0 && <div className="text-sm text-slate-400">None.</div>}
              {p.owned_companies.map(c => (
                <CompanyRow key={c.id} uid={userId} company={c} onDeleted={() => { load(); onChanged?.(); }} />
              ))}
            </div>

            <div className="mt-5 flex justify-end">
              <button type="button" onClick={onClose} className="px-4 py-2 rounded-full border border-slate-200 bg-white text-sm text-slate-600 hover:text-slate-900" data-testid="delete-client-cancel">Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
