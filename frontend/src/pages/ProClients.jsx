import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { AlertTriangle, CheckCircle2, ArrowRight } from "lucide-react";

export default function ProClients() {
  const [clients, setClients] = useState([]);
  const { switchCompany } = useCompany();
  useEffect(() => { api.get("/pro/clients").then(r => setClients(r.data.clients || [])); }, []);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-heading text-3xl font-bold tracking-tight">My Clients</h1>
        <p className="text-slate-500 text-sm mt-1">Firm portfolio · onboarding status · transactions needing your call.</p>
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
      </div>
    </div>
  );
}
