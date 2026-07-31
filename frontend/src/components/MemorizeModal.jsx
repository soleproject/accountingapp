import { useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { X, Loader2, Repeat } from "lucide-react";

/**
 * Memorize an invoice or bill as a recurring template.
 * Prefills all line items, tax, contact, notes from the source doc.
 * User picks frequency + start + optional end + net_days.
 */
export default function MemorizeModal({ currentId, source, kind, onClose }) {
  const [frequency, setFrequency] = useState("monthly");
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState("");
  const issue = new Date(source.issue_date);
  const due = new Date(source.due_date);
  const inferredNetDays = Math.max(1, Math.round((due - issue) / 86400000)) || 30;
  const [netDays, setNetDays] = useState(inferredNetDays);
  const [name, setName] = useState(`${kind === "invoice" ? "Recurring" : "Recurring bill"} · ${source.contact_name || source.number}`);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/companies/${currentId}/recurring`, {
        kind,
        frequency,
        start_date: startDate,
        end_date: endDate || null,
        net_days: Number(netDays),
        status_on_generate: "draft",
        contact_id: source.contact_id || null,
        contact_name: source.contact_name || "",
        line_items: source.line_items || [],
        tax: Number(source.tax || 0),
        notes: source.notes || "",
        created_from_id: source.id,
        name: name || null,
      });
      toast.success("Memorized — will auto-generate as a draft on the schedule.");
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Could not memorize");
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-3" data-testid="memorize-modal">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold inline-flex items-center gap-2">
            <Repeat size={16} /> Memorize {kind}
          </h3>
          <button onClick={onClose}><X size={16} /></button>
        </div>
        <p className="text-xs text-slate-500">
          We'll clone <b>{source.number}</b> on your schedule and post the new {kind} as a <b>draft</b> for you to review.
        </p>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Nickname</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full border rounded px-2 py-1.5 text-sm"
            data-testid="memorize-name"
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Frequency</label>
          <select
            value={frequency}
            onChange={(e) => setFrequency(e.target.value)}
            className="w-full border rounded px-2 py-1.5 text-sm bg-white"
            data-testid="memorize-frequency"
          >
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly (recommended)</option>
            <option value="quarterly">Quarterly</option>
            <option value="annual">Annual</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">First run</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full border rounded px-2 py-1.5 text-sm"
              data-testid="memorize-start-date"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Ends (optional)</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full border rounded px-2 py-1.5 text-sm"
              data-testid="memorize-end-date"
            />
          </div>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Net days (issue → due)</label>
          <input
            type="number"
            value={netDays}
            onChange={(e) => setNetDays(e.target.value)}
            className="w-full border rounded px-2 py-1.5 text-sm font-mono-num"
            data-testid="memorize-net-days"
          />
        </div>
        <button
          onClick={save}
          disabled={busy}
          className="w-full py-2 rounded-md bg-slate-900 text-white text-sm inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
          data-testid="memorize-save"
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          Memorize
        </button>
      </div>
    </div>
  );
}
