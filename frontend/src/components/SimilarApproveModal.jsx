import { useEffect, useState } from "react";
import { X, Check, Sparkles } from "lucide-react";
import { emitAction, useActionListener } from "@/lib/createBus";
import { api } from "@/lib/api";

const money = (n) => (typeof n === "number" ? n.toLocaleString("en-US", { style: "currency", currency: "USD" }) : "");

// Shown right after a row is approved when the same vendor still has
// unapproved rows. Mirrors the AI-chat card: ticks sync both ways, and
// either side (or voice) can run the approval.
export function SimilarApproveModal({ currentId, similar, ruleExists, anchor, onClose }) {
  const items = similar.items || similar.sample || [];
  const [ticked, setTicked] = useState(() => new Set(items.map(i => i.id)));
  const [busy, setBusy] = useState(false);
  const cat = similar.category_account_name || similar.category_account_code || "the same category";

  useEffect(() => { emitAction("bulk-approve-selection-changed", { ids: [...ticked], origin: "modal" }); }, [ticked]);
  useActionListener("bulk-approve-selection-changed", (p) => {
    if (p?.origin !== "modal" && Array.isArray(p?.ids)) setTicked(new Set(p.ids));
  });
  useActionListener("bulk-approve-done", () => onClose());

  const toggle = (id) => setTicked(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allOn = ticked.size === items.length;

  const run = async (createRule) => {
    if (busy || !ticked.size) return;
    setBusy(true);
    try {
      const res = await api.post(`/companies/${currentId}/transactions/apply-bulk-approve-rule`, {
        txn_ids: [...ticked], category_account_id: similar.category_account_id,
        contact_id: similar.contact_id, contact_name: similar.contact_name, create_rule: !!createRule,
      });
      const n = res.data?.updated || 0;
      const msg = res.data?.rule_id
        ? `Approved ${n} transaction${n === 1 ? "" : "s"} and created a rule for ${similar.contact_name}.`
        : `Approved ${n} transaction${n === 1 ? "" : "s"}.`;
      emitAction("bulk-approve-done", { msg, origin: "modal" });
      emitAction("txns:changed");
    } finally { setBusy(false); }
  };
  const decline = () => { emitAction("bulk-approve-done", { msg: "OK — just the one approved.", origin: "modal", declined: true }); };

  // Quick-action strip pinned beside the pointer that clicked the check,
  // so the common "yes, all of them" path is one short move away.
  const strip = anchor ? (() => {
    const w = ruleExists ? 230 : 440, h = 44;
    const left = Math.max(8, Math.min(anchor.x - w + 20, window.innerWidth - w - 8));
    const top = anchor.y + 14 + h > window.innerHeight ? anchor.y - h - 14 : anchor.y + 14;
    return { left, top };
  })() : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-[2px]" data-testid="similar-approve-modal">
      {strip && (
        <div className="fixed z-[60] flex items-center gap-2 rounded-full bg-white border border-fuchsia-200 shadow-2xl px-2 py-1.5"
             style={{ left: strip.left, top: strip.top }} data-testid="similar-approve-quick-strip">
          <button type="button" disabled={busy || !ticked.size} onClick={() => run(false)} data-testid="similar-approve-quick-apply"
                  className="inline-flex items-center gap-1.5 text-[13px] font-semibold px-3.5 py-1.5 rounded-full bg-fuchsia-600 text-white hover:bg-fuchsia-700 disabled:opacity-50 whitespace-nowrap">
            <Check size={14} /> {busy ? "Applying…" : `Categorize & approve ${ticked.size}`}
          </button>
          {!ruleExists && (
            <button type="button" disabled={busy || !ticked.size} onClick={() => run(true)} data-testid="similar-approve-quick-apply-rule"
                    className="text-[13px] font-semibold px-3.5 py-1.5 rounded-full border border-fuchsia-300 bg-white text-fuchsia-700 hover:bg-fuchsia-50 disabled:opacity-50 whitespace-nowrap">
              Approve {ticked.size} + create rule
            </button>
          )}
        </div>
      )}
      <div className="w-[min(680px,94vw)] rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-start justify-between px-5 pt-4 pb-3 border-b border-slate-100">
          <div>
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-fuchsia-700 font-semibold"><Sparkles size={12} /> Same vendor</div>
            <h3 className="text-base font-semibold text-slate-900 mt-0.5">
              {similar.count} more unapproved from {similar.contact_name}
            </h3>
            <p className="text-[13px] text-slate-600 mt-0.5">Categorize the ticked rows as <b>{cat}</b> and approve them?</p>
          </div>
          <button type="button" onClick={decline} className="text-slate-400 hover:text-slate-700" aria-label="Close" data-testid="similar-approve-close"><X size={16} /></button>
        </div>
        <div className="max-h-[46vh] overflow-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left w-8"><input type="checkbox" checked={allOn} onChange={() => setTicked(allOn ? new Set() : new Set(items.map(i => i.id)))} data-testid="similar-approve-tick-all" /></th>
                <th className="px-2 py-2 text-left">Date</th>
                <th className="px-2 py-2 text-left">Description</th>
                <th className="px-2 py-2 text-left">Current category</th>
                <th className="px-4 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr key={it.id} className="border-t border-slate-100 hover:bg-slate-50/60" data-testid={`similar-approve-row-${it.id}`}>
                  <td className="px-4 py-2"><input type="checkbox" checked={ticked.has(it.id)} onChange={() => toggle(it.id)} data-testid={`similar-approve-tick-${it.id}`} /></td>
                  <td className="px-2 py-2 font-mono text-slate-600 whitespace-nowrap">{it.date}</td>
                  <td className="px-2 py-2 text-slate-800 truncate max-w-[260px]">{it.merchant}</td>
                  <td className="px-2 py-2 text-slate-500">{it.category_account_name || "—"}</td>
                  <td className={`px-4 py-2 text-right font-mono ${it.amount > 0 ? "text-emerald-700" : "text-slate-800"}`}>{money(it.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-t border-slate-100 bg-slate-50/60 rounded-b-2xl">
          <button type="button" disabled={busy || !ticked.size} onClick={() => run(false)} data-testid="similar-approve-apply"
                  className="inline-flex items-center gap-1.5 text-[13px] font-medium px-3.5 py-1.5 rounded-md bg-fuchsia-600 text-white hover:bg-fuchsia-700 disabled:opacity-50">
            <Check size={14} /> {busy ? "Applying…" : `Categorize & approve ${ticked.size}`}
          </button>
          {!ruleExists && (
            <button type="button" disabled={busy || !ticked.size} onClick={() => run(true)} data-testid="similar-approve-apply-rule"
                    className="text-[13px] font-medium px-3.5 py-1.5 rounded-md border border-fuchsia-300 bg-white text-fuchsia-700 hover:bg-fuchsia-50 disabled:opacity-50">
              Approve {ticked.size} + create rule
            </button>
          )}
          <button type="button" disabled={busy} onClick={decline} data-testid="similar-approve-decline"
                  className="ml-auto text-[13px] px-3 py-1.5 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50">
            No, just this one
          </button>
          <span className="w-full text-[11px] text-slate-500">You can also answer in the assistant — say “yes” or “yes, and make a rule”.</span>
        </div>
      </div>
    </div>
  );
}
