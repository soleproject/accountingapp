import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import PlaidLinkButton from "@/components/PlaidLinkButton";
import { toast } from "sonner";
import { Link2, CheckCircle2 } from "lucide-react";

export default function Connections() {
  const { currentId } = useCompany();
  const [accounts, setAccounts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState(0);
  const [syncing, setSyncing] = useState(false);

  const onLinked = (accts) => {
    setAccounts(accts);
    toast.success(`Linked ${accts.length} bank accounts via Plaid`);
  };

  const manualSync = async () => {
    setSyncing(true);
    try {
      const r = await api.post(`/companies/${currentId}/plaid/manual-sync`);
      toast.success(`Synced ${r.data.imported} new transactions from Plaid`);
      setImported(v => v + r.data.imported);
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
                    className="px-3 py-1.5 rounded-md bg-emerald-600 text-white text-xs disabled:opacity-50">
              Sync & AI-categorize transactions
            </button>
            {imported > 0 && <div className="text-xs text-emerald-700">✓ Synced {imported} new transactions.</div>}
          </>
        )}
      </div>
    </div>
  );
}
