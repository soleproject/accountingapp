import { useCallback, useEffect, useState } from "react";
import { MessageSquare, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { ClientMessagesCard } from "@/components/ClientMessagesCard";
import AskAccountantModal from "@/components/AskAccountantModal";
import { notifyClientMessagesChanged } from "@/lib/useClientUnread";

/** My business → Messages: the client's view of their threads with the accounting pro. */
export default function MessagesTab({ companyId }) {
  const [data, setData] = useState(null);
  const [compose, setCompose] = useState(false);
  const load = useCallback(() => {
    if (!companyId) return;
    api.get(`/companies/${companyId}/client-messages`).then(r => { setData(r.data); notifyClientMessagesChanged(); }).catch(() => setData({ messages: [], pro: null }));
  }, [companyId]);
  useEffect(() => { load(); }, [load]);

  const reply = async (m, text, _resolve, attachments = []) => {
    try { await api.post(`/client-messages/${m.id}/reply`, { text, attachments }); toast.success("Sent"); load(); }
    catch { toast.error("Couldn't send"); }
  };
  const resolve = async (m) => {
    try { await api.patch(`/client-messages/${m.id}`, { status: "resolved" }); toast.success("Marked resolved"); load(); }
    catch { toast.error("Couldn't update"); }
  };

  return (
    <div className="rounded-2xl border-2 border-emerald-200 bg-emerald-50/30 p-5" data-testid="owner-messages-card">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center"><MessageSquare size={15} /></div>
          <div>
            <div className="text-sm font-semibold text-slate-900">Messages</div>
            <div className="text-[11px] text-slate-500">
              {data?.pro?.name ? `Your threads with ${data.pro.name}. ` : "Your threads with your accountant. "}
              Outstanding = their reply is waiting on you · Answered = you replied last · Resolved = you marked it handled.
            </div>
          </div>
        </div>
        <button onClick={() => setCompose(true)} className="text-[11px] px-2.5 py-1 rounded-md bg-slate-900 text-white font-medium" data-testid="owner-messages-new">New message</button>
      </div>
      <div className="bg-white rounded-lg border border-slate-200 p-4 min-h-[220px]">
        {!data ? <div className="text-sm text-slate-400 py-6 text-center"><Loader2 size={14} className="inline animate-spin mr-1" /> Loading…</div>
          : <ClientMessagesCard messages={data.messages} perspective="client" onReply={reply} onResolve={resolve} onChanged={load} testidPrefix="owner-cm" />}
      </div>
      <AskAccountantModal open={compose} onClose={() => { setCompose(false); load(); }} companyId={companyId} />
    </div>
  );
}
