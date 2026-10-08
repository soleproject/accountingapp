import { useState } from "react";
import { Plus, X } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { SendSheet } from "./SendSheet";
import { STAGE_META, fmtUsd, ago } from "./tools";

function LeadCard({ r, onAct, onLost }) {
  const n = r.next;
  const src = r.source === "manual" ? "Manual" : r.source === "link" ? "Link" : "Form";
  return (
    <div className={"bg-white border rounded-xl p-3 text-xs " + (r.stage === "trial_ending" ? "border-orange-200" : "border-slate-200")} data-testid={`pipeline-card-${r.email}`}>
      <div className="font-semibold text-[13px] text-slate-900 truncate">{r.company_name || r.name || r.email}</div>
      {r.company_name && r.name && <div className="text-slate-500 truncate">{r.name}</div>}
      <div className="flex flex-wrap gap-1 mt-1.5">
        <span className="px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 font-semibold text-[10px]">{r.role_label}</span>
        <span className="px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 font-semibold text-[10px]">{src}{r.variant ? ` · ${r.variant}` : ""}</span>
        {r.stage === "trial_ending" && <span className="px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700 font-semibold text-[10px]">{Math.max(0, r.days_to_trial_end)} days left</span>}
      </div>
      <div className="text-slate-500 mt-1.5">
        {r.stage === "paying" ? <>{r.payments} invoice{r.payments === 1 ? "" : "s"} · <span className="font-mono text-emerald-700 font-semibold">{fmtUsd(r.earned_cents)}</span> to you</>
          : r.stage === "signed_up" ? <>{ago(r.signed_up_at)} · {r.has_bank ? "bank connected ✓" : "no bank connected"}</>
          : r.booking_at ? <>Walkthrough {r.booking_at.slice(0, 10)}</>
          : r.stage === "lost" ? <>{r.canceled ? "Canceled" : "Marked lost"}</>
          : <>{ago(r.submitted_at || r.signed_up_at)}{r.activities?.length ? ` · ${r.activities.length} touch${r.activities.length === 1 ? "" : "es"}` : ""}</>}
      </div>
      {n && (
        <div className="mt-2 pt-2 border-t border-dashed border-slate-200 flex items-center justify-between gap-2">
          <span className={"font-semibold " + (n.urgent ? "text-orange-700" : n.ok ? "text-emerald-700" : "text-indigo-700")}>{n.label}</span>
          {n.template && <button onClick={() => onAct(r, n)} className="px-2 py-1 rounded-full bg-slate-900 text-white font-semibold text-[10px]" data-testid={`pipeline-next-${r.email}`}>Go →</button>}
        </div>
      )}
      {r.lead_id && r.stage !== "lost" && r.stage !== "paying" && (
        <button onClick={() => onLost(r)} className="mt-1.5 text-[10px] text-slate-400 hover:text-red-600" data-testid={`pipeline-lost-${r.email}`}>Mark lost</button>
      )}
    </div>
  );
}

function AddLeadModal({ open, onClose, onAdded, slug, EnterReferral }) {
  const [mode, setMode] = useState("track");
  const [f, setF] = useState({ name: "", email: "", phone: "", role: "business_owner", company_name: "", notes: "" });
  const [busy, setBusy] = useState(false);
  if (!open) return null;
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/affiliate/leads", { ...f, email: f.email.trim() || null, phone: f.phone.trim() || null, company_name: f.company_name.trim() || null, notes: f.notes.trim() || null });
      toast.success("Lead added");
      onAdded(); onClose();
    } catch (err) { toast.error(err?.response?.data?.detail || "Couldn't add lead"); }
    finally { setBusy(false); }
  };
  const cls = "w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:border-slate-900 outline-none";
  return (
    <div className="fixed inset-0 z-[1200] bg-slate-900/50 flex items-end sm:items-center justify-center p-0 sm:p-6" onClick={onClose} data-testid="add-lead-modal">
      <div className="bg-white w-full sm:max-w-xl rounded-t-2xl sm:rounded-2xl p-5 shadow-xl max-h-[92vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between"><h3 className="font-heading font-bold text-lg">Add a lead</h3><button onClick={onClose} className="p-1 rounded hover:bg-slate-100" data-testid="add-lead-close"><X size={16} /></button></div>
        <div className="mt-3 flex gap-1 rounded-full bg-slate-100 p-1 text-xs font-semibold">
          <button onClick={() => setMode("track")} className={"flex-1 h-8 rounded-full " + (mode === "track" ? "bg-white shadow-sm" : "text-slate-500")} data-testid="add-lead-mode-track">Just track it (I talked to someone)</button>
          <button onClick={() => setMode("invite")} className={"flex-1 h-8 rounded-full " + (mode === "invite" ? "bg-white shadow-sm" : "text-slate-500")} data-testid="add-lead-mode-invite">Send them the invite email</button>
        </div>
        {mode === "track" ? (
          <form onSubmit={save} className="mt-4 space-y-3">
            <input placeholder="Name *" value={f.name} onChange={set("name")} className={cls} required data-testid="add-lead-name" />
            <div className="grid grid-cols-2 gap-3">
              <input placeholder="Email" type="email" value={f.email} onChange={set("email")} className={cls} data-testid="add-lead-email" />
              <input placeholder="Mobile" value={f.phone} onChange={set("phone")} className={cls} data-testid="add-lead-phone" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <select value={f.role} onChange={set("role")} className={cls} data-testid="add-lead-role"><option value="business_owner">Business owner</option><option value="accounting_pro">Accounting pro</option><option value="enterprise">Enterprise</option></select>
              <input placeholder="Business / firm" value={f.company_name} onChange={set("company_name")} className={cls} data-testid="add-lead-company" />
            </div>
            <textarea placeholder="Where you met, what they said…" value={f.notes} onChange={set("notes")} rows={2} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 outline-none" data-testid="add-lead-notes" />
            <p className="text-[11px] text-slate-500">No email is sent. Email or mobile required so you can follow up from the board.</p>
            <button disabled={busy} className="w-full h-11 rounded-full bg-slate-900 text-white font-semibold text-sm disabled:opacity-60" data-testid="add-lead-save">Add to pipeline</button>
          </form>
        ) : (
          <div className="mt-4"><EnterReferral slug={slug} onDone={() => { onAdded(); onClose(); }} /></div>
        )}
      </div>
    </div>
  );
}

