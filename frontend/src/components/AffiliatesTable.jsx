/**
 * AffiliatesTable — shared affiliate directory used by Superadmin
 * (/admin/affiliates, platform-wide, can reassign firm) and by the
 * firm-scoped views on the Partner dashboard + Pro Settings.
 *
 * Props:
 *   base          — API base: "/admin/affiliates" | "/firm/affiliates"
 *   canReassign   — show inline firm picker (superadmin only)
 *   showFirmColumn— hide for firm-scoped views (always the same firm)
 */
import { Fragment, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  Search, Loader2, Copy, Check, ChevronDown, ChevronRight, Users, Building2,
  MousePointerClick, Inbox, UserPlus, DollarSign, ExternalLink,
} from "lucide-react";

const money = (c) => `$${((c || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—");

function Stat({ label, value, Icon, testId }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2" data-testid={testId}>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-slate-400 font-semibold">
        <Icon size={11} /> {label}
      </div>
      <div className="text-lg font-semibold text-slate-900 tabular-nums">{value}</div>
    </div>
  );
}

function CopyBtn({ text, testId }) {
  const [ok, setOk] = useState(false);
  if (!text) return <span className="text-slate-300">—</span>;
  return (
    <button
      type="button"
      onClick={async (e) => { e.stopPropagation(); await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1200); }}
      className="inline-flex items-center gap-1 text-[11px] text-cyan-700 hover:underline"
      title={text}
      data-testid={testId}
    >
      {ok ? <Check size={11} /> : <Copy size={11} />} {ok ? "Copied" : "Copy link"}
    </button>
  );
}

function Detail({ base, uid }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    api.get(`${base}/${uid}`).then(r => setD(r.data)).catch(() => setD({ error: true }));
  }, [base, uid]);
  if (!d) return <div className="p-4 text-xs text-slate-400"><Loader2 size={12} className="inline animate-spin mr-1" /> Loading…</div>;
  if (d.error) return <div className="p-4 text-xs text-rose-600">Couldn't load detail.</div>;
  return (
    <div className="grid md:grid-cols-2 gap-4 p-4 bg-slate-50/60" data-testid={`affiliate-detail-${uid}`}>
      <div>
        <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold mb-2">Referrals ({d.referred.length})</div>
        {d.referred.length === 0 ? (
          <div className="text-xs text-slate-400">No signups yet.</div>
        ) : (
          <table className="w-full text-xs">
            <tbody className="divide-y divide-slate-100">
              {d.referred.map(r => (
                <tr key={r.id} data-testid={`affiliate-referral-${r.id}`}>
                  <td className="py-1.5 pr-2">
                    <div className="font-medium text-slate-800">{r.name || r.email}</div>
                    <div className="text-slate-400">{r.email} · {fmtDate(r.created_at)}</div>
                  </td>
                  <td className="py-1.5 text-right whitespace-nowrap">
                    {r.paying
                      ? <span className="inline-flex px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">paying · {money(r.earned_cents)}</span>
                      : <span className="inline-flex px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">signed up</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold mb-2">Earnings ({d.earnings.length})</div>
        {d.earnings.length === 0 ? (
          <div className="text-xs text-slate-400">No commissions yet.</div>
        ) : (
          <table className="w-full text-xs">
            <tbody className="divide-y divide-slate-100">
              {d.earnings.slice(0, 25).map(e => (
                <tr key={e.id}>
                  <td className="py-1.5 pr-2 text-slate-600">{fmtDate(e.created_at)}</td>
                  <td className="py-1.5 pr-2 text-slate-500 truncate max-w-[180px]">{e.stripe_invoice_id || e.platform_payment_id || "—"}</td>
                  <td className="py-1.5 text-right tabular-nums font-medium text-slate-800">{money(e.share_cents)}</td>
                  <td className="py-1.5 pl-2 text-right">
                    <span className={`inline-flex px-1.5 py-0.5 rounded border ${e.status === "paid_out" ? "bg-slate-100 text-slate-600 border-slate-200" : "bg-amber-50 text-amber-800 border-amber-200"}`}>
                      {e.status === "paid_out" ? "paid" : "pending"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {d.leads.length > 0 && (
          <div className="mt-3 text-xs text-slate-500">{d.leads.length} lead{d.leads.length === 1 ? "" : "s"} captured · {d.clicks} link click{d.clicks === 1 ? "" : "s"}</div>
        )}
      </div>
    </div>
  );
}

export default function AffiliatesTable({ base, canReassign = false, showFirmColumn = true }) {
  const [data, setData] = useState(null);
  const [q, setQ] = useState("");
  const [firm, setFirm] = useState("");
  const [open, setOpen] = useState(null);
  const [saving, setSaving] = useState(null);

  const load = () => {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (firm) p.set("firm", firm);
    api.get(`${base}?${p.toString()}`).then(r => setData(r.data)).catch(() => setData({ items: [], totals: {}, firms: [] }));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [firm]);

  const assign = async (uid, slug) => {
    setSaving(uid);
    try {
      await api.patch(`/admin/affiliates/${uid}/firm`, { firm_slug: slug || null });
      toast.success(slug ? `Assigned to ${slug}` : "Firm cleared");
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't reassign");
    } finally { setSaving(null); }
  };

  if (!data) return <div className="p-6 text-sm text-slate-400"><Loader2 size={14} className="inline animate-spin mr-2" /> Loading affiliates…</div>;
  const t = data.totals || {};
  const rows = data.items || [];

  return (
    <div className="space-y-4" data-testid="affiliates-table">
      {data.no_firm && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="affiliates-no-firm">
          Set a sign-in address (private-label subdomain) in Branding first — affiliates are matched to your firm by that slug.
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <Stat label="Affiliates" value={t.affiliates || 0} Icon={Users} testId="aff-stat-affiliates" />
        <Stat label="Clicks" value={t.clicks || 0} Icon={MousePointerClick} testId="aff-stat-clicks" />
        <Stat label="Leads" value={t.leads || 0} Icon={Inbox} testId="aff-stat-leads" />
        <Stat label="Signups" value={t.signups || 0} Icon={UserPlus} testId="aff-stat-signups" />
        <Stat label="Paying" value={t.paying || 0} Icon={DollarSign} testId="aff-stat-paying" />
        <Stat label="Pending payout" value={money(t.pending_cents)} Icon={DollarSign} testId="aff-stat-pending" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={(e) => { e.preventDefault(); load(); }} className="relative flex-1 min-w-[220px]">
          <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search name, email, slug, firm…"
            className="w-full pl-8 pr-3 py-2 text-sm border border-slate-300 rounded-md bg-white focus:ring-1 focus:ring-cyan-500 focus:border-cyan-500"
            data-testid="affiliates-search"
          />
        </form>
        {showFirmColumn && (data.firms || []).length > 0 && (
          <select
            value={firm}
            onChange={e => setFirm(e.target.value)}
            className="text-sm border border-slate-300 rounded-md bg-white px-2 py-2"
            data-testid="affiliates-firm-filter"
          >
            <option value="">All firms</option>
            {data.firms.map(f => <option key={f.slug} value={f.slug}>{f.name}</option>)}
          </select>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-slate-500 bg-slate-50 border-b">
                <th className="text-left px-3 py-2 font-semibold">Affiliate</th>
                <th className="text-left px-3 py-2 font-semibold">Link</th>
                {showFirmColumn && <th className="text-left px-3 py-2 font-semibold">Firm</th>}
                <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Joined</th>
                <th className="text-right px-3 py-2 font-semibold">Clicks</th>
                <th className="text-right px-3 py-2 font-semibold">Leads</th>
                <th className="text-right px-3 py-2 font-semibold">Signups</th>
                <th className="text-right px-3 py-2 font-semibold">Paying</th>
                <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Earned / Pending</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.length === 0 && (
                <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-400 text-sm" data-testid="affiliates-empty">No affiliates yet.</td></tr>
              )}
              {rows.map(r => {
                const isOpen = open === r.user_id;
                return (
                  <Fragment key={r.user_id}>
                    <tr
                      onClick={() => setOpen(isOpen ? null : r.user_id)}
                      className={`cursor-pointer hover:bg-slate-50 ${isOpen ? "bg-cyan-50/40" : ""}`}
                      data-testid={`affiliate-row-${r.user_id}`}
                    >
                      <td className="px-3 py-2 align-top">
                        <div className="flex items-start gap-1.5">
                          {isOpen ? <ChevronDown size={14} className="mt-0.5 text-slate-400" /> : <ChevronRight size={14} className="mt-0.5 text-slate-400" />}
                          <div>
                            <div className="font-medium text-slate-900">{r.name || r.email}</div>
                            <div className="text-[11px] text-slate-500">{r.email}
                              {r.role !== "affiliate" && <span className="ml-1.5 inline-flex px-1 rounded bg-slate-100 text-slate-600 uppercase text-[9px] tracking-wider">{r.role}</span>}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <div className="font-mono text-[11px] text-slate-700">{r.slug || "—"}</div>
                        <CopyBtn text={r.link} testId={`affiliate-copy-${r.user_id}`} />
                      </td>
                      {showFirmColumn && (
                        <td className="px-3 py-2 align-top" onClick={e => e.stopPropagation()}>
                          {canReassign ? (
                            <select
                              value={r.firm_slug || ""}
                              disabled={saving === r.user_id}
                              onChange={e => assign(r.user_id, e.target.value)}
                              className={`text-xs border rounded-md px-1.5 py-1 bg-white ${r.firm_slug ? "border-slate-300" : "border-amber-300 text-amber-800"}`}
                              data-testid={`affiliate-firm-picker-${r.user_id}`}
                            >
                              <option value="">Platform (no firm)</option>
                              {(data.firms || []).map(f => <option key={f.slug} value={f.slug}>{f.name}</option>)}
                            </select>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-slate-700"><Building2 size={11} /> {r.firm_name || "Platform"}</span>
                          )}
                        </td>
                      )}
                      <td className="px-3 py-2 align-top text-xs text-slate-600 whitespace-nowrap">{fmtDate(r.created_at)}</td>
                      <td className="px-3 py-2 align-top text-right tabular-nums">{r.clicks}</td>
                      <td className="px-3 py-2 align-top text-right tabular-nums">{r.leads}</td>
                      <td className="px-3 py-2 align-top text-right tabular-nums">{r.signups}</td>
                      <td className="px-3 py-2 align-top text-right tabular-nums">{r.paying}</td>
                      <td className="px-3 py-2 align-top text-right tabular-nums whitespace-nowrap">
                        <span className="font-medium text-slate-900">{money(r.earned_cents)}</span>
                        <span className="text-slate-400"> / </span>
                        <span className={r.pending_cents > 0 ? "text-amber-700" : "text-slate-500"}>{money(r.pending_cents)}</span>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={9} className="p-0 border-t border-slate-100"><Detail base={base} uid={r.user_id} /></td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="text-[11px] text-slate-400 inline-flex items-center gap-1">
        <ExternalLink size={10} /> Includes anyone with a referral link who has activity — pros and clients too, not only affiliate accounts.
      </div>
    </div>
  );
}
