import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus, Trash2, X, Pencil } from "lucide-react";
import { toast } from "sonner";

const EMPTY_FORM = { name: "", type: "customer", email: "", phone: "", address: "" };

export default function Contacts() {
  const { currentId } = useCompany();
  const [items, setItems] = useState([]);
  const [modal, setModal] = useState(null); // null | { mode: "create" | "edit", contact?: obj }

  const load = async () => {
    if (!currentId) return;
    const r = await api.get(`/companies/${currentId}/contacts`);
    setItems(r.data.contacts || []);
  };
  useEffect(() => { load(); }, [currentId]);

  const del = async (e, id) => {
    e.stopPropagation();
    if (!confirm("Delete this contact?")) return;
    await api.delete(`/companies/${currentId}/contacts/${id}`);
    toast.success("Contact deleted");
    load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Contacts</h1>
          <p className="text-slate-500 text-sm mt-1">Customers &amp; vendors.</p>
        </div>
        <button
          data-testid={TID.addBtn}
          onClick={() => setModal({ mode: "create" })}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs"
        >
          <Plus size={13} /> New Contact
        </button>
      </div>

      <div className="rounded-xl border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b">
            <tr>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-left">Type</th>
              <th className="px-3 py-2 text-left">Email</th>
              <th className="px-3 py-2 text-left">Phone</th>
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
                <td className="px-3 py-2 font-medium">{c.name}</td>
                <td className="px-3 py-2">
                  {c.type && (
                    <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100">{c.type}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-500">{c.email}</td>
                <td className="px-3 py-2 text-slate-500">{c.phone}</td>
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
              <tr><td colSpan={5} className="text-center py-8 text-slate-500">No contacts.</td></tr>
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
        <input
          data-testid="contact-name-input"
          placeholder="Name"
          value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value })}
          className="w-full border rounded px-2 py-1.5 text-sm"
        />
        <select
          data-testid="contact-type-select"
          value={f.type}
          onChange={(e) => setF({ ...f, type: e.target.value })}
          className="w-full border rounded px-2 py-1.5 text-sm"
        >
          <option value="customer">Customer</option>
          <option value="vendor">Vendor</option>
          <option value="both">Both</option>
        </select>
        <input
          data-testid="contact-email-input"
          placeholder="Email"
          value={f.email}
          onChange={(e) => setF({ ...f, email: e.target.value })}
          className="w-full border rounded px-2 py-1.5 text-sm"
        />
        <input
          data-testid="contact-phone-input"
          placeholder="Phone"
          value={f.phone}
          onChange={(e) => setF({ ...f, phone: e.target.value })}
          className="w-full border rounded px-2 py-1.5 text-sm"
        />
        <input
          data-testid="contact-address-input"
          placeholder="Address"
          value={f.address}
          onChange={(e) => setF({ ...f, address: e.target.value })}
          className="w-full border rounded px-2 py-1.5 text-sm"
        />
        <button
          data-testid={TID.saveBtn}
          onClick={save}
          disabled={!f.name.trim() || saving}
          className="w-full py-2 rounded-md bg-slate-900 text-white text-sm disabled:opacity-50"
        >
          {saving ? "Saving…" : (mode === "edit" ? "Save changes" : "Create contact")}
        </button>
      </div>
    </div>
  );
}
