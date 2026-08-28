import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  X, Loader2, Save, ClipboardList, CalendarCheck, Phone, Mail,
} from "lucide-react";

import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";

/**
 * CalendarQuickAddModal — click a day cell → drop a task, meeting,
 * call, or email onto that date (Phase C polish, Feb 2026).
 *
 * All four kinds use the polymorphic `tasks` collection under the
 * hood — the `kind` field distinguishes them so the Calendar can
 * render meetings with a phone/handshake icon vs. plain tasks.
 * Optionally links the event to a Deal or Contact so it also
 * threads through their activity feeds.
 */
const KINDS = [
  { key: "task",    label: "Task",    icon: ClipboardList,  color: "bg-cyan-600" },
  { key: "meeting", label: "Meeting", icon: CalendarCheck,  color: "bg-emerald-600" },
  { key: "call",    label: "Call",    icon: Phone,          color: "bg-amber-600" },
  { key: "email",   label: "Email",   icon: Mail,           color: "bg-indigo-600" },
];

export default function CalendarQuickAddModal({ date, onClose, onSaved }) {
  const { currentId } = useCompany();
  const [kind, setKind] = useState("task");
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("medium");
  const [entityRef, setEntityRef] = useState("");  // "deal:<id>" | "contact:<id>" | ""
  const [saving, setSaving] = useState(false);
  const [deals, setDeals] = useState([]);
  const [contacts, setContacts] = useState([]);

  useEffect(() => {
    if (!currentId) return;
    (async () => {
      try {
        const [d, c] = await Promise.all([
          api.get(`/companies/${currentId}/deals`),
          api.get(`/companies/${currentId}/contacts`),
        ]);
        setDeals(d.data?.deals || []);
        setContacts(c.data?.contacts || []);
      } catch { /* silent */ }
    })();
  }, [currentId]);

  const submit = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      let entity_type = null, entity_id = null, entity_label = null;
      if (entityRef) {
        const [t, id] = entityRef.split(":");
        entity_type = t;
        entity_id = id;
        const src = t === "deal" ? deals : contacts;
        const hit = src.find(x => x.id === id);
        entity_label = hit?.title || hit?.name || null;
      }
      const payload = {
        title: title.trim(), kind, priority,
        due_date: date, entity_type, entity_id, entity_label,
      };
      await api.post(`/companies/${currentId}/tasks`, payload);
      // If a meeting/call is linked to a deal or contact, ALSO log an
      // activity on that entity so the CRM feeds stay in sync.
      if (["meeting", "call", "email"].includes(kind) && entity_type && entity_id) {
        try {
          const url = entity_type === "deal"
            ? `/companies/${currentId}/deals/${entity_id}/activities`
            : `/companies/${currentId}/contacts/${entity_id}/activities`;
          await api.post(url, { kind, body: `${title.trim()} — ${date}` });
        } catch { /* activity is nice-to-have; task creation is the source of truth */ }
      }
      toast.success(`${kind.charAt(0).toUpperCase()+kind.slice(1)} added to ${date}`);
      onSaved?.();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center px-4"
          role="dialog" aria-modal="true"
          data-testid="calendar-quickadd-modal">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
            onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md border border-slate-200 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div>
            <div className="font-heading font-bold text-slate-900">Add to calendar</div>
            <div className="text-[11px] text-slate-500 font-mono-num">{date}</div>
          </div>
          <button onClick={onClose}
                  data-testid="calendar-quickadd-close"
                  className="p-1 rounded hover:bg-slate-100 text-slate-400">
            <X size={16} />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-4 gap-2" data-testid="calendar-quickadd-kinds">
            {KINDS.map(k => {
              const Icon = k.icon;
              const active = kind === k.key;
              return (
                <button key={k.key}
                        onClick={() => setKind(k.key)}
                        data-testid={`calendar-quickadd-kind-${k.key}`}
                        className={`rounded-lg border p-2 text-center transition ${
                          active
                            ? "border-slate-900 bg-slate-900 text-white"
                            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                        }`}>
                  <Icon size={14} className="inline mb-0.5" />
                  <div className="text-[10px] uppercase tracking-wider mt-0.5">{k.label}</div>
                </button>
              );
            })}
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-0.5">Title *</label>
            <input value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && submit()}
                    autoFocus
                    placeholder={
                      kind === "meeting" ? "Discovery call with Acme"
                    : kind === "call" ? "Follow-up call with Bob"
                    : kind === "email" ? "Send Q3 proposal"
                    : "Prep deck for Friday review"
                    }
                    data-testid="calendar-quickadd-title"
                    className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-0.5">Priority</label>
              <select value={priority}
                        onChange={(e) => setPriority(e.target.value)}
                        data-testid="calendar-quickadd-priority"
                        className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm bg-white">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-0.5">Link to (optional)</label>
              <select value={entityRef}
                        onChange={(e) => setEntityRef(e.target.value)}
                        data-testid="calendar-quickadd-entity"
                        className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm bg-white">
                <option value="">— none —</option>
                {deals.length > 0 && (
                  <optgroup label="Deals">
                    {deals.slice(0, 30).map(d => (
                      <option key={d.id} value={`deal:${d.id}`}>{d.title}</option>
                    ))}
                  </optgroup>
                )}
                {contacts.length > 0 && (
                  <optgroup label="Contacts">
                    {contacts.slice(0, 60).map(c => (
                      <option key={c.id} value={`contact:${c.id}`}>{c.name}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
          </div>
        </div>
        <div className="px-4 py-3 border-t bg-slate-50 flex justify-end gap-2">
          <button onClick={onClose}
                  className="text-sm px-3 py-1.5 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50">
            Cancel
          </button>
          <button onClick={submit}
                  disabled={!title.trim() || saving}
                  data-testid="calendar-quickadd-submit"
                  className="text-sm px-3 py-1.5 rounded bg-slate-900 text-white font-medium hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
