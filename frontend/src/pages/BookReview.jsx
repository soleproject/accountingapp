import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { toast } from "sonner";

export default function BookReview() {
  const { currentId } = useCompany();
  const [items, setItems] = useState([]);
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [notes, setNotes] = useState("");
  const load = async () => {
    if (!currentId) return;
    const r = await api.get(`/companies/${currentId}/book-reviews`);
    setItems(r.data.reviews || []);
  };
  useEffect(() => { load(); }, [currentId]);
  const submit = async () => {
    await api.post(`/companies/${currentId}/book-reviews`, { period, notes, status: "in_progress" });
    toast.success("Review started"); setNotes(""); load();
  };
  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-heading text-3xl font-bold tracking-tight">Book Review</h1>
        <p className="text-slate-500 text-sm mt-1">Monthly review checklist before closing the books.</p>
      </div>
      <div className="rounded-xl border bg-white p-4 space-y-2">
        <div className="grid grid-cols-4 gap-2">
          <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="border rounded px-2 py-1.5 text-sm" />
          <input placeholder="Review notes / findings" value={notes} onChange={(e) => setNotes(e.target.value)}
                 className="col-span-2 border rounded px-2 py-1.5 text-sm" />
          <button data-testid={TID.addBtn} onClick={submit}
                  className="rounded-md bg-slate-900 text-white text-sm">Log review</button>
        </div>
      </div>
      <div className="rounded-xl border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
            <tr><th className="px-3 py-2 text-left">Period</th><th className="px-3 py-2 text-left">Notes</th><th className="px-3 py-2">Status</th></tr>
          </thead>
          <tbody>
            {items.map(r => (
              <tr key={r.id} className="border-b">
                <td className="px-3 py-2 font-mono-num text-slate-600">{r.period}</td>
                <td className="px-3 py-2">{r.notes}</td>
                <td className="px-3 py-2"><span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100">{r.status}</span></td>
              </tr>
            ))}
            {!items.length && <tr><td colSpan={3} className="text-center py-8 text-slate-500">No reviews yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