export function PipelineTab({ center, toolkit, onChanged, slug, EnterReferral }) {
  const [filter, setFilter] = useState("all");
  const [sheet, setSheet] = useState(null);
  const [adding, setAdding] = useState(false);
  if (!center) return <div className="text-sm text-slate-400 p-6">Loading…</div>;
  const rows = center.pipeline.filter(r => filter === "all" || (filter === "action" ? r.next?.template : (r.role || "business_owner").includes(filter)));
  const act = (r, n) => setSheet({ templateId: n.template, ctx: n.ctx, lead: r });
  const lost = async (r) => {
    try { await api.patch(`/affiliate/leads/${r.lead_id}`, { status: "dead" }); toast.success("Marked lost"); onChanged(); } catch { toast.error("Failed"); }
  };
  const chips = [["all", `All ${center.pipeline.length}`], ["business_owner", `Owners ${center.pipeline.filter(r => (r.role || "business_owner") === "business_owner").length}`],
    ["accounting_pro", `Pros ${center.pipeline.filter(r => r.role === "accounting_pro").length}`], ["enterprise", `Enterprise ${center.pipeline.filter(r => r.role === "enterprise").length}`],
    ["action", `Needs action ${center.pipeline.filter(r => r.next?.template).length}`]];
  return (
    <div data-testid="pipeline-tab">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {chips.map(([k, l]) => <button key={k} onClick={() => setFilter(k)} className={"h-7 px-3 rounded-full text-xs font-semibold border " + (filter === k ? "bg-slate-900 text-white border-slate-900" : "bg-white border-slate-200 text-slate-600")} data-testid={`pipeline-filter-${k}`}>{l}</button>)}
        <span className="flex-1" />
        <button onClick={() => setAdding(true)} className="h-8 px-3 rounded-full border border-slate-300 bg-white text-xs font-semibold flex items-center gap-1" data-testid="pipeline-add-lead"><Plus size={12} /> Add a lead</button>
      </div>
      {center.pipeline.length === 0 ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-2xl p-8 text-center text-sm text-slate-500" data-testid="pipeline-empty">
          Nobody in your pipeline yet. Share your link or <button onClick={() => setAdding(true)} className="underline font-medium text-slate-700">add someone you've talked to</button>.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
          {center.stages.map(st => {
            const m = STAGE_META[st];
            const list = rows.filter(r => r.stage === st);
            return (
              <div key={st} className={"rounded-2xl p-2.5 min-h-[120px] " + m.col} data-testid={`pipeline-col-${st}`}>
                <div className="flex justify-between text-[11px] uppercase tracking-[.1em] font-bold text-slate-500 px-1 pb-2">{m.label}<span>{list.length}</span></div>
                <div className="space-y-2">{list.map(r => <LeadCard key={r.email} r={r} onAct={act} onLost={lost} />)}</div>
              </div>
            );
          })}
        </div>
      )}
      <SendSheet open={!!sheet} onClose={() => setSheet(null)} toolkit={toolkit} templateId={sheet?.templateId} ctx={sheet?.ctx} lead={sheet?.lead} onLogged={onChanged} />
      <AddLeadModal open={adding} onClose={() => setAdding(false)} onAdded={onChanged} slug={slug} EnterReferral={EnterReferral} />
    </div>
  );
}
