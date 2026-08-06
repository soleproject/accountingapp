import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  Link2, CheckCircle2, XCircle, Loader2, ChevronRight,
  Sparkles, RefreshCw, Play, ShieldCheck,
} from "lucide-react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";

// Cadence of the migration-status poll while a job is running. QBO
// migrations for a mid-size realm typically finish in 30-90s; the
// 2s poll gives smooth progress feedback without hammering the API.
const POLL_MS = 2000;

const ENTITY_LABELS = {
  Account: "Chart of Accounts",
  Customer: "Customers",
  Vendor: "Vendors",
  Item: "Items",
  Invoice: "Invoices",
  Bill: "Bills",
  Payment: "Payments (received)",
  BillPayment: "Bill Payments",
  JournalEntry: "Journal Entries",
  Deposit: "Deposits",
  Transfer: "Transfers",
  CreditMemo: "Credit Memos",
  SalesReceipt: "Sales Receipts",
  RefundReceipt: "Refund Receipts",
  Purchase: "Purchases / Expenses",
  Attachable: "Attachments",
};

export default function QboConnect() {
  const { currentId } = useCompany();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState(null);
  const pollRef = useRef(null);

  const refreshStatus = async () => {
    if (!currentId) return;
    const r = await api.get(`/companies/${currentId}/qbo/status`);
    setStatus(r.data);
  };
  useEffect(() => { refreshStatus(); }, [currentId]);

  // OAuth callback lands with ?qbo=connected — toast + refresh state.
  useEffect(() => {
    if (params.get("qbo") === "connected") {
      toast.success("QuickBooks Online connected");
      refreshStatus();
      params.delete("qbo"); params.delete("realm");
      setParams(params, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const connect = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/companies/${currentId}/qbo/oauth/start`);
      window.location.href = r.data.url;
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to start QBO connection");
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!confirm("Disconnect from QuickBooks Online?\n\nThis revokes access at Intuit. Imported data stays in your ledger.")) return;
    setBusy(true);
    try {
      await api.post(`/companies/${currentId}/qbo/disconnect`);
      toast.success("Disconnected");
      setStatus({ connected: false });
      setPreview(null);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Disconnect failed");
    } finally { setBusy(false); }
  };

  const runPreview = async () => {
    setBusy(true);
    try {
      const r = await api.get(`/companies/${currentId}/qbo/preview`);
      setPreview(r.data);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Preview failed");
    } finally { setBusy(false); }
  };

  const startMigration = async () => {
    if (!confirm("Start migration?\n\nThis imports every listed record from QuickBooks Online into your ledger. Safe to re-run — records are matched by QBO ID.")) return;
    setBusy(true);
    try {
      const r = await api.post(`/companies/${currentId}/qbo/migrations`);
      setJob({ job_id: r.data.job_id, status: "queued", processed: 0 });
      startPolling(r.data.job_id);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Migration failed to start");
    } finally { setBusy(false); }
  };

  const pollOnce = async (jid) => {
    try {
      const r = await api.get(`/companies/${currentId}/qbo/migrations/${jid}`);
      setJob(r.data);
      if (r.data.status === "done" || r.data.status === "failed" || r.data.status === "cancelled") {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        if (r.data.status === "done") toast.success("Migration complete");
        else if (r.data.status === "failed") toast.error(`Migration failed: ${r.data.error || "unknown"}`);
      }
    } catch (e) { /* transient — keep polling */ }
  };
  const startPolling = (jid) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollOnce(jid);
    pollRef.current = setInterval(() => pollOnce(jid), POLL_MS);
  };
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const previewTotal = preview?.total ?? 0;
  const running = job && (job.status === "queued" || job.status === "running");
  const done = job && job.status === "done";

  return (
    <div className="p-6 max-w-5xl" data-testid="qbo-connect-page">
      <button
        onClick={() => navigate("/connections")}
        className="text-sm text-slate-500 hover:text-slate-800 mb-3 inline-flex items-center gap-1"
        data-testid="qbo-back-btn"
      >
        <ChevronRight size={14} className="rotate-180" /> Back to Connections
      </button>

      <div className="flex items-start gap-4 mb-6">
        <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-emerald-500 to-cyan-600 grid place-items-center text-white shrink-0">
          <Link2 size={26} />
        </div>
        <div>
          <h1 className="font-heading text-2xl font-semibold text-slate-900">QuickBooks Online</h1>
          <p className="text-sm text-slate-600 mt-1 max-w-2xl">
            Connect your QuickBooks Online company and migrate every account, contact, item,
            transaction and attachment into SmartBooks. One-way import — your QBO data stays
            untouched. Safe to re-run: matched by QBO ID.
          </p>
        </div>
      </div>

      {/* Step 1: Connect */}
      <section className="rounded-xl border bg-white p-5 mb-4" data-testid="qbo-step-connect">
        <div className="flex items-center gap-3 mb-3">
          <span className={`w-7 h-7 rounded-full grid place-items-center text-xs font-semibold ${
            status?.connected ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"
          }`}>1</span>
          <h2 className="font-heading font-semibold text-slate-900">Connect</h2>
          {status?.connected && (
            <span className="ml-auto inline-flex items-center gap-1 text-xs text-emerald-700 font-medium">
              <CheckCircle2 size={14} /> Connected
              {status.environment && (
                <span className="ml-1 text-slate-500">· {status.environment}</span>
              )}
            </span>
          )}
        </div>
        {status?.connected ? (
          <div className="flex items-center justify-between text-sm">
            <div className="text-slate-600">
              <div>Realm ID: <span className="font-mono text-xs">{status.realm_id}</span></div>
              <div className="text-xs text-slate-400 mt-1">Connected {status.connected_at?.slice(0, 10)}</div>
            </div>
            <button
              onClick={disconnect}
              disabled={busy}
              data-testid="qbo-disconnect-btn"
              className="px-3 py-1.5 text-xs rounded-md border border-red-200 bg-white text-red-700 hover:bg-red-50 disabled:opacity-40"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <button
            onClick={connect}
            disabled={busy || !currentId}
            data-testid="qbo-connect-btn"
            className="px-4 py-2 rounded-md bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-40 inline-flex items-center gap-2"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
            Connect to QuickBooks Online
          </button>
        )}
      </section>

      {/* Step 2: Preview */}
      <section className={`rounded-xl border bg-white p-5 mb-4 transition-opacity ${
        status?.connected ? "" : "opacity-40 pointer-events-none"
      }`} data-testid="qbo-step-preview">
        <div className="flex items-center gap-3 mb-3">
          <span className={`w-7 h-7 rounded-full grid place-items-center text-xs font-semibold ${
            preview ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"
          }`}>2</span>
          <h2 className="font-heading font-semibold text-slate-900">Preview scope</h2>
          {preview && (
            <span className="ml-auto text-xs text-slate-500">
              {previewTotal.toLocaleString()} records across {Object.keys(preview.counts).length} object types
            </span>
          )}
        </div>
        {!preview ? (
          <button
            onClick={runPreview}
            disabled={busy || !status?.connected}
            data-testid="qbo-preview-btn"
            className="px-4 py-2 rounded-md border bg-white text-sm hover:bg-slate-50 disabled:opacity-40 inline-flex items-center gap-2"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Preview what will import
          </button>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
            {Object.entries(preview.counts).map(([e, n]) => (
              <div key={e} className="flex items-center justify-between border rounded-md px-3 py-2">
                <span className="text-slate-700">{ENTITY_LABELS[e] || e}</span>
                <span className={`font-mono text-xs ${n < 0 ? "text-red-500" : "text-slate-900"}`}>
                  {n < 0 ? "—" : n.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Step 3: Migrate */}
      <section className={`rounded-xl border bg-white p-5 mb-4 transition-opacity ${
        preview ? "" : "opacity-40 pointer-events-none"
      }`} data-testid="qbo-step-migrate">
        <div className="flex items-center gap-3 mb-3">
          <span className={`w-7 h-7 rounded-full grid place-items-center text-xs font-semibold ${
            done ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"
          }`}>3</span>
          <h2 className="font-heading font-semibold text-slate-900">Migrate</h2>
          {job && (
            <span className="ml-auto text-xs">
              {running && <span className="inline-flex items-center gap-1 text-blue-700"><Loader2 size={12} className="animate-spin" /> {job.status}</span>}
              {done && <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 size={12} /> Complete</span>}
              {job.status === "failed" && <span className="inline-flex items-center gap-1 text-red-700"><XCircle size={12} /> Failed</span>}
            </span>
          )}
        </div>
        {!job ? (
          <button
            onClick={startMigration}
            disabled={busy || !preview}
            data-testid="qbo-migrate-btn"
            className="px-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-40 inline-flex items-center gap-2"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            Start migration
          </button>
        ) : (
          <div className="text-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="text-slate-700">
                {job.entity ? `Importing ${ENTITY_LABELS[job.entity] || job.entity}…` : job.phase}
              </span>
              <span className="font-mono text-xs text-slate-500">
                {(job.processed || 0).toLocaleString()} records
              </span>
            </div>
            <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-emerald-500 to-cyan-500 transition-all"
                style={{
                  width: `${done ? 100 : Math.min(90, ((job.processed || 0) / Math.max(1, previewTotal)) * 100)}%`,
                }}
              />
            </div>
            {job.error && (
              <div className="mt-2 text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
                <b>Error:</b> {job.error}
              </div>
            )}
            {done && (
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => navigate("/accounting/chart-of-accounts")}
                  className="px-3 py-1.5 text-xs rounded-md border bg-white hover:bg-slate-50"
                >
                  View Chart of Accounts
                </button>
                <button
                  onClick={() => navigate("/contacts")}
                  className="px-3 py-1.5 text-xs rounded-md border bg-white hover:bg-slate-50"
                >
                  View Contacts
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      <div className="text-xs text-slate-400 mt-6 flex items-start gap-2">
        <Sparkles size={12} className="mt-0.5 text-slate-300" />
        <span>
          V1 imports Foundation entities (Chart of Accounts, Customers, Vendors, Items).
          Transactional entities (Invoices, Bills, Payments, Journal Entries) land in the
          next release — the connection persists so you won't reconnect.
        </span>
      </div>
    </div>
  );
}
