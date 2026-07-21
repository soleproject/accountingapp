import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtMoney } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { toast } from "sonner";
import {
  CheckCircle2, Loader2, Upload, FileText, Sparkles, ArrowRight,
  CalendarDays, Building2, Plus, ChevronRight, X,
} from "lucide-react";

// Reconciliation — Slice R1+R2+R3.
// R1 (Plaid auto-clear) runs invisibly on every sync + on-demand via the
// "Auto-clear settled Plaid txns" button on this page. R2 (manual matching)
// is the checkable list on the left with a live difference readout. R3
// (statement-PDF fuzzy matching) is behind the "Match statement PDF" upload.
export default function Reconciliation() {
  const { currentId } = useCompany();
  const [banks, setBanks] = useState([]);
  const [acctId, setAcctId] = useState("");
  // Freeform date range — pro reconciles anything from a single week to a
  // multi-year backfill. On Finish, the backend splits the range into ONE
  // reconciliation doc per calendar month so the history table stays
  // per-month even for large imports.
  const [periodStart, setPeriodStart] = useState(() => {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 10);
  });
  const [periodEnd, setPeriodEnd] = useState(() => {
    const d = new Date(); d.setDate(0);  // last day of previous month
    return d.toISOString().slice(0, 10);
  });
  const asOf = periodEnd;
  const [openBal, setOpenBal] = useState("");
  const [closeBal, setCloseBal] = useState("");
  const [preview, setPreview] = useState(null);
  const [checked, setChecked] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState([]);
  const [matchResult, setMatchResult] = useState(null);
  const [showMatchModal, setShowMatchModal] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const fileRef = useRef(null);

  // Load bank/CC accounts + past reconciliations once we know the company.
  const load = async () => {
    if (!currentId) return;
    const [a, r] = await Promise.all([
      api.get(`/companies/${currentId}/accounts`),
      api.get(`/companies/${currentId}/reconciliations`),
    ]);
    const asset = (a.data.accounts || []).filter(
      x => x.type === "asset" || x.type === "liability"
    );
    setBanks(asset);
    if (asset.length && !acctId) setAcctId(asset[0].id);
    setHistory(r.data.reconciliations || []);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId]);

  // Debounced preview refresh whenever the user changes any of the 3 inputs.
  useEffect(() => {
    if (!currentId || !acctId || !asOf) return;
    let cancelled = false;
    setLoading(true);
    setChecked(new Set());
    const t = setTimeout(async () => {
      try {
        const r = await api.get(`/companies/${currentId}/reconciliations/preview`, {
          params: {
            bank_account_id: acctId, as_of: asOf,
            opening_balance: parseFloat(openBal) || 0,
            closing_balance: parseFloat(closeBal) || 0,
          },
        });
        if (!cancelled) setPreview(r.data);
      } catch (e) {
        if (!cancelled) toast.error(e.response?.data?.detail || "Preview failed");
      } finally { if (!cancelled) setLoading(false); }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [currentId, acctId, asOf, openBal, closeBal]);

  const clearedSum = useMemo(() => {
    if (!preview) return 0;
    return (preview.uncleared || [])
      .filter(t => checked.has(t.id))
      .reduce((s, t) => s + Number(t.amount || 0), 0);
  }, [preview, checked]);

  // Classic recon math:  closing − opening − sum(cleared) == 0  when done.
  const diffLive = useMemo(() => {
    const op = parseFloat(openBal) || 0;
    const cl = parseFloat(closeBal) || 0;
    return round2(cl - op - clearedSum);
  }, [openBal, closeBal, clearedSum]);
  const isBalanced = Math.abs(diffLive) < 0.005;

  const toggle = (id) => {
    setChecked(c => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };
  const tickAll = () => {
    if (!preview) return;
    setChecked(new Set(preview.uncleared.map(t => t.id)));
  };
  const untickAll = () => setChecked(new Set());

  const finish = async () => {
    if (!isBalanced) return;
    setBusy(true);
    try {
      const r = await api.post(`/companies/${currentId}/reconciliations/complete`, {
        bank_account_id: acctId,
        period_start: periodStart,
        period_end: periodEnd,
        opening_balance: parseFloat(openBal) || 0,
        closing_balance: parseFloat(closeBal) || 0,
        cleared_txn_ids: [...checked],
      });
      const n = r.data?.count || 1;
      toast.success(
        n > 1
          ? `Reconciled ${checked.size} transactions across ${n} monthly reports.`
          : `Reconciled ${checked.size} transactions.`
      );
      setOpenBal(""); setCloseBal("");
      setChecked(new Set());
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Finish failed");
    } finally { setBusy(false); }
  };

  const runAutoClear = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/companies/${currentId}/reconciliations/auto-clear`);
      toast.success(`Auto-cleared ${r.data.cleared} Plaid transactions.`);
      // Refresh preview so newly-cleared items disappear from the list.
      setStmtBal(s => s);  // trigger the debounced reload
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Auto-clear failed");
    } finally { setBusy(false); }
  };

  const uploadStatement = async (file) => {
    if (!file || !acctId) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("bank_account_id", acctId);
      const r = await api.post(
        `/companies/${currentId}/reconciliations/match-statement`,
        fd,
        { headers: { "Content-Type": "multipart/form-data" }, timeout: 120_000 },
      );
      setMatchResult(r.data);
      setShowMatchModal(true);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Statement matching failed");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="space-y-4" data-testid="reconciliation-page">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Reconciliation</h1>
          <p className="text-slate-500 text-sm mt-1">
            {history.length} reconciliation period{history.length === 1 ? "" : "s"} · Plaid txns auto-clear after 5 days.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={runAutoClear}
            disabled={busy || !currentId}
            data-testid="recon-auto-clear-btn"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border bg-white hover:bg-slate-50 disabled:opacity-40"
          >
            <Sparkles size={13} className="text-cyan-600" /> Auto-clear settled Plaid txns
          </button>
          {!startOpen && (
            <button
              onClick={() => setStartOpen(true)}
              data-testid="recon-start-new-btn"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-slate-900 text-white hover:bg-slate-800"
            >
              <Plus size={13} /> Start reconciliation
            </button>
          )}
        </div>
      </div>

      {/* Collapsible: start-new interactive matcher */}
      {startOpen && (
        <div className="rounded-xl border bg-white overflow-hidden" data-testid="recon-start-new">
          <div className="flex items-center justify-between px-4 py-2 border-b bg-slate-50">
            <div className="font-heading font-semibold text-sm">New reconciliation</div>
            <div className="flex items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.csv,image/*"
                onChange={(e) => uploadStatement(e.target.files?.[0])}
                className="hidden"
                data-testid="recon-statement-input"
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={busy || !acctId}
                data-testid="recon-match-statement-btn"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border hover:bg-slate-50 disabled:opacity-40"
              >
                <Upload size={13} /> Match statement PDF
              </button>
              <button
                onClick={() => setStartOpen(false)}
                data-testid="recon-close-new-btn"
                className="p-1.5 rounded-md hover:bg-slate-100"
                title="Close"
              >
                <X size={14} className="text-slate-500" />
              </button>
            </div>
          </div>

          <div className="p-4 space-y-4">
            {/* Setup */}
            <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
              <div className="md:col-span-1">
                <div className="text-xs text-slate-500 mb-1 flex items-center gap-1">
                  <Building2 size={12} /> Bank account
                </div>
                <select
                  value={acctId}
                  onChange={(e) => setAcctId(e.target.value)}
                  className="w-full border rounded-md px-2 py-1.5 text-sm"
                  data-testid="recon-account-select"
                >
                  {banks.map(b => <option key={b.id} value={b.id}>{b.code} {b.name}</option>)}
                </select>
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1 flex items-center gap-1">
                  <CalendarDays size={12} /> Statement start
                </div>
                <input
                  type="date" value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                  className="w-full border rounded-md px-2 py-1.5 text-sm"
                  data-testid="recon-period-start"
                />
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1 flex items-center gap-1">
                  <CalendarDays size={12} /> Statement end
                </div>
                <input
                  type="date" value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                  className="w-full border rounded-md px-2 py-1.5 text-sm"
                  data-testid="recon-period-end"
                />
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1">Opening balance</div>
                <input
                  type="number" step="0.01" value={openBal}
                  onChange={(e) => setOpenBal(e.target.value)}
                  placeholder="e.g. 0.00"
                  className="w-full border rounded-md px-2 py-1.5 text-sm font-mono-num"
                  data-testid="recon-open-balance"
                />
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1">Ending balance</div>
                <input
                  type="number" step="0.01" value={closeBal}
                  onChange={(e) => setCloseBal(e.target.value)}
                  placeholder="e.g. 12450.31"
                  className="w-full border rounded-md px-2 py-1.5 text-sm font-mono-num"
                  data-testid="recon-close-balance"
                />
              </div>
            </div>
            {spansMultipleMonths(periodStart, periodEnd) && (
              <div className="text-[11px] text-cyan-800 bg-cyan-50 border border-cyan-100 rounded px-3 py-1.5">
                This range spans multiple months. On Finish, we'll create <b>one reconciliation report per month</b> automatically.
              </div>
            )}

            {/* Live scoreboard + list */}
            {preview && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="lg:col-span-2 rounded-xl border overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2 border-b bg-slate-50">
                    <div className="text-xs uppercase tracking-widest text-slate-500">
                      Uncleared through {periodEnd} · {preview.uncleared.length}
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <button onClick={tickAll} className="text-cyan-700 hover:underline" data-testid="recon-tick-all">Check all</button>
                      <span className="text-slate-300">·</span>
                      <button onClick={untickAll} className="text-slate-500 hover:underline" data-testid="recon-untick-all">Clear</button>
                    </div>
                  </div>
                  <div className="max-h-[500px] overflow-y-auto">
                    {loading && (
                      <div className="p-8 text-center text-slate-500 text-sm">
                        <Loader2 size={16} className="animate-spin inline mr-2" />Loading…
                      </div>
                    )}
                    {!loading && preview.uncleared.length === 0 && (
                      <div className="p-8 text-center text-slate-500 text-sm">
                        Nothing to clear — everything through {periodEnd} is already reconciled. 🎉
                      </div>
                    )}
                    {!loading && preview.uncleared.map(t => (
                      <label key={t.id}
                        className="flex items-center gap-3 px-4 py-2 border-b last:border-b-0 hover:bg-slate-50 cursor-pointer text-sm"
                        data-testid={`recon-row-${t.id}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked.has(t.id)}
                          onChange={() => toggle(t.id)}
                          className="accent-slate-900"
                        />
                        <span className="w-24 text-slate-500 font-mono-num text-xs">{t.date}</span>
                        <span className="flex-1 truncate">{t.description}</span>
                        <span className="text-slate-400 text-xs truncate max-w-[160px]">{t.category_account_name}</span>
                        <span className={`font-mono-num tabular-nums w-28 text-right ${Number(t.amount) < 0 ? "text-red-700" : "text-emerald-700"}`}>
                          {fmtMoney(t.amount)}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
                <ScoreboardCard
                  preview={preview} clearedCount={checked.size} clearedSum={clearedSum}
                  opening={parseFloat(openBal) || 0}
                  closing={parseFloat(closeBal) || 0}
                  diff={diffLive} isBalanced={isBalanced}
                  onFinish={async () => { await finish(); setStartOpen(false); }} busy={busy}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* History table — primary surface */}
      <div className="rounded-xl border bg-white overflow-hidden" data-testid="recon-history">
        <table className="w-full text-sm">
          <thead className="text-[11px] uppercase text-slate-500 border-b bg-slate-50">
            <tr>
              <th className="px-4 py-2 text-left">Period</th>
              <th className="px-4 py-2 text-left">Account</th>
              <th className="px-4 py-2 text-center">Status</th>
              <th className="px-4 py-2 text-right">Statement</th>
              <th className="px-4 py-2 text-right">Ledger</th>
              <th className="px-4 py-2 text-right">Diff</th>
              <th className="px-4 py-2 w-8" />
            </tr>
          </thead>
          <tbody>
            {history.length === 0 && (
              <tr><td colSpan={7} className="text-center py-10 text-slate-500 text-sm">
                No reconciliations yet. Hit "+ Start reconciliation" or "Auto-clear settled Plaid txns" to begin.
              </td></tr>
            )}
            {history.map(r => (
              <tr key={r.id} className="border-b last:border-b-0 hover:bg-slate-50 cursor-pointer" data-testid={`recon-history-row-${r.id}`}>
                <td className="px-4 py-2 font-mono-num text-xs text-cyan-700">
                  <Link to={`/accounting/reconciliation/${r.id}`} className="hover:underline">
                    {formatPeriodLabel(r.period_start, r.period_end, r.as_of)}
                  </Link>
                </td>
                <td className="px-4 py-2">
                  <Link to={`/accounting/reconciliation/${r.id}`} className="hover:underline">
                    {r.account_name || "—"}{r.account_last4 ? ` ···${r.account_last4}` : ""}
                  </Link>
                </td>
                <td className="px-4 py-2 text-center">
                  <span className={`text-[10px] uppercase px-2 py-0.5 rounded ${
                    r.status === "reconciled" ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"
                  }`}>
                    {r.status || (r.source === "plaid_auto" ? "auto" : "open")}
                  </span>
                </td>
                <td className="px-4 py-2 text-right font-mono-num tabular-nums">{fmtMoney(r.statement_balance || 0)}</td>
                <td className="px-4 py-2 text-right font-mono-num tabular-nums">{fmtMoney(r.ledger_balance || 0)}</td>
                <td className={`px-4 py-2 text-right font-mono-num tabular-nums ${
                  Math.abs(r.diff || 0) < 0.005 ? "text-emerald-700" : "text-red-700"
                }`}>{fmtMoney(r.diff || 0)}</td>
                <td className="px-4 py-2 text-slate-300">
                  <Link to={`/accounting/reconciliation/${r.id}`}><ChevronRight size={14} /></Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showMatchModal && matchResult && (
        <MatchResultModal
          result={matchResult}
          onClose={() => { setShowMatchModal(false); setMatchResult(null); }}
          onApply={async (ids) => {
            try {
              await api.post(`/companies/${currentId}/reconciliations/apply-matches`, {
                bank_account_id: acctId,
                period_end: periodEnd,
                apply_txn_ids: ids,
              });
              toast.success(`Cleared ${ids.length} matched transactions.`);
              setShowMatchModal(false); setMatchResult(null);
              setStmtBal(s => s);
              load();
            } catch (e) {
              toast.error(e.response?.data?.detail || "Apply failed");
            }
          }}
        />
      )}
    </div>
  );
}

function ScoreboardCard({ preview, clearedCount, clearedSum, opening, closing, diff, isBalanced, onFinish, busy }) {
  return (
    <div className={`rounded-xl border bg-white p-5 space-y-3 ${isBalanced ? "ring-2 ring-emerald-200" : ""}`} data-testid="recon-scoreboard">
      <div className="text-xs uppercase tracking-widest text-slate-500 mb-1">Reconciliation summary</div>
      <Row label="Opening balance" value={opening} />
      <Row label="Ending balance"  value={closing} />
      <Row label={`Cleared this session (${clearedCount})`} value={clearedSum} muted />
      <div className="border-t pt-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Difference</span>
          <span className={`font-mono-num tabular-nums text-xl font-bold ${
            isBalanced ? "text-emerald-700" : "text-red-700"
          }`} data-testid="recon-difference">
            {fmtMoney(diff)}
          </span>
        </div>
        <div className={`text-xs mt-1 ${isBalanced ? "text-emerald-700" : "text-slate-500"}`}>
          {isBalanced ? "Ready to finish — books match the statement." : "Keep ticking items until the difference is $0.00."}
        </div>
      </div>
      <button
        onClick={onFinish}
        disabled={!isBalanced || busy || clearedCount === 0}
        className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-emerald-600 text-white text-sm hover:bg-emerald-700 disabled:opacity-40"
        data-testid="recon-finish-btn"
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
        Finish reconciliation
      </button>
    </div>
  );
}

function Row({ label, value, muted }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className={muted ? "text-slate-500" : "text-slate-700"}>{label}</span>
      <span className="font-mono-num tabular-nums">{fmtMoney(value)}</span>
    </div>
  );
}

function MatchResultModal({ result, onClose, onApply }) {
  // Modal shown after a Veryfi-OCR statement upload. Groups per-line matches
  // by confidence tier so users can bulk-apply the safe ones and spot-check
  // the fuzzy ones.
  const [pickSuggest, setPickSuggest] = useState(new Set(
    (result.suggest || []).map(s => s.best?.id).filter(Boolean),
  ));
  const [pickAuto] = useState(new Set(
    (result.auto || []).map(s => s.best?.id).filter(Boolean),
  ));
  const toApply = useMemo(() => new Set([...pickAuto, ...pickSuggest]), [pickAuto, pickSuggest]);
  const toggleSuggest = (id) => {
    setPickSuggest(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
        data-testid="recon-match-modal"
      >
        <div className="px-5 py-3 border-b flex items-center justify-between">
          <div>
            <h3 className="font-heading font-semibold">Statement match preview</h3>
            <p className="text-xs text-slate-500">
              {result.line_count} statement lines · <b className="text-emerald-700">{result.auto_count} auto</b>
              {" · "}<b className="text-amber-700">{result.suggest_count} suggested</b>
              {" · "}<b className="text-slate-500">{result.manual_count} manual</b>
              {result.missing_from_statement_count > 0 && (
                <> · <b className="text-red-700">{result.missing_from_statement_count} in books but not on statement</b></>
              )}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-900 text-sm">Close</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
          {result.auto?.length > 0 && (
            <Tier
              title={<span className="text-emerald-700">✓ Auto-matched (≥0.90 confidence)</span>}
              rows={result.auto}
              picked={pickAuto}
              locked
            />
          )}
          {result.suggest?.length > 0 && (
            <Tier
              title={<span className="text-amber-700">Suggested (0.60–0.90) — uncheck any that look wrong</span>}
              rows={result.suggest}
              picked={pickSuggest}
              onToggle={toggleSuggest}
            />
          )}
          {result.manual?.length > 0 && (
            <Tier
              title={<span className="text-slate-600">No confident match ({result.manual_count})</span>}
              rows={result.manual}
              manual
            />
          )}
          {result.missing_from_statement?.length > 0 && (
            <MissingTier rows={result.missing_from_statement} />
          )}
        </div>
        <div className="px-5 py-3 border-t bg-slate-50 flex items-center justify-between">
          <span className="text-xs text-slate-500">{toApply.size} of {result.line_count} will be cleared.</span>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-md border">Cancel</button>
            <button
              onClick={() => onApply([...toApply])}
              disabled={toApply.size === 0}
              className="px-4 py-1.5 text-sm rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 inline-flex items-center gap-1"
              data-testid="recon-match-apply"
            >
              Apply <ArrowRight size={13} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Tier({ title, rows, picked, onToggle, locked, manual }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-widest mb-2">{title}</div>
      <div className="space-y-1">
        {rows.map((row, idx) => (
          <div key={idx} className={`rounded border px-3 py-2 flex items-center gap-3 ${
            manual ? "bg-red-50/40 border-red-100" : "bg-white"
          }`}>
            {!manual && onToggle ? (
              <input
                type="checkbox"
                checked={picked?.has(row.best?.id)}
                onChange={() => onToggle(row.best?.id)}
                className="accent-slate-900"
              />
            ) : locked ? (
              <CheckCircle2 size={14} className="text-emerald-600 shrink-0" />
            ) : (
              <FileText size={14} className="text-slate-400 shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <div className="truncate">{row.line?.description || row.line?.merchant}</div>
              <div className="text-[11px] text-slate-500 font-mono-num">
                {row.line?.date} · {fmtMoney(row.line?.amount || 0)}
              </div>
            </div>
            {row.best ? (
              <div className="text-right">
                <div className="text-[11px] text-slate-500">match ↓ ({Math.round((row.score || 0) * 100)}%)</div>
                <div className="text-xs truncate max-w-[220px]">{row.best.description}</div>
                <div className="text-[11px] text-slate-500 font-mono-num">{row.best.date} · {fmtMoney(row.best.amount)}</div>
              </div>
            ) : (
              <div className="text-[11px] text-red-700 italic">No candidate — likely missing from ledger.</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function MissingTier({ rows }) {
  // Ledger transactions with no matching line on the statement.
  // For a client using Axiom this usually means either:
  //   1. The transaction was posted to the books but never actually hit the bank
  //      (typo, or the txn was deleted at the bank end)
  //   2. A duplicate posting the client will want to review
  //   3. A fraud item that hit the ledger but not the statement
  // Purely informational — no bulk action; user needs to open each and decide.
  return (
    <div data-testid="recon-missing-from-statement">
      <div className="text-xs font-semibold uppercase tracking-widest mb-2 text-red-700">
        In your books but not on this statement ({rows.length})
      </div>
      <p className="text-[11px] text-slate-500 mb-2">
        These transactions exist in the ledger for the same period + account but didn't match any line
        on the uploaded statement. Review each — likely a duplicate, a bank correction,
        or a fraud red-flag.
      </p>
      <div className="space-y-1">
        {rows.map(t => (
          <div key={t.id}
               className="rounded border border-red-100 bg-red-50/40 px-3 py-2 flex items-center gap-3"
               data-testid={`recon-missing-row-${t.id}`}>
            <FileText size={14} className="text-red-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="truncate">{t.description}</div>
              <div className="text-[11px] text-slate-500 font-mono-num">
                {t.date}
                {t.category_account_name && <> · {t.category_account_name}</>}
              </div>
            </div>
            <span className={`font-mono-num tabular-nums w-24 text-right ${
              Number(t.amount) < 0 ? "text-red-700" : "text-emerald-700"
            }`}>
              {fmtMoney(t.amount)}
            </span>
            <Link
              to={`/accounting/transactions?highlight=${t.id}`}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-cyan-700 hover:underline"
            >
              Open
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}

function round2(v) { return Math.round(v * 100) / 100; }

function spansMultipleMonths(start, end) {
  if (!start || !end) return false;
  const s = new Date(start), e = new Date(end);
  if (isNaN(s) || isNaN(e)) return false;
  return s.getUTCFullYear() !== e.getUTCFullYear() ||
         s.getUTCMonth() !== e.getUTCMonth();
}

// Prefer a "May 2026" label when the period spans a whole calendar month
// (which is now the default). Fall back to the raw date range for legacy
// docs where period_start and period_end don't align to month boundaries.
function formatPeriodLabel(start, end, asOf) {
  const s = start || asOf, e = end || asOf;
  if (!s || !e) return "—";
  const sd = new Date(s), ed = new Date(e);
  if (isNaN(sd) || isNaN(ed)) return `${s} → ${e}`;
  const sameMonth = sd.getUTCFullYear() === ed.getUTCFullYear() &&
                    sd.getUTCMonth() === ed.getUTCMonth();
  const spansFullMonth = sd.getUTCDate() === 1 &&
    ed.getUTCDate() === new Date(ed.getUTCFullYear(), ed.getUTCMonth() + 1, 0).getUTCDate();
  if (sameMonth && spansFullMonth) {
    return sd.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  }
  return `${s} → ${e}`;
}
