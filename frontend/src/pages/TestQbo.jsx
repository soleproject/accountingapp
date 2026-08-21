import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  FlaskConical, RefreshCw, Play, ChevronRight, Loader2,
  Trash2, X, ExternalLink,
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
// reading order (matches the Connect QBO "Preview scope" panel).
const ENTITY_META = [
  { key: "Account",             label: "Chart of Accounts" },
  { key: "Customer",            label: "Customers" },
  { key: "Vendor",              label: "Vendors" },
  { key: "Item",                label: "Items" },
  { key: "Invoice",             label: "Invoices" },
  { key: "Bill",                label: "Bills" },
  { key: "Payment",             label: "Payments (received)" },
  { key: "BillPayment",         label: "Bill Payments" },
  { key: "JournalEntry",        label: "Journal Entries" },
  { key: "Deposit",             label: "Deposits" },
  { key: "Transfer",            label: "Transfers" },
  { key: "CreditMemo",          label: "Credit Memos" },
  { key: "SalesReceipt",        label: "Sales Receipts" },
  { key: "RefundReceipt",       label: "Refund Receipts" },
  { key: "Purchase",            label: "Purchases / Expenses" },
  { key: "InventoryAdjustment", label: "InventoryAdjustment" },
  { key: "Attachable",          label: "Attachments" },
];

export default function TestQbo() {
  const { currentId } = useCompany();
  const [loading, setLoading]   = useState(true);
  const [running, setRunning]   = useState(false);
  const [preview, setPreview]   = useState(null);
  const [confirm, setConfirm]   = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [drill, setDrill]       = useState(null);   // {entity_type, ...}

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

  const total = useMemo(() => {
    if (!preview?.counts) return 0;
    return Object.values(preview.counts).reduce((a, b) => a + b, 0);
  }, [preview]);

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
            Isolated raw-migration workbench. Pulls every QBO entity
            into a separate collection <code
              className="text-[11px] px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">
              qbo_test_raw</code> without touching your live ledger,
            reports, or dashboards. Follows the QuickBooks environment
            set in your company Settings.
          </p>
        </div>
      </div>

      {/* Connection strip */}
      <div className="rounded-xl border bg-white dark:bg-slate-900
                       dark:border-slate-800 p-4 flex items-center gap-4"
            data-testid="test-qbo-connection-strip">
        <div className="flex-1">
          <div className="text-xs uppercase tracking-wide text-slate-500">
            QuickBooks connection
          </div>
          <div className="flex items-center gap-2 mt-1">
            {preview?.connected ? (
              <>
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
              </>
            ) : (
              <span className="text-sm text-rose-500">
                Not connected — visit Connect QBO first.
              </span>
            )}
          </div>
          {preview?.last_fetched_at && (
            <div className="text-[11px] text-slate-400 mt-1">
              Last pull · {new Date(preview.last_fetched_at).toLocaleString()}
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
            onClick={() => setResetConfirm(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg
                       text-sm border hover:bg-rose-50 hover:border-rose-200
                       hover:text-rose-600 dark:border-slate-800
                       dark:hover:bg-rose-950/40"
            disabled={total === 0 || running}
            data-testid="test-qbo-reset-btn"
          >
            <Trash2 className="w-4 h-4" />
            Reset
          </button>
          <button
            onClick={() => setConfirm(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg
                       text-sm font-medium bg-indigo-600 text-white
                       hover:bg-indigo-500 disabled:opacity-50
                       disabled:cursor-not-allowed"
            disabled={!preview?.connected || running}
            data-testid="test-qbo-migrate-btn"
          >
            {running ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {running ? "Migrating…" : "Run Migration"}
          </button>
        </div>
      </div>

      {/* Total pulled */}
      {total > 0 && (
        <div className="text-sm text-slate-600 dark:text-slate-300"
              data-testid="test-qbo-total">
          {total.toLocaleString()} raw records
          across {Object.keys(preview.counts).filter(k => preview.counts[k] > 0).length} entity types
        </div>
      )}

      {/* Tile grid — 3 columns matching Connect QBO Preview panel */}
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

      {/* Migrate confirm */}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run Test QBO migration?</AlertDialogTitle>
            <AlertDialogDescription>
              This wipes any existing test data for this company and
              re-pulls every supported entity into <code>qbo_test_raw</code>.
              It runs against your <b>{preview?.environment}</b> QuickBooks
              connection and touches no other tables.
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
              Removes every row in <code>qbo_test_raw</code> for this
              company. The QBO connection is left intact.
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

      {/* Entity drill-down */}
      <EntityDrillDown
        cid={currentId}
        drill={drill}
        onClose={() => setDrill(null)}
      />
    </div>
  );
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
