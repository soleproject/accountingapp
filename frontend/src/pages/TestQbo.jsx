import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  FlaskConical, RefreshCw, Play, ChevronRight, Loader2,
  Trash2, X, ShieldCheck, Link2, Unplug, FileBarChart2,
} from "lucide-react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// Test QBO — an isolated raw migration workbench. Pulls every
// supported QBO entity into `qbo_test_raw` without touching the
// production tables. Follows the company's currently-connected
// QuickBooks environment (sandbox / production).
//
// Sidebar entry: right below "Connect QBO". No side effects on the
// production ledger, reports, or dashboards — pure raw payload lab.

// Human-readable labels for the tile grid. Order = the tile grid
// reading order (grouped: master data → HR/dimensional → sales side →
// bill side → bank/cash → manual/inventory → reference → company).
const ENTITY_META = [
  // Master data
  { key: "Account",              label: "Chart of Accounts" },
  { key: "Customer",             label: "Customers" },
  { key: "Vendor",               label: "Vendors" },
  { key: "Item",                 label: "Items" },
  // HR + dimensional
  { key: "Employee",             label: "Employees" },
  { key: "Class",                label: "Classes" },
  { key: "Department",           label: "Departments" },
  { key: "CustomerType",         label: "Customer Types" },
  // Sales side
  { key: "Invoice",              label: "Invoices" },
  { key: "Estimate",             label: "Estimates" },
  { key: "SalesReceipt",         label: "Sales Receipts" },
  { key: "CreditMemo",           label: "Credit Memos" },
  { key: "RefundReceipt",        label: "Refund Receipts" },
  // Bill side
  { key: "Bill",                 label: "Bills" },
  { key: "PurchaseOrder",        label: "Purchase Orders" },
  { key: "VendorCredit",         label: "Vendor Credits" },
  { key: "BillPayment",          label: "Bill Payments" },
  // Bank + cash
  { key: "Payment",              label: "Payments (received)" },
  { key: "Deposit",              label: "Deposits" },
  { key: "Transfer",             label: "Transfers" },
  { key: "CreditCardPayment",    label: "Credit Card Payments" },
  { key: "Purchase",             label: "Purchases / Expenses" },
  // Manual + inventory
  { key: "JournalEntry",         label: "Journal Entries" },
  { key: "InventoryAdjustment",  label: "InventoryAdjustment" },
  { key: "RecurringTransaction", label: "Recurring Transactions" },
  // Reference
  { key: "PaymentMethod",        label: "Payment Methods" },
  { key: "Term",                 label: "Terms" },
  { key: "TaxAgency",            label: "Tax Agencies" },
  { key: "TaxCode",              label: "Tax Codes" },
  { key: "TaxRate",              label: "Tax Rates" },
  // Company
  { key: "CompanyInfo",          label: "Company Info" },
  { key: "Preferences",          label: "Preferences" },
  { key: "Budget",               label: "Budgets" },
  { key: "Attachable",           label: "Attachments" },
];

