import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import {
  Loader2, Play as PlayCircle, CheckCircle2, AlertCircle, RefreshCw,
  Database, FileText, ScanLine, ChevronRight, ChevronDown,
} from "lucide-react";

/**
 * Superadmin — QBO GL-as-Source-of-Truth Lab.
 *
 * Experimental page that proves GL-derived reports match QBO's
 * canonical BalanceSheet + ProfitAndLoss to the penny. Three
 * phases:
 *
 *   1. Migrate — pull QBO GL for every account into `qbo_gl_lines`
 *   2. Report  — aggregate `qbo_gl_lines` into BS + P&L
 *   3. Verify  — diff GL-derived numbers against QBO's own report
 *                endpoints; row-level match/drift indicators
 *
 * Feb 28 2026 — built after Emeral Coast residual $463K drift
 * couldn't be explained by the current migration pipeline. This
 * page is the artifact that greenlights the Phase 2 primary-
 * migration refactor.
 */
const fmt = (n) => {
  if (n == null || Number.isNaN(n)) return "—";
  const v = Number(n);
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  return `${sign}$${abs.toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
};

const VerdictBadge = ({ verdict }) => {
  const map = {
    PERFECT: {
      cls: "bg-emerald-50 text-emerald-700 ring-emerald-200",
      icon: CheckCircle2, label: "PERFECT",
    },
    CLOSE: {
      cls: "bg-amber-50 text-amber-700 ring-amber-200",
      icon: AlertCircle, label: "CLOSE",
    },
    DRIFT: {
      cls: "bg-rose-50 text-rose-700 ring-rose-200",
      icon: AlertCircle, label: "DRIFT",
    },
  };
  const m = map[verdict] || map.DRIFT;
  const I = m.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ring-1 ${m.cls}`}
      data-testid="gl-lab-verdict-badge"
    >
      <I className="h-3.5 w-3.5" />
      {m.label}
    </span>
  );
};

