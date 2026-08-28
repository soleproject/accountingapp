import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  X, Loader2, Save, ClipboardList, CalendarCheck, Phone, Mail,
  Users as UsersIcon, StickyNote, Check, UserPlus, Contact as ContactIcon,
  Link2, Plus,
} from "lucide-react";

import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCompany } from "@/lib/company";
import TimeSlotPicker, { toMinutes } from "./TimeSlotPicker";

/**
 * CalendarQuickAddModal — click a day cell → drop a task, meeting,
 * call, or email onto that date (Phase C polish, Feb 2026).
 *
 * All four kinds use the polymorphic `tasks` collection under the
 * hood — the `kind` field distinguishes them so the Calendar can
 * render meetings with a phone/handshake icon vs. plain tasks.
 *
 * Google-Calendar parity:
 *   - Start-time picker auto-scrolls to the current local time
 *   - Guests are a MULTI-select of Contacts (with inline "+ new")
 *   - A single Deal can be linked so the task threads into the pipeline
 */
const KINDS = [
  { key: "task",    label: "Task",    icon: ClipboardList,  color: "bg-cyan-600" },
  { key: "meeting", label: "Meeting", icon: CalendarCheck,  color: "bg-emerald-600" },
  { key: "call",    label: "Call",    icon: Phone,          color: "bg-amber-600" },
  { key: "email",   label: "Email",   icon: Mail,           color: "bg-indigo-600" },
];

