import { useEffect, useState } from "react";
import { api, fmtMoney, fmtDate } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

export default function JournalEntries() {
  const { currentId } = useCompany();
  const [entries, setEntries] = useState([]);
  const [accts, setAccts] = useState([]);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    if (!currentId) return;
    const [j, a] = await Promise.all([
      api.get(`/companies/${currentId}/journal-entries`),
      api.get(`/companies/${currentId}/accounts`),
    ]);
    setEntries(j.data.entries || []);
    setAccts(a.data.accounts || []);
  };
  useEffect(() => { load(); }, [currentId]);

  const del = async (id) => {
    if (!confirm("Delete this JE?")) return;
    await api.delete(`/companies/${currentId}/journal-entries/${id}`);
    load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Journal Entries</h1>
          <p className="text-slate-500 text-sm mt-1">Double-entry postings. Debits must equal credits.</p>
        </div>
        <button data-testid={TID.addBtn} onClick={() => setCreating(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs">
          <Plus size={13} /> New JE
        </button>
      </div>
      <div className="rounded-xl border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
            <tr>
              <th className="px-3 py-2 text-left">Date</th>
              <th className="px-3 py-2 text-left">Memo</th>
              <th className="px-3 py-2 text-left">Lines</th>
              <th className="px-3 py-2 text-right">Debit</th>
              <th className="px-3 py-2 text-right">Credit</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {entries.map(e => (
              <tr key={e.id} className="border-b hover:bg-slate-50">
                <td className="px-3 py-2 font-mono-num text-slate-600">{fmtDate(e.date)}</td>
                <td className="px-3 py-2">{e.memo}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{e.lines.length} lines</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(e.total_debit)}</td>
                <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(e.total_credit)}</td>
                <td className="px-3 py-2 text-right"><button onClick={() => del(e.id)} className="text-red-500 p-1"><Trash2 size={13} /></button></td>
              </tr>
            ))}
            {!entries.length && <tr><td colSpan={6} className="text-center py-8 text-slate-500">No journal entries yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {creating && <NewJE currentId={currentId} accts={accts} onClose={() => { setCreating(false); load(); }} />}
    </div>
  );
}

function NewJE({ currentId, accts, onClose }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState([
    { account_id: "", debit: 0, credit: 0, description: "" },
    { account_id: "", debit: 0, credit: 0, description: "" },
  ]);
  const td = lines.reduce((s, l) => s + parseFloat(l.debit || 0), 0);
  const tc = lines.reduce((s, l) => s + parseFloat(l.credit || 0), 0);
  const balanced = Math.abs(td - tc) < 0.01 && td > 0;
  const save = async () => {
    if (!balanced) { toast.error("Debits must equal credits"); return; }
    await api.post(`/companies/${currentId}/journal-entries`, { date, memo, lines });
    toast.success("Journal entry posted"); onClose();
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold">New Journal Entry</h3>
          <button onClick={onClose}><X size={16} /></button>
        </div>
        <div className="flex gap-2">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="border rounded px-2 py-1.5 text-sm" />
          <input placeholder="Memo" value={memo} onChange={(e) => setMemo(e.target.value)} className="flex-1 border rounded px-2 py-1.5 text-sm" />
        </div>
        <div className="space-y-2">
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-12 gap-2">
              <select value={l.account_id} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, account_id: e.target.value } : x))}
                      className="col-span-5 border rounded px-2 py-1.5 text-sm">
                <option value="">Account…</option>
                {accts.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
              </select>
              <input type="number" step="0.01" placeholder="Debit" value={l.debit}
                     onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, debit: e.target.value } : x))}
                     className="col-span-2 border rounded px-2 py-1.5 text-sm font-mono-num" />
              <input type="number" step="0.01" placeholder="Credit" value={l.credit}
                     onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, credit: e.target.value } : x))}
                     className="col-span-2 border rounded px-2 py-1.5 text-sm font-mono-num" />
              <input placeholder="Description" value={l.description}
                     onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, description: e.target.value } : x))}
                     className="col-span-3 border rounded px-2 py-1.5 text-sm" />
            </div>
          ))}
          <button onClick={() => setLines([...lines, { account_id: "", debit: 0, credit: 0, description: "" }])}
                  className="text-xs text-slate-600 border border-dashed rounded px-2 py-1">+ Add line</button>
        </div>
        <div className="flex items-center justify-between border-t pt-3">
          <div className={`text-sm ${balanced ? "text-emerald-600" : "text-red-600"}`}>
            Debits <span className="font-mono-num">{fmtMoney(td)}</span> · Credits <span className="font-mono-num">{fmtMoney(tc)}</span>
          </div>
          <button data-testid={TID.saveBtn} onClick={save} disabled={!balanced}
                  className="px-4 py-1.5 rounded-md bg-slate-900 text-white text-sm disabled:opacity-50">Post JE</button>
        </div>
      </div>
    </div>
  );
}
