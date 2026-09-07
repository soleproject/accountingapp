import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Loader2, ChevronLeft } from "lucide-react";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt, useDateFmt } from "@/lib/company";
import ReportExportMenu from "@/components/ReportExportMenu";

/**
 * Standard A/R Aging Report — QBO-parity layout.
 * Shows outstanding customer invoices bucketed by days-past-due
 * (Current / 1-30 / 31-60 / 61-90 / 90+) with an optional customer-grouped
 * view and a browser-native print button that produces a clean report.
 *
 * Data source: GET /api/companies/{cid}/reports/ar-aging?as_of=YYYY-MM-DD
 */
const BUCKETS = [
  { key: "current", label: "Current",   color: "emerald" },
  { key: "1_30",    label: "1–30",      color: "amber"   },
  { key: "31_60",   label: "31–60",     color: "orange"  },
  { key: "61_90",   label: "61–90",     color: "red"     },
  { key: "over_90", label: "90+",       color: "rose"    },
];
const TEXT = {
  emerald: "text-emerald-700", amber: "text-amber-700",
  orange: "text-orange-700", red: "text-red-700", rose: "text-rose-700",
};

export default function ArAgingReport() {
  return <AgingReport kind="ar" />;
}

export function AgingReport({ kind }) {
  const { currentId } = useCompany();
  const fmtMoney = useMoneyFmt();
  const fmtDate = useDateFmt();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [asOf, setAsOf] = useState(
    params.get("as_of") || new Date().toISOString().slice(0, 10)
  );
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [groupBy, setGroupBy] = useState(params.get("group") || "customer");

  const isAr = kind === "ar";
  const title    = isAr ? "A/R Aging" : "A/P Aging (Bills to Pay)";
  const subtitle = isAr
    ? "Outstanding customer invoices bucketed by days past due."
    : "Outstanding vendor bills bucketed by days past due — plan payments accordingly.";
  const partyLabel = isAr ? "Customer" : "Vendor";
  const listLabel  = isAr ? "Invoice"  : "Bill";
  const listPath   = isAr ? "invoices" : "bills";
  const exportBase = currentId ? `/companies/${currentId}/reports/${kind}-aging` : "";
  const exportName = isAr ? "ar_aging" : "ap_aging";

  useEffect(() => {
    if (!currentId) return;
    setLoading(true);
    api
      .get(`/companies/${currentId}/reports/${kind}-aging`, { params: { as_of: asOf } })
      .then(r => setData(r.data))
      .catch(e => {
        toast.error(e.response?.data?.detail || `Failed to load ${title}`);
        setData(null);
      })
      .finally(() => setLoading(false));
  }, [currentId, asOf, kind, title]);

  // Persist filters to URL so print / share works.
  useEffect(() => {
    const p = new URLSearchParams(params);
    p.set("as_of", asOf);
    p.set("group", groupBy);
    setParams(p, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asOf, groupBy]);

  const grouped = useMemo(() => {
    if (!data?.lines) return [];
    if (groupBy === "none") return null;
    const by = new Map();
    for (const l of data.lines) {
      const key = l.contact_name || "(no contact)";
      if (!by.has(key)) by.set(key, { name: key, lines: [], totals: {} });
      by.get(key).lines.push(l);
    }
    // Fill per-customer bucket totals.
    for (const g of by.values()) {
      for (const b of BUCKETS) g.totals[b.key] = 0;
      g.totals.total = 0;
      for (const l of g.lines) {
        g.totals[l.bucket] = (g.totals[l.bucket] || 0) + l.balance_due;
        g.totals.total += l.balance_due;
      }
    }
    return Array.from(by.values()).sort((a, b) => b.totals.total - a.totals.total);
  }, [data, groupBy]);

  const onPrint = () => window.print();

  return (
    <div className="space-y-4 print-report">
      <div className="flex items-center justify-between flex-wrap gap-3 print:hidden">
        <div>
          <div className="text-xs text-slate-500 mb-1">
            <Link to="/reports" className="inline-flex items-center gap-1 hover:underline">
              <ChevronLeft size={12} /> Reports
            </Link>
          </div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">{title}</h1>
          <p className="text-slate-500 text-sm mt-1">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500 inline-flex items-center gap-1">
            As of
            <input
              type="date" value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              className="border rounded px-2 py-1 text-sm"
              data-testid={`${kind}-aging-as-of`}
            />
          </label>
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value)}
            className="border rounded px-2 py-1 text-sm"
            data-testid={`${kind}-aging-group-by`}
          >
            <option value="customer">Group by {partyLabel.toLowerCase()}</option>
            <option value="none">Flat list</option>
          </select>
          <ReportExportMenu
            basePath={exportBase}
            filename={exportName}
            params={{ as_of: asOf }}
            testIdPrefix={`${kind}-aging-export`}
          />
        </div>
      </div>

      {loading && (
        <div className="rounded-xl border bg-white p-8 text-center text-slate-500">
          <Loader2 className="inline animate-spin mr-2" size={16} /> Loading…
        </div>
      )}

      {!loading && data && (
        <>
          <div className="rounded-xl border bg-white p-5">
            <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
              <div>
                <div className="font-heading font-semibold text-lg">{data.company_name || title}</div>
                <div className="text-xs text-slate-500">
                  {title} · As of <span className="font-mono-num">{data.as_of}</span>
                </div>
              </div>
              <div className="text-sm text-slate-600">
                Total outstanding: <span className="font-mono-num font-semibold text-slate-900">{fmtMoney(data.total || 0)}</span>
              </div>
            </div>
            {/* Bucket summary strip */}
            <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
              {BUCKETS.map(b => {
                const amt = data.buckets?.[b.key] || 0;
                const pct = data.total ? (amt / data.total) * 100 : 0;
                return (
                  <div key={b.key} className="rounded-lg border p-3 bg-slate-50/40">
                    <div className={`text-[10px] uppercase tracking-wider font-semibold ${TEXT[b.color]}`}>{b.label}</div>
                    <div className={`font-mono-num text-base font-semibold mt-0.5 ${TEXT[b.color]}`}>{fmtMoney(amt)}</div>
                    <div className="text-[10px] text-slate-500 mt-0.5">{pct.toFixed(0)}% of total</div>
                  </div>
                );
              })}
              <div className="rounded-lg border p-3 bg-slate-900 text-white">
                <div className="text-[10px] uppercase tracking-wider font-semibold text-white/80">Total</div>
                <div className="font-mono-num text-base font-semibold mt-0.5">{fmtMoney(data.total || 0)}</div>
                <div className="text-[10px] text-white/60 mt-0.5">Outstanding {isAr ? "A/R" : "A/P"}</div>
              </div>
            </div>
          </div>

          {/* Detail — grouped by customer or flat */}
          <div className="rounded-xl border bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase text-slate-500 border-b">
                <tr>
                  <th className="px-3 py-2 text-left">{listLabel} #</th>
                  <th className="px-3 py-2 text-left">{partyLabel}</th>
                  <th className="px-3 py-2 text-left">Issue date</th>
                  <th className="px-3 py-2 text-left">Due date</th>
                  <th className="px-3 py-2 text-right">Days past due</th>
                  {BUCKETS.map(b => (
                    <th key={b.key} className={`px-3 py-2 text-right ${TEXT[b.color]}`}>{b.label}</th>
                  ))}
                  <th className="px-3 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {(!data.lines || !data.lines.length) && (
                  <tr>
                    <td colSpan={5 + BUCKETS.length + 1} className="text-center py-10 text-slate-500">
                      Nothing outstanding as of {data.as_of}. 🎉
                    </td>
                  </tr>
                )}

                {groupBy === "customer" && grouped && grouped.map(g => (
                  <RenderCustomerGroup
                    key={g.name}
                    group={g}
                    fmtMoney={fmtMoney}
                    fmtDate={fmtDate}
                    listPath={listPath}
                    navigate={navigate}
                  />
                ))}

                {groupBy === "none" && data.lines.map(l => (
                  <tr key={l.id} className="border-b hover:bg-slate-50">
                    <td className="px-3 py-2 font-mono-num text-indigo-700">
                      <button
                        onClick={() => navigate(`/${listPath}/${l.id}/edit`)}
                        className="hover:underline"
                        data-testid={`${kind}-aging-row-${l.number}`}
                      >{l.number || l.id.slice(0, 6)}</button>
                    </td>
                    <td className="px-3 py-2">{l.contact_name || "—"}</td>
                    <td className="px-3 py-2 font-mono-num text-slate-600">{fmtDate(l.issue_date)}</td>
                    <td className="px-3 py-2 font-mono-num text-slate-600">{fmtDate(l.due_date)}</td>
                    <td className="px-3 py-2 text-right font-mono-num">{l.days_past_due}</td>
                    {BUCKETS.map(b => (
                      <td key={b.key} className="px-3 py-2 text-right font-mono-num">
                        {b.key === l.bucket ? fmtMoney(l.balance_due) : ""}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right font-mono-num font-semibold">{fmtMoney(l.balance_due)}</td>
                  </tr>
                ))}

                {data.lines && data.lines.length > 0 && (
                  <tr className="bg-slate-100 font-semibold border-t-2 border-slate-300">
                    <td className="px-3 py-2" colSpan={4}>Grand total</td>
                    <td></td>
                    {BUCKETS.map(b => (
                      <td key={b.key} className="px-3 py-2 text-right font-mono-num">
                        {fmtMoney(data.buckets?.[b.key] || 0)}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(data.total || 0)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function RenderCustomerGroup({ group, fmtMoney, fmtDate, listPath, navigate }) {
  return (
    <>
      <tr className="bg-slate-50/70">
        <td colSpan={9 + 0} className="px-3 py-2 font-semibold text-slate-800">
          {group.name}
        </td>
      </tr>
      {group.lines.map(l => (
        <tr key={l.id} className="border-b hover:bg-slate-50">
          <td className="px-3 py-2 font-mono-num text-indigo-700">
            <button
              onClick={() => navigate(`/${listPath}/${l.id}/edit`)}
              className="hover:underline"
            >{l.number || l.id.slice(0, 6)}</button>
          </td>
          <td className="px-3 py-2 text-slate-500 text-xs">{l.contact_name || "—"}</td>
          <td className="px-3 py-2 font-mono-num text-slate-600">{fmtDate(l.issue_date)}</td>
          <td className="px-3 py-2 font-mono-num text-slate-600">{fmtDate(l.due_date)}</td>
          <td className="px-3 py-2 text-right font-mono-num">{l.days_past_due}</td>
          {BUCKETS.map(b => (
            <td key={b.key} className="px-3 py-2 text-right font-mono-num">
              {b.key === l.bucket ? fmtMoney(l.balance_due) : ""}
            </td>
          ))}
          <td className="px-3 py-2 text-right font-mono-num font-semibold">{fmtMoney(l.balance_due)}</td>
        </tr>
      ))}
      <tr className="bg-slate-50 font-medium border-b">
        <td className="px-3 py-2 text-xs uppercase text-slate-500" colSpan={4}>
          Subtotal — {group.name}
        </td>
        <td></td>
        {BUCKETS.map(b => (
          <td key={b.key} className="px-3 py-2 text-right font-mono-num">
            {fmtMoney(group.totals[b.key] || 0)}
          </td>
        ))}
        <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(group.totals.total)}</td>
      </tr>
    </>
  );
}