export default function TestQbo() {
  const { currentId } = useCompany();
  const [loading, setLoading]   = useState(true);
  const [running, setRunning]   = useState(false);
  const [runningReports, setRunningReports] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [preview, setPreview]   = useState(null);
  const [confirm, setConfirm]   = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [disconnectConfirm, setDisconnectConfirm] = useState(false);
  const [drill, setDrill]       = useState(null);   // {entity_type, ...}
  const [report, setReport]     = useState({ name: "BalanceSheet",
                                              basis: "Accrual" });
  const [reportData, setReportData] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);

  const refresh = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const r = await api.get(`/companies/${currentId}/qbo-test/preview`);
      setPreview(r.data);
    } catch (e) {
      toast.error("Failed to load Test QBO preview");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [currentId]);

  // Auto-load reports whenever the selected report/basis changes
  // AND the report has been fetched at least once.
  useEffect(() => {
    if (!currentId) return;
    const avail = preview?.reports_available?.[report.name]?.[report.basis];
    if (!avail) { setReportData(null); return; }
    setReportLoading(true);
    api.get(`/companies/${currentId}/qbo-test/reports/${report.name}`, {
      params: { basis: report.basis },
    }).then((r) => setReportData(r.data))
      .catch(() => toast.error("Failed to load report"))
      .finally(() => setReportLoading(false));
  }, [currentId, report.name, report.basis, preview?.reports_available]);

  const connectQbo = async () => {
    setConnecting(true);
    try {
      const r = await api.post(
        `/companies/${currentId}/qbo-test/oauth/start`,
        { return_path: "/test-qbo?qbo=connected" },
      );
      // Full-page redirect to Intuit consent screen.
      window.location.href = r.data.url;
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not start OAuth");
      setConnecting(false);
    }
  };

  const disconnectQbo = async () => {
    setDisconnectConfirm(false);
    try {
      await api.post(`/companies/${currentId}/qbo-test/disconnect`);
      toast.success("Test QBO disconnected");
      await refresh();
    } catch {
      toast.error("Disconnect failed");
    }
  };

  const runMigrate = async () => {
    setConfirm(false);
    setRunning(true);
    try {
      const r = await api.post(`/companies/${currentId}/qbo-test/migrate`);
      const total = Object.values(r.data.counts || {})
                       .reduce((a, b) => a + b, 0);
      if (r.data.ok) {
        toast.success(`Pulled ${total} raw rows across ${
          Object.keys(r.data.counts).length} entities`);
      } else {
        const failed = Object.keys(r.data.errors || {}).join(", ");
        toast.warning(`Completed with errors on: ${failed}`);
      }
      await refresh();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Migration failed");
    } finally {
      setRunning(false);
    }
  };

  // Import via the production QBO OAuth link — no separate consent
  // step. Backend uses `db.qbo_connections` tokens for the read but
  // still writes to `qbo_test_raw`. Also runs the reports refresh so
  // the BS/P&L snapshot lands in `qbo_test_reports`. Aug 22 2026.
  const runMigrateFromProd = async () => {
    setRunning(true);
    try {
      const r = await api.post(
        `/companies/${currentId}/qbo-test/migrate`, null,
        { params: { use_prod: true } },
      );
      const total = Object.values(r.data.counts || {})
                       .reduce((a, b) => a + b, 0);
      if (r.data.ok) {
        toast.success(`Imported ${total} raw rows from production QBO`);
      } else {
        toast.warning("Completed with errors on some entities");
      }
      // Pull reports too so the panel lights up immediately.
      try {
        await api.post(`/companies/${currentId}/qbo-test/reports/refresh`,
                        null, { params: { use_prod: true } });
      } catch { /* non-fatal */ }
      await refresh();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Import failed");
    } finally {
      setRunning(false);
    }
  };

  const runReset = async () => {
    setResetConfirm(false);
    try {
      const r = await api.post(`/companies/${currentId}/qbo-test/reset`);
      toast.success(`Wiped ${r.data.wiped} rows`);
      await refresh();
    } catch (e) {
      toast.error("Reset failed");
    }
  };

  const refreshReports = async () => {
    setRunningReports(true);
    // When the user reached this panel via "Import from Production
    // Connection" (no test OAuth) reuse those prod tokens for the
    // reports fetch too. Writes still land in qbo_test_reports.
    const useProd = !preview?.connected && preview?.prod_connected;
    try {
      const r = await api.post(
        `/companies/${currentId}/qbo-test/reports/refresh`,
        null,
        useProd ? { params: { use_prod: true } } : undefined,
      );
      if (r.data.ok) {
        toast.success(`Pulled ${r.data.fetched.length} report views`);
      } else {
        toast.warning("Some reports failed to fetch");
      }
      await refresh();
    } catch {
      toast.error("Report fetch failed");
    } finally {
      setRunningReports(false);
    }
  };

  const total = useMemo(() => {
    if (!preview?.counts) return 0;
    return Object.values(preview.counts).reduce((a, b) => a + b, 0);
  }, [preview]);

  const hasReports = !!preview?.reports_available &&
    Object.keys(preview.reports_available).length > 0;

  if (!currentId) {
    return (
      <div className="p-8 text-sm text-slate-500">
        Select a company to use Test QBO.
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto space-y-6"
          data-testid="test-qbo-page">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-indigo-100 dark:bg-indigo-900/40 p-2.5">
          <FlaskConical className="w-5 h-5 text-indigo-600 dark:text-indigo-300" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Test QBO</h1>
          <p className="text-sm text-slate-500 mt-1 max-w-2xl">
            Isolated raw-migration workbench with its own QuickBooks
            connection. Every entity + report is stored in the
            dedicated <code
              className="text-[11px] px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">
              qbo_test_*</code> collections. Your live ledger, reports,
            and dashboards are never touched.
          </p>
        </div>
      </div>

      {/* Connect step 1 — only when not yet connected */}
      {!preview?.connected && !loading && (
        <div className="rounded-xl border bg-white dark:bg-slate-900
                         dark:border-slate-800 p-5 space-y-4"
              data-testid="test-qbo-connect-card">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-full bg-slate-100
                             dark:bg-slate-800 flex items-center justify-center
                             text-xs font-medium text-slate-600
                             dark:text-slate-300">
              1
            </div>
            <div className="text-base font-medium">Connect</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={connectQbo}
              disabled={connecting}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg
                         bg-emerald-600 text-white text-sm font-medium
                         hover:bg-emerald-500 disabled:opacity-60"
              data-testid="test-qbo-connect-btn"
            >
              {connecting
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <ShieldCheck className="w-4 h-4" />}
              Connect to QuickBooks Online
            </button>
            {/* Import from prod — only when a production QBO connection
                exists on this company. Reuses prod OAuth tokens for
                the pull but writes land in `qbo_test_raw` (isolation
                preserved). Aug 22 2026 — user request. */}
            {preview?.prod_connected && (
              <button
                onClick={runMigrateFromProd}
                disabled={running || connecting}
                className="inline-flex items-center gap-2 px-4 py-2.5
                           rounded-lg border border-indigo-300 bg-white
                           text-indigo-700 text-sm font-medium
                           hover:bg-indigo-50 disabled:opacity-60"
                data-testid="test-qbo-import-from-prod-btn"
              >
                {running
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <Play className="w-4 h-4" />}
                Import from Production Connection
              </button>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-2">
            {preview?.prod_connected
              ? <>Reuse your production QBO connection to populate
                  Test QBO without a second OAuth. Writes still land
                  in <code>qbo_test_raw</code> — your live ledger
                  is untouched.</>
              : <>Uses an isolated OAuth connection stored in
                  {" "}<code>qbo_test_connections</code>. Your production
                  QBO link is unaffected.</>}
          </p>
        </div>
      )}

      {/* Connection strip — visible when connected */}
      {preview?.connected && (
        <div className="rounded-xl border bg-white dark:bg-slate-900
                         dark:border-slate-800 p-4 flex items-center gap-4"
              data-testid="test-qbo-connection-strip">
          <div className="flex-1">
            <div className="text-xs uppercase tracking-wide text-slate-500">
              QuickBooks connection (Test QBO — isolated)
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className="inline-flex items-center gap-1.5 text-sm">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"/>
                Connected
              </span>
              <span className="text-[11px] px-2 py-0.5 rounded-full
                                bg-slate-100 dark:bg-slate-800
                                text-slate-600 dark:text-slate-300 uppercase">
                {preview.environment}
              </span>
              <span className="text-xs text-slate-500 font-mono">
                · realm {preview.realm_id}
              </span>
            </div>
            {preview?.last_fetched_at && (
              <div className="text-[11px] text-slate-400 mt-1">
                Last entity pull · {new Date(preview.last_fetched_at).toLocaleString()}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={refresh}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg
                         text-sm border hover:bg-slate-50
                         dark:border-slate-800 dark:hover:bg-slate-800"
              disabled={loading || running}
              data-testid="test-qbo-refresh-btn"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </button>
            <button
              onClick={() => setDisconnectConfirm(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg
                         text-sm border hover:bg-rose-50 hover:border-rose-200
                         hover:text-rose-600 dark:border-slate-800
                         dark:hover:bg-rose-950/40"
              disabled={running || runningReports}
              data-testid="test-qbo-disconnect-btn"
            >
              <Unplug className="w-4 h-4" />
              Disconnect
            </button>
            <button
              onClick={() => setResetConfirm(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg
                         text-sm border hover:bg-slate-50
                         dark:border-slate-800 dark:hover:bg-slate-800"
              disabled={total === 0 || running}
              data-testid="test-qbo-reset-btn"
            >
              <Trash2 className="w-4 h-4" />
              Reset data
            </button>
            <button
              onClick={() => setConfirm(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg
                         text-sm font-medium bg-indigo-600 text-white
                         hover:bg-indigo-500 disabled:opacity-50
                         disabled:cursor-not-allowed"
              disabled={running || runningReports}
              data-testid="test-qbo-migrate-btn"
            >
              {running ? <Loader2 className="w-4 h-4 animate-spin" />
                        : <Play className="w-4 h-4" />}
              {running ? "Migrating…" : "Run Migration"}
            </button>
          </div>
        </div>
      )}

      {/* Total pulled */}
      {total > 0 && (
        <div className="text-sm text-slate-600 dark:text-slate-300"
              data-testid="test-qbo-total">
          {total.toLocaleString()} raw entity records
          across {Object.keys(preview.counts).filter(k => preview.counts[k] > 0).length} entity types
        </div>
      )}

      {/* Tile grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
            data-testid="test-qbo-tile-grid">
        {ENTITY_META.map(({ key, label }) => {
          const count = preview?.counts?.[key] ?? 0;
          const has = count > 0;
          return (
            <button
              key={key}
              onClick={() => has && setDrill({ entity_type: key, label })}
              disabled={!has}
              className={`flex items-center justify-between p-4 rounded-xl border
                          text-left transition ${
                has
                  ? "bg-white dark:bg-slate-900 hover:border-indigo-400 hover:shadow-sm cursor-pointer dark:border-slate-800"
                  : "bg-slate-50/60 dark:bg-slate-900/40 dark:border-slate-800/60 cursor-default"
              }`}
              data-testid={`test-qbo-tile-${key}`}
            >
              <div className="text-sm">{label}</div>
              <div className="flex items-center gap-1.5">
                <span className={`font-mono text-sm ${
                  has ? "text-slate-900 dark:text-slate-100"
                       : "text-slate-400"}`}>
                  {count}
                </span>
                {has && <ChevronRight className="w-4 h-4 text-slate-400" />}
              </div>
            </button>
          );
        })}
      </div>

      {/* Reports section — visible when EITHER the isolated Test QBO
          connection exists OR the production QBO connection is
          reusable (Import-from-Prod flow). Aug 22 2026 fix. */}
      {(preview?.connected || preview?.prod_connected) && (
        <ReportsPanel
          cid={currentId}
          report={report}
          setReport={setReport}
          data={reportData}
          loading={reportLoading}
          hasReports={hasReports}
          refresh={refreshReports}
          running={runningReports}
          fetchedAt={preview?.reports_available?.[report.name]?.[report.basis]?.fetched_at}
          useProd={!preview?.connected && preview?.prod_connected}
        />
      )}

      {/* Migrate confirm */}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run Test QBO migration?</AlertDialogTitle>
            <AlertDialogDescription>
              This wipes any existing test entity + report data for this
              company and re-pulls every supported entity into
              <code> qbo_test_raw</code>. Runs against your{" "}
              <b>{preview?.environment}</b> QuickBooks connection and
              touches no production tables.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={runMigrate}
                                data-testid="test-qbo-confirm-migrate">
              Run migration
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reset confirm */}
      <AlertDialog open={resetConfirm} onOpenChange={setResetConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Wipe test data?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes every row in <code>qbo_test_raw</code> and
              <code> qbo_test_reports</code> for this company. The
              QuickBooks connection is left intact.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={runReset}
                                data-testid="test-qbo-confirm-reset">
              Wipe
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Disconnect confirm */}
      <AlertDialog open={disconnectConfirm}
                    onOpenChange={setDisconnectConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Test QBO?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes the isolated Test QBO OAuth connection. Any
              previously-pulled entities and reports remain in the
              database — click Reset data separately if you also want
              to wipe those.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={disconnectQbo}
                                data-testid="test-qbo-confirm-disconnect">
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Entity drill-down */}
      <EntityDrillDown
        cid={currentId}
        drill={drill}
        onClose={() => setDrill(null)}
      />
    </div>
  );
}


// ---------- Reports panel — accountant-style BS & P&L ----------

function ReportsPanel({ cid, report, setReport, data, loading,
                        hasReports, refresh, running, fetchedAt }) {
  return (
    <div className="rounded-xl border bg-white dark:bg-slate-900
                     dark:border-slate-800 p-5 space-y-4"
          data-testid="test-qbo-reports-panel">
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-amber-100 dark:bg-amber-900/30 p-2">
          <FileBarChart2 className="w-4 h-4 text-amber-600 dark:text-amber-300" />
        </div>
        <div className="flex-1">
          <div className="font-medium">QBO Reports</div>
          <div className="text-xs text-slate-500">
            Raw Balance Sheet & Profit and Loss pulled directly from
            QuickBooks. Cash and Accrual basis, unchanged from QBO.
          </div>
        </div>
        <button
          onClick={refresh}
          disabled={running}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg
                     text-sm font-medium bg-amber-600 text-white
                     hover:bg-amber-500 disabled:opacity-60"
          data-testid="test-qbo-reports-refresh-btn"
        >
          {running ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <RefreshCw className="w-4 h-4" />}
          {running ? "Pulling…" : hasReports ? "Refresh reports" : "Pull reports"}
        </button>
      </div>

      {/* Selector */}
      {hasReports && (
        <div className="flex flex-wrap gap-2 border-t
                         dark:border-slate-800 pt-4">
          {["BalanceSheet", "ProfitAndLoss"].map((n) => (
            <button
              key={n}
              onClick={() => setReport(r => ({ ...r, name: n }))}
              className={`px-3 py-1.5 rounded-lg text-sm border ${
                report.name === n
                  ? "bg-indigo-600 border-indigo-600 text-white"
                  : "hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800"
              }`}
              data-testid={`test-qbo-report-tab-${n}`}
            >
              {n === "BalanceSheet" ? "Balance Sheet" : "Profit & Loss"}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2 text-xs">
            {["Accrual", "Cash"].map((b) => (
              <button
                key={b}
                onClick={() => setReport(r => ({ ...r, basis: b }))}
                className={`px-2.5 py-1 rounded-md ${
                  report.basis === b
                    ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                    : "text-slate-500 hover:text-slate-700"
                }`}
                data-testid={`test-qbo-basis-${b}`}
              >
                {b}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Table */}
      {hasReports && (
        <div className="overflow-auto rounded-lg border
                         dark:border-slate-800"
              data-testid="test-qbo-report-table">
          {loading ? (
            <div className="p-6 text-sm text-slate-500 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin"/> Loading report…
            </div>
          ) : data ? (
            <ReportTable data={data} />
          ) : (
            <div className="p-6 text-sm text-slate-500">
              Report not available. Click Pull reports.
            </div>
          )}
          {fetchedAt && (
            <div className="text-[11px] text-slate-400 px-4 py-2 border-t
                             dark:border-slate-800">
              Fetched · {new Date(fetchedAt).toLocaleString()}
            </div>
          )}
        </div>
      )}

      {!hasReports && !running && (
        <div className="text-sm text-slate-500 border-t
                         dark:border-slate-800 pt-4">
          No reports pulled yet. Click <b>Pull reports</b> to fetch
          Balance Sheet and Profit and Loss from QuickBooks.
        </div>
      )}
    </div>
  );
}


function ReportTable({ data }) {
  const cols = data.columns || [];
  return (
    <table className="min-w-full text-sm">
      <thead className="bg-slate-50 dark:bg-slate-950 sticky top-0">
        <tr>
          <th className="text-left px-4 py-2 font-medium text-slate-600
                          dark:text-slate-400 uppercase text-[11px] tracking-wide">
            {cols[0] || "Account"}
          </th>
          {cols.slice(1).map((c, i) => (
            <th key={i} className="text-right px-4 py-2 font-medium
                                     text-slate-600 dark:text-slate-400
                                     uppercase text-[11px] tracking-wide">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {(data.rows || []).map((r, i) => {
          const isHeader = r.kind === "section_header";
          const isTotal  = r.kind === "total";
          const indent = r.depth * 18;
          return (
            <tr key={i}
                 className={`${
                    isHeader
                      ? "font-semibold text-slate-800 dark:text-slate-100"
                      : isTotal
                      ? "font-medium bg-slate-50/70 dark:bg-slate-950/50 border-t dark:border-slate-800"
                      : "text-slate-700 dark:text-slate-300"
                  }`}>
              <td className="px-4 py-1.5"
                   style={{ paddingLeft: 16 + indent }}>
                {r.label}
              </td>
              {r.values.map((v, j) => (
                <td key={j}
                     className="px-4 py-1.5 text-right font-mono tabular-nums">
                  {_fmt(v)}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}


function _fmt(v) {
  if (v === "" || v == null) return "";
  const n = Number(v);
  if (Number.isNaN(n)) return v;
  const s = Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `(${s})` : s;
}


function EntityDrillDown({ cid, drill, onClose }) {
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!drill || !cid) return;
    setLoading(true);
    api.get(`/companies/${cid}/qbo-test/entity/${drill.entity_type}`, {
      params: { limit: 100 },
    }).then((r) => {
      setRows(r.data.rows || []);
      setTotal(r.data.total || 0);
    }).catch(() => {
      toast.error("Failed to load entity");
    }).finally(() => setLoading(false));
  }, [drill, cid]);

  return (
    <Dialog open={!!drill} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>{drill?.label}</span>
            <span className="text-xs font-mono px-2 py-0.5 rounded
                              bg-slate-100 dark:bg-slate-800 text-slate-500">
              {drill?.entity_type}
            </span>
            <span className="text-xs text-slate-500 font-normal">
              · showing {rows?.length ?? 0} of {total}
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-auto rounded-lg border
                         dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
          {loading && (
            <div className="p-6 text-sm text-slate-500 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading raw rows…
            </div>
          )}
          {!loading && rows && rows.length === 0 && (
            <div className="p-6 text-sm text-slate-500">No rows.</div>
          )}
          {!loading && rows && rows.map((r, i) => (
            <details key={i}
                      className="border-b dark:border-slate-800 last:border-none">
              <summary className="cursor-pointer p-3 text-sm font-mono
                                   hover:bg-white dark:hover:bg-slate-900">
                <span className="text-slate-500">{drill?.entity_type} · </span>
                <span>Id {r.qbo_id}</span>
                {r.raw?.DisplayName && (
                  <span className="ml-2 text-slate-700 dark:text-slate-200 font-sans">
                    {r.raw.DisplayName}
                  </span>
                )}
                {r.raw?.Name && !r.raw?.DisplayName && (
                  <span className="ml-2 text-slate-700 dark:text-slate-200 font-sans">
                    {r.raw.Name}
                  </span>
                )}
                {r.raw?.DocNumber && (
                  <span className="ml-2 text-slate-500 font-sans">
                    #{r.raw.DocNumber}
                  </span>
                )}
                {r.raw?.TotalAmt !== undefined && (
                  <span className="ml-2 text-slate-500 font-sans">
                    · ${r.raw.TotalAmt}
                  </span>
                )}
              </summary>
              <pre className="text-[11px] p-3 pt-0 whitespace-pre-wrap break-all
                              text-slate-600 dark:text-slate-300">
                {JSON.stringify(r.raw, null, 2)}
              </pre>
            </details>
          ))}
        </div>
        <DialogFooter>
          <button
            onClick={onClose}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg
                       text-sm border hover:bg-slate-50
                       dark:border-slate-800 dark:hover:bg-slate-800"
          >
            <X className="w-4 h-4" /> Close
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
