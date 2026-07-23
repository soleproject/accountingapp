import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import {
  Activity, DollarSign, Users, TrendingUp, Zap, Loader2, ChevronRight,
  Building2, UserRound,
} from "lucide-react";

/**
 * Superadmin — AI Usage & Costs.
 *
 * Rolls up every billable event (LLM tokens, Veryfi OCR, Resend emails,
 * Plaid linked items) into a single spend dashboard. The mockup this
 * matches (rocketsuite reference) sets the visual grammar:
 *
 *   [ range chips ]
 *   [ category chips ]
 *   [ 4 KPI cards ]
 *   [ By Feature ]   [ All Cost Categories ]
 *
 * Costs are stored in cents (float) on the backend to survive fractional
 * per-token pricing; formatting is done once here at the boundary so the
 * ledger stays precise.
 */
const RANGES = [
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "month", label: "This month" },
];

const CATEGORIES = [
  { key: "all", label: "All categories" },
  { key: "llm", label: "llm" },
  { key: "bank", label: "bank" },
  { key: "email", label: "email" },
  { key: "ocr", label: "ocr" },
];

const money = (cents) => {
  const dollars = (Number(cents) || 0) / 100;
  if (dollars >= 100) return `$${dollars.toFixed(2)}`;
  if (dollars >= 0.01) return `$${dollars.toFixed(2)}`;
  if (dollars > 0) return `$${dollars.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
  return "$0.00";
};
const compact = (n) => Number(n || 0).toLocaleString();

const SERVICE_LABEL = {
  openai_llm: "OpenAI — LLM tokens",
  anthropic_llm: "Anthropic — LLM tokens",
  veryfi_ocr: "Veryfi OCR",
  resend_email: "Resend email",
  plaid_linked_item: "Plaid linked items",
};

export default function SuperadminUsage() {
  const [range, setRange] = useState("month");
  const [category, setCategory] = useState("all");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.get(`/admin/usage?range=${range}${category !== "all" ? `&category=${category}` : ""}`)
      .then(r => { setData(r.data); setLoading(false); })
      .catch(() => { setData({}); setLoading(false); });
  }, [range, category]);

  const totals = data?.totals || {};
  const byFeature = data?.by_feature || [];
  const byService = data?.by_service || [];
  const byCategory = data?.by_category || [];
  const byCompany = data?.by_company || [];
  const byUser = data?.by_user || [];
  const expected = data?.expected_services || [];

  // Category chip totals — sum from byCategory response (unfiltered).
  const catTotals = useMemo(() => {
    const m = {};
    for (const r of byCategory) m[r.category] = r.cost_cents;
    return m;
  }, [byCategory]);

  // Merge expected + actual services so unused integrations still appear.
  const mergedServices = useMemo(() => {
    const byKey = new Map();
    for (const s of expected) byKey.set(s.service, { ...s, cost_cents: 0, quantity: 0, unit: s.unit, events: 0 });
    for (const s of byService) byKey.set(s.service, { ...(byKey.get(s.service) || {}), ...s });
    return Array.from(byKey.values());
  }, [expected, byService]);

  return (
    <div className="p-6 max-w-7xl mx-auto" data-testid="usage-page">
      <div className="flex items-center gap-2 text-slate-500 text-sm mb-1">
        <Activity size={14} /> SuperAdmin · Usage &amp; Costs
      </div>
      <h1 className="text-2xl font-heading font-bold text-slate-900 mb-4">
        Usage &amp; Costs
      </h1>

      {/* Date range chips */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {RANGES.map(r => (
          <button
            key={r.key}
            data-testid={`usage-range-${r.key}`}
            onClick={() => setRange(r.key)}
            className={`px-3 py-1.5 rounded-md border text-sm transition ${
              range === r.key
                ? "bg-white border-cyan-300 text-cyan-800 ring-1 ring-cyan-200"
                : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* Category chips */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        {CATEGORIES.map(c => {
          const active = category === c.key;
          const chipCost = c.key === "all" ? totals.cost_cents : catTotals[c.key];
          return (
            <button
              key={c.key}
              data-testid={`usage-cat-${c.key}`}
              onClick={() => setCategory(c.key)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition ${
                active
                  ? "bg-slate-900 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {c.label}
              {chipCost !== undefined && (
                <span className={`ml-1.5 tabular-nums ${active ? "text-slate-300" : "text-slate-400"}`}>
                  · {money(chipCost || 0)}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <KpiCard label="Total cost" value={money(totals.cost_cents)} icon={DollarSign} accent="emerald" />
        <KpiCard label="Total events" value={compact(totals.events)} icon={Zap} accent="cyan" />
        <KpiCard label="Unique users" value={compact(totals.unique_users)} icon={Users} accent="indigo" />
        <KpiCard
          label="Avg cost / event"
          value={
            totals.events && totals.events > 0
              ? `$${(totals.cost_cents / totals.events / 100).toFixed(6).replace(/0+$/, "").replace(/\.$/, "") || "0"}`
              : "$0.00"
          }
          icon={TrendingUp} accent="amber"
        />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* By Feature */}
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden" data-testid="usage-by-feature">
          <div className="px-4 py-3 border-b border-slate-100 font-medium text-slate-700 text-sm flex items-center justify-between">
            <span>By Feature <span className="text-slate-400 font-normal">({rangeLabel(range)})</span></span>
            {loading && <Loader2 size={13} className="animate-spin text-slate-400" />}
          </div>
          {byFeature.length === 0 ? (
            <div className="p-8 text-center text-slate-400 text-sm">
              {loading ? "Loading…" : "No AI events in this range yet."}
            </div>
          ) : (
            <div className="max-h-[520px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide sticky top-0">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Feature</th>
                    <th className="text-right px-4 py-2 font-medium">Events</th>
                    <th className="text-right px-4 py-2 font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {byFeature.map(f => (
                    <tr key={f.feature} data-testid={`feature-row-${f.feature}`}>
                      <td className="px-4 py-2 font-mono text-xs text-slate-700">{f.feature}</td>
                      <td className="px-4 py-2 text-right text-slate-600 tabular-nums">{compact(f.events)}</td>
                      <td className="px-4 py-2 text-right font-medium text-slate-900 tabular-nums">
                        {money(f.cost_cents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* All Cost Categories (services) */}
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden" data-testid="usage-by-service">
          <div className="px-4 py-3 border-b border-slate-100 font-medium text-slate-700 text-sm">
            All Cost Categories <span className="text-slate-400 font-normal">({rangeLabel(range)})</span>
          </div>
          <div className="max-h-[520px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide sticky top-0">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Service</th>
                  <th className="text-right px-4 py-2 font-medium">Quantity</th>
                  <th className="text-right px-4 py-2 font-medium">Rate</th>
                  <th className="text-right px-4 py-2 font-medium">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {mergedServices.map(s => (
                  <ServiceRow key={s.service} row={s} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Per Enterprise (Company) + Per User */}
      <div className="grid lg:grid-cols-2 gap-4 mt-4">
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden" data-testid="usage-by-company">
          <div className="px-4 py-3 border-b border-slate-100 font-medium text-slate-700 text-sm flex items-center gap-2">
            <Building2 size={14} className="text-slate-400" />
            By Enterprise
            <span className="text-slate-400 font-normal ml-1">({rangeLabel(range)})</span>
          </div>
          {byCompany.length === 0 ? (
            <div className="p-8 text-center text-slate-400 text-sm">
              {loading ? "Loading…" : "No enterprise events in this range yet."}
            </div>
          ) : (
            <div className="max-h-[520px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide sticky top-0">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Enterprise</th>
                    <th className="text-right px-4 py-2 font-medium">Users</th>
                    <th className="text-right px-4 py-2 font-medium">Events</th>
                    <th className="text-right px-4 py-2 font-medium">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {byCompany.map(c => (
                    <tr key={c.company_id} data-testid={`company-row-${c.company_id}`}>
                      <td className="px-4 py-2">
                        <div className="font-medium text-slate-900 text-sm">{c.name || "—"}</div>
                        {c.plaid_items > 0 && (
                          <div className="text-[11px] text-slate-500">
                            AI ${(c.cost_cents / 100).toFixed(4).replace(/0+$/, "").replace(/\.$/, "") || "0"} · Plaid ${(c.plaid_cost_cents / 100).toFixed(2)} ({c.plaid_items} item{c.plaid_items === 1 ? "" : "s"})
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right text-slate-600 tabular-nums text-xs">{compact(c.unique_users || 0)}</td>
                      <td className="px-4 py-2 text-right text-slate-600 tabular-nums text-xs">{compact(c.events)}</td>
                      <td className="px-4 py-2 text-right font-medium text-slate-900 tabular-nums">
                        {money(c.total_cost_cents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden" data-testid="usage-by-user">
          <div className="px-4 py-3 border-b border-slate-100 font-medium text-slate-700 text-sm flex items-center gap-2">
            <UserRound size={14} className="text-slate-400" />
            By User
            <span className="text-slate-400 font-normal ml-1">({rangeLabel(range)})</span>
          </div>
          {byUser.length === 0 ? (
            <div className="p-8 text-center text-slate-400 text-sm">
              {loading ? "Loading…" : "No user-attributed events in this range yet."}
            </div>
          ) : (
            <div className="max-h-[520px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide sticky top-0">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">User</th>
                    <th className="text-left px-4 py-2 font-medium">Role</th>
                    <th className="text-right px-4 py-2 font-medium">Events</th>
                    <th className="text-right px-4 py-2 font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {byUser.map(u => (
                    <tr key={u.user_id} data-testid={`user-row-${u.user_id}`}>
                      <td className="px-4 py-2">
                        <div className="font-medium text-slate-900 text-sm">{u.name || "—"}</div>
                        <div className="text-[11px] text-slate-500">{u.email || u.user_id}</div>
                      </td>
                      <td className="px-4 py-2">
                        <RoleBadge role={u.role} />
                      </td>
                      <td className="px-4 py-2 text-right text-slate-600 tabular-nums text-xs">{compact(u.events)}</td>
                      <td className="px-4 py-2 text-right font-medium text-slate-900 tabular-nums">
                        {money(u.cost_cents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
function KpiCard({ label, value, icon: Icon, accent }) {
  const tone = {
    emerald: "text-emerald-700 bg-emerald-50 border-emerald-100",
    cyan: "text-cyan-700 bg-cyan-50 border-cyan-100",
    indigo: "text-indigo-700 bg-indigo-50 border-indigo-100",
    amber: "text-amber-700 bg-amber-50 border-amber-100",
  }[accent];
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4">
      <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{label}</div>
      <div className="flex items-baseline gap-2">
        <div className="text-2xl font-heading font-bold text-slate-900 tabular-nums">{value}</div>
        {Icon && (
          <div className={`ml-auto w-8 h-8 rounded-md flex items-center justify-center border ${tone}`}>
            <Icon size={14} />
          </div>
        )}
      </div>
    </div>
  );
}

function ServiceRow({ row }) {
  const label = SERVICE_LABEL[row.service] || row.service;
  const cost = row.cost_cents || 0;
  const dim = cost === 0;
  const quantity = row.quantity ?? 0;
  const rate = row.unit_price_usd;

  // For LLM (per-token pricing), show a per-1M rate for readability
  // based on the model actually recorded on the row.
  const LLM_RATES_PER_1M = {
    "gpt-4o-mini": 0.15,
    "gpt-4o": 2.50,
    "gpt-4.1-mini": 0.40,
    "gpt-4.1": 2.00,
    "gpt-5": 2.50,
    "gpt-5-mini": 0.25,
    "claude-sonnet-4-5-20250929": 3.00,
    "claude-haiku-4-5-20251001": 1.00,
  };
  const rateDisplay = row.service.endsWith("_llm")
    ? (row.model && LLM_RATES_PER_1M[row.model] !== undefined
        ? `$${LLM_RATES_PER_1M[row.model].toFixed(2)} / 1M`
        : "—")
    : (rate !== undefined && rate !== null
        ? `$${Number(rate).toFixed(rate < 0.01 ? 6 : 4)} / ${row.unit || "unit"}`
        : "—");

  const qtyDisplay = quantity > 0
    ? `${compact(quantity)} ${row.unit || (row.service.endsWith("_llm") ? "tokens" : "")}`
    : "—";

  return (
    <tr data-testid={`service-row-${row.service}`} className={dim ? "opacity-50" : ""}>
      <td className="px-4 py-2">
        <div className="font-medium text-slate-900 text-sm">{label}</div>
        <div className="text-[11px] text-slate-400">
          / {row.unit || "unit"}
        </div>
      </td>
      <td className="px-4 py-2 text-right text-slate-600 tabular-nums text-xs">{qtyDisplay}</td>
      <td className="px-4 py-2 text-right text-slate-500 tabular-nums text-xs">{rateDisplay}</td>
      <td className="px-4 py-2 text-right font-medium text-slate-900 tabular-nums">
        {money(cost)}
      </td>
    </tr>
  );
}

function rangeLabel(key) {
  return RANGES.find(r => r.key === key)?.label || key;
}

function RoleBadge({ role }) {
  if (!role) return <span className="text-xs text-slate-400">—</span>;
  const tone = {
    superadmin: "bg-indigo-50 text-indigo-700 border-indigo-100",
    pro: "bg-cyan-50 text-cyan-700 border-cyan-100",
    client: "bg-emerald-50 text-emerald-700 border-emerald-100",
  }[role] || "bg-slate-50 text-slate-600 border-slate-100";
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-medium uppercase tracking-wide ${tone}`}>
      {role}
    </span>
  );
}
