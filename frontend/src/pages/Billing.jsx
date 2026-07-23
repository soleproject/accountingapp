import { useEffect, useState } from "react";
import { api, fmtMoney, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";
import {
  CreditCard, DollarSign, TrendingUp, Users, ExternalLink, Loader2,
  CheckCircle2, XCircle, Clock, Award, ArrowUpRight, Wallet,
} from "lucide-react";

/**
 * Billing page — role-aware. Superadmin sees platform revenue + top
 * affiliates, pros see client billing status, everyone sees their own
 * "My Billing" section at the top.
 *
 * The dispatch is intentionally colocated in one file so we can share
 * the money-formatting helpers and stat-card styling without wiring
 * three near-identical routes.
 */
const cents = (c) => fmtMoney((Number(c || 0) / 100));

export default function Billing() {
  const { user } = useAuth();
  return (
    <div className="p-6 max-w-6xl mx-auto" data-testid="billing-page">
      <div className="flex items-center gap-2 text-slate-500 text-sm mb-1">
        <CreditCard size={14} /> Billing
      </div>
      <h1 className="text-2xl font-heading font-bold text-slate-900 mb-6">
        Billing &amp; subscription
      </h1>

      <MyBillingSection />

      {user?.role === "pro" && <ProClientBillingSection />}
      {user?.role === "superadmin" && <SuperadminBillingSection />}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/*  My Billing — everyone                                             */
/* ---------------------------------------------------------------- */
function MyBillingSection() {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get("/billing/me").then(r => setData(r.data)).catch(() => setData({}));
  }, []);

  if (!data) return (
    <div className="p-6 text-slate-400 text-sm">
      <Loader2 size={14} className="inline animate-spin mr-2" /> Loading your billing…
    </div>
  );

  const sub = data.subscription || {};
  const status = sub.status || "none";
  const badge =
    status === "active" ? <StatusBadge color="emerald" icon={CheckCircle2} label="Active" /> :
    status === "canceled" ? <StatusBadge color="rose" icon={XCircle} label="Canceled" /> :
    status === "past_due" ? <StatusBadge color="amber" icon={Clock} label="Past due" /> :
    <StatusBadge color="slate" icon={Clock} label="No subscription" />;

  return (
    <section className="mb-8" data-testid="billing-me-section">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-heading font-semibold text-slate-700 uppercase tracking-wide">My subscription</h2>
      </div>

      <div className="grid md:grid-cols-3 gap-3 mb-4">
        <Stat label="Status" value={badge} />
        <Stat label="Lifetime paid" value={cents(data.total_paid_cents)} />
        <Stat label="Invoices" value={(data.payments || []).length} />
      </div>

      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <div className="font-medium text-slate-700 text-sm">Payment history</div>
          {sub.stripe_customer_id && (
            <span className="text-[11px] font-mono text-slate-400">
              cust {sub.stripe_customer_id.slice(0, 14)}…
            </span>
          )}
        </div>
        {(!data.payments || data.payments.length === 0) ? (
          <div className="p-8 text-center text-slate-400 text-sm">
            No payments yet. When your subscription is charged, invoices will appear here.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Paid at</th>
                <th className="text-left px-4 py-2 font-medium">Amount</th>
                <th className="text-left px-4 py-2 font-medium">Currency</th>
                <th className="text-right px-4 py-2 font-medium">Invoice</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.payments.map(p => (
                <tr key={p.id} data-testid={`billing-me-row-${p.id}`}>
                  <td className="px-4 py-2 text-slate-600">{fmtDate(p.paid_at)}</td>
                  <td className="px-4 py-2 font-medium text-slate-900 tabular-nums">{cents(p.amount_cents)}</td>
                  <td className="px-4 py-2 uppercase text-slate-500">{p.currency}</td>
                  <td className="px-4 py-2 text-right">
                    {p.hosted_invoice_url && (
                      <a
                        href={p.hosted_invoice_url} target="_blank" rel="noreferrer"
                        className="inline-flex items-center gap-1 text-cyan-700 hover:underline text-xs"
                      >
                        View <ExternalLink size={11} />
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- */
/*  Pro — client billing overview                                     */
/* ---------------------------------------------------------------- */
function ProClientBillingSection() {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    api.get("/billing/pro/clients")
      .then(r => setRows(r.data?.clients || []))
      .catch(() => setRows([]));
  }, []);

  const totalGross = (rows || []).reduce((s, r) => s + (r.total_paid_cents || 0), 0);
  const activeCount = (rows || []).filter(r => r.subscription_status === "active").length;

  return (
    <section className="mb-8" data-testid="billing-pro-section">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-heading font-semibold text-slate-700 uppercase tracking-wide">Client billing</h2>
      </div>
      <div className="grid md:grid-cols-3 gap-3 mb-4">
        <Stat label="Active clients" value={activeCount} icon={Users} />
        <Stat label="Total collected" value={cents(totalGross)} icon={DollarSign} />
        <Stat label="Clients tracked" value={(rows || []).length} icon={TrendingUp} />
      </div>
      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        {rows === null ? (
          <div className="p-8 text-center text-slate-400 text-sm">
            <Loader2 size={14} className="inline animate-spin mr-2" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-slate-500 text-sm">
            No clients with Stripe billing yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Client</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-left px-4 py-2 font-medium">Invoices</th>
                <th className="text-right px-4 py-2 font-medium">Lifetime paid</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(r => (
                <tr key={r.id} data-testid={`billing-pro-row-${r.id}`}>
                  <td className="px-4 py-2">
                    <div className="font-medium text-slate-900">{r.name || "—"}</div>
                    <div className="text-xs text-slate-500">{r.email}</div>
                  </td>
                  <td className="px-4 py-2">
                    <SubStatusBadge status={r.subscription_status} />
                  </td>
                  <td className="px-4 py-2 text-slate-600 tabular-nums">{r.invoice_count}</td>
                  <td className="px-4 py-2 text-right font-medium text-slate-900 tabular-nums">
                    {cents(r.total_paid_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- */
/*  Superadmin — platform revenue                                    */
/* ---------------------------------------------------------------- */
function SuperadminBillingSection() {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(new Set());

  const load = () =>
    api.get("/billing/superadmin").then(r => setData(r.data)).catch(() => setData({}));

  useEffect(() => { load(); }, []);

  const markPaid = async () => {
    if (selected.size === 0) return;
    try {
      const r = await api.post("/billing/superadmin/mark-paid", {
        earning_ids: Array.from(selected),
      });
      toast.success(`Marked ${r.data.updated} earning(s) as paid out`);
      setSelected(new Set());
      load();
    } catch (e) {
      toast.error("Failed to mark as paid");
    }
  };

  if (!data) return (
    <div className="p-6 text-slate-400 text-sm">
      <Loader2 size={14} className="inline animate-spin mr-2" /> Loading platform revenue…
    </div>
  );

  const t = data.totals || {};

  return (
    <section className="mb-8" data-testid="billing-superadmin-section">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-heading font-semibold text-slate-700 uppercase tracking-wide">Platform revenue</h2>
      </div>
      <div className="grid md:grid-cols-4 gap-3 mb-6">
        <Stat label="Gross revenue" value={cents(t.gross_revenue_cents)} icon={DollarSign} accent="emerald" />
        <Stat label="Net revenue" value={cents(t.net_revenue_cents)} icon={TrendingUp} accent="cyan" />
        <Stat label="Active subs" value={t.active_subscribers ?? 0} icon={Users} />
        <Stat label="Referral owed" value={cents(t.referral_accrued_cents)} icon={Award} accent="amber" />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 font-medium text-slate-700 text-sm">
            Recent payments
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {(data.recent_payments || []).length === 0 ? (
              <div className="p-6 text-center text-slate-400 text-sm">No payments yet.</div>
            ) : (
              <table className="w-full text-sm">
                <tbody className="divide-y divide-slate-100">
                  {data.recent_payments.map(p => (
                    <tr key={p.id} data-testid={`sa-recent-row-${p.id}`}>
                      <td className="px-4 py-2 text-xs text-slate-500">{fmtDate(p.paid_at)}</td>
                      <td className="px-4 py-2 font-mono text-[11px] text-slate-400 truncate max-w-[180px]">
                        {p.stripe_invoice_id}
                      </td>
                      <td className="px-4 py-2 text-right font-medium text-slate-900 tabular-nums">
                        {cents(p.amount_cents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <span className="font-medium text-slate-700 text-sm">Top affiliates</span>
            <span className="text-[11px] text-slate-400">
              paid out lifetime: {cents(t.referral_paid_out_cents)}
            </span>
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {(data.top_affiliates || []).length === 0 ? (
              <div className="p-6 text-center text-slate-400 text-sm">
                No referral earnings yet. When someone signs up via a referral link and pays, credits accrue here.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Affiliate</th>
                    <th className="text-right px-4 py-2 font-medium">Owed</th>
                    <th className="text-right px-4 py-2 font-medium">Paid out</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.top_affiliates.map(a => (
                    <tr key={a.referrer_user_id} data-testid={`sa-aff-row-${a.referrer_user_id}`}>
                      <td className="px-4 py-2">
                        <div className="font-medium text-slate-900 text-xs">{a.name || "—"}</div>
                        <div className="text-[11px] text-slate-500">{a.email}</div>
                      </td>
                      <td className="px-4 py-2 text-right font-medium text-amber-700 tabular-nums">
                        {cents(a.accrued_cents)}
                      </td>
                      <td className="px-4 py-2 text-right text-slate-500 tabular-nums text-xs">
                        {cents(a.paid_out_cents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- */
/*  Shared primitives                                                */
/* ---------------------------------------------------------------- */
function Stat({ label, value, icon: Icon, accent = "slate" }) {
  const tone = {
    slate: "text-slate-700 bg-slate-50 border-slate-100",
    emerald: "text-emerald-700 bg-emerald-50 border-emerald-100",
    cyan: "text-cyan-700 bg-cyan-50 border-cyan-100",
    amber: "text-amber-700 bg-amber-50 border-amber-100",
  }[accent];
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4">
      <div className="flex items-start gap-3">
        {Icon && (
          <div className={`w-8 h-8 rounded-md flex items-center justify-center border ${tone}`}>
            <Icon size={14} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
          <div className="text-xl font-heading font-bold text-slate-900 tabular-nums truncate">
            {value}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ color, icon: Icon, label }) {
  const tone = {
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-100",
    rose: "bg-rose-50 text-rose-700 border-rose-100",
    amber: "bg-amber-50 text-amber-700 border-amber-100",
    slate: "bg-slate-50 text-slate-500 border-slate-100",
  }[color];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium ${tone}`}>
      <Icon size={11} /> {label}
    </span>
  );
}

function SubStatusBadge({ status }) {
  if (!status) return <span className="text-xs text-slate-400">—</span>;
  const map = {
    active: { color: "emerald", icon: CheckCircle2, label: "Active" },
    canceled: { color: "rose", icon: XCircle, label: "Canceled" },
    past_due: { color: "amber", icon: Clock, label: "Past due" },
    trialing: { color: "cyan", icon: Clock, label: "Trialing" },
  };
  const s = map[status] || { color: "slate", icon: Clock, label: status };
  return <StatusBadge {...s} />;
}
