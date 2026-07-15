import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import PlaidLinkButton from "@/components/PlaidLinkButton";
import { toast } from "sonner";
import { Link2, CheckCircle2, ChevronDown, ChevronRight, PlugZap, CircleDashed } from "lucide-react";

export default function Connections() {
  const { currentId } = useCompany();
  const [accounts, setAccounts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [status, setStatus] = useState({ linked: false, connected: [], available: [] });
  const [loadingStatus, setLoadingStatus] = useState(false);

  const loadStatus = async () => {
    if (!currentId) return;
    setLoadingStatus(true);
    try {
      const r = await api.get(`/companies/${currentId}/plaid/accounts`);
      setStatus(r.data);
    } catch (e) {
      // Endpoint may not exist yet on stale backend — ignore quietly.
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
              Sync &amp; AI-categorize transactions
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
        />
      </div>
    </div>
  );
}

function PlaidAccountsDropdown({ expanded, onToggle, status, loading, onRefresh }) {
  const total = (status.connected?.length || 0) + (status.available?.length || 0);

  return (
    <div className="mt-3 border rounded-md" data-testid="plaid-accounts-dropdown">
      <button
        type="button"
        onClick={onToggle}
        data-testid="plaid-accounts-toggle"
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-50 rounded-md"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="text-sm font-medium">Linked accounts</span>
        <span className="text-[11px] text-slate-500">
          {status.linked
            ? `${status.connected?.length || 0} connected · ${status.available?.length || 0} available`
            : "No Plaid item linked yet"}
        </span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRefresh(); }}
          className="ml-auto text-[11px] text-slate-500 hover:text-slate-800 underline"
          data-testid="plaid-accounts-refresh"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </button>

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
                  <AccountRow key={a.account_id} a={a} />
                ))}
              </div>
              <div className="mt-2 text-[11px] text-slate-500">
                Tip: hit <span className="font-medium">Sync &amp; AI-categorize transactions</span> above to pull
                these into the ledger.
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

function AccountRow({ a, connected = false }) {
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
        <div className="text-[11px] text-slate-500">
          {(a.type || "").replace(/_/g, " ")}
          {a.subtype ? ` / ${(a.subtype || "").replace(/_/g, " ")}` : ""}
          {connected && a.transaction_count > 0 && (
            <span className="ml-2 text-emerald-700">
              · {a.transaction_count} txn{a.transaction_count === 1 ? "" : "s"}
              {a.last_transaction_date ? ` · last ${a.last_transaction_date}` : ""}
            </span>
          )}
        </div>
      </div>
      {a.balance_current != null && (
        <div className="font-mono-num text-sm text-slate-700">
          ${Number(a.balance_current || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
      )}
    </div>
  );
}
