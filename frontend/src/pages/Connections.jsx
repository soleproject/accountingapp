import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import PlaidLinkButton from "@/components/PlaidLinkButton";
import PlaidBackfillButton from "@/components/PlaidBackfillButton";
import StatementsTab from "@/components/StatementsTab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Link2, CheckCircle2, ChevronDown, ChevronRight, PlugZap, CircleDashed, Loader2, FileText } from "lucide-react";

export default function Connections() {
  const { currentId } = useCompany();
  const [accounts, setAccounts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [status, setStatus] = useState({ linked: false, connected: [], available: [] });
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [connecting, setConnecting] = useState(null); // plaid_account_id currently being connected

  const loadStatus = async () => {
    if (!currentId) return;
    setLoadingStatus(true);
    try {
      const r = await api.get(`/companies/${currentId}/plaid/accounts`);
      setStatus(r.data);
    } catch (e) {
      // ignore
    } finally { setLoadingStatus(false); }
  };

  useEffect(() => { loadStatus(); /* eslint-disable-next-line */ }, [currentId]);

  const onLinked = (accts) => {
    setAccounts(accts);
    toast.success(`Linked ${accts.length} bank accounts via Plaid`);
    loadStatus();
  };

  const [activeJob, setActiveJob] = useState(null);   // {job_id, status, kind, result?}

  // Poll active job every 2s until it completes/fails.
  useEffect(() => {
    if (!activeJob?.job_id || activeJob.status === "completed" || activeJob.status === "failed") {
      return undefined;
    }
    const t = setInterval(async () => {
      try {
        const r = await api.get(`/jobs/${activeJob.job_id}`);
        setActiveJob(r.data);
        if (r.data.status === "completed") {
          toast.success(
            `${r.data.kind === "plaid_reset_resync" ? "Full re-sync" : "Sync"} complete — ` +
            `imported ${r.data.result?.imported ?? 0} transaction(s)`
          );
          loadStatus();
          clearInterval(t);
        } else if (r.data.status === "failed") {
          toast.error(`Sync failed — ${(r.data.error || "").split(String.fromCharCode(10)).slice(-2, -1)[0] || "check backend logs"}`);
          clearInterval(t);
        }
      } catch (e) { /* keep polling; transient errors are OK */ }
    }, 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJob?.job_id, activeJob?.status]);

  const manualSync = async () => {
    setSyncing(true);
    try {
      const r = await api.post(`/companies/${currentId}/plaid/manual-sync`);
      setActiveJob({ job_id: r.data.job_id, status: "queued", kind: "plaid_manual_sync" });
      toast.info("Sync queued — running in the background");
    } catch (e) {
      toast.error(`Failed to queue sync: ${e.response?.data?.detail || e.message}`);
    } finally { setSyncing(false); }
  };

  const resetResync = async () => {
    if (!window.confirm(
      "Reset Plaid cursor and re-pull the entire transaction history?\n\n" +
      "Use this if your initial connection only imported the last ~30 days " +
      "(happens when Plaid's HISTORICAL_UPDATE webhook is missed). Duplicates " +
      "are auto-deduped, so this is safe. Runs in the background — you can " +
      "keep working while it processes."
    )) return;
    setSyncing(true);
    try {
      const r = await api.post(`/companies/${currentId}/plaid/reset-and-resync`);
      setActiveJob({ job_id: r.data.job_id, status: "queued", kind: "plaid_reset_resync" });
      toast.info("Full re-sync queued — this may take up to a minute");
    } catch (e) {
      toast.error(`Failed to queue re-sync: ${e.response?.data?.detail || e.message}`);
    } finally { setSyncing(false); }
  };

  const connectOne = async (plaidAccountId, label) => {
    setConnecting(plaidAccountId);
    try {
      const r = await api.post(`/companies/${currentId}/plaid/connect-account`, {
        plaid_account_id: plaidAccountId,
      });
      const d = r.data;
      toast.success(
        `${label} → ${d.ledger_account_code} ${d.ledger_account_name}. Opening $${Number(d.opening_balance).toLocaleString()} as of ${d.opening_as_of}. ${d.imported} txns imported${d.skipped ? `, ${d.skipped} skipped (dedup)` : ""}.`,
        { duration: 7000 },
      );
      await loadStatus();
    } catch (e) {
      toast.error(`Connect failed: ${e.response?.data?.detail || e.message}`);
    } finally { setConnecting(null); }
  };

  const connectAll = async () => {
    if (!status.available?.length) return;
    setBusy(true);
    try {
      for (const a of status.available) {
        await connectOne(a.account_id, a.name);
      }
    } finally { setBusy(false); }
  };

  const importAll = async () => {
    if (!accounts.length) return;
    setBusy(true);
    try {
      const r = await api.post(`/companies/${currentId}/onboarding/plaid/import`, {
        account_ids: accounts.map(a => a.account_id),
      });
      setImported(r.data.imported);
      toast.success(`AI categorized ${r.data.imported} new transactions from your linked accounts.`);
      loadStatus();
    } catch (e) {
      toast.error(`Import failed: ${e.response?.data?.detail || e.message}`);
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-heading text-3xl font-bold tracking-tight">Connections</h1>
        <p className="text-slate-500 text-sm mt-1">
          Connect real bank accounts via Plaid, or upload bank-statement PDFs for Veryfi OCR.
        </p>
      </div>

      <Tabs defaultValue="plaid" className="space-y-4">
        <TabsList className="h-10 bg-slate-100 p-1 rounded-lg">
          <TabsTrigger value="plaid" data-testid="connections-tab-plaid"
            className="data-[state=active]:bg-white data-[state=active]:shadow-sm px-4 py-1.5 rounded-md text-sm">
            <Link2 size={14} className="inline-block mr-1.5 -mt-0.5" />
            Connect accounts
          </TabsTrigger>
          <TabsTrigger value="statements" data-testid="connections-tab-statements"
            className="data-[state=active]:bg-white data-[state=active]:shadow-sm px-4 py-1.5 rounded-md text-sm">
            <FileText size={14} className="inline-block mr-1.5 -mt-0.5" />
            Load account statements
          </TabsTrigger>
        </TabsList>

        <TabsContent value="plaid" className="space-y-4 mt-0">
          <div className="rounded-xl border bg-white p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Link2 size={16} className="text-cyan-600" />
              <h3 className="font-heading font-semibold">Plaid — Bank &amp; Card Feeds</h3>
          {status.linked && (
            <PlaidBackfillButton companyId={currentId} onDone={loadStatus} />
          )}
          <button data-testid="plaid-manual-sync-btn" onClick={manualSync} disabled={syncing}
                  className="ml-auto text-xs px-3 py-1 rounded-md border border-slate-300 hover:bg-slate-50 disabled:opacity-50">
            {syncing ? "Syncing…" : "Manual Sync (webhook fallback)"}
          </button>
          {status.linked && (
            <button data-testid="plaid-reset-resync-btn" onClick={resetResync} disabled={syncing || (activeJob && activeJob.status !== "completed" && activeJob.status !== "failed")}
                    className="text-xs px-3 py-1 rounded-md border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                    title="Nulls the stored cursor and re-pulls Plaid's entire 730-day history. Use when only ~30 days imported at connect time.">
              Re-sync full history
            </button>
          )}
        </div>

        {activeJob && activeJob.status !== "completed" && activeJob.status !== "failed" && (
          <div data-testid="plaid-active-job"
               className="flex items-center gap-2 text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-md px-3 py-1.5">
            <Loader2 size={14} className="animate-spin text-cyan-600" />
            <span className="font-medium">
              {activeJob.kind === "plaid_reset_resync"
                ? "Full history re-sync"
                : "Syncing transactions"}
            </span>
            <span className="text-slate-500">
              · status <span className="font-mono-num">{activeJob.status}</span>
            </span>
            <span className="ml-auto text-slate-400 font-mono-num text-[10px]">
              {activeJob.job_id?.slice(0, 8)}
            </span>
          </div>
        )}

        <CoverageBanner coverage={status.coverage}
                        balanceSnapshotAt={status.balance_snapshot_at}
                        connected={status.connected} />
        <SyncHistoryPanel companyId={currentId} refreshKey={activeJob?.status} />

        <PlaidLinkButton companyId={currentId} onSuccess={onLinked} />

        {accounts.length > 0 && (
          <>
            <div className="mt-2 space-y-2">
              {accounts.map(a => (
                <div key={a.account_id} className="flex items-center gap-3 p-2.5 border rounded-md">
                  <CheckCircle2 size={14} className="text-emerald-500" />
                  <div className="flex-1">
                    <div className="text-sm font-medium">{a.name} <span className="text-slate-400">···{a.mask}</span></div>
                    <div className="text-[11px] text-slate-500">{a.type} / {a.subtype}</div>
                  </div>
                  <div className="font-mono-num text-sm">${Number(a.balance_current || 0).toLocaleString()}</div>
                </div>
              ))}
            </div>
            <button onClick={importAll} disabled={busy}
                    data-testid="plaid-import-btn"
                    className="px-3 py-1.5 rounded-md bg-emerald-600 text-white text-xs disabled:opacity-50">
              Sync &amp; AI-categorize transactions (legacy, all → 1010)
            </button>
            {imported > 0 && <div className="text-xs text-emerald-700">Synced {imported} new transactions.</div>}
          </>
        )}

        <PlaidAccountsDropdown
          expanded={expanded}
          onToggle={() => setExpanded(v => !v)}
          status={status}
          loading={loadingStatus}
          onRefresh={loadStatus}
          onConnectOne={connectOne}
          onConnectAll={connectAll}
          connecting={connecting}
          busy={busy}
        />
          </div>
        </TabsContent>

        <TabsContent value="statements" className="mt-0">
          <StatementsTab companyId={currentId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}


/**
 * Shows aggregate coverage stats for the company's Plaid feed:
 * date range, unique-day count, total txns, and PFC deterministic %.
 * Instant proof to the client that the import was complete.
 */
function CoverageBanner({ coverage, balanceSnapshotAt, connected }) {
  if (!coverage || !coverage.total_txns) return null;
  const {
    total_txns, first_date, last_date, unique_days,
    pfc_deterministic, ai_fallback, uncategorized, needs_review,
  } = coverage;
  const detPct = Math.round((pfc_deterministic / total_txns) * 100);
  const reviewPct = Math.round((needs_review / total_txns) * 100);
  // Aggregate current-balance snapshot reported by Plaid (free, comes with
  // every /transactions/sync call — not the per-call-billed /accounts/balance/get)
  const plaidBalance = (connected || []).reduce(
    (sum, c) => sum + (Number(c.balance_current) || 0), 0,
  );
  const relTime = balanceSnapshotAt ? _relTime(balanceSnapshotAt) : null;
  return (
    <div data-testid="plaid-coverage-banner"
         className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <div className="text-emerald-900 font-semibold">Bank sync coverage</div>
        <div className="text-emerald-900">
          <span className="font-mono-num">{first_date}</span>
          <span className="mx-1.5 text-emerald-600">→</span>
          <span className="font-mono-num">{last_date}</span>
        </div>
        <div className="text-emerald-800">
          <span className="font-mono-num font-semibold">
            {total_txns.toLocaleString()}
          </span> txns across{" "}
          <span className="font-mono-num font-semibold">{unique_days}</span> days
        </div>
        {balanceSnapshotAt && (
          <div className="ml-auto text-xs text-emerald-800"
               title="Balance reported by Plaid at last sync. Uses the free bundled snapshot — no per-call /accounts/balance/get charges.">
            Plaid balance:{" "}
            <span className="font-mono-num font-semibold">
              ${plaidBalance.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
            </span>
            <span className="text-emerald-600 ml-1.5">· {relTime}</span>
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-700">
        <span title="Categorized deterministically via Plaid PFC → Chart of Accounts">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 mr-1.5 align-middle" />
          PFC deterministic:{" "}
          <span className="font-mono-num font-semibold">{pfc_deterministic.toLocaleString()}</span>{" "}
          <span className="text-slate-500">({detPct}%)</span>
        </span>
        {ai_fallback > 0 && (
          <span title="Categorized by LLM fallback when Plaid PFC was ambiguous">
            <span className="inline-block w-2 h-2 rounded-full bg-blue-500 mr-1.5 align-middle" />
            AI fallback:{" "}
            <span className="font-mono-num font-semibold">{ai_fallback.toLocaleString()}</span>
          </span>
        )}
        {uncategorized > 0 && (
          <span title="Uncategorized bucket — needs accountant review">
            <span className="inline-block w-2 h-2 rounded-full bg-slate-400 mr-1.5 align-middle" />
            Uncategorized:{" "}
            <span className="font-mono-num font-semibold">{uncategorized.toLocaleString()}</span>
          </span>
        )}
        <span className="ml-auto text-slate-600" title="Transactions flagged for accountant review">
          Needs review:{" "}
          <span className="font-mono-num font-semibold">{needs_review.toLocaleString()}</span>{" "}
          <span className="text-slate-500">({reviewPct}%)</span>
        </span>
      </div>
    </div>
  );
}


function _relTime(iso) {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min} min ago`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  } catch { return ""; }
}


/**
 * Recent sync jobs (last 10 by default). Auto-refreshes when a job's status
 * flips (via `refreshKey`). Gives accountants a per-firm audit trail of who
 * synced when + result.
 */
function SyncHistoryPanel({ companyId, refreshKey }) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const load = async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      const r = await api.get(`/companies/${companyId}/plaid/sync-jobs?limit=10`);
      setJobs(r.data.jobs || []);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [companyId, refreshKey]);
  if (!jobs.length && !loading) return null;

  return (
    <div data-testid="plaid-sync-history"
         className="rounded-lg border border-slate-200 bg-white text-sm">
      <button onClick={() => setOpen(o => !o)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-50">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="font-medium text-slate-700">Sync history</span>
        <span className="text-xs text-slate-500">last {jobs.length}</span>
        <span className="ml-auto text-xs text-slate-400">
          {jobs[0] && jobs[0].created_at ? _relTime(jobs[0].created_at) : ""}
        </span>
      </button>
      {open && (
        <div className="border-t border-slate-100 divide-y divide-slate-50">
          {jobs.map(j => (
            <SyncHistoryRow key={j.id} job={j} />
          ))}
        </div>
      )}
    </div>
  );
}


function SyncHistoryRow({ job }) {
  const kindLabel = {
    plaid_manual_sync:      "Delta sync",
    plaid_reset_resync:     "Full re-sync",
    plaid_contact_backfill: "Contact backfill",
  }[job.kind] || job.kind;
  const statusColor = {
    completed: "text-emerald-700 bg-emerald-50 border-emerald-200",
    running:   "text-cyan-700   bg-cyan-50   border-cyan-200",
    queued:    "text-slate-600  bg-slate-50  border-slate-200",
    failed:    "text-rose-700   bg-rose-50   border-rose-200",
  }[job.status] || "text-slate-600 bg-slate-50 border-slate-200";
  const duration = job.duration_ms != null
    ? (job.duration_ms >= 1000
        ? `${(job.duration_ms / 1000).toFixed(1)}s`
        : `${job.duration_ms}ms`)
    : "—";
  const imported = job.imported ?? 0;
  return (
    <div data-testid={`sync-history-row-${job.id}`}
         className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-3 items-center px-3 py-2 text-xs">
      <span className={`px-2 py-0.5 rounded border font-mono-num ${statusColor}`}>
        {job.status}
      </span>
      <span className="text-slate-700 font-medium">
        {kindLabel}
        {job.reset && <span className="ml-1.5 text-amber-700">· cursor reset</span>}
      </span>
      <span className="text-slate-500 font-mono-num" title="Transactions imported">
        {imported.toLocaleString()} txns
      </span>
      <span className="text-slate-500 font-mono-num" title="End-to-end run time">
        {duration}
      </span>
      <span className="text-slate-400 text-[10px] whitespace-nowrap"
            title={`Triggered by ${job.triggered_by_email || "system"} · ${job.created_at}`}>
        {job.triggered_by_email ? job.triggered_by_email.split("@")[0] : "system"}
        {" · "}
        {_relTime(job.created_at)}
      </span>
      {job.error && (
        <div className="col-span-5 text-rose-600 text-[11px] font-mono truncate" title={job.error}>
          error: {job.error}
        </div>
      )}
    </div>
  );
}

function PlaidAccountsDropdown({ expanded, onToggle, status, loading, onRefresh, onConnectOne, onConnectAll, connecting, busy }) {
  const total = (status.connected?.length || 0) + (status.available?.length || 0);
  const hasAvailable = (status.available?.length || 0) > 0;

  // Table renders both flavours in a single flat list — SCOPE badge
  // distinguishes IN BOOKS (connected) vs EXCLUDED (available-to-add).
  const rows = [
    ...(status.connected || []).map(a => ({ ...a, _connected: true })),
    ...(status.available || []).map(a => ({ ...a, _connected: false })),
  ];

  return (
    <div className="mt-3 border rounded-md" data-testid="plaid-accounts-dropdown">
      <div className="flex items-center gap-2 px-3 py-2 hover:bg-slate-50 rounded-md">
        <button
          type="button"
          onClick={onToggle}
          data-testid="plaid-accounts-toggle"
          className="flex items-center gap-2 flex-1 text-left"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="text-sm font-medium">Linked accounts</span>
          <span className="text-[11px] text-slate-500">
            {status.linked
              ? `${status.connected?.length || 0} in books · ${status.available?.length || 0} excluded`
              : "No Plaid item linked yet"}
          </span>
        </button>
        {hasAvailable && (
          <button
            type="button"
            onClick={onConnectAll}
            disabled={busy || connecting}
            data-testid="plaid-connect-all-btn"
            className="text-[11px] px-2 py-1 rounded-md bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50"
          >
            Add all to books
          </button>
        )}
        <button
          type="button"
          onClick={onRefresh}
          className="text-[11px] text-slate-500 hover:text-slate-800 underline"
          data-testid="plaid-accounts-refresh"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {expanded && (
        <div className="border-t">
          {!status.linked && total === 0 && (
            <div className="px-4 py-6 text-xs text-slate-500 italic">
              Launch Plaid Link above to connect a bank. Once linked, all accounts on the
              institution will appear here — the ones already pulling transactions and the ones
              still available to add.
            </div>
          )}
          {status.linked && total === 0 && (
            <div className="px-4 py-6 text-xs text-slate-500 italic">This Plaid item returned no accounts.</div>
          )}
          {rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="plaid-accounts-table">
                <thead>
                  <tr className="bg-slate-50 text-[10px] uppercase tracking-widest text-slate-500 border-b">
                    <th className="text-left px-3 py-2 font-semibold">Institution</th>
                    <th className="text-left px-3 py-2 font-semibold">Account</th>
                    <th className="text-left px-3 py-2 font-semibold">Scope</th>
                    <th className="text-left px-3 py-2 font-semibold">Last sync</th>
                    <th className="text-right px-3 py-2 font-semibold">Raw / Promoted</th>
                    <th className="text-left px-3 py-2 font-semibold">Mapping &amp; promotion</th>
                    <th className="text-right px-3 py-2 font-semibold"></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map(a => (
                    <AccountTableRow
                      key={a.account_id}
                      a={a}
                      institution={status.institution_name || "—"}
                      lastSyncAt={status.last_sync_at}
                      onConnect={a._connected ? null : () => onConnectOne(a.account_id, a.name)}
                      onResync={onRefresh}
                      connecting={connecting === a.account_id}
                      anyConnecting={!!connecting}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AccountTableRow({ a, institution, lastSyncAt, onConnect, onResync, connecting, anyConnecting }) {
  const connected = !!a._connected;
  const subtype = ((a.type || "").replace(/AccountType\('|'\)/g, "") + " / " +
                   (a.subtype || "").replace(/AccountSubtype\('|'\)/g, "")).replace(/_/g, " ").trim();
  const mappingLabel = connected
    ? (a.ledger_account_code ? `${a.ledger_account_code} · ${a.ledger_account_name}` : "—")
    : (a.suggested_ledger_code ? `→ ${a.suggested_ledger_code} · ${a.suggested_ledger_name}` : "—");
  const raw = a.transaction_count ?? 0;
  const promoted = connected ? raw : 0;   // Available accounts have 0 promoted by definition.
  return (
    <tr
      className={connected ? "hover:bg-slate-50/50" : "bg-slate-50/30 hover:bg-slate-50/60"}
      data-testid={`plaid-row-${connected ? "connected" : "available"}-${a.account_id}`}
    >
      <td className="px-3 py-2.5 text-slate-700 whitespace-nowrap">{institution}</td>
      <td className="px-3 py-2.5">
        <div className="font-medium text-slate-900 truncate">
          {a.name}
          {a.mask && <span className="text-slate-400 ml-1 font-mono-num">···{a.mask}</span>}
        </div>
        <div className="text-[11px] text-slate-500">{subtype}</div>
      </td>
      <td className="px-3 py-2.5">
        {connected ? (
          <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 uppercase tracking-widest">In books</span>
        ) : (
          <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded bg-slate-200 text-slate-700 uppercase tracking-widest">Excluded</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-slate-600 font-mono-num text-[11px] whitespace-nowrap">
        {connected
          ? (a.last_transaction_date || (lastSyncAt ? new Date(lastSyncAt).toLocaleString() : "idle"))
          : "—"}
      </td>
      <td className="px-3 py-2.5 text-right font-mono-num text-slate-700 whitespace-nowrap">
        {raw.toLocaleString()} / {promoted.toLocaleString()}
      </td>
      <td className="px-3 py-2.5">
        <div className={`text-[11px] font-mono-num truncate max-w-[240px] ${connected ? "text-slate-700" : "text-slate-500"}`}>
          {mappingLabel}
        </div>
        {connected && a.opening_balance != null && (
          <div className="text-[10px] text-slate-400 font-mono-num">
            opening ${Number(a.opening_balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            {a.opening_as_of ? ` · ${a.opening_as_of}` : ""}
          </div>
        )}
      </td>
      <td className="px-3 py-2.5 text-right whitespace-nowrap">
        {connected ? (
          <button
            type="button"
            onClick={onResync}
            data-testid={`plaid-row-resync-${a.account_id}`}
            className="text-[11px] px-2.5 py-1 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50"
          >
            Re-sync
          </button>
        ) : (
          <button
            type="button"
            onClick={onConnect}
            disabled={connecting || anyConnecting}
            data-testid={`plaid-row-add-${a.account_id}`}
            className="text-[11px] px-2.5 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-1"
          >
            {connecting ? <><Loader2 size={10} className="animate-spin" /> Adding…</> : "Add to books"}
          </button>
        )}
      </td>
    </tr>
  );
}

// Legacy card row — kept for backward-compat if any parent still uses it.
function AccountRow({ a, connected = false, onConnect, connecting = false, anyConnecting = false }) {
  const ledgerBadge = connected
    ? (a.ledger_account_code ? `${a.ledger_account_code} ${a.ledger_account_name}` : null)
    : (a.suggested_ledger_code ? `→ ${a.suggested_ledger_code} ${a.suggested_ledger_name}` : null);

  return (
    <div
      className={`flex items-center gap-3 px-3 py-2 rounded-md border ${connected ? "bg-emerald-50/40 border-emerald-100" : "bg-slate-50/60 border-slate-200"}`}
      data-testid={`plaid-account-${connected ? "connected" : "available"}-${a.account_id}`}
    >
      {connected
        ? <CheckCircle2 size={14} className="text-emerald-500" />
        : <CircleDashed size={14} className="text-slate-400" />}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">
          {a.name}
          {a.mask && <span className="text-slate-400 ml-1">···{a.mask}</span>}
        </div>
        <div className="text-[11px] text-slate-500 flex items-center gap-2 flex-wrap">
          <span>
            {(a.type || "").replace(/AccountType\('|'\)/g, "").replace(/_/g, " ")}
            {a.subtype ? ` / ${(a.subtype || "").replace(/AccountSubtype\('|'\)/g, "").replace(/_/g, " ")}` : ""}
          </span>
          {ledgerBadge && (
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono-num ${connected ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"}`}>
              {ledgerBadge}
            </span>
          )}
          {connected && a.transaction_count > 0 && (
            <span className="text-emerald-700">
              · {a.transaction_count} txn{a.transaction_count === 1 ? "" : "s"}
              {a.last_transaction_date ? ` · last ${a.last_transaction_date}` : ""}
            </span>
          )}
          {connected && a.opening_balance != null && (
            <span className="text-slate-500">
              · opening ${Number(a.opening_balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              {a.opening_as_of ? ` as of ${a.opening_as_of}` : ""}
            </span>
          )}
        </div>
      </div>
      {a.balance_current != null && (
        <div className="font-mono-num text-sm text-slate-700">
          ${Number(a.balance_current || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
      )}
      {!connected && onConnect && (
        <button
          type="button"
          onClick={onConnect}
          disabled={connecting || anyConnecting}
          data-testid={`plaid-connect-account-btn-${a.account_id}`}
          className="text-[11px] px-2.5 py-1 rounded-md bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1"
        >
          {connecting
            ? <><Loader2 size={11} className="animate-spin" /> Connecting…</>
            : "Connect"}
        </button>
      )}
    </div>
  );
}
