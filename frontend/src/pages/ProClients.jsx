import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { AlertTriangle, CheckCircle2, ArrowRight, Plus, X, Loader2, UserPlus } from "lucide-react";
import { toast } from "sonner";

export default function ProClients() {
  const [clients, setClients] = useState([]);
  const [creating, setCreating] = useState(false);
  const { switchCompany, refresh } = useCompany();
  const load = () => api.get("/pro/clients").then(r => setClients(r.data.clients || []));
  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">My Clients</h1>
          <p className="text-slate-500 text-sm mt-1">Firm portfolio · onboarding status · transactions needing your call.</p>
        </div>
        <button
          data-testid="new-client-btn"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-slate-900 text-white text-sm"
        >
          <UserPlus size={14} /> New Client
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {clients.map(c => (
          <div key={c.id} className="rounded-xl border bg-white p-4 hover:border-slate-400 transition">
            <div className="flex items-start justify-between">
              <div>
                <div className="font-heading font-semibold text-lg">{c.name}</div>
                <div className="text-xs text-slate-500">{c.business_type || "—"}</div>
              </div>
              {c.onboarding_complete
                ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 flex items-center gap-1"><CheckCircle2 size={10} /> Ready</span>
                : <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">Onboarding</span>}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-md bg-slate-50 p-2">
                <div className="text-[10px] uppercase text-slate-500">Transactions</div>
                <div className="font-mono-num font-semibold">{c.transactions}</div>
              </div>
              <div className="rounded-md bg-orange-50 p-2">
                <div className="text-[10px] uppercase text-orange-700 flex items-center gap-1"><AlertTriangle size={10} /> Review</div>
                <div className="font-mono-num font-semibold text-orange-700">{c.needs_review}</div>
              </div>
            </div>
            <button onClick={() => { switchCompany(c.id); window.location.href = "/dashboard"; }}
                    className="mt-3 w-full inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs">
              Open books <ArrowRight size={12} />
            </button>
          </div>
        ))}
        {!clients.length && (
          <div className="col-span-full text-sm text-slate-500 border border-dashed rounded-xl p-8 text-center">
            No clients yet. Click "New Client" to add your first one.
          </div>
        )}
      </div>

      {creating && <NewClientModal onClose={() => setCreating(false)} onCreated={async () => { await load(); await refresh(); setCreating(false); }} />}
    </div>
  );
}

function NewClientModal({ onClose, onCreated }) {
  const [form, setForm] = useState({
    company_name: "", business_type: "", business_description: "",
    client_name: "", client_email: "", client_password: "",
    reporting_basis: "accrual",
  });
  const [busy, setBusy] = useState(false);
  const update = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.company_name || !form.client_name || !form.client_email || !form.client_password) {
      toast.error("Fill company name + client name/email/password"); return;
    }
    setBusy(true);
    try {
      await api.post("/pro/clients", form);
      toast.success(`Client "${form.client_name}" added to ${form.company_name}. Onboarding is ready to start.`);
      onCreated();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to create client");
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h3 className="font-heading font-semibold">Add a new client</h3>
          <button onClick={onClose} data-testid={TID.cancelBtn} className="p-1 rounded hover:bg-slate-100"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          <div className="text-xs uppercase tracking-wider text-slate-500 border-b pb-1">Company</div>
          <div>
            <label className="text-xs text-slate-600">Company name</label>
            <input data-testid="new-client-company-name" value={form.company_name}
                   onChange={(e) => update("company_name", e.target.value)}
                   className="w-full mt-1 border rounded px-2 py-1.5" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-slate-600">Business type</label>
              <input value={form.business_type} onChange={(e) => update("business_type", e.target.value)}
                     placeholder="e.g. Marketing agency" className="w-full mt-1 border rounded px-2 py-1.5" />
            </div>
            <div>
              <label className="text-xs text-slate-600">Reporting basis</label>
              <select value={form.reporting_basis} onChange={(e) => update("reporting_basis", e.target.value)}
                      className="w-full mt-1 border rounded px-2 py-1.5">
                <option value="accrual">Accrual</option>
                <option value="cash">Cash</option>
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-600">What does the business do?</label>
            <textarea rows={2} value={form.business_description} onChange={(e) => update("business_description", e.target.value)}
                      className="w-full mt-1 border rounded px-2 py-1.5" />
          </div>

          <div className="text-xs uppercase tracking-wider text-slate-500 border-b pb-1 pt-2">Owner login</div>
          <div>
            <label className="text-xs text-slate-600">Client name</label>
            <input data-testid="new-client-name" value={form.client_name} onChange={(e) => update("client_name", e.target.value)}
                   className="w-full mt-1 border rounded px-2 py-1.5" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-slate-600">Email</label>
              <input data-testid="new-client-email" type="email" value={form.client_email}
                     onChange={(e) => update("client_email", e.target.value)}
                     className="w-full mt-1 border rounded px-2 py-1.5" />
            </div>
            <div>
              <label className="text-xs text-slate-600">Temporary password</label>
              <input data-testid="new-client-password" type="text" value={form.client_password}
                     onChange={(e) => update("client_password", e.target.value)}
                     className="w-full mt-1 border rounded px-2 py-1.5 font-mono-num" />
            </div>
          </div>
          <div className="text-[11px] text-slate-500">
            A GAAP-compliant Chart of Accounts is seeded automatically. The client can start onboarding after their first login.
          </div>
        </div>
        <div className="px-5 py-3 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md border text-sm">Cancel</button>
          <button data-testid={TID.saveBtn} onClick={save} disabled={busy}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-slate-900 text-white text-sm disabled:opacity-60">
            {busy && <Loader2 size={13} className="animate-spin" />} Create client
          </button>
        </div>
      </div>
    </div>
  );
}