export default function AdminQboGlLab() {
  const [companies, setCompanies] = useState([]);
  const [cid, setCid] = useState("");
  const [basis, setBasis] = useState("Accrual");
  const [startDate, setStartDate] = useState("2000-01-01");
  const [endDate, setEndDate] = useState("2099-12-31");

  const [migrating, setMigrating] = useState(false);
  const [migrateResult, setMigrateResult] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState(null);
  const [error, setError] = useState("");

  const [expandedSection, setExpandedSection] = useState({
    balance_sheet: true, profit_and_loss: true,
  });
  const [showMatched, setShowMatched] = useState(false);

  // Load companies — superadmin sees every company on the tenant.
  useEffect(() => {
    (async () => {
      try {
        const r = await api.get("/admin/overview");
        const list = (r.data?.companies || [])
          .map((c) => ({ id: c.id, name: c.name || c.id }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setCompanies(list);
        // Prefer Emeral Coast preview clone if present.
        const preferred = list.find(
          (c) => (c.name || "").toLowerCase().includes("emeral")
        );
        setCid(preferred?.id || list[0]?.id || "");
      } catch (e) {
        setError(String(e?.response?.data?.detail || e.message));
      }
    })();
  }, []);

  const runMigrate = async () => {
    setError("");
    setMigrating(true);
    setMigrateResult(null);
    try {
      const r = await api.post(
        `/admin/qbo/gl-migrate/${cid}`,
        { accounting_method: basis, start_date: startDate, end_date: endDate },
        { timeout: 300000 },
      );
      setMigrateResult(r.data);
    } catch (e) {
      setError(String(e?.response?.data?.detail || e.message));
    } finally {
      setMigrating(false);
    }
  };

  const runVerify = async () => {
    setError("");
    setVerifying(true);
    setVerifyResult(null);
    try {
      const r = await api.post(
        `/admin/qbo/gl-verify/${cid}`,
        {},
        {
          params: {
            accounting_method: basis,
            start_date: startDate,
            end_date: endDate,
          },
          timeout: 120000,
        },
      );
      setVerifyResult(r.data);
    } catch (e) {
      setError(String(e?.response?.data?.detail || e.message));
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8" data-testid="admin-qbo-gl-lab">
      {/* ---------- Header ---------- */}
      <div className="mb-8">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-slate-500">
          <span>Superadmin</span>
          <ChevronRight className="h-3 w-3" />
          <span>Experimental</span>
        </div>
        <h1 className="mt-1 text-3xl font-semibold text-slate-900">
          QBO GL Lab
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">
          Test bench for the <b>GL-as-source-of-truth</b> migration
          approach. Pulls QBO's own General Ledger, aggregates it into
          BS + P&amp;L, then verifies against QBO's canonical
          BalanceSheet + ProfitAndLoss endpoints. If they agree to the
          penny, we've proven the concept and can promote GL to the
          primary migration path.
        </p>
      </div>

      {/* ---------- Controls ---------- */}
      <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              Company
            </label>
            <select
              value={cid}
              onChange={(e) => setCid(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              data-testid="gl-lab-company-select"
            >
              {companies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              Basis
            </label>
            <select
              value={basis}
              onChange={(e) => setBasis(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              data-testid="gl-lab-basis-select"
            >
              <option value="Accrual">Accrual</option>
              <option value="Cash">Cash</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              Start date
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              data-testid="gl-lab-start-date"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              End date
            </label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              data-testid="gl-lab-end-date"
            />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            onClick={runMigrate}
            disabled={!cid || migrating}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="gl-lab-migrate-button"
          >
            {migrating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Database className="h-4 w-4" />
            )}
            {migrating ? "Pulling GL…" : "1. Run GL Migrate"}
          </button>
          <button
            onClick={runVerify}
            disabled={!cid || verifying}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="gl-lab-verify-button"
          >
            {verifying ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ScanLine className="h-4 w-4" />
            )}
            {verifying ? "Verifying…" : "2. Verify vs QBO"}
          </button>
          {error && (
            <div className="text-xs text-rose-600" data-testid="gl-lab-error">
              {error}
            </div>
          )}
        </div>
      </div>

      {/* ---------- Migrate result ---------- */}
      {migrateResult && (
        <div
          className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
          data-testid="gl-lab-migrate-panel"
        >
          <div className="mb-3 flex items-center gap-2">
            <Database className="h-4 w-4 text-slate-500" />
            <h2 className="text-sm font-semibold text-slate-900">
              GL Migrate — Result
            </h2>
          </div>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <StatCard label="Accounts walked" value={migrateResult.accounts_walked} />
            <StatCard label="Total GL lines" value={migrateResult.total_lines_pulled?.toLocaleString()} />
            <StatCard label="Prior rows wiped" value={migrateResult.wiped_prior_rows?.toLocaleString()} />
            <StatCard
              label="Walk errors"
              value={migrateResult.walk_errors?.length ?? 0}
              tone={migrateResult.walk_errors?.length ? "rose" : "emerald"}
            />
          </div>
          <div className="mt-3 text-xs text-slate-500">
            {migrateResult.started_at?.slice(0, 19)} → {migrateResult.finished_at?.slice(0, 19)}
          </div>
        </div>
      )}

      {/* ---------- Verify verdict ---------- */}
      {verifyResult && (
        <div
          className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
          data-testid="gl-lab-verify-panel"
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <ScanLine className="h-4 w-4 text-slate-500" />
              <h2 className="text-sm font-semibold text-slate-900">
                Verify — GL-derived vs QBO's canonical reports
              </h2>
            </div>
            <div className="flex items-center gap-3">
              <VerdictBadge verdict={verifyResult.overall_verdict} />
              <span className="text-xs text-slate-500">
                Total absolute drift:{" "}
                <b className="text-slate-900">
                  {fmt(verifyResult.total_abs_drift)}
                </b>
              </span>
            </div>
          </div>

          <div className="mb-4 flex items-center gap-3 text-xs text-slate-500">
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={showMatched}
                onChange={(e) => setShowMatched(e.target.checked)}
                className="rounded"
                data-testid="gl-lab-show-matched-toggle"
              />
              Show matched rows
            </label>
          </div>

          <SectionTable
            title="Balance Sheet"
            section={verifyResult.balance_sheet}
            expanded={expandedSection.balance_sheet}
            onToggle={() =>
              setExpandedSection((s) => ({
                ...s, balance_sheet: !s.balance_sheet,
              }))
            }
            showMatched={showMatched}
          />
          <SectionTable
            title="Profit &amp; Loss"
            section={verifyResult.profit_and_loss}
            expanded={expandedSection.profit_and_loss}
            onToggle={() =>
              setExpandedSection((s) => ({
                ...s, profit_and_loss: !s.profit_and_loss,
              }))
            }
            showMatched={showMatched}
          />
        </div>
      )}

      {/* ---------- Empty state ---------- */}
      {!migrateResult && !verifyResult && (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center text-sm text-slate-500">
          <FileText className="mx-auto mb-3 h-6 w-6 text-slate-400" />
          Pick a company + date range, then <b>Run GL Migrate</b> to
          seed <code>qbo_gl_lines</code>. Once done, <b>Verify vs QBO</b>{" "}
          compares our aggregate against QBO's own reports.
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function StatCard({ label, value, tone = "slate" }) {
  const toneMap = {
    slate: "text-slate-900",
    emerald: "text-emerald-700",
    rose: "text-rose-700",
  };
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-3">
      <div className="text-[11px] uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div className={`mt-1 text-lg font-semibold ${toneMap[tone]}`}>
        {value ?? "—"}
      </div>
    </div>
  );
}

function SectionTable({ title, section, expanded, onToggle, showMatched }) {
  if (!section) return null;
  const rows = section.rows || [];
  const visible = showMatched ? rows : rows.filter((r) => !r.match);
  const missing = section.missing_from_our_side || [];

  return (
    <div className="mb-4 rounded-lg border border-slate-200">
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-slate-50"
        data-testid={`gl-lab-section-toggle-${section.section}`}
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-slate-500" />
          ) : (
            <ChevronRight className="h-4 w-4 text-slate-500" />
          )}
          <span className="text-sm font-semibold text-slate-900">{title}</span>
          <span className="text-xs text-slate-500">
            {section.matched_accounts}/{section.total_accounts} matched
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <VerdictBadge verdict={section.verdict} />
          <span className="text-slate-500">
            drift <b className="text-slate-900">{fmt(section.sum_abs_drift)}</b>
          </span>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-slate-200">
          {visible.length === 0 && missing.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">
              {showMatched
                ? "No accounts in this section."
                : "🎉 All accounts match. Toggle 'Show matched rows' to view every account."}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-2 text-left">Account</th>
                  <th className="px-4 py-2 text-left">Type</th>
                  <th className="px-4 py-2 text-right">GL-derived</th>
                  <th className="px-4 py-2 text-right">QBO reported</th>
                  <th className="px-4 py-2 text-right">Δ</th>
                  <th className="px-4 py-2 text-center">Match</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((r) => (
                  <tr
                    key={r.account_qbo_id}
                    className={r.match ? "" : "bg-rose-50/40"}
                  >
                    <td className="px-4 py-2 font-medium text-slate-900">
                      {r.account_name}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-500">
                      {r.account_type}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-800">
                      {fmt(r.gl_derived)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-800">
                      {fmt(r.qbo_reported)}
                    </td>
                    <td className={`px-4 py-2 text-right tabular-nums font-semibold ${Math.abs(r.delta || 0) < 0.01 ? "text-slate-400" : "text-rose-700"}`}>
                      {fmt(r.delta)}
                    </td>
                    <td className="px-4 py-2 text-center">
                      {r.match ? (
                        <CheckCircle2 className="mx-auto h-4 w-4 text-emerald-600" />
                      ) : (
                        <AlertCircle className="mx-auto h-4 w-4 text-rose-600" />
                      )}
                    </td>
                  </tr>
                ))}
                {missing.map((m) => (
                  <tr key={`missing-${m.account_qbo_id}`} className="bg-amber-50/60">
                    <td className="px-4 py-2 text-slate-500 italic">
                      (Missing on Axiom side — qbo_id={m.account_qbo_id})
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-400">—</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-400">—</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-800">
                      {fmt(m.qbo_reported)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums font-semibold text-amber-700">
                      {fmt(-m.qbo_reported)}
                    </td>
                    <td className="px-4 py-2 text-center">
                      <AlertCircle className="mx-auto h-4 w-4 text-amber-600" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
