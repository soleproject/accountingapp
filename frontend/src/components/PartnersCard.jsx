import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  Handshake, Plus, Loader2, X, Building, Users as UsersIcon,
  ExternalLink, RefreshCw, Copy,
} from "lucide-react";

/**
 * Superadmin — Partners section.
 *
 * Renders a header ("Partners") with a "New Partner" button, plus a
 * card grid of the current partners with rollup stats (clients,
 * enterprises, linked users). Clicking "New Partner" opens the
 * CreatePartnerModal.
 *
 * Mirrors the shape of the existing Enterprises card so the Superadmin
 * dashboard feels consistent — the ONLY axis differences are that
 * Partners can also have their own branding/subdomain from day 1, and
 * their auto-provisioned Partner Books is surfaced as a stat.
 */

function StatChip({ icon: Icon, label, value }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-slate-50 px-2 py-1 text-xs">
      <Icon className="h-3.5 w-3.5 text-slate-500" />
      <span className="text-slate-500">{label}</span>
      <span className="font-semibold text-slate-800">{value}</span>
    </div>
  );
}

function PartnerCard({ partner, onOpenBooks }) {
  const s = partner.stats || {};
  return (
    <div
      data-testid={`partner-card-${partner.id}`}
      className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-indigo-300 hover:shadow-md"
    >
      <div className="flex items-start gap-3">
        <div
          className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-md font-semibold text-white"
          style={{ backgroundColor: partner.primary_color || "#4f46e5" }}
        >
          {(partner.display_name || partner.name || "?").charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="truncate font-semibold text-slate-900">
              {partner.display_name || partner.name}
            </div>
            <span className="inline-flex items-center rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-indigo-700 border border-indigo-200">
              Partner
            </span>
          </div>
          <div className="truncate text-xs text-slate-500">{partner.email}</div>
          {partner.subdomain && (
            <div className="mt-1 flex items-center gap-1 text-xs text-slate-500">
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px]">
                {partner.subdomain}.accountingapp.ai
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <StatChip icon={UsersIcon} label="Clients" value={s.clients ?? 0} />
        <StatChip icon={Building} label="Enterprises" value={s.enterprises ?? 0} />
        <StatChip icon={UsersIcon} label="Users" value={s.linked_users ?? 0} />
        {s.has_partner_books && (
          <button
            onClick={() => onOpenBooks?.(s.partner_books_company_id)}
            data-testid={`partner-books-open-${partner.id}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-800 hover:bg-emerald-100"
            title="Open Partner Books"
          >
            <Building className="h-3.5 w-3.5" />
            Partner Books
            <ExternalLink className="h-3 w-3" />
          </button>
        )}
      </div>
      {partner.must_set_password && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          Awaiting password set — welcome email sent
        </div>
      )}
    </div>
  );
}

function CreatePartnerModal({ onClose, onCreated }) {
  const [form, setForm] = useState({
    name: "",
    email: "",
    display_name: "",
    subdomain: "",
    primary_color: "#4f46e5",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setErr("");
    try {
      const { data } = await api.post("/superadmin/partners", form);
      toast.success(`Partner "${data.partner.display_name}" created`);
      onCreated?.(data);
      onClose?.();
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message || "Create failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        data-testid="create-partner-modal"
        className="w-full max-w-lg rounded-xl bg-white p-6 shadow-2xl"
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">New Partner</h2>
            <p className="mt-1 text-sm text-slate-500">
              Provisions Partner Books, sends a magic-link welcome email so
              they can set their password.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-slate-700">Contact name</span>
              <input
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                data-testid="partner-form-name"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                placeholder="Alex Reseller"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-700">Contact email</span>
              <input
                required
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                data-testid="partner-form-email"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                placeholder="owner@cypherpro.ai"
              />
            </label>
          </div>
          <label className="block">
            <span className="text-xs font-medium text-slate-700">Display name (brand)</span>
            <input
              value={form.display_name}
              onChange={(e) => setForm({ ...form, display_name: e.target.value })}
              data-testid="partner-form-display-name"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              placeholder="CypherPro"
            />
            <span className="mt-1 block text-[11px] text-slate-500">
              Shown on their dashboard, invoices, and welcome emails.
            </span>
          </label>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-slate-700">Subdomain</span>
              <div className="mt-1 flex items-center rounded-md border border-slate-300 overflow-hidden">
                <input
                  value={form.subdomain}
                  onChange={(e) =>
                    setForm({ ...form, subdomain: e.target.value.replace(/[^a-z0-9-]/gi, "").toLowerCase() })
                  }
                  data-testid="partner-form-subdomain"
                  className="flex-1 px-3 py-2 text-sm"
                  placeholder="cypherpro"
                />
                <span className="px-2 py-2 bg-slate-50 text-xs text-slate-500">
                  .accountingapp.ai
                </span>
              </div>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-700">Brand color</span>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="color"
                  value={form.primary_color}
                  onChange={(e) => setForm({ ...form, primary_color: e.target.value })}
                  data-testid="partner-form-color"
                  className="h-9 w-14 cursor-pointer rounded border border-slate-300"
                />
                <input
                  value={form.primary_color}
                  onChange={(e) => setForm({ ...form, primary_color: e.target.value })}
                  className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm font-mono"
                />
              </div>
            </label>
          </div>
          {err && (
            <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
              {err}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              data-testid="partner-form-submit"
              className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Create Partner
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function PartnersCard() {
  const [partners, setPartners] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [err, setErr] = useState("");

  async function load() {
    setErr("");
    try {
      const { data } = await api.get("/superadmin/partners");
      setPartners(data.partners || []);
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message || "Failed to load");
      setPartners([]);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <section data-testid="partners-card" className="rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center gap-3 border-b border-slate-100 p-4">
        <Handshake className="h-5 w-5 text-indigo-500" />
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-slate-900">Partners</h2>
          <p className="text-xs text-slate-500">
            Resellers who provision their own enterprises + clients. See usage,
            costs, and revenue scoped only to their tree.
          </p>
        </div>
        <button
          onClick={load}
          className="rounded-md border border-slate-300 bg-white p-2 text-slate-500 hover:bg-slate-50"
          title="Refresh"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
        <button
          onClick={() => setModalOpen(true)}
          data-testid="new-partner-btn"
          className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Plus className="h-4 w-4" />
          New Partner
        </button>
      </div>
      <div className="p-4">
        {partners === null && (
          <div className="flex items-center justify-center py-8 text-slate-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        )}
        {err && (
          <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            {err}
          </div>
        )}
        {partners !== null && partners.length === 0 && !err && (
          <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 py-8 text-center">
            <div className="text-sm text-slate-600">No partners yet.</div>
            <div className="mt-1 text-xs text-slate-500">
              Click <span className="font-medium">New Partner</span> above to create
              your first reseller (e.g. CypherPro).
            </div>
          </div>
        )}
        {partners !== null && partners.length > 0 && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {partners.map((p) => (
              <PartnerCard key={p.id} partner={p} />
            ))}
          </div>
        )}
      </div>
      {modalOpen && (
        <CreatePartnerModal
          onClose={() => setModalOpen(false)}
          onCreated={() => load()}
        />
      )}
    </section>
  );
}
