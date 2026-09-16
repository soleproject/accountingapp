import React, { useEffect, useMemo, useState } from "react";
import { useCompany } from "@/lib/company";
import { labApi } from "../lib/labCompareApi";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import { Loader2, RefreshCw, ChevronRight, AlertCircle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

const PAGE_SIZE = 50;

const MOVEMENT_LABELS = {
  internal_transfer:    { label: "Matched transfer",      tone: "verified" },
  card_payment:         { label: "Matched card payment",  tone: "verified" },
  outside_transfer:     { label: "Outside transfer",      tone: "review"   },
  payment_app_transfer: { label: "Payment app",           tone: "review"   },
  credit_line_payment:  { label: "Credit line payment",   tone: "review"   },
  unpaired_transfer:    { label: "Unpaired transfer",     tone: "review"   },
};

const money = (n) => (n == null ? "" : new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 2,
}).format(Number(n)));

const fmtDate = (d) => (d ? String(d).slice(0, 10) : "");


function LabStatusBadge({ movement, confidence }) {
  if (!movement) return <span className="text-xs text-slate-400">—</span>;
  const meta = MOVEMENT_LABELS[movement] || { label: movement, tone: "review" };
  const cls = meta.tone === "verified"
    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
    : "bg-amber-500/15 text-amber-300 border-amber-500/40";
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border ${cls}`}
          data-testid={`lab-status-${movement}`}>
      {meta.tone === "verified"
        ? <CheckCircle2 className="h-3 w-3" />
        : <AlertCircle className="h-3 w-3" />}
      {meta.label}
      {confidence === "low" && <span className="opacity-60">(low)</span>}
    </span>
  );
}


function DiffCell({ children, differs }) {
  return (
    <td className={`px-3 py-2 text-sm ${differs ? "bg-amber-500/10" : ""}`}>
      {children}
    </td>
  );
}


function RawExpansion({ row }) {
  return (
    <div className="bg-slate-900/60 border-t border-slate-800 px-4 py-3 text-xs text-slate-300 space-y-2">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-slate-400 uppercase text-[10px] tracking-wide mb-1">Raw Plaid fields</div>
          <div><b>merchant_name:</b> {row.raw?.merchant_name || <i>—</i>}</div>
          <div><b>original_description:</b> {row.raw?.original_description || <i>—</i>}</div>
          <div><b>merchant_entity_id:</b> {row.raw?.merchant_entity_id || <i>—</i>}</div>
          <div><b>pfc_primary:</b> {row.raw?.pfc_primary || <i>—</i>}</div>
          <div><b>pfc_detailed:</b> {row.raw?.pfc_detailed || <i>—</i>}</div>
          <div><b>transaction_code:</b> {row.raw?.transaction_code || <i>—</i>}</div>
          <div><b>payment_channel:</b> {row.raw?.payment_channel || <i>—</i>}</div>
          <div><b>counterparties:</b> {(row.raw?.counterparties || []).map((c, i) =>
            <Badge key={i} variant="outline" className="mr-1">{c.name} <span className="opacity-50 ml-1">{c.type}</span></Badge>) || <i>—</i>}</div>
        </div>
        <div>
          <div className="text-slate-400 uppercase text-[10px] tracking-wide mb-1">Lab-derived</div>
          <div><b>direction:</b> {row.direction || <i>—</i>}</div>
          <div><b>channel:</b> {row.channel || <i>—</i>}</div>
          <div><b>parsed format:</b> {row.parsed?.format || row.parsed?.format_tag || <i>unknown</i>}</div>
          {row.parsed?.format === "boa_ach" && (
            <div className="mt-1 pl-2 border-l border-slate-700">
              <div><b>originator:</b> {row.parsed.originator}</div>
              <div><b>DES:</b> {row.parsed.des}</div>
              <div><b>ID:</b> {row.parsed.id_value}</div>
              <div><b>INDN:</b> {row.parsed.indn} <span className="text-slate-500">(accountholder, never contact)</span></div>
              <div><b>CO ID:</b> {row.parsed.co_id}</div>
            </div>
          )}
          {row.paypal && (
            <div className="mt-1 pl-2 border-l border-slate-700">
              <div><b>PayPal kind:</b> {row.paypal.kind}</div>
              <div><b>reason:</b> {row.paypal.reason}</div>
            </div>
          )}
          <div className="mt-2"><b>movement_type:</b> {row.lab?.movement_type || <i>none</i>}</div>
          <div><b>movement_reason:</b> {row.lab?.movement_reason || <i>—</i>}</div>
          <div><b>movement_pair_id:</b> {row.lab?.movement_pair_id || <i>—</i>}</div>
          <div><b>linked_lab_account:</b> {row.lab?.linked_lab_account || <i>—</i>}</div>
          {row.raw_overwrites?.length > 0 && (
            <div className="mt-2 text-amber-400"><b>raw overwrites:</b> {row.raw_overwrites.join(", ")}</div>
          )}
        </div>
      </div>
    </div>
  );
}


export default function LabTransactionsCompare() {
  const { currentId: cid } = useCompany();
  const [summary, setSummary] = useState(null);
  const [running, setRunning] = useState(false);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [onlyDifferences, setOnlyDifferences] = useState(false);
  const [movementFilter, setMovementFilter] = useState("");
  const [error, setError] = useState(null);

  const loadSummary = async () => {
    if (!cid) return;
    try {
      const r = await labApi.summary(cid);
      setSummary(r.data);
      setError(null);
    } catch (e) {
      setError(e?.response?.data?.detail || "Feature flag off or not authorized");
    }
  };

  const loadPage = async (p = page) => {
    if (!cid) return;
    setLoading(true);
    try {
      const r = await labApi.compare(cid, {
        page: p, page_size: PAGE_SIZE,
        only_differences: onlyDifferences ? "true" : undefined,
        movement_type: movementFilter || undefined,
      });
      setRows(r.data.rows);
      setTotal(r.data.total);
      setPage(p);
    } catch (e) {
      setError(e?.response?.data?.detail || "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  const runPipeline = async () => {
    setRunning(true);
    try {
      const r = await labApi.run(cid);
      if (r.data?.ok) {
        toast.success(`Ran Phase 1 on ${r.data.scanned} rows in ${r.data.duration_s}s`);
      } else {
        toast.error(r.data?.reason || "Run failed");
      }
      await loadSummary();
      await loadPage(1);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Run failed");
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => { loadSummary(); loadPage(1); /* eslint-disable-next-line */ }, [cid]);
  useEffect(() => { loadPage(1); /* eslint-disable-next-line */ }, [onlyDifferences, movementFilter]);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total]);

  return (
    <div className="p-6 space-y-4" data-testid="lab-compare-page">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">Lab · Live vs. Lab Transactions</h1>
          <p className="text-sm text-slate-300 mt-1">
            Read-only reprocessing of stored Plaid transactions. Live pipeline is unchanged.
          </p>
        </div>
        <Button onClick={runPipeline} disabled={running || !cid} data-testid="lab-run-pipeline">
          {running ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
          Run Phase 1 pipeline
        </Button>
      </div>

      {error && (
        <Card className="border border-red-500/60 bg-red-950/50 p-3 text-sm text-red-100" data-testid="lab-error">
          {error}
        </Card>
      )}

      {summary && (
        <Card className="p-4 bg-slate-900 border border-slate-700" data-testid="lab-summary">
          <div className="grid grid-cols-2 md:grid-cols-6 gap-4 text-sm">
            <div><div className="text-slate-300 text-xs uppercase tracking-wide">Scanned</div><div className="text-2xl font-semibold text-white mt-1">{summary.scanned}</div></div>
            <div><div className="text-slate-300 text-xs uppercase tracking-wide">Matched transfers</div><div className="text-2xl font-semibold text-emerald-400 mt-1">{summary.by_movement_type?.internal_transfer || 0}</div></div>
            <div><div className="text-slate-300 text-xs uppercase tracking-wide">Card payments</div><div className="text-2xl font-semibold text-emerald-400 mt-1">{summary.by_movement_type?.card_payment || 0}</div></div>
            <div><div className="text-slate-300 text-xs uppercase tracking-wide">Unpaired transfers</div><div className="text-2xl font-semibold text-amber-400 mt-1">{summary.by_movement_type?.unpaired_transfer || 0}</div></div>
            <div><div className="text-slate-300 text-xs uppercase tracking-wide">Transfer-gained</div><div className="text-2xl font-semibold text-amber-400 mt-1">{summary.differences?.movement_gained_transfer || 0}</div></div>
            <div><div className="text-slate-300 text-xs uppercase tracking-wide">Transfer-lost</div><div className="text-2xl font-semibold text-amber-400 mt-1">{summary.differences?.movement_lost_transfer || 0}</div></div>
          </div>
        </Card>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-2 text-sm text-slate-200" data-testid="lab-only-diff-toggle">
          <input type="checkbox" checked={onlyDifferences} onChange={(e) => setOnlyDifferences(e.target.checked)} />
          Only differences (transfer gained/lost)
        </label>
        <select className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-sm text-slate-100"
                data-testid="lab-movement-filter"
                value={movementFilter} onChange={(e) => setMovementFilter(e.target.value)}>
          <option value="">All movement types</option>
          {Object.keys(MOVEMENT_LABELS).map((k) => <option key={k} value={k}>{MOVEMENT_LABELS[k].label}</option>)}
        </select>
        <div className="ml-auto text-xs text-slate-300">
          {total} rows · page {page}/{totalPages}
        </div>
      </div>

      <Card className="overflow-hidden border border-slate-700 bg-slate-950">
        {loading ? (
          <div className="p-8 flex items-center justify-center text-slate-300"><Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-slate-400">No rows.</div>
        ) : (
          <table className="w-full text-sm" data-testid="lab-compare-table">
            <thead className="bg-slate-800">
              <tr className="text-left text-slate-100 border-b border-slate-700">
                <th className="px-3 py-2.5 w-6"></th>
                <th className="px-3 py-2.5 font-semibold text-xs uppercase tracking-wide">Date</th>
                <th className="px-3 py-2.5 font-semibold text-xs uppercase tracking-wide">Contact (live)</th>
                <th className="px-3 py-2.5 font-semibold text-xs uppercase tracking-wide">Merchant / Description</th>
                <th className="px-3 py-2.5 font-semibold text-xs uppercase tracking-wide">Category (live)</th>
                <th className="px-3 py-2.5 font-semibold text-xs uppercase tracking-wide text-right">Amount</th>
                <th className="px-3 py-2.5 font-semibold text-xs uppercase tracking-wide">Lab status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const isOpen = expanded === r.txn_id;
                const movementDiffers = r.diff?.movement_gained_transfer || r.diff?.movement_lost_transfer;
                const zebra = idx % 2 === 0 ? "bg-slate-900" : "bg-slate-900/40";
                return (
                  <React.Fragment key={r.txn_id}>
                    <tr className={`border-b border-slate-800 hover:bg-slate-800/60 cursor-pointer ${movementDiffers ? "bg-amber-500/10" : zebra}`}
                        onClick={() => setExpanded(isOpen ? null : r.txn_id)}
                        data-testid={`lab-row-${r.txn_id}`}>
                      <td className="px-3 py-2"><ChevronRight className={`h-3 w-3 text-slate-400 transition-transform ${isOpen ? "rotate-90" : ""}`} /></td>
                      <td className="px-3 py-2 text-slate-200 whitespace-nowrap tabular-nums">{fmtDate(r.date)}</td>
                      <td className="px-3 py-2 text-slate-100">{r.live.contact || <span className="text-slate-500">—</span>}</td>
                      <td className="px-3 py-2 text-slate-100 max-w-[420px] truncate" title={r.description}>
                        <div className="font-medium">{r.merchant || <span className="text-slate-300">{r.description}</span>}</div>
                        {r.merchant && r.description && <div className="text-xs text-slate-400 truncate">{r.description}</div>}
                      </td>
                      <td className="px-3 py-2 text-slate-200">{r.live.category || <span className="text-slate-500">—</span>}</td>
                      <td className={`px-3 py-2 text-right whitespace-nowrap tabular-nums font-medium ${Number(r.amount) < 0 ? "text-rose-300" : "text-emerald-300"}`}>
                        {money(r.amount)}
                      </td>
                      <DiffCell differs={movementDiffers}>
                        <LabStatusBadge movement={r.lab?.movement_type} confidence={r.lab?.movement_confidence} />
                      </DiffCell>
                    </tr>
                    {isOpen && (
                      <tr><td colSpan={7} className="p-0"><RawExpansion row={r} /></td></tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <div className="flex items-center gap-2 justify-center pt-2">
        <Button variant="outline" size="sm" disabled={page <= 1 || loading}
                onClick={() => loadPage(page - 1)} data-testid="lab-prev-page">Prev</Button>
        <span className="text-xs text-slate-400">Page {page} of {totalPages}</span>
        <Button variant="outline" size="sm" disabled={page >= totalPages || loading}
                onClick={() => loadPage(page + 1)} data-testid="lab-next-page">Next</Button>
      </div>
    </div>
  );
}
