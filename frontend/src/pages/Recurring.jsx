import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany, useMoneyFmt, useDateFmt } from "@/lib/company";
import { toast } from "sonner";
import { Play, Pause, Trash2, Repeat, X, Loader2, CheckCircle2 } from "lucide-react";

const FREQ_LABEL = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Annual",
};

export default function Recurring() {

  const fmtMoney = useMoneyFmt();

  const fmtDate = useDateFmt();
  const { currentId } = useCompany();
  const [tab, setTab] = useState("invoice");
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const r = await api.get(`/companies/${currentId}/recurring`);
      setTemplates(r.data.templates || []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [currentId]);

  const filtered = templates.filter(t => t.kind === tab);

  const togglePause = async (t) => {
    const path = t.paused ? "resume" : "pause";
    await api.post(`/companies/${currentId}/recurring/${t.id}/${path}`);
    toast.success(t.paused ? "Resumed" : "Paused");
    load();
  };
  const runNow = async (t) => {
    try {
      await api.post(`/companies/${currentId}/recurring/${t.id}/run-now`);
      toast.success(`Generated a new ${t.kind} — check the ${t.kind}s page.`);
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not run");
    }
  };
  const del = async (t) => {
    if (!confirm(`Delete recurring ${t.kind}?`)) return;
    await api.delete(`/companies/${currentId}/recurring/${t.id}`);
    toast.success("Removed");
    load();
  };

  return (
    <div className="space-y-4" data-testid="recurring-page">
      <div>
        <h1 className="font-heading text-3xl font-bold tracking-tight">Recurring</h1>
        <p className="text-slate-500 text-sm mt-1">Memorized invoices &amp; bills that auto-generate on your chosen cadence. New rows land as <span className="font-semibold">drafts</span> for you to review.</p>
      </div>

      <div className="inline-flex rounded-lg border bg-white p-1 text-xs">
        <button
          onClick={() => setTab("invoice")}
          className={`px-3 py-1.5 rounded-md ${tab === "invoice" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}
          data-testid="recurring-tab-invoice"
        >Invoices</button>
        <button
          onClick={() => setTab("bill")}
          className={`px-3 py-1.5 rounded-md ${tab === "bill" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}
          data-testid="recurring-tab-bill"
        >Bills</button>
      </div>

      <div className="rounded-xl border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
            <tr>
              <th className="px-3 py-2 text-left">Name / Customer</th>
              <th className="px-3 py-2 text-left">Frequency</th>
              <th className="px-3 py-2 text-left">Next run</th>
              <th className="px-3 py-2 text-left">Ends</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2 text-center">Runs</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8} className="text-center py-8 text-slate-400"><Loader2 className="inline animate-spin" size={16} /></td></tr>
            )}
            {!loading && filtered.map(t => {
              const amount = (t.line_items || []).reduce((s, l) => s + Number(l.amount || 0), 0) + Number(t.tax || 0);
              return (
                <tr key={t.id} className="border-b hover:bg-slate-50" data-testid={`recurring-row-${t.id}`}>
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-800">{t.name || t.contact_name || <span className="text-slate-400">—</span>}</div>
                    {t.name && t.contact_name && <div className="text-xs text-slate-500">{t.contact_name}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs">{FREQ_LABEL[t.frequency] || t.frequency}</td>
                  <td className="px-3 py-2 font-mono-num text-slate-600">{fmtDate(t.next_run_date)}</td>
                  <td className="px-3 py-2 font-mono-num text-slate-500">{t.end_date ? fmtDate(t.end_date) : <span className="text-slate-400">Never</span>}</td>
                  <td className="px-3 py-2 text-right font-mono-num">{fmtMoney(amount)}</td>
                  <td className="px-3 py-2 text-center font-mono-num text-slate-500">{t.runs_count || 0}</td>
                  <td className="px-3 py-2">
                    {t.paused ? (
                      <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">Paused</span>
                    ) : (
                      <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">Active</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        onClick={() => runNow(t)}
                        title="Generate now"
                        data-testid={`recurring-run-${t.id}`}
                        className="p-1 rounded hover:bg-emerald-100 text-emerald-700"
                      ><CheckCircle2 size={13} /></button>
                      <button
                        onClick={() => togglePause(t)}
                        title={t.paused ? "Resume" : "Pause"}
                        data-testid={`recurring-toggle-${t.id}`}
                        className="p-1 rounded hover:bg-amber-100 text-amber-700"
                      >{t.paused ? <Play size={13} /> : <Pause size={13} />}</button>
                      <button
                        onClick={() => setEditing(t)}
                        title="Edit"
                        data-testid={`recurring-edit-${t.id}`}
                        className="p-1 rounded hover:bg-indigo-100 text-indigo-600"
                      ><Repeat size={13} /></button>
                      <button
                        onClick={() => del(t)}
                        title="Delete"
                        data-testid={`recurring-delete-${t.id}`}
                        className="p-1 rounded hover:bg-red-100 text-red-500"
                      ><Trash2 size={13} /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!loading && !filtered.length && (
              <tr><td colSpan={8} className="text-center py-10 text-slate-500 text-sm">
                No memorized {tab === "invoice" ? "invoices" : "bills"} yet.
                <div className="text-xs text-slate-400 mt-1">Open any {tab === "invoice" ? "invoice" : "bill"} → click <b>Memorize</b> to schedule it.</div>
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <EditRecurringModal
          currentId={currentId}
          template={editing}
          onClose={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function EditRecurringModal({ currentId, template, onClose }) {
  const [frequency, setFrequency] = useState(template.frequency);
  const [startDate, setStartDate] = useState(template.start_date);
  const [endDate, setEndDate] = useState(template.end_date || "");
  const [netDays, setNetDays] = useState(template.net_days || 30);
  const [name, setName] = useState(template.name || "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/companies/${currentId}/recurring/${template.id}`, {
        frequency,
        start_date: startDate,
        end_date: endDate || null,
        net_days: Number(netDays),
        name: name || null,
      });
      toast.success("Schedule updated");
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-3" data-testid="recurring-edit-modal">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold">Edit schedule</h3>
          <button onClick={onClose}><X size={16} /></button>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Nickname</label>
          <input value={name} onChange={(e) => setName(e.target.value)}
                 placeholder="e.g. Monthly retainer — Acme Co."
                 className="w-full border rounded px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Frequency</label>
          <select value={frequency} onChange={(e) => setFrequency(e.target.value)}
                  className="w-full border rounded px-2 py-1.5 text-sm bg-white">
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="annual">Annual</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Next run</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                   className="w-full border rounded px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Ends (optional)</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                   className="w-full border rounded px-2 py-1.5 text-sm" />
          </div>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Net days (issue → due)</label>
          <input type="number" value={netDays} onChange={(e) => setNetDays(e.target.value)}
                 className="w-full border rounded px-2 py-1.5 text-sm font-mono-num" />
        </div>
        <button onClick={save} disabled={busy}
                className="w-full py-2 rounded-md bg-slate-900 text-white text-sm inline-flex items-center justify-center gap-1.5 disabled:opacity-60">
          {busy && <Loader2 size={13} className="animate-spin" />}
          Save schedule
        </button>
      </div>
    </div>
  );
}
