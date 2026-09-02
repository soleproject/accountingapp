import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Percent, Building2, Tag, Receipt } from "lucide-react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import TaxLibrary from "@/pages/TaxLibrary";

// Sales Tax Center — unifies Rates, Agencies, Codes, and Payments in a
// single destination. Rates CRUD (New / Edit / Delete / Import CSV)
// now lives INLINE inside the Rates tab (Feb 2026) — the former
// stand-alone Tax Library page redirects here. Agencies / Codes /
// Payments remain read-only summaries.
export default function SalesTax() {
  const { currentId } = useCompany();
  const [tab, setTab] = useState("rates");
  const [rates, setRates] = useState([]);
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentId) return;
    setLoading(true);
    Promise.all([
      api.get(`/companies/${currentId}/taxes`).catch(() => ({ data: { taxes: [] } })),
      api.get(`/companies/${currentId}/transactions?limit=1000`).catch(() => ({ data: { transactions: [] } })),
    ]).then(([r, t]) => {
      setRates(r.data.taxes || []);
      const all = t.data.transactions || [];
      // The Sales Tax Payment synthesizer posts JEs with a memo of
      // "QBO Sales Tax Payment"; also include any manual Purchase
      // txns whose category is a `sales_tax_payable` account.
      setPayments(all.filter(x =>
        (x.memo || "").toLowerCase().includes("sales tax") ||
        x.txn_type === "SalesTaxPayment"
      ));
    }).finally(() => setLoading(false));
  }, [currentId]);

  // Roll agencies up from tax_rates (each rate carries `agency_name`).
  const agencies = useMemo(() => {
    const map = new Map();
    rates.forEach((r) => {
      const name = r.agency_name || "—";
      const cur = map.get(name) || { name, rate_count: 0, total_rate: 0 };
      cur.rate_count += 1;
      cur.total_rate += Number(r.rate || 0);
      map.set(name, cur);
    });
    return Array.from(map.values());
  }, [rates]);

  return (
    <div className="space-y-4" data-testid="sales-tax-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">
            Sales Tax Center
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Rates, agencies, codes, and payments — sales tax and other tax rates in one place.
          </p>
        </div>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={Percent} label="Tax Rates" value={rates.length} tint="amber" />
        <StatCard icon={Building2} label="Agencies" value={agencies.length} tint="indigo" />
        <StatCard icon={Tag} label="Tax Codes"
                   value={"—"} tint="slate"
                   hint="Populated via QBO import" />
        <StatCard icon={Receipt} label="Sales Tax Payments" value={payments.length} tint="emerald" />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {[
          ["rates",    "Rates",     Percent],
          ["agencies", "Agencies",  Building2],
          ["codes",    "Codes",     Tag],
          ["payments", "Payments",  Receipt],
        ].map(([k, l, Icon]) => (
          <button key={k} onClick={() => setTab(k)}
                   className={`inline-flex items-center gap-1.5 px-3 py-2
                              text-sm border-b-2 -mb-px ${
                     tab === k
                       ? "border-indigo-600 text-indigo-600 font-medium"
                       : "border-transparent text-slate-500 hover:text-slate-700"
                   }`}
                   data-testid={`sales-tax-tab-${k}`}>
            <Icon className="w-4 h-4" /> {l}
          </button>
        ))}
      </div>

      {/* Panels */}
      {tab === "rates" && (
        <TaxLibrary embedded />
      )}
      {tab === "agencies" && (
        <SimpleTable
          cols={["Agency", "Rate Count", "Combined Rate"]}
          rows={agencies.map(a => [
            a.name, a.rate_count, `${a.total_rate.toFixed(3)}%`,
          ])}
          empty="No agencies. Agencies are inferred from imported rates."
          loading={loading}
        />
      )}
      {tab === "codes" && (
        <div className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500">
          Tax Codes are populated on QBO migration. When available they
          appear here as combinations of rates by jurisdiction.
        </div>
      )}
      {tab === "payments" && (
        <SimpleTable
          cols={["Date", "Vendor / Agency", "Ref #", "Amount"]}
          rows={payments.map(p => [
            p.date, p.contact_name || "—", p.number || "—",
            `$${Math.abs(Number(p.amount || 0)).toLocaleString(undefined,
              { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          ])}
          empty="No sales tax payments yet. Payments show up here once you record a payment to a tax agency (or after a QBO import synthesizes them)."
          loading={loading}
          rightAlignLast
        />
      )}
    </div>
  );
}


function StatCard({ icon: Icon, label, value, tint, hint }) {
  const tints = {
    amber: "bg-amber-100 text-amber-600",
    indigo: "bg-indigo-100 text-indigo-600",
    emerald: "bg-emerald-100 text-emerald-600",
    slate: "bg-slate-100 text-slate-500",
  };
  return (
    <div className="rounded-xl border bg-white p-3 flex items-center gap-3">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${tints[tint]}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div>
        <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
        <div className="text-lg font-semibold">{value}</div>
        {hint && <div className="text-[10px] text-slate-400 leading-tight">{hint}</div>}
      </div>
    </div>
  );
}


function SimpleTable({ cols, rows, empty, loading, rightAlignLast }) {
  return (
    <div className="rounded-xl border bg-white overflow-hidden">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-slate-500">
          <tr>
            {cols.map((c, i) => (
              <th key={i}
                   className={`px-4 py-2.5 font-medium uppercase text-[11px] tracking-wide ${
                     rightAlignLast && i === cols.length - 1 ? "text-right" : "text-left"
                   }`}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr><td colSpan={cols.length} className="px-4 py-6 text-center text-slate-400">Loading…</td></tr>
          )}
          {!loading && rows.length === 0 && (
            <tr><td colSpan={cols.length} className="px-4 py-10 text-center text-slate-500 text-sm">{empty}</td></tr>
          )}
          {rows.map((r, i) => (
            <tr key={i} className="border-t hover:bg-slate-50">
              {r.map((v, j) => (
                <td key={j}
                     className={`px-4 py-2 ${
                       rightAlignLast && j === r.length - 1
                         ? "text-right font-mono tabular-nums" : ""
                     }`}>
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
