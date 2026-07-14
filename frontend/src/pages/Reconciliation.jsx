import { useEffect, useState } from "react";
import { api, fmtMoney } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus } from "lucide-react";
import { toast } from "sonner";

export default function Reconciliation() {
  const { currentId } = useCompany();
  const [items, setItems] = useState([]);
  const [accts, setAccts] = useState([]);
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [acct, setAcct] = useState("");
  const [statementBal, setStatementBal] = useState("");
  const load = async () => {
    if (!currentId) return;
    const [r, a] = await Promise.all([
      api.get(`/companies/${currentId}/reconciliations`),
      api.get(`/companies/${currentId}/accounts`),
    ]);
    setItems(r.data.reconciliations || []);
    setAccts((a.data.accounts || []).filter(x => x.type === "asset" || x.type === "liability"));
  };
  useEffect(() => { load(); }, [currentId]);

  const create = async () => {
    if (!acct || !statementBal) return;
    await api.post(`/companies/${currentId}/reconciliations`, {
      as_of: asOf, account_id: acct, statement_balance: parseFloat(statementBal), status: "in_progress",
    });
    toast.success("Reconciliation started"); setStatementBal(""); load();
  };
  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-heading text-3xl font-bold tracking-tight">Reconciliation</h1>
        <p className="text-slate-500 text-sm mt-1">Match your books to bank statements. AI uses balance data from Plaid feed.</p>
      </div>
      <div className="rounded-xl border bg-white p-4 space-y-2">
        <h3 className="font-heading font-semibold text-sm">New reconciliation</h3>
        <div className="grid grid-cols-4 gap-2">
          <select value={acct} onChange={(e) => setAcct(e.target.value)} className="border rounded px-2 py-1.5 text-sm">
            <option value="">Account…</option>
            {accts.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
          </select>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="border rounded px-2 py-1.5 text-sm" />
          <input type="number" placeholder="Statement balance" value={statementBal} onChange={(e) => setStatementBal(e.target.value)}
                 className="border rounded px-2 py-1.5 text-sm font-mono-num" />
          <button data-testid={TID.addBtn} onClick={create} className="rounded-md bg-slate-900 text-white text-sm inline-flex items-center justify-center gap-1">
            <Plus size={13} /> Start
          </button>
        </div>
      </div>
      <div className="rounded-xl border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
            <tr><th className="px-3 py-2 text-left">As of</th><th className="px-3 py-2 text-left">Account</th>
              <th className="px-3 py-2 text-right">Statement Balance</th><th className="px-3 py-2">Status</th></tr>
          </thead>
          <tbody>
            {items.map(r => (
              <tr key={r.id} className="border-b">
                <td className="px-3 py-2 font-mono-num text-slate-600">{r.as_of}</td>
                <td className="px-3 py-2">{accts.find(a => a.id === r.account_id)?.name || "—"}</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(r.statement_balance)}</td>
                <td className="px-3 py-2"><span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100">{r.status}</span></td>
              </tr>
            ))}
            {!items.length && <tr><td colSpan={4} className="text-center py-8 text-slate-500">No reconciliations.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
