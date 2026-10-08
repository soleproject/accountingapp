import { useState } from "react";
import { Copy, MessageSquare, Mail, Phone, X, Check } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { buildMessage, copyText, smsHref, mailtoHref } from "./tools";

/** Bottom-sheet / modal that shows a merged template with Copy · Open in Messages · Email · Call, and logs the touch. */
export function SendSheet({ open, onClose, toolkit, templateId, ctx, lead, onLogged }) {
  const [custom, setCustom] = useState(null);
  if (!open) return null;
  const msg = buildMessage(toolkit, templateId, ctx);
  const text = custom ?? msg?.text ?? "";
  const isEmail = msg?.channel === "email";

  const log = async (kind) => {
    try {
      if (lead?.lead_id) await api.post(`/affiliate/leads/${lead.lead_id}/activity`, { kind, note: `${msg?.title || templateId}` });
      else if (lead?.email) await api.post(`/affiliate/referrals/${encodeURIComponent(lead.email)}/activity`, { kind, note: `${msg?.title || templateId}` });
      onLogged?.();
    } catch { /* logging is best-effort */ }
  };

  return (
    <div className="fixed inset-0 z-[1200] bg-slate-900/50 flex items-end sm:items-center justify-center p-0 sm:p-6" onClick={onClose} data-testid="send-sheet">
      <div className="bg-white w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-bold tracking-[.12em] uppercase text-indigo-600">{isEmail ? "Email" : "Text"} · {msg?.title || "Message"}</div>
            {lead?.name && <div className="text-sm text-slate-500 mt-0.5">to {lead.name}{lead.phone ? ` · ${lead.phone}` : ""}{lead.email && !lead.email.endsWith("no-email.local") ? ` · ${lead.email}` : ""}</div>}
          </div>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-slate-100" data-testid="send-sheet-close"><X size={16} /></button>
        </div>
        {msg?.subject && <div className="mt-3 text-sm"><span className="text-slate-500">Subject:</span> <b>{msg.subject}</b></div>}
        <textarea value={text} onChange={e => setCustom(e.target.value)} rows={isEmail ? 9 : 5}
          className="mt-3 w-full rounded-xl border border-slate-300 p-3 text-sm leading-relaxed focus:border-slate-900 focus:ring-2 focus:ring-slate-200 outline-none" data-testid="send-sheet-text" />
        <div className="mt-3 grid grid-cols-2 sm:flex gap-2">
          <button onClick={() => { copyText(text); log(isEmail ? "email" : "text"); }} className="h-10 px-4 rounded-full bg-slate-900 text-white text-sm font-semibold flex items-center justify-center gap-2" data-testid="send-sheet-copy"><Copy size={14} /> Copy</button>
          {!isEmail && lead?.phone && <a href={smsHref(lead.phone, text)} onClick={() => log("text")} className="h-10 px-4 rounded-full border border-slate-300 text-sm font-semibold flex items-center justify-center gap-2" data-testid="send-sheet-sms"><MessageSquare size={14} /> Open in Messages</a>}
          {lead?.email && !lead.email.endsWith("no-email.local") && <a href={mailtoHref(lead.email, msg?.subject || "", text)} onClick={() => log("email")} className="h-10 px-4 rounded-full border border-slate-300 text-sm font-semibold flex items-center justify-center gap-2" data-testid="send-sheet-mail"><Mail size={14} /> Email</a>}
          {lead?.phone && <a href={`tel:${lead.phone}`} onClick={() => log("call")} className="h-10 px-4 rounded-full border border-slate-300 text-sm font-semibold flex items-center justify-center gap-2" data-testid="send-sheet-call"><Phone size={14} /> Call</a>}
        </div>
        <button onClick={async () => { await log("note"); toast.success("Marked as done"); onClose(); }} className="mt-3 text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1" data-testid="send-sheet-done"><Check size={12} /> I did this another way — mark as contacted</button>
      </div>
    </div>
  );
}
