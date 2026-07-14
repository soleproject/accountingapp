import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { toast } from "sonner";
import { Lock } from "lucide-react";

export default function ClosePeriods({ kind = "month" }) {
  const { currentId } = useCompany();
  const [items, setItems] = useState([]);
  const [periodStart, setPS] = useState("");
  const [periodEnd, setPE] = useState("");
  const load = async () => {
    if (!currentId) return;
    const r = await api.get(`/companies/${currentId}/close-periods`);
    setItems((r.data.periods || []).filter(p => (p.kind || "month") === kind));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId, kind]);
  const close = async () => {
    if (!periodStart || !periodEnd) return;
    await api.post(`/companies/${currentId}/close-periods`, {
      period_start: periodStart, period_end: periodEnd, kind, closed_by: "user", status: "closed",
    });
    toast.success(`${kind === "year" ? "Year-end" : "Period"} closed. Prior entries are now locked.`);
    setPS(""); setPE(""); load();
  };
  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-heading text-3xl font-bold tracking-tight">
          {kind === "year" ? "Year-End Close" : "Close the Books"}
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Lock a period so no further changes can be made to those transactions.
        </p>
      </div>
      <div className="rounded-xl border bg-white p-4">
        <div className="grid grid-cols-3 gap-2">
          <input type="date" value={periodStart} onChange={(e) => setPS(e.target.value)} className="border rounded px-2 py-1.5 text-sm" placeholder="Start" />
          <input type="date" value={periodEnd} onChange={(e) => setPE(e.target.value)} className="border rounded px-2 py-1.5 text-sm" />
          <button data-testid={TID.addBtn} onClick={close}
                  className="rounded-md bg-slate-900 text-white text-sm inline-flex items-center justify-center gap-1">
            <Lock size={13} /> Close period
          </button>
        </div>
      </div>
      <div className="rounded-xl border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
            <tr><th className="px-3 py-2 text-left">Start</th><th className="px-3 py-2 text-left">End</th>
              <th className="px-3 py-2">Kind</th><th className="px-3 py-2">Status</th></tr>
          </thead>
          <tbody>
            {items.map(p => (
              <tr key={p.id} className="border-b">
                <td className="px-3 py-2 font-mono-num text-slate-600">{p.period_start}</td>
                <td className="px-3 py-2 font-mono-num text-slate-600">{p.period_end}</td>
                <td className="px-3 py-2 text-xs uppercase">{p.kind}</td>
                <td className="px-3 py-2"><span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">{p.status}</span></td>
              </tr>
            ))}
            {!items.length && <tr><td colSpan={4} className="text-center py-8 text-slate-500">No closed periods.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