export default function CalendarQuickAddModal({ date, onClose, onSaved }) {
  const { currentId } = useCompany();
  const { user } = useAuth();
  const [kind, setKind] = useState("task");
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("medium");
  const [dueTime, setDueTime] = useState("");     // "HH:MM" 24h start
  const [endTime, setEndTime] = useState("");     // "HH:MM" 24h end
  const [dealId, setDealId] = useState("");        // linked deal (single)
  const [contactIds, setContactIds] = useState([]);// guests (multi)
  const [showContacts, setShowContacts] = useState(false);
  const [contactQuery, setContactQuery] = useState("");
  const [notes, setNotes] = useState("");
  // Assignees always include the creator. Employees list drives the
  // chooser; primary assignee is the first entry.
  const [assigneeIds, setAssigneeIds] = useState([]);
  const [showAssignees, setShowAssignees] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deals, setDeals] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [addingContact, setAddingContact] = useState(false);

  // Sensible default end-times per kind whenever a start is picked.
  // Google flips end-time to +30 min for events, +15 for calls, etc.
  useEffect(() => {
    if (!dueTime) return;
    const bump = kind === "meeting" ? 30 : kind === "call" ? 15 : 30;
    const startM = toMinutes(dueTime);
    const endM = Math.min(startM + bump, 23 * 60 + 45);
    const h = Math.floor(endM / 60), m = endM % 60;
    if (!endTime || toMinutes(endTime) <= startM) {
      setEndTime(`${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`);
    }
  }, [dueTime, kind]);

  useEffect(() => {
    if (!currentId) return;
    (async () => {
      try {
        const [d, c, e] = await Promise.all([
          api.get(`/companies/${currentId}/deals`),
          api.get(`/companies/${currentId}/contacts`),
          api.get(`/companies/${currentId}/employees`),
        ]);
        setDeals(d.data?.deals || []);
        setContacts(c.data?.contacts || []);
        setEmployees(e.data?.employees || []);
        // Pre-fill assignees with the current user's linked employee
        // (or fall back to their user_id).
        const me = (e.data?.employees || []).find(
          x => x.user_id === user?.id);
        setAssigneeIds([me?.user_id || user?.id].filter(Boolean));
      } catch { /* silent */ }
    })();
  }, [currentId, user?.id]);

  const toggleContact = (id) => {
    setContactIds(cur => cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]);
  };

  const createContactInline = async () => {
    const name = contactQuery.trim();
    if (!name) return;
    setAddingContact(true);
    try {
      const r = await api.post(
        `/companies/${currentId}/contacts`,
        { name, type: "customer" });
      const c = r.data?.contact || r.data;
      if (c?.id) {
        setContacts(cs => [c, ...cs]);
        setContactIds(ids => [...ids, c.id]);
        setContactQuery("");
        toast.success(`Contact "${c.name}" added`);
      }
    } catch (err) {
      toast.error(`Failed: ${err.response?.data?.detail || err.message}`);
    } finally { setAddingContact(false); }
  };

  const submit = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      // Compute duration from end/start if end was picked.
      let dur = null;
      if (dueTime && endTime) {
        const diff = toMinutes(endTime) - toMinutes(dueTime);
        dur = diff > 0 ? diff : null;
      }
      // A single "entity" still anchors the task for legacy views
      // — prefer the deal, else the first contact.
      let entity_type = null, entity_id = null, entity_label = null;
      if (dealId) {
        const hit = deals.find(x => x.id === dealId);
        entity_type = "deal"; entity_id = dealId; entity_label = hit?.title || null;
      } else if (contactIds.length === 1) {
        const hit = contacts.find(x => x.id === contactIds[0]);
        entity_type = "contact"; entity_id = contactIds[0]; entity_label = hit?.name || null;
      }
      const payload = {
        title: title.trim(), kind, priority,
        due_date: date,
        due_time: dueTime || null,
        duration_minutes: dur,
        description: notes.trim() || undefined,
        assignee_user_id: assigneeIds[0] || null,
        assignee_user_ids: assigneeIds,
        contact_ids: contactIds,
        entity_type, entity_id, entity_label,
      };
      await api.post(`/companies/${currentId}/tasks`, payload);
      // Cross-post activities for meetings/calls/emails so the CRM
      // feeds stay in sync — one entry per linked contact + deal.
      if (["meeting", "call", "email"].includes(kind)) {
        const when = dueTime ? `${date} ${dueTime}` : date;
        const body = `${title.trim()} — ${when}`;
        const posts = [];
        if (dealId) {
          posts.push(api.post(
            `/companies/${currentId}/deals/${dealId}/activities`,
            { kind, body }).catch(() => {}));
        }
        for (const cid of contactIds) {
          posts.push(api.post(
            `/companies/${currentId}/contacts/${cid}/activities`,
            { kind, body }).catch(() => {}));
        }
        await Promise.all(posts);
      }
      toast.success(`${kind.charAt(0).toUpperCase()+kind.slice(1)} added to ${date}`);
      onSaved?.();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    } finally { setSaving(false); }
  };

  // Search-filtered contacts for the picker.
  const q = contactQuery.trim().toLowerCase();
  const filteredContacts = q
    ? contacts.filter(c => (c.name || "").toLowerCase().includes(q))
    : contacts.slice(0, 100);
  const contactExists = contacts.some(c => (c.name || "").toLowerCase() === q);

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center px-4"
          role="dialog" aria-modal="true"
          data-testid="calendar-quickadd-modal">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
            onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md border border-slate-200 overflow-hidden max-h-[92vh] flex flex-col">
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
        <div className="p-5 space-y-3 overflow-y-auto">
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
          <div className="grid grid-cols-3 gap-2">
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
              <label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-0.5">Start</label>
              <TimeSlotPicker value={dueTime} onChange={setDueTime}
                                placeholder="—"
                                testId="calendar-quickadd-time" />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-0.5">End</label>
              <TimeSlotPicker value={endTime} onChange={setEndTime}
                                anchor={dueTime || null}
                                placeholder="—"
                                testId="calendar-quickadd-end" />
            </div>
          </div>

          {/* Guests = multi-select Contacts (Google-Calendar parity) */}
          <div>
            <div className="flex items-center justify-between mb-0.5">
              <label className="text-[10px] uppercase tracking-wider text-slate-500 flex items-center gap-1">
                <ContactIcon size={10} /> Guests ({contactIds.length})
              </label>
              <button type="button"
                      onClick={() => setShowContacts(v => !v)}
                      data-testid="calendar-quickadd-contacts-toggle"
                      className="text-[10px] text-violet-600 hover:underline">
                {showContacts ? "Hide" : "Add contacts"}
              </button>
            </div>
            {contactIds.length > 0 && !showContacts && (
              <div className="flex flex-wrap gap-1 mb-1"
                   data-testid="calendar-quickadd-contacts-chips">
                {contactIds.map(id => {
                  const c = contacts.find(x => x.id === id);
                  if (!c) return null;
                  return (
                    <span key={id}
                          className="inline-flex items-center gap-1 text-[11px] bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-full pl-2 pr-1 py-0.5">
                      {c.name}
                      <button type="button"
                              onClick={() => toggleContact(id)}
                              className="text-emerald-600 hover:text-emerald-900 rounded-full hover:bg-emerald-100">
                        <X size={11} />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
            {showContacts && (
              <div className="rounded border border-slate-200 bg-slate-50/50"
                    data-testid="calendar-quickadd-contacts-picker">
                <div className="flex items-center gap-1 p-1 border-b border-slate-200 bg-white">
                  <input value={contactQuery}
                         onChange={(e) => setContactQuery(e.target.value)}
                         onKeyDown={(e) => {
                           if (e.key === "Enter" && contactQuery.trim() && !contactExists) {
                             e.preventDefault();
                             createContactInline();
                           }
                         }}
                         placeholder="Search or type a new name…"
                         data-testid="calendar-quickadd-contact-search"
                         className="flex-1 px-2 py-1 text-xs border-0 focus:ring-0 focus:outline-none" />
                  {contactQuery.trim() && !contactExists && (
                    <button type="button"
                            onClick={createContactInline}
                            disabled={addingContact}
                            data-testid="calendar-quickadd-contact-new"
                            className="text-[10px] text-violet-700 hover:bg-violet-50 rounded px-1.5 py-1 inline-flex items-center gap-1 disabled:opacity-50">
                      {addingContact ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />}
                      Add "{contactQuery.trim()}"
                    </button>
                  )}
                </div>
                <div className="max-h-40 overflow-y-auto p-1">
                  {filteredContacts.length === 0 && (
                    <div className="text-[11px] text-slate-500 italic p-2">
                      {q
                        ? <>No matches — press <kbd className="px-1 border rounded bg-white">Enter</kbd> to create.</>
                        : "No contacts yet. Type a name to add one."}
                    </div>
                  )}
                  {filteredContacts.map(c => {
                    const on = contactIds.includes(c.id);
                    return (
                      <button key={c.id} type="button"
                              onClick={() => toggleContact(c.id)}
                              data-testid={`calendar-quickadd-contact-${c.id}`}
                              className={`w-full text-left px-2 py-1 rounded flex items-center gap-2 text-xs ${
                                on ? "bg-emerald-50 text-emerald-800" : "hover:bg-slate-100 text-slate-700"
                              }`}>
                        <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center ${
                          on ? "bg-emerald-600 border-emerald-600 text-white" : "border-slate-300 bg-white"}`}>
                          {on && <Check size={10} />}
                        </span>
                        {c.name}
                        <span className="text-slate-400 text-[10px] ml-auto truncate max-w-[110px]">
                          {c.email || c.company || ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Deal link (single) — separate from Guests so a task can
              both belong to a deal and invite external attendees. */}
          <div>
            <label className="text-[10px] uppercase tracking-wider text-slate-500 flex items-center gap-1 mb-0.5">
              <Link2 size={10} /> Deal (optional)
            </label>
            <select value={dealId}
                    onChange={(e) => setDealId(e.target.value)}
                    data-testid="calendar-quickadd-deal"
                    className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm bg-white">
              <option value="">— none —</option>
              {deals.slice(0, 100).map(d => (
                <option key={d.id} value={d.id}>{d.title}</option>
              ))}
            </select>
          </div>

          {/* Assignees (internal teammates — separate from Guests) */}
          <div>
            <div className="flex items-center justify-between mb-0.5">
              <label className="text-[10px] uppercase tracking-wider text-slate-500 flex items-center gap-1">
                <UsersIcon size={10} /> Assignees ({assigneeIds.length})
              </label>
              <button type="button"
                      onClick={() => setShowAssignees(v => !v)}
                      data-testid="calendar-quickadd-assignees-toggle"
                      className="text-[10px] text-violet-600 hover:underline">
                {showAssignees ? "Hide" : "Pick teammates"}
              </button>
            </div>
            {showAssignees && (
              <div className="max-h-32 overflow-y-auto rounded border border-slate-200 bg-slate-50/50 p-1"
                    data-testid="calendar-quickadd-assignees-picker">
                {employees.length === 0 && (
                  <div className="text-[11px] text-slate-500 italic p-2">
                    No employees yet — add teammates under Team → Employees.
                  </div>
                )}
                {employees.map(e => {
                  const key = e.user_id || e.id;
                  const on = assigneeIds.includes(key);
                  return (
                    <button key={e.id} type="button"
                            onClick={() => setAssigneeIds(cur =>
                              on ? cur.filter(x => x !== key) : [...cur, key])}
                            data-testid={`calendar-quickadd-assignee-${e.id}`}
                            className={`w-full text-left px-2 py-1 rounded flex items-center gap-2 text-xs ${
                              on ? "bg-emerald-50 text-emerald-800" : "hover:bg-slate-100 text-slate-700"
                            }`}>
                      <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center ${
                        on ? "bg-emerald-600 border-emerald-600 text-white" : "border-slate-300 bg-white"}`}>
                        {on && <Check size={10} />}
                      </span>
                      {e.name}
                      <span className="text-slate-400 text-[10px] ml-auto">
                        {(e.role || "").replace("_", " ")}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wider text-slate-500 flex items-center gap-1 mb-0.5">
              <StickyNote size={10} /> Notes (optional)
            </label>
            <textarea value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        rows={2}
                        placeholder={
                          kind === "meeting" ? "Agenda, dial-in link, location…"
                        : kind === "call"    ? "Talking points, phone number…"
                        : kind === "email"   ? "Draft or follow-up context…"
                        : "Any extra detail…"
                        }
                        data-testid="calendar-quickadd-notes"
                        className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
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
