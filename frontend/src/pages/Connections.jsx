import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import PlaidLinkButton from "@/components/PlaidLinkButton";
import PlaidBackfillButton from "@/components/PlaidBackfillButton";
import { toast } from "sonner";
import { Link2, CheckCircle2, ChevronDown, ChevronRight, PlugZap, CircleDashed, Loader2 } from "lucide-react";

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

  const manualSync = async () => {
    setSyncing(true);
    try {
      const r = await api.post(`/companies/${currentId}/plaid/manual-sync`);
      toast.success(`Synced ${r.data.imported} new transactions from Plaid`);
      setImported(v => v + r.data.imported);
      loadStatus();
    } catch (e) {
      toast.error(`Sync failed: ${e.response?.data?.detail || e.message}`);
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
          Link real bank accounts via Plaid Sandbox. Use credentials <span className="font-mono-num">user_good</span> / <span className="font-mono-num">pass_good</span>.
        </p>
      </div>

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
        </div>
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
    </div>
  );
}

function PlaidAccountsDropdown({ expanded, onToggle, status, loading, onRefresh, onConnectOne, onConnectAll, connecting, busy }) {
  const total = (status.connected?.length || 0) + (status.available?.length || 0);
  const hasAvailable = (status.available?.length || 0) > 0;

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
              ? `${status.connected?.length || 0} connected · ${status.available?.length || 0} available`
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
            Connect all
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
        <div className="border-t px-3 py-3 space-y-4">
          {!status.linked && total === 0 && (
            <div className="text-xs text-slate-500 italic">
              Launch Plaid Link above to connect a bank. Once linked, all accounts on the
              institution will appear here — the ones already pulling transactions and the ones
              still available to activate.
            </div>
          )}

          {status.connected?.length > 0 && (
            <div data-testid="plaid-accounts-connected">
              <div className="text-[10px] uppercase tracking-widest font-semibold text-emerald-700 mb-1.5 flex items-center gap-1">
                <PlugZap size={11} /> Connected ({status.connected.length})
              </div>
              <div className="space-y-1.5">
                {status.connected.map(a => (
                  <AccountRow key={a.account_id} a={a} connected />
                ))}
              </div>
            </div>
          )}

          {status.available?.length > 0 && (
            <div data-testid="plaid-accounts-available">
              <div className="text-[10px] uppercase tracking-widest font-semibold text-slate-500 mb-1.5 flex items-center gap-1">
                <CircleDashed size={11} /> Available — not yet syncing ({status.available.length})
              </div>
              <div className="space-y-1.5">
                {status.available.map(a => (
                  <AccountRow
                    key={a.account_id}
                    a={a}
                    onConnect={() => onConnectOne(a.account_id, a.name)}
                    connecting={connecting === a.account_id}
                    anyConnecting={!!connecting}
                  />
                ))}
              </div>
              <div className="mt-2 text-[11px] text-slate-500">
                Connecting will auto-map to the suggested ledger account, import full Plaid history
                (skipping periods already covered by QBO), and post the opening balance from the
                earliest transaction.
              </div>
            </div>
          )}

          {status.linked && total === 0 && (
            <div className="text-xs text-slate-500 italic">This Plaid item returned no accounts.</div>
          )}
        </div>
      )}
    </div>
  );
}

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
