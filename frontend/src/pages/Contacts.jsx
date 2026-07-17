import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus, Trash2, X, Pencil, GitMerge } from "lucide-react";
import { toast } from "sonner";

const EMPTY_FORM = { name: "", type: "customer", email: "", phone: "", address: "" };

const fmtMoney = (n) => {
  const v = Number(n) || 0;
  const abs = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `-$${abs}` : `$${abs}`;
};

const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

export default function Contacts() {
  const { currentId } = useCompany();
  const [items, setItems] = useState([]);
  const [modal, setModal] = useState(null); // null | { mode, contact? }
  const [selected, setSelected] = useState(new Set());
  const [mergeOpen, setMergeOpen] = useState(false);

  const load = async () => {
    if (!currentId) return;
    const r = await api.get(`/companies/${currentId}/contacts`);
    setItems(r.data.contacts || []);
    setSelected(new Set());
  };
  useEffect(() => { load(); }, [currentId]);

  const del = async (e, id) => {
    e.stopPropagation();
    if (!confirm("Delete this contact?")) return;
    await api.delete(`/companies/${currentId}/contacts/${id}`);
    toast.success("Contact deleted");
    load();
  };

  const toggleSel = (e, id) => {
    e.stopPropagation();
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectedContacts = useMemo(
    () => items.filter(c => selected.has(c.id)),
    [items, selected]
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Contacts</h1>
          <p className="text-slate-500 text-sm mt-1">Customers &amp; vendors.</p>
        </div>
        <div className="flex items-center gap-2">
          {selected.size >= 2 && (
            <button
              data-testid="contacts-merge-btn"
              onClick={() => setMergeOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-300 bg-white text-slate-900 text-xs hover:bg-slate-50"
            >
              <GitMerge size={13} /> Merge {selected.size}
            </button>
          )}
          <button
            data-testid={TID.addBtn}
            onClick={() => setModal({ mode: "create" })}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs"
          >
            <Plus size={13} /> New Contact
          </button>
        </div>
      </div>

      <div className="rounded-xl border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500 border-b">
            <tr>
              <th className="w-8 px-3 py-2"></th>
              <th className="px-3 py-2 text-left">Contact</th>
              <th className="px-3 py-2 text-right">Hits</th>
              <th className="px-3 py-2 text-right">YTD In</th>
              <th className="px-3 py-2 text-right">YTD Out</th>
              <th className="px-3 py-2 text-right">Net</th>
              <th className="px-3 py-2 text-left">Last Seen</th>
              <th className="px-3 py-2 text-left">Type</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map(c => (
              <tr
                key={c.id}
                onClick={() => setModal({ mode: "edit", contact: c })}
                data-testid={`contact-row-${c.id}`}
                className="border-b hover:bg-slate-50 cursor-pointer"
              >
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={(e) => toggleSel(e, c.id)}
                    data-testid={`contact-select-${c.id}`}
                    className="cursor-pointer"
                  />
                </td>
                <td className="px-3 py-2 font-medium">
                  <div>{c.name}</div>
                  {(c.email || c.phone) && (
                    <div className="text-[11px] text-slate-500 truncate">
                      {[c.email, c.phone].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-right text-slate-500 tabular-nums">{c.hits ?? 0}</td>
                <td className="px-3 py-2 text-right tabular-nums text-emerald-700">
                  {(c.ytd_in ?? 0) > 0 ? fmtMoney(c.ytd_in) : ""}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-800">
                  {(c.ytd_out ?? 0) > 0 ? fmtMoney(c.ytd_out) : ""}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums font-medium ${
                  (c.net ?? 0) < 0 ? "text-rose-600" : "text-slate-900"
                }`}>
                  {(c.net ?? 0) === 0 ? "" : fmtMoney(c.net)}
                </td>
                <td className="px-3 py-2 text-slate-500 text-xs whitespace-nowrap">
                  {fmtDate(c.last_seen)}
                </td>
                <td className="px-3 py-2">
                  {c.type && (
                    <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100">{c.type}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button
                    onClick={(e) => { e.stopPropagation(); setModal({ mode: "edit", contact: c }); }}
                    data-testid={`contact-edit-${c.id}`}
                    className="text-slate-500 hover:text-slate-900 p-1"
                    title="Edit"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    onClick={(e) => del(e, c.id)}
                    data-testid={`contact-delete-${c.id}`}
                    className="text-red-500 hover:text-red-700 p-1"
                    title="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
            {!items.length && (
              <tr><td colSpan={9} className="text-center py-8 text-slate-500">No contacts.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {modal && (
        <ContactModal
          currentId={currentId}
          mode={modal.mode}
          contact={modal.contact}
          onClose={(reload) => { setModal(null); if (reload) load(); }}
        />
      )}

      {mergeOpen && (
        <MergeModal
          currentId={currentId}
          contacts={selectedContacts}
          onClose={(reload) => { setMergeOpen(false); if (reload) load(); }}
        />
      )}
    </div>
  );
}

function ContactModal({ currentId, mode, contact, onClose }) {
  const [f, setF] = useState(() =>
    mode === "edit" && contact
      ? {
          name: contact.name || "",
          type: contact.type || "customer",
          email: contact.email || "",
          phone: contact.phone || "",
          address: contact.address || "",
        }
      : { ...EMPTY_FORM }
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!f.name.trim()) return;
    setSaving(true);
    try {
      if (mode === "edit") {
        await api.patch(`/companies/${currentId}/contacts/${contact.id}`, f);
        toast.success("Contact updated");
      } else {
        await api.post(`/companies/${currentId}/contacts`, f);
        toast.success("Contact created");
      }
      onClose(true);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to save contact");
    } finally {
      setSaving(false);
    }
  };

  const title = mode === "edit" ? "Edit Contact" : "New Contact";

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-heading font-semibold">{title}</h3>
          <button onClick={() => onClose(false)} data-testid="contact-modal-close"><X size={16} /></button>
        </div>
        <input data-testid="contact-name-input" placeholder="Name" value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value })}
          className="w-full border rounded px-2 py-1.5 text-sm" />
        <select data-testid="contact-type-select" value={f.type}
          onChange={(e) => setF({ ...f, type: e.target.value })}
          className="w-full border rounded px-2 py-1.5 text-sm">
          <option value="customer">Customer</option>
          <option value="vendor">Vendor</option>
          <option value="both">Both</option>
        </select>
        <input data-testid="contact-email-input" placeholder="Email" value={f.email}
          onChange={(e) => setF({ ...f, email: e.target.value })}
          className="w-full border rounded px-2 py-1.5 text-sm" />
        <input data-testid="contact-phone-input" placeholder="Phone" value={f.phone}
          onChange={(e) => setF({ ...f, phone: e.target.value })}
          className="w-full border rounded px-2 py-1.5 text-sm" />
        <input data-testid="contact-address-input" placeholder="Address" value={f.address}
          onChange={(e) => setF({ ...f, address: e.target.value })}
          className="w-full border rounded px-2 py-1.5 text-sm" />
        <button data-testid={TID.saveBtn} onClick={save} disabled={!f.name.trim() || saving}
          className="w-full py-2 rounded-md bg-slate-900 text-white text-sm disabled:opacity-50">
          {saving ? "Saving…" : (mode === "edit" ? "Save changes" : "Create contact")}
        </button>
      </div>
    </div>
  );
}

function MergeModal({ currentId, contacts, onClose }) {
  // Default keeper = contact with the most hits (ties → first alpha).
  const defaultKeeper = useMemo(() => {
    if (!contacts.length) return null;
    return [...contacts].sort((a, b) =>
      (b.hits ?? b.txn_count ?? 0) - (a.hits ?? a.txn_count ?? 0)
      || a.name.localeCompare(b.name)
    )[0].id;
  }, [contacts]);
  const [keeperId, setKeeperId] = useState(defaultKeeper);
  const [saving, setSaving] = useState(false);

  const keeper = contacts.find(c => c.id === keeperId);
  const losers = contacts.filter(c => c.id !== keeperId);
  const totalTxns = losers.reduce((s, c) => s + (c.hits ?? c.txn_count ?? 0), 0);

  const doMerge = async () => {
    if (!keeperId || losers.length === 0) return;
    setSaving(true);
    try {
      const r = await api.post(`/companies/${currentId}/contacts/merge`, {
        keeper_id: keeperId,
        loser_ids: losers.map(c => c.id),
      });
      const re = r.data.reassigned || {};
      const totalReassigned = Object.values(re).reduce((s, n) => s + n, 0);
      toast.success(
        `Merged ${r.data.merged_contacts} contact(s) into "${r.data.keeper_name}". ` +
        `Reassigned ${totalReassigned} record(s).`
      );
      onClose(true);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Merge failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-heading font-semibold text-lg">Merge Contacts</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Pick the contact to keep. All transactions, invoices, bills, payments, and receipts from
              the others will be reassigned to it. The other contacts will be deleted.
            </p>
          </div>
          <button onClick={() => onClose(false)} data-testid="merge-modal-close"><X size={16} /></button>
        </div>

        <div className="rounded-lg border divide-y max-h-72 overflow-y-auto">
          {contacts.map(c => (
            <label
              key={c.id}
              data-testid={`merge-option-${c.id}`}
              className={`flex items-center gap-3 px-3 py-2 cursor-pointer ${
                keeperId === c.id ? "bg-emerald-50" : "hover:bg-slate-50"
              }`}
            >
              <input
                type="radio"
                name="keeper"
                checked={keeperId === c.id}
                onChange={() => setKeeperId(c.id)}
                data-testid={`merge-keeper-radio-${c.id}`}
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{c.name}</div>
                <div className="text-[11px] text-slate-500 truncate">
                  {[c.type, c.email, c.phone].filter(Boolean).join(" · ") || "—"}
                </div>
              </div>
              <div className="text-xs text-slate-500 tabular-nums whitespace-nowrap">
                {c.hits ?? c.txn_count ?? 0} txns
              </div>
              {keeperId === c.id && (
                <span className="text-[10px] uppercase font-semibold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">
                  Keep
                </span>
              )}
            </label>
          ))}
        </div>

        {keeper && (
          <div className="text-xs text-slate-600 bg-slate-50 rounded-md px-3 py-2 border">
            <b>{losers.length}</b> contact(s) will be merged into <b>{keeper.name}</b>.
            About <b>{totalTxns}</b> transaction(s) will be reassigned.
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={() => onClose(false)}
            className="px-3 py-1.5 rounded-md text-sm border border-slate-300 hover:bg-slate-50"
            data-testid="merge-cancel-btn"
          >
            Cancel
          </button>
          <button
            onClick={doMerge}
            disabled={!keeperId || losers.length === 0 || saving}
            data-testid="merge-confirm-btn"
            className="px-3 py-1.5 rounded-md text-sm bg-slate-900 text-white disabled:opacity-50"
          >
            {saving ? "Merging…" : `Merge ${losers.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}
