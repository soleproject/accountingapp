import { useEffect, useState, useMemo } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCompany } from "@/lib/company";
import { toast } from "sonner";
import {
  Briefcase, Plus, Pencil, Trash2, Loader2, X, ArrowRight, Search,
} from "lucide-react";

/**
 * "My Businesses" — a top-level CRUD screen for every company the current
 * user OWNS (i.e. company.owner_user_id === user.id). Companies the user
 * only has staff access to (via memberships/invites) are intentionally
 * excluded — those are managed by their actual owner.
 *
 * Layout keeps to the app's existing conventions: white card, left-aligned
 * table, subtle divide-y rows, small action buttons on hover. No fancy grid.
 */
const BUSINESS_TYPES = [
  "LLC", "S-Corp", "C-Corp", "Partnership", "Sole Proprietorship", "Nonprofit",
];

const REPORTING_BASES = [
  { value: "accrual", label: "Accrual" },
  { value: "cash", label: "Cash" },
];

export default function MyBusinesses() {
  const { user } = useAuth();
  const { switchCompany } = useCompany();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const load = async () => {
    try {
      const r = await api.get("/companies");
      const all = r.data?.companies || [];
      // Owner-only filter. Server returns every company the user has access
      // to (owned + shared/staff) — we scope the page to owned ones here so
      // "My Businesses" always means "businesses I own."
      const mine = all.filter(c => c.owner_user_id === user?.id);
      setRows(mine);
    } catch (e) {
      toast.error("Couldn't load your businesses.");
      setRows([]);
    }
  };

  useEffect(() => { if (user?.id) load(); }, [user?.id]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(r =>
      (r.name || "").toLowerCase().includes(needle)
      || (r.business_type || "").toLowerCase().includes(needle)
    );
  }, [rows, q]);

  return (
    <div className="p-6 max-w-6xl mx-auto" data-testid="my-businesses-page">
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 text-slate-500 text-sm mb-1">
            <Briefcase size={14} /> My Businesses
          </div>
          <h1 className="text-2xl font-heading font-bold text-slate-900">
            Businesses you own
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Manage the entities you own directly. Businesses where you're only staff/reviewer aren't shown here.
          </p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-slate-900 text-white text-sm hover:bg-slate-800"
          data-testid="my-businesses-new-btn"
        >
          <Plus size={14} /> New business
        </button>
      </div>

      <div className="relative mb-4">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search by name or type..."
          className="w-full pl-9 pr-3 py-2 rounded-md border border-slate-200 text-sm focus:outline-none focus:border-slate-400"
          data-testid="my-businesses-search"
        />
      </div>

      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        {rows === null ? (
          <div className="p-10 text-center text-slate-400 text-sm">
            <Loader2 size={16} className="inline animate-spin mr-2" /> Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-slate-500">
            {q ? (
              <>No businesses match "<b>{q}</b>"</>
            ) : (
              <>
                <Briefcase size={24} className="mx-auto text-slate-300 mb-2" />
                <div className="text-sm">You don't own any businesses yet.</div>
                <button
                  onClick={() => setCreateOpen(true)}
                  className="mt-3 text-sm text-cyan-700 hover:underline"
                  data-testid="my-businesses-empty-create"
                >
                  Create your first business →
                </button>
              </>
            )}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-left px-4 py-3 font-medium">Type</th>
                <th className="text-left px-4 py-3 font-medium">Reporting basis</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-right px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map(row => (
                <tr key={row.id} className="hover:bg-slate-50 group" data-testid={`my-business-row-${row.id}`}>
                  <td className="px-4 py-3">
                    <button
                      onClick={async () => { await switchCompany(row.id); toast.success(`Switched to ${row.name}`); }}
                      className="font-medium text-slate-900 hover:text-cyan-700 flex items-center gap-1.5"
                      data-testid={`my-business-open-${row.id}`}
                    >
                      {row.name} <ArrowRight size={12} className="opacity-0 group-hover:opacity-100 transition" />
                    </button>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{row.business_type || "—"}</td>
                  <td className="px-4 py-3 text-slate-600 capitalize">{row.reporting_basis || "accrual"}</td>
                  <td className="px-4 py-3">
                    {row.onboarding_complete
                      ? <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100">Active</span>
                      : <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-100">Onboarding</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => setEditing(row)}
                        className="p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-slate-900"
                        title="Edit"
                        data-testid={`my-business-edit-${row.id}`}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        onClick={() => setDeleting(row)}
                        className="p-1.5 rounded hover:bg-rose-50 text-slate-500 hover:text-rose-600"
                        title="Delete"
                        data-testid={`my-business-delete-${row.id}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {createOpen && (
        <BusinessFormModal
          onClose={() => setCreateOpen(false)}
          onSaved={() => { setCreateOpen(false); load(); }}
        />
      )}
      {editing && (
        <BusinessFormModal
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
      {deleting && (
        <DeleteConfirmModal
          company={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => { setDeleting(null); load(); }}
        />
      )}
    </div>
  );
}

/**
 * One modal for both Create and Edit — mode is determined by the presence
 * of `initial`. Keeping them together avoids duplicating the field list.
 */
function BusinessFormModal({ initial, onClose, onSaved }) {
  const isEdit = !!initial?.id;
  const [name, setName] = useState(initial?.name || "");
  const [type, setType] = useState(initial?.business_type || "LLC");
  const [basis, setBasis] = useState(initial?.reporting_basis || "accrual");
  const [desc, setDesc] = useState(initial?.business_description || "");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { toast.error("Name required"); return; }
    setBusy(true);
    try {
      if (isEdit) {
        await api.patch(`/companies/${initial.id}`, {
          name: name.trim(),
          business_type: type,
          reporting_basis: basis,
          business_description: desc || null,
        });
        toast.success("Business updated");
      } else {
        await api.post("/companies", {
          name: name.trim(),
          business_type: type,
          reporting_basis: basis,
          business_description: desc || null,
        });
        toast.success("Business created");
      }
      onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={e => e.stopPropagation()}
        className="bg-white rounded-lg shadow-xl w-full max-w-md"
        data-testid="my-business-form-modal"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="font-heading font-semibold text-slate-900">
            {isEdit ? "Edit business" : "New business"}
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-slate-100">
            <X size={16} className="text-slate-500" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Business name *</span>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-slate-400"
              autoFocus
              maxLength={100}
              data-testid="my-business-form-name"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Entity type</span>
            <select
              value={type}
              onChange={e => setType(e.target.value)}
              className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-slate-400 bg-white"
              data-testid="my-business-form-type"
            >
              {BUSINESS_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Reporting basis</span>
            <select
              value={basis}
              onChange={e => setBasis(e.target.value)}
              className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-slate-400 bg-white"
              data-testid="my-business-form-basis"
            >
              {REPORTING_BASES.map(b => <option key={b.value} value={b.value}>{b.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Description (optional)</span>
            <textarea
              value={desc}
              onChange={e => setDesc(e.target.value)}
              className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-slate-400 resize-none"
              rows={2}
              maxLength={300}
              placeholder="What does this business do?"
              data-testid="my-business-form-desc"
            />
          </label>
        </div>
        <div className="px-5 py-4 border-t border-slate-100 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-sm text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-slate-900 text-white text-sm hover:bg-slate-800 disabled:opacity-50"
            data-testid="my-business-form-save"
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            {isEdit ? "Save changes" : "Create business"}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Type-the-name-to-confirm deletion modal. Matches the backend requirement
 * (`?confirm=<exact name>`) so a fat-finger click can't wipe a company +
 * all its transactions/JEs/invoices in one shot.
 */
function DeleteConfirmModal({ company, onClose, onDeleted }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const matches = typed.trim() === (company?.name || "").trim();

  const del = async () => {
    if (!matches) return;
    setBusy(true);
    try {
      await api.delete(`/companies/${company.id}?confirm=${encodeURIComponent(company.name)}`);
      toast.success(`${company.name} deleted`);
      onDeleted();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Delete failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        className="bg-white rounded-lg shadow-xl w-full max-w-md"
        data-testid="my-business-delete-modal"
      >
        <div className="px-5 py-4 border-b border-slate-100">
          <div className="font-heading font-semibold text-rose-700">Delete business</div>
        </div>
        <div className="p-5 space-y-3 text-sm text-slate-700">
          <p>
            This permanently deletes <b>{company.name}</b> and every transaction, journal entry,
            invoice, bill, and connected bank account under it. This <b>cannot be undone</b>.
          </p>
          <p className="text-slate-600">
            Type <span className="font-mono font-medium bg-slate-100 px-1.5 py-0.5 rounded">{company.name}</span> below to confirm.
          </p>
          <input
            value={typed}
            onChange={e => setTyped(e.target.value)}
            placeholder={company.name}
            className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-rose-400"
            data-testid="my-business-delete-confirm-input"
            autoFocus
          />
        </div>
        <div className="px-5 py-4 border-t border-slate-100 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-sm text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            onClick={del}
            disabled={!matches || busy}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-rose-600 text-white text-sm hover:bg-rose-700 disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid="my-business-delete-confirm-btn"
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            Delete forever
          </button>
        </div>
      </div>
    </div>
  );
}
