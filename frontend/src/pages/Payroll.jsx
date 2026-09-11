/**
 * Payroll — Phase 1
 *
 * Single-file module hosting three views chosen by URL:
 *   /accounting/payroll              → dashboard (MTD/YTD + recent runs)
 *   /accounting/payroll/runs         → all runs table
 *   /accounting/payroll/runs/:id     → run editor (stubs + finalize)
 *   /accounting/payroll/employees/:eid → per-employee stub history
 *
 * We deliberately keep everything in one file so Phase 1 stays easy to
 * reason about. Anything reused across pages (money formatter, empty
 * state) is defined once at the bottom.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import {
  Users as UsersIcon, Plus, Loader2, Wallet, RefreshCw, Trash2, Check,
  ChevronLeft, ChevronRight, X, PenTool, ShieldCheck, Sparkles,
  Landmark, Download, FileText,
} from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { useCompany, useMoneyFmt } from "@/lib/company";


function fmtDate(d) {
  if (!d) return "—";
  return d.length === 10 ? d : d.slice(0, 10);
}


// ── Dashboard ──────────────────────────────────────────────────────

export function PayrollDashboard() {
  const { currentId } = useCompany();
  const fmtMoney = useMoneyFmt();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [matching, setMatching] = useState(false);

  const load = async () => {
    if (!currentId) return;
    setBusy(true);
    try {
      const r = await api.get(`/companies/${currentId}/payroll/summary`);
      setData(r.data);
    } finally { setBusy(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId]);

  const autoMatch = async () => {
    setMatching(true);
    try {
      const r = await api.post(`/companies/${currentId}/payroll/auto-match`);
      toast.success(`Matched ${r.data.matched} · skipped ${r.data.skipped}`);
      await load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Auto-match failed");
    } finally { setMatching(false); }
  };

  const createDraft = async () => {
    const today = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - 14 * 86400 * 1000).toISOString().slice(0, 10);
    try {
      const r = await api.post(`/companies/${currentId}/payroll/runs`, {
        period_start: start, period_end: today, pay_date: today,
      });
      navigate(`/accounting/payroll/runs/${r.data.run.id}`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not create run");
    }
  };

  if (busy && !data) {
    return <div className="p-6"><Loader2 className="animate-spin" /></div>;
  }
  if (!data) return null;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5" data-testid="payroll-dashboard">
      <header className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight flex items-center gap-2">
            <Wallet className="text-emerald-600" /> Payroll
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Manual payroll ledger — record runs, post JEs, and auto-match net-pay debits to the bank feed. Not a tax engine.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={autoMatch} disabled={matching}
                  data-testid="payroll-auto-match"
                  className="text-xs inline-flex items-center gap-1.5 px-3 py-2 rounded-md border hover:bg-slate-50 disabled:opacity-40">
            {matching ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            Auto-match to bank
          </button>
          <button onClick={createDraft} data-testid="payroll-new-run"
                  className="text-xs inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-emerald-600 text-white hover:bg-emerald-700">
            <Plus size={13} /> New pay run
          </button>
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Finalized runs" value={data.runs_finalized}    testid="payroll-stat-finalized" />
        <StatCard label="Draft runs"     value={data.runs_draft}         testid="payroll-stat-draft" />
        <StatCard label="MTD gross"      value={fmtMoney(data.mtd.gross)} testid="payroll-stat-mtd" mono />
        <StatCard label="Unmatched ACH"  value={data.unmatched_ach_stubs} testid="payroll-stat-unmatched"
                  tone={data.unmatched_ach_stubs > 0 ? "amber" : "slate"} />
      </div>

      <section className="rounded-xl border bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b bg-slate-50 flex items-center justify-between">
          <div className="font-semibold text-sm text-slate-800">YTD summary</div>
          <div className="text-[11px] text-slate-500">Year-to-date across all finalized runs</div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-6 divide-y md:divide-y-0 md:divide-x text-sm">
          <YtdCell label="Gross"     value={fmtMoney(data.ytd.gross)} />
          <YtdCell label="EE tax"    value={fmtMoney(data.ytd.ee_tax)} />
          <YtdCell label="EE ded."   value={fmtMoney(data.ytd.ee_ded)} />
          <YtdCell label="ER tax"    value={fmtMoney(data.ytd.er_tax)} />
          <YtdCell label="ER benef." value={fmtMoney(data.ytd.er_ben)} />
          <YtdCell label="Net paid"  value={fmtMoney(data.ytd.net)} strong />
        </div>
      </section>

      <section className="rounded-xl border bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b bg-slate-50 flex items-center justify-between">
          <div className="font-semibold text-sm text-slate-800">Recent finalized runs</div>
          <Link to="/accounting/payroll/runs" className="text-xs text-slate-600 hover:text-slate-900">
            View all →
          </Link>
        </div>
        {data.recent_runs.length === 0 ? (
          <EmptyBlock text="No finalized runs yet. Click New pay run to start." />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50/60 text-[10px] uppercase text-slate-500 border-b">
              <tr>
                <th className="px-3 py-2 text-left">Pay date</th>
                <th className="px-3 py-2 text-left">Period</th>
                <th className="px-3 py-2 text-right">Gross</th>
                <th className="px-3 py-2 text-right">Net</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {data.recent_runs.map(r => {
                const t = r.totals || {};
                return (
                  <tr key={r.id} className="border-b hover:bg-slate-50"
                      onClick={() => navigate(`/accounting/payroll/runs/${r.id}`)}
                      data-testid={`payroll-recent-${r.id}`}>
                    <td className="px-3 py-2 font-mono-num">{fmtDate(r.pay_date)}</td>
                    <td className="px-3 py-2 text-slate-500 text-xs">{fmtDate(r.period_start)} → {fmtDate(r.period_end)}</td>
                    <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(t.gross)}</td>
                    <td className="px-3 py-2 text-right font-mono-num font-semibold">{fmtMoney(t.net)}</td>
                    <td className="px-3 py-2 text-right"><ChevronRight size={14} className="inline text-slate-400" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <LiabilityAging currentId={currentId} onChanged={load} />
    </div>
  );
}


// ── Runs list ──────────────────────────────────────────────────────

export function PayrollRuns() {
  const { currentId } = useCompany();
  const fmtMoney = useMoneyFmt();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const load = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const r = await api.get(`/companies/${currentId}/payroll/runs`);
      setRows(r.data.runs || []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId]);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4" data-testid="payroll-runs">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-2xl font-bold flex items-center gap-2">
          <Wallet size={20} /> Payroll runs
        </h1>
        <Link to="/accounting/payroll" className="text-xs text-slate-600 hover:text-slate-900">← Payroll dashboard</Link>
      </div>
      <div className="rounded-xl border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[10px] uppercase text-slate-500 border-b">
            <tr>
              <th className="px-3 py-2 text-left">Pay date</th>
              <th className="px-3 py-2 text-left">Period</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-right">Gross</th>
              <th className="px-3 py-2 text-right">Net</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={6} className="text-center py-8"><Loader2 className="inline animate-spin" /></td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={6}><EmptyBlock text="No runs yet." /></td></tr>
            )}
            {!loading && rows.map(r => {
              const t = r.totals || {};
              return (
                <tr key={r.id} className="border-b hover:bg-slate-50 cursor-pointer"
                    onClick={() => navigate(`/accounting/payroll/runs/${r.id}`)}
                    data-testid={`payroll-run-${r.id}`}>
                  <td className="px-3 py-2 font-mono-num">{fmtDate(r.pay_date)}</td>
                  <td className="px-3 py-2 text-slate-500 text-xs">{fmtDate(r.period_start)} → {fmtDate(r.period_end)}</td>
                  <td className="px-3 py-2">
                    <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${
                      r.status === "finalized"
                        ? "bg-emerald-100 text-emerald-800"
                        : "bg-amber-100 text-amber-800"
                    }`}>{r.status}</span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(t.gross)}</td>
                  <td className="px-3 py-2 text-right font-mono-num font-semibold">{fmtMoney(t.net)}</td>
                  <td className="px-3 py-2 text-right"><ChevronRight size={14} className="inline text-slate-400" /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}


// ── Run editor ─────────────────────────────────────────────────────

export function PayrollRun() {
  const { id: runId } = useParams();
  const { currentId } = useCompany();
  const fmtMoney = useMoneyFmt();
  const navigate = useNavigate();
  const [run, setRun] = useState(null);
  const [stubs, setStubs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [banks, setBanks] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [editingStub, setEditingStub] = useState(null);   // stub object OR "new"
  const [bankId, setBankId] = useState("");

  const load = async () => {
    if (!currentId || !runId) return;
    setLoading(true);
    try {
      const [r, ba, emp] = await Promise.all([
        api.get(`/companies/${currentId}/payroll/runs/${runId}`),
        api.get(`/companies/${currentId}/accounts?type=asset`).catch(() => ({ data: { accounts: [] } })),
        api.get(`/companies/${currentId}/employees`).catch(() => ({ data: { employees: [] } })),
      ]);
      setRun(r.data.run);
      setStubs(r.data.stubs || []);
      const bs = (ba.data.accounts || []).filter(a =>
        (a.detail_type || "").toLowerCase().includes("cash") ||
        (a.detail_type || "").toLowerCase().includes("bank") ||
        (a.subtype || "").toLowerCase().includes("bank") ||
        (a.name || "").toLowerCase().includes("bank") ||
        (a.name || "").toLowerCase().includes("checking")
      );
      setBanks(bs.length ? bs : (ba.data.accounts || []));
      if (r.data.run?.bank_account_id) setBankId(r.data.run.bank_account_id);
      else if (bs[0]) setBankId(bs[0].id);
      setEmployees(emp.data.employees || []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId, runId]);

  const totals = useMemo(() => {
    const t = { gross: 0, ee_tax: 0, ee_ded: 0, er_tax: 0, er_ben: 0, net: 0 };
    for (const s of stubs) {
      for (const k of Object.keys(t)) t[k] += Number(s[k] || 0);
    }
    return t;
  }, [stubs]);

  const finalize = async () => {
    if (!bankId) { toast.error("Select the bank account payroll is paid from."); return; }
    if (stubs.length === 0) { toast.error("Add at least one stub."); return; }
    if (!window.confirm(
      `Finalize this run?\n\nA journal entry will be posted, and any check-method stubs will be added to Print Checks. This cannot be undone from the UI.`
    )) return;
    try {
      const r = await api.post(`/companies/${currentId}/payroll/runs/${runId}/finalize`,
        { bank_account_id: bankId });
      toast.success(`Run finalized · ${r.data.check_ids.length} check(s) queued`);
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Finalize failed");
    }
  };

  const removeStub = async (sid) => {
    if (!window.confirm("Remove this stub from the run?")) return;
    try {
      await api.delete(`/companies/${currentId}/payroll/runs/${runId}/stubs/${sid}`);
      load();
    } catch (e) { toast.error(e.response?.data?.detail || "Delete failed"); }
  };

  const deleteRun = async () => {
    if (!window.confirm("Delete this draft run and all its stubs?")) return;
    try {
      await api.delete(`/companies/${currentId}/payroll/runs/${runId}`);
      navigate("/accounting/payroll");
    } catch (e) { toast.error(e.response?.data?.detail || "Delete failed"); }
  };

  if (loading || !run) {
    return <div className="p-6"><Loader2 className="animate-spin" /></div>;
  }

  const isDraft = run.status === "draft";

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4" data-testid="payroll-run-page">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Link to="/accounting/payroll" className="hover:text-slate-900">Payroll</Link>
        <ChevronRight size={12} />
        <span className="text-slate-900">
          Run · {fmtDate(run.pay_date)}
        </span>
      </div>

      <header className="flex items-start justify-between flex-wrap gap-3">
        <div className="flex-1 min-w-0">
          <h1 className="font-heading text-2xl font-bold">Pay run</h1>
          <p className="text-sm text-slate-500 mt-1">
            {fmtDate(run.period_start)} → {fmtDate(run.period_end)} · Pay date <b className="font-mono-num">{fmtDate(run.pay_date)}</b>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] uppercase px-2 py-1 rounded ${
            isDraft ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"
          }`} data-testid="payroll-run-status">{run.status}</span>
          {isDraft && (
            <button onClick={deleteRun}
                    className="text-xs inline-flex items-center gap-1 px-2 py-1.5 rounded border border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100"
                    data-testid="payroll-run-delete">
              <Trash2 size={12} /> Delete draft
            </button>
          )}
        </div>
      </header>

      {/* Stub table */}
      <section className="rounded-xl border bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b bg-slate-50 flex items-center justify-between">
          <div className="font-semibold text-sm text-slate-800">Pay stubs</div>
          {isDraft && (
            <button onClick={() => setEditingStub("new")}
                    data-testid="payroll-add-stub"
                    className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700">
              <Plus size={12} /> Add stub
            </button>
          )}
        </div>
        <table className="w-full text-sm">
          <thead className="bg-slate-50/60 text-[10px] uppercase text-slate-500 border-b">
            <tr>
              <th className="px-3 py-2 text-left">Employee</th>
              <th className="px-3 py-2 text-left">Kind</th>
              <th className="px-3 py-2 text-left">Method</th>
              <th className="px-3 py-2 text-right">Gross</th>
              <th className="px-3 py-2 text-right">EE tax</th>
              <th className="px-3 py-2 text-right">EE ded.</th>
              <th className="px-3 py-2 text-right">Net</th>
              <th className="px-3 py-2 text-left">Match</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {stubs.length === 0 && (
              <tr><td colSpan={9}><EmptyBlock text="No stubs yet." /></td></tr>
            )}
            {stubs.map(s => (
              <tr key={s.id} className="border-b hover:bg-slate-50" data-testid={`payroll-stub-${s.id}`}>
                <td className="px-3 py-2 font-medium text-slate-800">{s.employee_name}</td>
                <td className="px-3 py-2"><span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{s.kind}</span></td>
                <td className="px-3 py-2 text-xs text-slate-500">{s.payment_method}{s.check_number ? ` · #${s.check_number}` : ""}</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(s.gross)}</td>
                <td className="px-3 py-2 text-right font-mono-num text-slate-500">{fmtMoney(s.ee_tax)}</td>
                <td className="px-3 py-2 text-right font-mono-num text-slate-500">{fmtMoney(s.ee_ded)}</td>
                <td className="px-3 py-2 text-right font-mono-num font-semibold">{fmtMoney(s.net)}</td>
                <td className="px-3 py-2 text-xs">
                  {s.match_txn_id ? (
                    <span className="inline-flex items-center gap-1 text-emerald-700"><Check size={11} /> bank</span>
                  ) : s.match_check_id ? (
                    <span className="inline-flex items-center gap-1 text-indigo-700"><PenTool size={11} /> check</span>
                  ) : (
                    <span className="text-slate-400">unmatched</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <StubPdfButton currentId={currentId} stubId={s.id}
                                 testid={`payroll-stub-pdf-${s.id}`} />
                  {isDraft && (
                    <>
                      <button onClick={() => setEditingStub(s)}
                              data-testid={`payroll-stub-edit-${s.id}`}
                              className="text-xs px-2 py-1 rounded border hover:bg-slate-100 mx-1">Edit</button>
                      <button onClick={() => removeStub(s.id)}
                              data-testid={`payroll-stub-delete-${s.id}`}
                              className="text-xs px-2 py-1 rounded border border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100">
                        <Trash2 size={11} />
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          {stubs.length > 0 && (
            <tfoot className="bg-slate-50 border-t text-sm">
              <tr className="font-semibold">
                <td className="px-3 py-2" colSpan={3}>Totals</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(totals.gross)}</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(totals.ee_tax)}</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(totals.ee_ded)}</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(totals.net)}</td>
                <td colSpan={2}></td>
              </tr>
            </tfoot>
          )}
        </table>
      </section>

      {/* Finalize bar */}
      {isDraft && stubs.length > 0 && (
        <section className="rounded-xl border-2 border-emerald-200 bg-emerald-50 p-4 flex items-center justify-between flex-wrap gap-3"
                 data-testid="payroll-finalize-bar">
          <div className="text-sm text-emerald-900">
            <div className="font-semibold flex items-center gap-1.5"><ShieldCheck size={15} /> Ready to finalize</div>
            <p className="text-[12px] text-emerald-800/80 mt-0.5">
              Posts a journal entry, queues {stubs.filter(s => s.payment_method === "check").length} check(s) in Print Checks, and enables auto-match on {stubs.filter(s => s.payment_method === "ach").length} ACH stub(s).
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select value={bankId} onChange={e => setBankId(e.target.value)}
                    data-testid="payroll-bank-select"
                    className="text-xs border rounded px-2 py-1.5 bg-white">
              <option value="">— pick bank —</option>
              {banks.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <button onClick={finalize} disabled={!bankId}
                    data-testid="payroll-finalize"
                    className="text-sm px-3 py-2 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 inline-flex items-center gap-1.5">
              <Check size={14} /> Finalize run
            </button>
          </div>
        </section>
      )}

      {editingStub && (
        <StubModal
          existing={editingStub === "new" ? null : editingStub}
          runId={runId}
          currentId={currentId}
          employees={employees}
          onClose={(saved) => { setEditingStub(null); if (saved) load(); }}
        />
      )}
    </div>
  );
}


// ── Stub editor modal ──────────────────────────────────────────────

function StubModal({ existing, runId, currentId, employees, onClose }) {
  const fmtMoney = useMoneyFmt();
  const isNew = !existing;
  const [employeeId, setEmployeeId] = useState(existing?.employee_id || "");
  const [employeeName, setEmployeeName] = useState(existing?.employee_name || "");
  const [kind, setKind] = useState(existing?.kind || "w2");
  const [mode, setMode] = useState(existing?.mode || "simple");
  const [paymentMethod, setPaymentMethod] = useState(existing?.payment_method || "ach");
  const [checkNumber, setCheckNumber] = useState(existing?.check_number || "");
  const [gross, setGross] = useState(existing?.gross ?? "");
  const [net, setNet] = useState(existing?.net ?? "");
  const [lines, setLines] = useState(existing?.lines || []);
  const [memo, setMemo] = useState(existing?.memo || "");
  const [busy, setBusy] = useState(false);

  const kindIs1099 = kind === "1099";

  const pickEmployee = (eid) => {
    const e = employees.find(x => x.id === eid);
    setEmployeeId(eid);
    if (e) {
      setEmployeeName(e.name || "");
      if (e.hourly_cost_rate && !gross && mode === "simple") {
        // Suggest a 40hr week gross as a starting point.
        setGross(String(Math.round(e.hourly_cost_rate * 40 * 100) / 100));
      }
    }
  };

  const addLine = (k) => setLines([...lines, { kind: k, label: "", amount: 0 }]);
  const updLine = (i, patch) => setLines(lines.map((l, j) => j === i ? { ...l, ...patch } : l));
  const rmLine = (i) => setLines(lines.filter((_, j) => j !== i));

  const preview = useMemo(() => {
    if (mode === "simple") {
      const g = Number(gross || 0), n = Number(net || 0);
      return {
        gross: g,
        ee_tax: kindIs1099 ? 0 : Math.max(0, g - n),
        net: n,
      };
    }
    const sum = (k) => lines.filter(l => l.kind === k).reduce((s, l) => s + Number(l.amount || 0), 0);
    const g = sum("earning"), t = sum("ee_tax"), d = sum("ee_deduction");
    return { gross: g, ee_tax: t, ee_ded: d, net: Math.round((g - t - d) * 100) / 100 };
  }, [mode, gross, net, lines, kindIs1099]);

  const save = async () => {
    if (!employeeName.trim()) { toast.error("Employee name required."); return; }
    setBusy(true);
    try {
      await api.post(`/companies/${currentId}/payroll/runs/${runId}/stubs`, {
        id: existing?.id,
        employee_id: employeeId || null,
        employee_name: employeeName,
        kind, mode,
        payment_method: paymentMethod,
        check_number: checkNumber ? Number(checkNumber) : null,
        gross: mode === "simple" ? Number(gross || 0) : null,
        net:   mode === "simple" ? Number(net   || 0) : null,
        lines: mode === "itemized" ? lines.map(l => ({
          kind: l.kind, label: l.label || l.kind,
          amount: Number(l.amount || 0),
        })) : [],
        memo,
      });
      toast.success(isNew ? "Stub added" : "Stub saved");
      onClose(true);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl p-5 space-y-3 max-h-[92vh] overflow-y-auto"
           data-testid="payroll-stub-modal">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold text-lg">{isNew ? "Add" : "Edit"} pay stub</h3>
          <button onClick={() => onClose(false)}><X size={16} /></button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Employee</label>
            {employees.length > 0 ? (
              <select value={employeeId} onChange={e => pickEmployee(e.target.value)}
                      data-testid="stub-employee-select"
                      className="w-full border rounded px-2 py-1.5 text-sm">
                <option value="">— free-text name —</option>
                {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            ) : null}
            <input value={employeeName} onChange={e => setEmployeeName(e.target.value)}
                   placeholder="Employee name"
                   data-testid="stub-employee-name"
                   className="mt-1 w-full border rounded px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Kind</label>
            <div className="flex gap-1">
              {["w2", "1099"].map(k => (
                <button key={k} onClick={() => setKind(k)}
                        data-testid={`stub-kind-${k}`}
                        className={`flex-1 text-xs px-2 py-1.5 rounded border ${
                          kind === k ? "bg-slate-900 text-white border-slate-900" : "bg-white hover:bg-slate-50"
                        }`}>
                  {k.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Mode</label>
            <div className="flex gap-1">
              {[["simple", "Simple (gross + net)"], ["itemized", "Itemized"]].map(([k, label]) => (
                <button key={k} onClick={() => setMode(k)}
                        disabled={kindIs1099 && k === "itemized"}
                        data-testid={`stub-mode-${k}`}
                        className={`flex-1 text-xs px-2 py-1.5 rounded border disabled:opacity-30 disabled:cursor-not-allowed ${
                          mode === k ? "bg-slate-900 text-white border-slate-900" : "bg-white hover:bg-slate-50"
                        }`}>
                  {label}
                </button>
              ))}
            </div>
            {kindIs1099 && <p className="text-[10px] text-slate-500 mt-1">1099 always uses simple mode (no withholdings).</p>}
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Payment method</label>
            <div className="flex gap-1">
              {["ach", "check", "cash"].map(m => (
                <button key={m} onClick={() => setPaymentMethod(m)}
                        data-testid={`stub-method-${m}`}
                        className={`flex-1 text-xs px-2 py-1.5 rounded border ${
                          paymentMethod === m ? "bg-slate-900 text-white border-slate-900" : "bg-white hover:bg-slate-50"
                        }`}>
                  {m.toUpperCase()}
                </button>
              ))}
            </div>
            {paymentMethod === "check" && (
              <input value={checkNumber} onChange={e => setCheckNumber(e.target.value)}
                     placeholder="Check #"
                     data-testid="stub-check-number"
                     className="mt-1 w-full border rounded px-2 py-1.5 text-sm font-mono-num" />
            )}
          </div>
        </div>

        {(mode === "simple" || kindIs1099) ? (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Gross wages</label>
              <input type="number" step="0.01" value={gross} onChange={e => setGross(e.target.value)}
                     data-testid="stub-gross"
                     className="w-full border rounded px-2 py-1.5 text-sm font-mono-num" />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Net (take-home)</label>
              <input type="number" step="0.01" value={kindIs1099 ? gross : net}
                     onChange={e => setNet(e.target.value)}
                     disabled={kindIs1099}
                     data-testid="stub-net"
                     className="w-full border rounded px-2 py-1.5 text-sm font-mono-num disabled:bg-slate-50 disabled:text-slate-500" />
              {kindIs1099 && <p className="text-[10px] text-slate-400 mt-0.5">1099: net = gross (no withholding)</p>}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {["earning", "ee_tax", "ee_deduction", "er_tax", "er_benefit"].map(k => {
              const rows = lines.map((l, i) => ({ l, i })).filter(x => x.l.kind === k);
              return (
                <div key={k} className="rounded border bg-slate-50/50">
                  <div className="flex items-center justify-between px-2 py-1.5 border-b">
                    <span className="text-[11px] font-semibold text-slate-700">
                      {{
                        earning: "Earnings (gross)",
                        ee_tax: "Employee tax withholding",
                        ee_deduction: "Employee deductions",
                        er_tax: "Employer taxes",
                        er_benefit: "Employer benefits",
                      }[k]}
                    </span>
                    <button onClick={() => addLine(k)}
                            data-testid={`stub-line-add-${k}`}
                            className="text-[10px] px-1.5 py-0.5 rounded border bg-white hover:bg-slate-100">+ line</button>
                  </div>
                  {rows.length === 0 && <div className="px-2 py-1.5 text-[10px] text-slate-400">no lines</div>}
                  {rows.map(({ l, i }) => (
                    <div key={i} className="flex items-center gap-1 px-2 py-1 border-b last:border-b-0">
                      <input value={l.label} onChange={e => updLine(i, { label: e.target.value })}
                             placeholder="Label (e.g. Federal WH)"
                             className="flex-1 border rounded px-1.5 py-0.5 text-xs bg-white" />
                      <input type="number" step="0.01" value={l.amount}
                             onChange={e => updLine(i, { amount: e.target.value })}
                             className="w-28 border rounded px-1.5 py-0.5 text-xs bg-white font-mono-num text-right" />
                      <button onClick={() => rmLine(i)}
                              className="text-slate-400 hover:text-rose-600 p-0.5">
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}

        <div className="rounded-md border bg-slate-50 p-2 text-[11px] text-slate-600 grid grid-cols-4 gap-2">
          <Preview label="Gross"  value={fmtMoney(preview.gross)} />
          <Preview label="EE tax" value={fmtMoney(preview.ee_tax || 0)} />
          <Preview label="EE ded" value={fmtMoney(preview.ee_ded || 0)} />
          <Preview label="Net"    value={fmtMoney(preview.net)} strong />
        </div>

        <input value={memo} onChange={e => setMemo(e.target.value)}
               placeholder="Memo (optional)"
               data-testid="stub-memo"
               className="w-full border rounded px-2 py-1.5 text-sm" />

        <button onClick={save} disabled={busy}
                data-testid="stub-save"
                className="w-full py-2 rounded-md bg-emerald-600 text-white text-sm inline-flex items-center justify-center gap-1.5 hover:bg-emerald-700 disabled:opacity-50">
          {busy && <Loader2 size={13} className="animate-spin" />}
          {isNew ? "Add stub" : "Save stub"}
        </button>
      </div>
    </div>
  );
}


// ── Employee history ───────────────────────────────────────────────

export function PayrollEmployeeHistory() {
  const { eid } = useParams();
  const { currentId } = useCompany();
  const fmtMoney = useMoneyFmt();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [emp, setEmp] = useState(null);

  const load = async () => {
    if (!currentId || !eid) return;
    setLoading(true);
    try {
      const [h, e] = await Promise.all([
        api.get(`/companies/${currentId}/payroll/employees/${eid}/history`),
        api.get(`/companies/${currentId}/employees/${eid}`).catch(() => ({ data: {} })),
      ]);
      setData(h.data);
      setEmp(e.data?.employee || null);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId, eid]);

  if (loading || !data) return <div className="p-6"><Loader2 className="animate-spin" /></div>;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4" data-testid="payroll-emp-history">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Link to="/accounting/payroll" className="hover:text-slate-900">Payroll</Link>
        <ChevronRight size={12} />
        <span className="text-slate-900">{emp?.name || "Employee"}</span>
      </div>
      <header>
        <h1 className="font-heading text-2xl font-bold">{emp?.name || "Employee"} · payroll history</h1>
        <p className="text-sm text-slate-500 mt-1">All stubs across every pay run for this employee.</p>
      </header>

      <div className="grid grid-cols-4 gap-3">
        <StatCard label={`${data.year} gross`}  value={fmtMoney(data.ytd.gross)} mono />
        <StatCard label={`${data.year} EE tax`} value={fmtMoney(data.ytd.ee_tax)} mono />
        <StatCard label={`${data.year} EE ded`} value={fmtMoney(data.ytd.ee_ded)} mono />
        <StatCard label={`${data.year} net`}    value={fmtMoney(data.ytd.net)}    mono />
      </div>

      <section className="rounded-xl border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[10px] uppercase text-slate-500 border-b">
            <tr>
              <th className="px-3 py-2 text-left">Pay date</th>
              <th className="px-3 py-2 text-left">Period</th>
              <th className="px-3 py-2 text-left">Method</th>
              <th className="px-3 py-2 text-right">Gross</th>
              <th className="px-3 py-2 text-right">Net</th>
              <th className="px-3 py-2 text-left">Match</th>
              <th className="px-3 py-2 text-right"></th>
            </tr>
          </thead>
          <tbody>
            {data.stubs.length === 0 && (
              <tr><td colSpan={7}><EmptyBlock text="No stubs recorded for this employee yet." /></td></tr>
            )}
            {data.stubs.map(s => (
              <tr key={s.id} className="border-b hover:bg-slate-50">
                <td className="px-3 py-2 font-mono-num">{fmtDate(s.pay_date)}</td>
                <td className="px-3 py-2 text-slate-500 text-xs">{fmtDate(s.period_start)} → {fmtDate(s.period_end)}</td>
                <td className="px-3 py-2 text-xs">{s.payment_method}{s.check_number ? ` · #${s.check_number}` : ""}</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(s.gross)}</td>
                <td className="px-3 py-2 text-right font-mono-num font-semibold">{fmtMoney(s.net)}</td>
                <td className="px-3 py-2 text-xs">
                  {s.match_txn_id
                    ? <span className="text-emerald-700 inline-flex items-center gap-1"><Check size={11} /> bank</span>
                    : s.match_check_id
                      ? <span className="text-indigo-700 inline-flex items-center gap-1"><PenTool size={11} /> check</span>
                      : <span className="text-slate-400">unmatched</span>}
                </td>
                <td className="px-3 py-2 text-right">
                  <StubPdfButton currentId={currentId} stubId={s.id}
                                 testid={`emp-history-pdf-${s.id}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}


// ── Shared bits ────────────────────────────────────────────────────

function StatCard({ label, value, tone = "slate", mono, testid }) {
  const cls = tone === "amber"
    ? "border-amber-200 bg-amber-50 text-amber-900"
    : "border-slate-200 bg-white text-slate-800";
  return (
    <div className={`rounded-xl border p-3 ${cls}`} data-testid={testid}>
      <div className="text-[10px] uppercase tracking-wider font-semibold opacity-70">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${mono ? "font-mono-num" : ""}`}>{value}</div>
    </div>
  );
}

function YtdCell({ label, value, strong }) {
  return (
    <div className="px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mt-1 font-mono-num ${strong ? "text-slate-900 font-bold" : "text-slate-700"}`}>{value}</div>
    </div>
  );
}

function Preview({ label, value, strong }) {
  return (
    <div>
      <div className="uppercase text-[9px] tracking-wider text-slate-400">{label}</div>
      <div className={`font-mono-num ${strong ? "text-slate-900 font-semibold" : "text-slate-700"}`}>{value}</div>
    </div>
  );
}

function EmptyBlock({ text }) {
  return (
    <div className="text-center py-10 text-slate-500 text-sm">
      {text}
    </div>
  );
}


// ── Liability aging ────────────────────────────────────────────────

function LiabilityAging({ currentId, onChanged }) {
  const fmtMoney = useMoneyFmt();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [paying, setPaying] = useState(null); // aging row for the Pay modal

  const load = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const r = await api.get(`/companies/${currentId}/payroll/liabilities`);
      setData(r.data);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId]);

  if (loading && !data) return null;
  if (!data) return null;

  const outstandingRows = data.rows.filter(r => r.outstanding.total > 0.005);
  const nothingOwed = outstandingRows.length === 0;

  return (
    <section className="rounded-xl border bg-white overflow-hidden" data-testid="payroll-liability-aging">
      <div className="px-4 py-2.5 border-b bg-slate-50 flex items-center justify-between">
        <div className="font-semibold text-sm text-slate-800 flex items-center gap-1.5">
          <Landmark size={14} className="text-slate-500" /> Payroll liabilities
        </div>
        <div className="text-[11px] text-slate-500">
          Owed <b className="font-mono-num text-slate-800">{fmtMoney(data.totals.owed)}</b>
          <span className="mx-1.5 text-slate-300">·</span>
          Paid <b className="font-mono-num text-slate-800">{fmtMoney(data.totals.paid)}</b>
          <span className="mx-1.5 text-slate-300">·</span>
          Outstanding <b className={`font-mono-num ${data.totals.outstanding > 0.005 ? "text-rose-700" : "text-emerald-700"}`}>
            {fmtMoney(data.totals.outstanding)}
          </b>
        </div>
      </div>
      {nothingOwed ? (
        <EmptyBlock text="Nothing outstanding. All payroll liabilities are current." />
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-slate-50/60 text-[10px] uppercase text-slate-500 border-b">
            <tr>
              <th className="px-3 py-2 text-left">Run</th>
              <th className="px-3 py-2 text-right">EE tax</th>
              <th className="px-3 py-2 text-right">ER tax</th>
              <th className="px-3 py-2 text-right">ER benef.</th>
              <th className="px-3 py-2 text-right">EE ded.</th>
              <th className="px-3 py-2 text-right">Outstanding</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {outstandingRows.map(r => (
              <tr key={r.run_id} className="border-b hover:bg-slate-50"
                  data-testid={`payroll-liability-row-${r.run_id}`}>
                <td className="px-3 py-2">
                  <div className="font-mono-num text-slate-900">{fmtDate(r.pay_date)}</div>
                  <div className="text-[10px] text-slate-500">{fmtDate(r.period_start)} → {fmtDate(r.period_end)}</div>
                </td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(r.outstanding.ee_tax)}</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(r.outstanding.er_tax)}</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(r.outstanding.er_ben)}</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(r.outstanding.ee_ded)}</td>
                <td className="px-3 py-2 text-right font-mono-num font-bold text-rose-700">
                  {fmtMoney(r.outstanding.total)}
                </td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => setPaying(r)}
                          data-testid={`payroll-liability-pay-${r.run_id}`}
                          className="text-[11px] px-2 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 inline-flex items-center gap-1">
                    <Wallet size={11} /> Pay
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {paying && (
        <PayLiabilityModal
          currentId={currentId}
          row={paying}
          onClose={(saved) => {
            setPaying(null);
            if (saved) { load(); onChanged?.(); }
          }}
        />
      )}
    </section>
  );
}

function PayLiabilityModal({ currentId, row, onClose }) {
  const fmtMoney = useMoneyFmt();
  const [banks, setBanks] = useState([]);
  const [bankId, setBankId] = useState("");
  const [eeTax, setEeTax] = useState(row.outstanding.ee_tax);
  const [erTax, setErTax] = useState(row.outstanding.er_tax);
  const [erBen, setErBen] = useState(row.outstanding.er_ben);
  const [eeDed, setEeDed] = useState(row.outstanding.ee_ded);
  const [agency, setAgency] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.get(`/companies/${currentId}/accounts?type=asset`);
        const bs = (r.data.accounts || []).filter(a =>
          (a.detail_type || "").toLowerCase().includes("cash") ||
          (a.detail_type || "").toLowerCase().includes("bank") ||
          (a.subtype || "").toLowerCase().includes("bank") ||
          (a.name || "").toLowerCase().includes("bank") ||
          (a.name || "").toLowerCase().includes("checking")
        );
        setBanks(bs.length ? bs : (r.data.accounts || []));
        if (bs[0]) setBankId(bs[0].id);
      } catch (e) { /* noop */ }
    })();
  }, [currentId]);

  const total = Math.round(
    (Number(eeTax || 0) + Number(erTax || 0) + Number(erBen || 0) + Number(eeDed || 0)) * 100
  ) / 100;

  const save = async () => {
    if (!bankId) { toast.error("Pick a bank account."); return; }
    if (total <= 0) { toast.error("Enter at least one amount to pay."); return; }
    setBusy(true);
    try {
      await api.post(`/companies/${currentId}/payroll/liabilities/pay`, {
        run_id: row.run_id, bank_account_id: bankId,
        ee_tax: Number(eeTax || 0), er_tax: Number(erTax || 0),
        er_ben: Number(erBen || 0), ee_ded: Number(eeDed || 0),
        agency, date, memo,
      });
      toast.success(`Paid ${fmtMoney(total)} to ${agency || "agency"}`);
      onClose(true);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Payment failed");
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-5 space-y-3"
           data-testid="pay-liability-modal">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold text-lg inline-flex items-center gap-2">
            <Landmark size={16} className="text-emerald-600" /> Pay payroll liability
          </h3>
          <button onClick={() => onClose(false)}><X size={16} /></button>
        </div>

        <p className="text-xs text-slate-500">
          Run <b>{fmtDate(row.pay_date)}</b> · Outstanding <b className="text-rose-700 font-mono-num">{fmtMoney(row.outstanding.total)}</b>.
          Amounts default to what's outstanding — trim if you're paying partially.
        </p>

        <div className="grid grid-cols-2 gap-3">
          {[
            ["EE tax", eeTax, setEeTax, row.outstanding.ee_tax, "eeTax"],
            ["ER tax", erTax, setErTax, row.outstanding.er_tax, "erTax"],
            ["ER benefits", erBen, setErBen, row.outstanding.er_ben, "erBen"],
            ["EE deductions", eeDed, setEeDed, row.outstanding.ee_ded, "eeDed"],
          ].map(([label, v, set, cap, key]) => (
            <div key={key}>
              <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                {label} <span className="text-slate-400">(max {fmtMoney(cap)})</span>
              </label>
              <input type="number" step="0.01" min="0"
                     value={v} onChange={e => set(e.target.value)}
                     data-testid={`pay-liab-${key}`}
                     className="w-full border rounded px-2 py-1.5 text-sm font-mono-num" />
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Bank</label>
            <select value={bankId} onChange={e => setBankId(e.target.value)}
                    data-testid="pay-liab-bank"
                    className="w-full border rounded px-2 py-1.5 text-sm">
              <option value="">— pick bank —</option>
              {banks.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Payment date</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
                   data-testid="pay-liab-date"
                   className="w-full border rounded px-2 py-1.5 text-sm font-mono-num" />
          </div>
        </div>

        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Agency / payee</label>
          <input value={agency} onChange={e => setAgency(e.target.value)}
                 placeholder="e.g. IRS 941, EDD, State Withholding"
                 data-testid="pay-liab-agency"
                 className="w-full border rounded px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Memo</label>
          <input value={memo} onChange={e => setMemo(e.target.value)}
                 data-testid="pay-liab-memo"
                 className="w-full border rounded px-2 py-1.5 text-sm" />
        </div>

        <div className="rounded-md border bg-slate-50 p-2 text-sm flex items-center justify-between">
          <span className="text-slate-500 text-xs">Total to pay</span>
          <span className="font-mono-num font-bold text-slate-900">{fmtMoney(total)}</span>
        </div>

        <button onClick={save} disabled={busy || total <= 0}
                data-testid="pay-liab-save"
                className="w-full py-2 rounded-md bg-emerald-600 text-white text-sm inline-flex items-center justify-center gap-1.5 hover:bg-emerald-700 disabled:opacity-50">
          {busy && <Loader2 size={13} className="animate-spin" />}
          Post payment
        </button>
      </div>
    </div>
  );
}


// ── Pay stub PDF opener ────────────────────────────────────────────

function StubPdfButton({ currentId, stubId, testid }) {
  const open = () => {
    const url = `${api.defaults.baseURL || ""}/companies/${currentId}/payroll/stubs/${stubId}/pdf`;
    // Attach token — the PDF endpoint requires auth like everything else.
    const token = localStorage.getItem("axiom_token") || "";
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.blob())
      .then(blob => {
        const w = window.open(URL.createObjectURL(blob), "_blank");
        if (!w) toast.error("Pop-up blocked — allow pop-ups to view the pay stub");
      })
      .catch(() => toast.error("Could not open pay stub"));
  };
  return (
    <button onClick={open}
            data-testid={testid}
            title="Download pay stub PDF"
            className="text-xs px-2 py-1 rounded border hover:bg-slate-100 inline-flex items-center gap-1">
      <FileText size={11} /> PDF
    </button>
  );
}
