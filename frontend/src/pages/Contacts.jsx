import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams, useParams, useNavigate, Link } from "react-router-dom";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus, Trash2, X, Pencil, GitMerge, ExternalLink, Tag, Sparkles, Upload, FileSpreadsheet, FileText, Loader2, Check, ArrowLeft, History, Undo2, UserCircle, Store, Search, EyeOff } from "lucide-react";
import { toast } from "sonner";
import ReclassifyPicker from "@/components/ReclassifyPicker";
import { useCreateListener, useActionListener } from "@/lib/createBus";

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
  const [sp, setSp] = useSearchParams();
  const { contactId: urlContactId } = useParams();
  const navigate = useNavigate();
  // ?type=customer|vendor filter driven by sidebar links or the on-page
  // toggle. Missing / "both" / "all" all mean "show everything".
  const urlType = sp.get("type");
  const typeFilter = urlType === "customer" || urlType === "vendor" ? urlType : "all";
  // `from` breadcrumb source — passed when the user came from Customers
  // or Vendors, so the detail page can offer a working back link.
  const fromParam = sp.get("from") || (typeFilter === "customer" ? "customers"
                                       : typeFilter === "vendor" ? "vendors" : "contacts");
  const setTypeFilter = (v) => {
    const next = new URLSearchParams(sp);
    if (v === "customer" || v === "vendor") next.set("type", v);
    else next.delete("type");
    setSp(next, { replace: true });
  };
  // Open the transaction detail as a full-page route (`/contacts/:id`)
  // instead of the previous right-side drawer. Preserves the source
  // (customers | vendors | contacts) so breadcrumbs on the detail page
  // point back to wherever the user came from.
  const openContact = (c) => {
    const source = typeFilter === "customer" ? "customers"
                  : typeFilter === "vendor" ? "vendors"
                  : "contacts";
    navigate(`/contacts/${c.id}?from=${source}`);
  };
  const [query, setQuery] = useState("");
  const [items, setItems] = useState([]);
  const [modal, setModal] = useState(null); // null | { mode, contact? }
  const [selected, setSelected] = useState(new Set());
  const [mergeOpen, setMergeOpen] = useState(false);
  const [reportContact, setReportContact] = useState(null); // { contact } drilldown
  // Import modal open/close. Kept out of the main `modal` state so it
  // can layer above (or replace) the edit modal cleanly.
  const [importOpen, setImportOpen] = useState(false);
  const [view, setView] = useState(() =>
    localStorage.getItem("contacts_view") === "details" ? "details" : "analytics"
  );
  useEffect(() => { localStorage.setItem("contacts_view", view); }, [view]);

  const load = async () => {
    if (!currentId) return;
    const r = await api.get(`/companies/${currentId}/contacts`);
    setItems(r.data.contacts || []);
    setSelected(new Set());
  };
  useEffect(() => { load(); }, [currentId]);

  // When the URL is `/contacts/:contactId`, look up the contact from the
  // loaded list and open the detail as a full-page report (breadcrumb at
  // the top links back to whichever list the user came from). Falling
  // back to a stub {id} object if the list hasn't loaded yet lets the
  // report drawer trigger its own transaction fetch immediately —
  // the visible name populates once `items` finishes loading.
  const detailContact = useMemo(() => {
    if (!urlContactId) return null;
    const found = items.find(c => c.id === urlContactId);
    return found || { id: urlContactId, name: "Loading…" };
  }, [urlContactId, items]);

  // Voice/AI-driven modal opener. When the AI panel dispatches an
  // axiom:create event with kind='contact', open the create modal with any
  // parsed prefill (name, email, phone, type) applied to a fresh form.
  useCreateListener("contact", (prefill) => {
    setModal({ mode: "create", prefill: prefill || {} });
  });
  useActionListener("close-current-modal", () => {
    setModal(null);
    setMergeOpen(false);
    setReportContact(null);
    load();
  });

  // Soft-hide a contact (industry-standard "Make Inactive" pattern).
  // Preserves referential integrity for any invoices/payments/bills
  // attached to the contact, and mirrors correctly to QBO — QBO's own
  // "Make inactive" corresponds to a sparse update with Active=false.
  const inactivate = async (e, id, name = "") => {
    e.stopPropagation();
    if (!confirm(
      `Make "${name || "this contact"}" inactive?\n\n` +
      "The contact will be hidden from lists but preserved for " +
      "history. Any linked invoices/payments/bills stay intact.\n" +
      "You can reactivate anytime from the Inactive filter.\n\n" +
      "If QBO Mirror is on, this also marks the contact inactive " +
      "in QBO (Active=false)."
    )) return;
    await api.patch(`/companies/${currentId}/contacts/${id}`,
                     { active: false });
    toast.success("Contact made inactive");
    load();
  };

  const reactivate = async (e, id) => {
    e.stopPropagation();
    await api.patch(`/companies/${currentId}/contacts/${id}`,
                     { active: true });
    toast.success("Contact reactivated");
    load();
  };

  const del = async (e, id) => {
    e.stopPropagation();
    if (!confirm(
      "Hard-delete this contact?\n\n" +
      "This removes the contact entirely and cannot be undone. Only " +
      "use for test entries with NO invoices/payments/bills attached.\n\n" +
      "For normal cleanup, click Cancel and use \"Make Inactive\" instead."
    )) return;
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

  // Search matcher applied to both cards.
  const matchesQuery = (c) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [c.name, c.email, c.phone, c.address].some(v => (v || "").toLowerCase().includes(q));
  };

  // URL-driven filter (Customers vs Vendors links in the sidebar).
  // Contacts with type="both" always appear in either view. Now also
  // filtered by the on-page search bar.
  const customerList = useMemo(
    () => items.filter(c => (c.type === "customer" || c.type === "both") && matchesQuery(c)),
    [items, query]
  );
  const vendorList = useMemo(
    () => items.filter(c => (c.type === "vendor" || c.type === "both") && matchesQuery(c)),
    [items, query]
  );
  const visible = typeFilter === "customer" ? customerList
    : typeFilter === "vendor" ? vendorList
    : items.filter(matchesQuery);

  const pageTitle = typeFilter === "customer"
    ? "Customers"
    : typeFilter === "vendor" ? "Vendors" : "Contacts";
  const pageSubtitle = typeFilter === "customer"
    ? "People and companies you sell to."
    : typeFilter === "vendor" ? "Suppliers you buy from." : "Every contact — customers, vendors, and un-tagged.";

  // Renders a contacts table for the given row set. Extracted so we can
  // stack Customers + Vendors on the same page without duplicating markup.
  const renderContactsTable = (rows, { emptyMsg = "No contacts." } = {}) => (
    <table className="w-full text-sm">
      <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500 border-b">
        {view === "analytics" ? (
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
        ) : (
          <tr>
            <th className="w-8 px-3 py-2"></th>
            <th className="px-3 py-2 text-left">Name</th>
            <th className="px-3 py-2 text-left">Type</th>
            <th className="px-3 py-2 text-left">Email</th>
            <th className="px-3 py-2 text-left">Phone</th>
            <th className="px-3 py-2 text-left">Address</th>
            <th></th>
          </tr>
        )}
      </thead>
      <tbody>
        {rows.map(c => (
          <tr
            key={c.id}
            onClick={() => view === "analytics"
              ? openContact(c)
              : setModal({ mode: "edit", contact: c })}
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
            {view === "analytics" ? (
              <>
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
              </>
            ) : (
              <>
                <td className="px-3 py-2 font-medium">{c.name}</td>
                <td className="px-3 py-2">
                  {c.type && (
                    <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100">{c.type}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-600">{c.email || ""}</td>
                <td className="px-3 py-2 text-slate-600">{c.phone || ""}</td>
                <td className="px-3 py-2 text-slate-600 truncate max-w-[280px]" title={c.address || ""}>
                  {c.address || ""}
                </td>
              </>
            )}
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
                onClick={(e) => c.active === false
                  ? reactivate(e, c.id)
                  : inactivate(e, c.id, c.name)}
                data-testid={`contact-inactivate-${c.id}`}
                className={c.active === false
                  ? "text-emerald-600 hover:text-emerald-800 p-1"
                  : "text-amber-600 hover:text-amber-800 p-1"}
                title={c.active === false ? "Reactivate" : "Make inactive"}
              >
                {c.active === false ? <Check size={13} /> : <EyeOff size={13} />}
              </button>
              <button
                onClick={(e) => del(e, c.id)}
                data-testid={`contact-delete-${c.id}`}
                className="text-red-500 hover:text-red-700 p-1"
                title="Hard delete (rare — use Make Inactive instead)"
              >
                <Trash2 size={13} />
              </button>
            </td>
          </tr>
        ))}
        {rows.length === 0 && (
          <tr><td colSpan={view === "analytics" ? 9 : 7} className="text-center py-8 text-slate-500">{emptyMsg}</td></tr>
        )}
      </tbody>
    </table>
  );

  // ─── Detail (full-page) — /contacts/:contactId ─────────────────────
  // When the URL carries a contactId we short-circuit the list view and
  // render the transaction report drawer as a page instead. Breadcrumbs
  // at the top of the page link back to the source (Customers/Vendors/
  // Contacts) the user came from.
  if (detailContact) {
    const backLabel = fromParam === "customers" ? "Customers"
                    : fromParam === "vendors" ? "Vendors"
                    : "Contacts";
    const backHref = fromParam === "customers" ? "/contacts?type=customer"
                    : fromParam === "vendors" ? "/contacts?type=vendor"
                    : "/contacts";
    return (
      <div className="space-y-4">
        <nav aria-label="Breadcrumb" className="text-sm text-slate-500 flex items-center gap-2"
             data-testid="contact-detail-breadcrumb">
          <Link to={backHref} className="hover:text-slate-900 hover:underline"
                data-testid="contact-detail-back-link">← {backLabel}</Link>
          <span aria-hidden="true">/</span>
          <span className="text-slate-900 font-medium truncate max-w-[40ch]">
            {detailContact.name || detailContact.id}
          </span>
        </nav>
        <ContactReportDrawer
          currentId={currentId}
          contact={detailContact}
          embedded={true}
          onClose={() => navigate(backHref)}
          onEdit={() => setModal({ mode: "edit", contact: detailContact })}
        />
        {modal?.mode === "edit" && (
          <ContactModal
            currentId={currentId}
            mode="edit"
            contact={modal.contact}
            onClose={(reload) => { setModal(null); if (reload) load(); }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">{pageTitle}</h1>
          <p className="text-slate-500 text-sm mt-1">{pageSubtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <div
            className="inline-flex rounded-md border border-slate-300 overflow-hidden text-xs"
            data-testid="contacts-view-toggle"
          >
            <button
              onClick={() => setView("analytics")}
              data-testid="contacts-view-analytics"
              className={`px-3 py-1.5 ${view === "analytics"
                ? "bg-slate-900 text-white"
                : "bg-white text-slate-700 hover:bg-slate-50"}`}
            >
              Analytics
            </button>
            <button
              onClick={() => setView("details")}
              data-testid="contacts-view-details"
              className={`px-3 py-1.5 border-l border-slate-300 ${view === "details"
                ? "bg-slate-900 text-white"
                : "bg-white text-slate-700 hover:bg-slate-50"}`}
            >
              Details
            </button>
          </div>
          {selected.size >= 1 && (
            <>
              <div
                className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-slate-900 text-white"
                data-testid="contacts-bulk-toolbar"
              >
                <b>{selected.size}</b> selected
              </div>
              <button
                onClick={async () => {
                  try {
                    const r = await api.post(
                      `/companies/${currentId}/contacts/bulk-set-type`,
                      { ids: [...selected], type: "customer" },
                    );
                    toast.success(`Set ${r.data?.modified || 0} to Customer.`);
                    load();
                  } catch (e) {
                    toast.error(e.response?.data?.detail || "Bulk update failed");
                  }
                }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-emerald-300 bg-emerald-50 text-emerald-800 text-[11px] hover:bg-emerald-100"
                data-testid="contacts-bulk-customer"
                title="Set every selected contact's type to Customer"
              >
                <UserCircle size={12} /> → Customer
              </button>
              <button
                onClick={async () => {
                  try {
                    const r = await api.post(
                      `/companies/${currentId}/contacts/bulk-set-type`,
                      { ids: [...selected], type: "vendor" },
                    );
                    toast.success(`Set ${r.data?.modified || 0} to Vendor.`);
                    load();
                  } catch (e) {
                    toast.error(e.response?.data?.detail || "Bulk update failed");
                  }
                }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-amber-300 bg-amber-50 text-amber-800 text-[11px] hover:bg-amber-100"
                data-testid="contacts-bulk-vendor"
                title="Set every selected contact's type to Vendor"
              >
                <Store size={12} /> → Vendor
              </button>
            </>
          )}
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
            onClick={async () => {
              try {
                const r = await api.post(`/companies/${currentId}/contacts/reclassify`);
                const s = r.data || {};
                toast.success(
                  `Auto-classified ${s.updated} contacts — ` +
                  `${s.customer} customer${s.customer === 1 ? "" : "s"}, ` +
                  `${s.vendor} vendor${s.vendor === 1 ? "" : "s"}, ` +
                  `${s.both} both`
                );
                await load();
              } catch (err) {
                toast.error(err.response?.data?.detail || "Auto-classify failed");
              }
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-emerald-300 bg-emerald-50 text-emerald-800 text-xs hover:bg-emerald-100"
            data-testid="contacts-auto-classify-btn"
            title="Detect customer/vendor/both from transaction direction. Manual tags are preserved."
          >
            <Sparkles size={13} /> Auto-classify
          </button>
          <button
            onClick={() => setImportOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-indigo-300 bg-indigo-50 text-indigo-800 text-xs hover:bg-indigo-100"
            data-testid="contacts-import-btn"
          >
            <Upload size={13} /> Import
          </button>
          <button
            data-testid={TID.addBtn}
            onClick={() => setModal({ mode: "create" })}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs"
          >
            <Plus size={13} /> New Contact
          </button>
        </div>
      </div>

      {/* Type toggle + fuzzy search — filters BOTH cards in unison. */}
      <div className="flex items-center gap-3 flex-wrap" data-testid="contacts-page-toolbar">
        <div
          className="inline-flex rounded-md border border-slate-300 overflow-hidden text-xs bg-white"
          data-testid="contacts-type-toggle"
        >
          <button
            onClick={() => setTypeFilter("all")}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 ${typeFilter === "all" ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-50"}`}
            data-testid="contacts-type-all"
            title="Every contact — includes ones not tagged as customer or vendor"
          >All</button>
          <button
            onClick={() => setTypeFilter("customer")}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 border-l border-slate-300 ${typeFilter === "customer" ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-50"}`}
            data-testid="contacts-type-customer"
          ><UserCircle size={12} /> Customers</button>
          <button
            onClick={() => setTypeFilter("vendor")}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 border-l border-slate-300 ${typeFilter === "vendor" ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-50"}`}
            data-testid="contacts-type-vendor"
          ><Store size={12} /> Vendors</button>
        </div>
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search customers and vendors by name, email, phone…"
            className="w-full pl-8 pr-8 py-1.5 rounded-md border border-slate-300 text-xs focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
            data-testid="contacts-search"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              data-testid="contacts-search-clear"
              title="Clear search"
            ><X size={12} /></button>
          )}
        </div>
        {query && (
          <span className="text-[11px] text-slate-500" data-testid="contacts-search-count">
            {typeFilter === "all"
              ? items.filter(matchesQuery).length
              : customerList.length + vendorList.length} match{(typeFilter === "all" ? items.filter(matchesQuery).length : customerList.length + vendorList.length) === 1 ? "" : "es"}
          </span>
        )}
      </div>

      {/* "All" tab — one flat table listing EVERY contact, including
          ones that don't yet have a customer/vendor classification.
          This is essential after a Plaid connect: bank txns produce
          contacts with `type: null` (bare merchant names) that would
          otherwise be invisible on Customers/Vendors/Both. Feb 28 2026. */}
      {typeFilter === "all" && (
        <div className="rounded-xl border bg-white overflow-hidden" data-testid="contacts-all-card">
          <div className="px-4 py-3 border-b bg-slate-50/60">
            <div className="font-heading font-semibold text-slate-800 text-sm">All contacts</div>
            <div className="text-[11px] text-slate-500">
              Every contact on file · {items.filter(matchesQuery).length} contact{items.filter(matchesQuery).length === 1 ? "" : "s"}
              <span className="ml-2 text-slate-400">
                ({customerList.length} customer{customerList.length === 1 ? "" : "s"},{" "}
                {vendorList.length} vendor{vendorList.length === 1 ? "" : "s"},{" "}
                {items.filter(c => !c.type || (c.type !== "customer" && c.type !== "vendor" && c.type !== "both")).filter(matchesQuery).length} untagged)
              </span>
            </div>
          </div>
          {renderContactsTable(items.filter(matchesQuery), { emptyMsg: query ? "No matching contacts." : "No contacts yet." })}
        </div>
      )}

      {typeFilter === "customer" && (
        <div className="rounded-xl border bg-white overflow-hidden" data-testid="contacts-customers-card">
          <div className="px-4 py-3 border-b bg-slate-50/60">
            <div className="font-heading font-semibold text-slate-800 text-sm">Customers</div>
            <div className="text-[11px] text-slate-500">People and companies you sell to · {customerList.length} contact{customerList.length === 1 ? "" : "s"}</div>
          </div>
          {renderContactsTable(customerList, { emptyMsg: query ? "No matching customers." : "No customers yet." })}
        </div>
      )}

      {typeFilter === "vendor" && (
        <div className="rounded-xl border bg-white overflow-hidden" data-testid="contacts-vendors-card">
          <div className="px-4 py-3 border-b bg-slate-50/60 flex items-center justify-between">
            <div>
              <div className="font-heading font-semibold text-slate-800 text-sm">Vendors</div>
              <div className="text-[11px] text-slate-500">Suppliers you buy from · {vendorList.length} contact{vendorList.length === 1 ? "" : "s"}</div>
            </div>
          </div>
          {renderContactsTable(vendorList, { emptyMsg: query ? "No matching vendors." : "No vendors yet." })}
        </div>
      )}

      {modal && (
        <ContactModal
          currentId={currentId}
          mode={modal.mode}
          contact={modal.contact}
          prefill={modal.prefill}
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

      {reportContact && (
        <ContactReportDrawer
          currentId={currentId}
          contact={reportContact}
          onClose={() => setReportContact(null)}
          onEdit={() => { const c = reportContact; setReportContact(null); setModal({ mode: "edit", contact: c }); }}
        />
      )}
      {importOpen && (
        <ImportContactsModal
          currentId={currentId}
          initialDefaultType={typeFilter === "vendor" ? "vendor" : "customer"}
          onClose={(reload) => { setImportOpen(false); if (reload) load(); }}
        />
      )}
    </div>
  );
}

function ContactModal({ currentId, mode, contact, prefill, onClose }) {
  const [f, setF] = useState(() =>
    mode === "edit" && contact
      ? {
          name: contact.name || "",
          type: contact.type || "customer",
          email: contact.email || "",
          phone: contact.phone || "",
          address: contact.address || "",
        }
      : {
          ...EMPTY_FORM,
          ...(prefill && {
            name: prefill.name || EMPTY_FORM.name,
            type: prefill.type || EMPTY_FORM.type,
            email: prefill.email || EMPTY_FORM.email,
            phone: prefill.phone || EMPTY_FORM.phone,
            address: prefill.address || EMPTY_FORM.address,
          }),
        }
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


function ContactReportDrawer({ currentId, contact, onClose, onEdit, embedded = false }) {
  const [txns, setTxns] = useState(null);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState("ytd"); // "ytd" | "all"
  const [loading, setLoading] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [reclassOpen, setReclassOpen] = useState(false);
  const [ruleSuggestion, setRuleSuggestion] = useState(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ contact_id: contact.id, limit: "1000" });
        if (filter === "ytd") {
          params.set("date_from", `${new Date().getFullYear()}-01-01`);
        }
        const r = await api.get(`/companies/${currentId}/transactions?${params.toString()}`);
        if (cancelled) return;
        setTxns(r.data.transactions || []);
        setTotal(r.data.pagination?.total ?? (r.data.transactions?.length ?? 0));
        setSelected(new Set());
      } catch (err) {
        if (!cancelled) toast.error("Failed to load transactions");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [currentId, contact.id, filter, reload]);

  // Load CoA once for the reclassify picker.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get(`/companies/${currentId}/accounts`);
        if (!cancelled) setAccounts(r.data.accounts || []);
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [currentId]);

  const totals = useMemo(() => {
    const rows = txns || [];
    let inc = 0, out = 0;
    for (const t of rows) {
      const amt = Number(t.amount) || 0;
      if (amt > 0) inc += amt; else out += -amt;
    }
    return { inc, out, net: inc - out, count: rows.length };
  }, [txns]);

  const toggleSel = (id) => setSelected(prev => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const toggleAll = () => {
    if (!txns) return;
    if (selected.size === txns.length) setSelected(new Set());
    else setSelected(new Set(txns.map(t => t.id)));
  };

  const applyReclassify = async (categoryAccountId) => {
    try {
      const r = await api.post(`/companies/${currentId}/transactions/bulk-reclassify`, {
        transaction_ids: [...selected],
        category_account_id: categoryAccountId,
      });
      const acct = accounts.find(a => a.id === categoryAccountId);
      toast.success(
        `Reclassified ${r.data.updated} txn(s) → ${acct?.name || "category"}`
        + (r.data.skipped_closed?.length
            ? `. Skipped ${r.data.skipped_closed.length} (closed period).`
            : "")
      );
      setReclassOpen(false);
      if (r.data.rule_suggestion) setRuleSuggestion(r.data.rule_suggestion);
      setReload(v => v + 1);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Reclassify failed");
    }
  };

  const acceptRule = async () => {
    if (!ruleSuggestion) return;
    try {
      const r = await api.post(`/companies/${currentId}/rules`, {
        match_type: "merchant_contains",
        match_value: ruleSuggestion.merchant,
        account_code: ruleSuggestion.account_code,
        apply_to_existing: true,
      });
      toast.success(
        `Rule created: "${ruleSuggestion.merchant}" → ${ruleSuggestion.account_name}`
        + (r.data.applied ? ` (applied to ${r.data.applied} existing txns)` : "")
      );
      setRuleSuggestion(null);
      setReload(v => v + 1);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to create rule");
    }
  };

  return (
    <div
      className={embedded
        ? "flex flex-col rounded-lg border border-slate-200 bg-white shadow-sm"
        : "fixed inset-0 z-50 flex"}
      data-testid="contact-report-drawer"
    >
      {!embedded && <div className="flex-1 bg-black/40" onClick={onClose} />}
      <div className={embedded
        ? "w-full flex flex-col"
        : "w-full max-w-3xl h-full bg-white shadow-2xl flex flex-col"}>
        {/* Header */}
        <div className="px-5 py-4 border-b flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-heading font-semibold text-xl truncate">{contact.name}</h3>
              {contact.type && (
                <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100">{contact.type}</span>
              )}
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Transaction report — {filter === "ytd" ? new Date().getFullYear() : "all time"}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={onEdit}
              data-testid="report-edit-contact"
              className="px-2 py-1 text-xs rounded-md border border-slate-300 hover:bg-slate-50 inline-flex items-center gap-1"
              title="Edit contact"
            >
              <Pencil size={12} /> Edit
            </button>
            <button
              onClick={onClose}
              data-testid="report-close"
              className="p-1 hover:bg-slate-100 rounded"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Summary + filter */}
        <div className="px-5 py-3 border-b bg-slate-50/50 flex items-center gap-4">
          <div className="inline-flex rounded-md border border-slate-300 overflow-hidden text-xs">
            <button
              onClick={() => setFilter("ytd")}
              data-testid="report-filter-ytd"
              className={`px-2.5 py-1 ${filter === "ytd" ? "bg-slate-900 text-white" : "bg-white hover:bg-slate-50"}`}
            >YTD</button>
            <button
              onClick={() => setFilter("all")}
              data-testid="report-filter-all"
              className={`px-2.5 py-1 border-l border-slate-300 ${filter === "all" ? "bg-slate-900 text-white" : "bg-white hover:bg-slate-50"}`}
            >All time</button>
          </div>
          <div className="flex-1 grid grid-cols-4 gap-2 text-center">
            <SumTile label="Txns" value={totals.count} />
            <SumTile label="In" value={fmtMoney(totals.inc)} tone="in" />
            <SumTile label="Out" value={fmtMoney(totals.out)} tone="out" />
            <SumTile label="Net" value={fmtMoney(totals.net)} tone={totals.net < 0 ? "neg" : "pos"} />
          </div>
        </div>

        {/* Rule suggestion banner */}
        {ruleSuggestion && (
          <div
            className="px-5 py-2.5 bg-amber-50 border-b border-amber-200 flex items-center gap-3"
            data-testid="rule-suggestion-banner"
          >
            <Sparkles size={16} className="text-amber-700 flex-shrink-0" />
            <div className="flex-1 text-xs text-amber-900">
              You've reclassified <b>{ruleSuggestion.merchant}</b> to{" "}
              <b>{ruleSuggestion.account_name}</b> {ruleSuggestion.approvals} times.
              <br/>Turn this into an automatic rule?
            </div>
            <button
              onClick={acceptRule}
              data-testid="rule-suggestion-accept"
              className="px-2.5 py-1 text-xs rounded-md bg-amber-700 text-white hover:bg-amber-800"
            >
              Create rule
            </button>
            <button
              onClick={() => setRuleSuggestion(null)}
              data-testid="rule-suggestion-dismiss"
              className="px-2.5 py-1 text-xs rounded-md hover:bg-amber-100 text-amber-900"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Bulk-select toolbar */}
        {selected.size > 0 && (
          <div className="px-5 py-2 bg-slate-900 text-white flex items-center gap-3" data-testid="report-bulk-toolbar">
            <span className="text-xs">
              <b>{selected.size}</b> selected
            </span>
            <button
              onClick={() => setReclassOpen(true)}
              data-testid="report-reclassify-btn"
              className="ml-auto inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-white text-slate-900 text-xs hover:bg-slate-100"
            >
              <Tag size={12} /> Reclassify
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs px-2 py-1 hover:bg-slate-800 rounded"
              data-testid="report-clear-selection"
            >
              Clear
            </button>
          </div>
        )}

        {/* Table */}
        <div className="flex-1 overflow-y-auto">
          {loading && !txns ? (
            <div className="py-16 text-center text-sm text-slate-500">Loading…</div>
          ) : !txns || txns.length === 0 ? (
            <div className="py-16 text-center text-sm text-slate-500">
              No transactions found for this contact{filter === "ytd" ? " this year" : ""}.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500 border-b sticky top-0">
                <tr>
                  <th className="w-8 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={txns.length > 0 && selected.size === txns.length}
                      onChange={toggleAll}
                      data-testid="report-select-all"
                    />
                  </th>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Description</th>
                  <th className="px-3 py-2 text-left">Category</th>
                  <th className="px-3 py-2 text-left">Bank</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2 text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {txns.map(t => {
                  const amt = Number(t.amount) || 0;
                  return (
                    <tr
                      key={t.id}
                      className={`border-b hover:bg-slate-50 ${selected.has(t.id) ? "bg-slate-50" : ""}`}
                      data-testid={`report-txn-${t.id}`}
                    >
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selected.has(t.id)}
                          onChange={() => toggleSel(t.id)}
                          data-testid={`report-txn-select-${t.id}`}
                        />
                      </td>
                      <td className="px-3 py-2 text-slate-600 tabular-nums whitespace-nowrap">{t.date}</td>
                      <td className="px-3 py-2 max-w-[220px] truncate" title={t.description}>{t.description}</td>
                      <td className="px-3 py-2 text-slate-600 text-xs">
                        {t.category_account_code ? `${t.category_account_code} · ${t.category_account_name || ""}` : "—"}
                      </td>
                      <td className="px-3 py-2 text-slate-500 text-xs truncate max-w-[140px]" title={t.bank_account_name}>
                        {t.bank_account_name || "—"}
                      </td>
                      <td className={`px-3 py-2 text-right font-medium tabular-nums whitespace-nowrap ${
                        amt < 0 ? "text-slate-800" : "text-emerald-700"
                      }`}>
                        {fmtMoney(amt)}
                      </td>
                      <td className="px-3 py-2">
                        {t.needs_review ? (
                          <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">Review</span>
                        ) : t.posted ? (
                          <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">Posted</span>
                        ) : (
                          <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t bg-slate-50/50 flex items-center justify-between text-xs text-slate-500">
          <div>
            Showing <b>{txns?.length ?? 0}</b> of <b>{total}</b> transactions
            {total > (txns?.length ?? 0) && " (first 1,000)"}
          </div>
          <a
            href={`/transactions?contact_id=${contact.id}`}
            className="inline-flex items-center gap-1 text-slate-700 hover:text-slate-900"
            data-testid="report-open-full"
          >
            Open in Transactions <ExternalLink size={11} />
          </a>
        </div>
      </div>

      {reclassOpen && (
        <ReclassifyPicker
          accounts={accounts}
          count={selected.size}
          onCancel={() => setReclassOpen(false)}
          onApply={applyReclassify}
        />
      )}
    </div>
  );
}

function SumTile({ label, value, tone }) {
  const toneCls = tone === "in" ? "text-emerald-700"
    : tone === "out" ? "text-slate-800"
    : tone === "neg" ? "text-rose-600"
    : tone === "pos" ? "text-emerald-700"
    : "text-slate-900";
  return (
    <div className="px-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${toneCls}`}>{value}</div>
    </div>
  );
}


/**
 * ImportContactsModal — two-step upload flow for customer/vendor lists.
 *
 * Step 1 (upload): pick an .xlsx / .csv / .pdf, choose a default type
 *   (customer vs vendor) for rows that don't specify one, POST to
 *   ``/contacts/import/preview``.
 * Step 2 (review): show the parsed rows in an editable table with
 *   per-row "will create" / "will update" pills, let the CPA tweak
 *   type/email/etc. or uncheck rows they don't want, then POST to
 *   ``/contacts/import/commit``.
 */
function ImportContactsModal({ currentId, onClose, initialDefaultType = "customer" }) {
  const [step, setStep] = useState("upload"); // upload | review | done
  const [busy, setBusy] = useState(false);
  const [defaultType, setDefaultType] = useState(initialDefaultType);
  const [preview, setPreview] = useState(null); // {source, filename, contacts[], raw_rows, detected_headers, auto_mapping, known_fields}
  const [mapping, setMapping] = useState({});   // {colIndex: canonical | ""}
  const [rows, setRows] = useState([]);         // editable copy of preview.contacts
  const [selected, setSelected] = useState(new Set());
  const [result, setResult] = useState(null);   // {created, updated, skipped, batch_id}
  const [batches, setBatches] = useState([]);   // recent import history
  const [historyOpen, setHistoryOpen] = useState(false);
  const inputRef = React.useRef(null);

  const loadHistory = async () => {
    try {
      const r = await api.get(`/companies/${currentId}/contacts/imports?limit=10`);
      setBatches(r.data?.batches || []);
    } catch { /* history is advisory */ }
  };
  useEffect(() => { loadHistory(); }, [currentId]);

  const upload = async (file, opts = {}) => {
    if (!file) return;
    const useAi = !!opts.ai;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("default_type", defaultType);
      if (useAi) fd.append("ai", "true");
      const r = await api.post(
        `/companies/${currentId}/contacts/import/preview`,
        fd,
        { headers: { "Content-Type": "multipart/form-data" } },
      );
      const d = r.data;
      setPreview(d);
      setMapping(d.auto_mapping || {});
      setRows(d.contacts || []);
      setSelected(new Set((d.contacts || []).map((_, i) => i)));
      setStep("review");
      if (useAi) toast.success(`AI parsed ${d.contacts?.length || 0} contact${d.contacts?.length === 1 ? "" : "s"} from the PDF.`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't parse the file");
    } finally { setBusy(false); }
  };

  // Keep a ref to the last-uploaded file so the "Try AI parsing"
  // button on the review step doesn't force the user to re-drag it.
  const lastFileRef = React.useRef(null);
  const uploadWithFile = (f, opts) => { lastFileRef.current = f; return upload(f, opts); };

  // Re-resolve rows client-side when the CPA changes a column mapping.
  // Uses the /remap endpoint so we keep the same dedup + existing-flag
  // logic the initial preview ran — no need to duplicate it here.
  const remap = async (nextMapping) => {
    if (!preview) return;
    setMapping(nextMapping);
    setBusy(true);
    try {
      const r = await api.post(`/companies/${currentId}/contacts/import/remap`, {
        headers: preview.detected_headers,
        raw_rows: preview.raw_rows,
        mapping: nextMapping,
        default_type: defaultType,
      });
      setRows(r.data?.contacts || []);
      setSelected(new Set((r.data?.contacts || []).map((_, i) => i)));
    } catch (e) {
      toast.error(e.response?.data?.detail || "Remap failed");
    } finally { setBusy(false); }
  };

  const toggleRow = (i) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected(prev =>
      prev.size === rows.length ? new Set() : new Set(rows.map((_, i) => i))
    );
  };

  const editRow = (i, field, value) => {
    setRows(rs => rs.map((r, idx) => idx === i ? { ...r, [field]: value } : r));
  };

  const commit = async () => {
    const payload = rows.filter((_, i) => selected.has(i));
    if (!payload.length) { toast.error("Nothing selected to import."); return; }
    setBusy(true);
    try {
      const r = await api.post(
        `/companies/${currentId}/contacts/import/commit`,
        {
          contacts: payload,
          filename: preview?.filename,
          source: preview?.source,
        },
      );
      setResult(r.data);
      setStep("done");
      loadHistory();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Import failed");
    } finally { setBusy(false); }
  };

  const undoBatch = async (batchId) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm("Undo this import? Every contact it created will be deleted and every contact it updated will be restored to its previous state.")) return;
    try {
      const r = await api.post(`/companies/${currentId}/contacts/imports/${batchId}/undo`);
      toast.success(`Undo complete — deleted ${r.data?.deleted || 0}, restored ${r.data?.restored || 0}.`);
      loadHistory();
      // Signal the parent to reload the contacts table.
      onClose(true);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Undo failed");
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col" data-testid="contacts-import-modal">
        {/* ---------- Header ---------- */}
        <div className="px-5 py-3 border-b flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-indigo-100 flex items-center justify-center shrink-0">
            <Upload size={16} className="text-indigo-700" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-heading font-semibold">Import contacts</h3>
            <p className="text-xs text-slate-500">
              Bulk-add customers &amp; vendors from an Excel, CSV, or PDF list.
            </p>
          </div>
          <button onClick={() => onClose(false)} className="p-1 rounded hover:bg-slate-100" data-testid="import-close">
            <X size={16} />
          </button>
        </div>

        {/* ---------- Step: Upload ---------- */}
        {step === "upload" && (
          <div className="p-5 space-y-4">
            <DropZone busy={busy} onFile={(f) => uploadWithFile(f)} inputRef={inputRef} />
            <div className="flex items-center gap-3">
              <label className="text-xs text-slate-600">
                Default type when the file doesn't specify:
              </label>
              <select
                value={defaultType}
                onChange={(e) => setDefaultType(e.target.value)}
                className="border rounded px-2 py-1 text-sm bg-white"
                data-testid="import-default-type"
              >
                <option value="customer">Customer</option>
                <option value="vendor">Vendor</option>
              </select>
            </div>
            <div className="text-[11px] text-slate-500 bg-slate-50 border rounded p-3">
              <b>Column names we recognize:</b> Name, Contact, Customer Name,
              Vendor Name, Supplier Name, Company · Email, E-mail · Phone,
              Mobile, Cell · Address, Street · Type, Kind. Anything else stays
              as-is. PDFs with a proper Type/Name/Email/Phone/Address column
              header row are parsed cell-by-cell; unstructured PDFs are scanned
              line-by-line for names, emails, and phone numbers.
            </div>

            {/* Import history — collapsed by default. Renders per-batch
                row counts + an Undo button. Undoing deletes every
                contact the batch created and restores every contact it
                overwrote to the previous snapshot. */}
            {batches.length > 0 && (
              <div className="rounded-lg border bg-white">
                <button
                  onClick={() => setHistoryOpen(o => !o)}
                  className="w-full px-4 py-2 flex items-center gap-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  data-testid="import-history-toggle"
                >
                  <History size={13} className="text-slate-500" />
                  Import history ({batches.length})
                  <span className="ml-auto text-slate-400">{historyOpen ? "▼" : "▶"}</span>
                </button>
                {historyOpen && (
                  <ul className="divide-y">
                    {batches.map((b) => (
                      <li key={b.id} className="px-4 py-2.5 flex items-center gap-3 text-xs">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate text-slate-800">
                            {b.filename}
                            <span className="text-[10px] ml-2 text-slate-400 uppercase">{b.source}</span>
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {new Date(b.at).toLocaleString()} · {b.user_name} ·
                            {" "}created <b>{b.created_count}</b>, updated <b>{b.updated_count}</b>
                            {b.skipped_count ? <>, skipped <b>{b.skipped_count}</b></> : ""}
                          </div>
                        </div>
                        {b.undone ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 border border-slate-200 uppercase tracking-wide">
                            Undone
                          </span>
                        ) : (
                          <button
                            onClick={() => undoBatch(b.id)}
                            className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-rose-200 text-rose-700 hover:bg-rose-50"
                            data-testid={`import-undo-${b.id}`}
                            title="Delete created + restore updated"
                          >
                            <Undo2 size={11} /> Undo
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        {/* ---------- Step: Review ---------- */}
        {step === "review" && preview && (
          <>
            <div className="px-5 py-2 border-b bg-slate-50/40 flex items-center gap-3 text-xs">
              <span className="text-slate-700">
                <b>{preview.filename}</b> ·{" "}
                {rows.length} contact{rows.length !== 1 ? "s" : ""} parsed
                {preview.row_count_raw !== rows.length && (
                  <span className="text-slate-500"> ({preview.row_count_raw - rows.length} deduped/skipped)</span>
                )}
                {preview.source === "pdf-ai" && (
                  <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-fuchsia-50 text-fuchsia-700 border border-fuchsia-200 uppercase tracking-wide">
                    AI parsed
                  </span>
                )}
              </span>
              {preview.source === "pdf" && lastFileRef.current && (
                <button
                  onClick={() => uploadWithFile(lastFileRef.current, { ai: true })}
                  disabled={busy}
                  className="text-fuchsia-700 hover:bg-fuchsia-50 border border-fuchsia-200 rounded px-2 py-1 text-[11px] inline-flex items-center gap-1 disabled:opacity-50"
                  data-testid="import-try-ai"
                  title="Re-parse this PDF with GPT-5.2 — useful for messy multi-column layouts"
                >
                  {busy ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                  Try AI parsing
                </button>
              )}
              <button
                onClick={() => { setStep("upload"); setPreview(null); setRows([]); }}
                className="ml-auto text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
              >
                <ArrowLeft size={12} /> Choose different file
              </button>
            </div>

            {/* Column mapping bar — one control per detected column so the
                CPA can override the auto-detection (or map a column the
                auto-detector missed). Setting a column to "Skip" removes
                it from the parse. */}
            {preview.detected_headers?.length > 0 && (
              <div className="px-5 py-3 border-b bg-white">
                <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-2">
                  Column mapping · edit if any field auto-detected wrong
                </div>
                <div className="flex flex-wrap gap-2">
                  {preview.detected_headers.map((h, colIdx) => {
                    const current = mapping[String(colIdx)] || "";
                    const known = preview.known_fields || ["name", "email", "phone", "address", "type"];
                    // Options: the current selection, "Skip", plus any
                    // field not already claimed by another column.
                    const claimed = new Set(
                      Object.entries(mapping)
                        .filter(([k]) => Number(k) !== colIdx)
                        .map(([, v]) => v)
                        .filter(Boolean)
                    );
                    return (
                      <div key={colIdx} className="flex flex-col gap-0.5">
                        <div className="text-[10px] text-slate-500 uppercase tracking-wide truncate max-w-[140px]" title={h}>
                          {h || `Column ${colIdx + 1}`}
                        </div>
                        <select
                          value={current}
                          onChange={(e) => {
                            const next = { ...mapping };
                            // "" = skip; keep the key in place for clarity.
                            next[String(colIdx)] = e.target.value;
                            remap(next);
                          }}
                          className={`border rounded px-2 py-1 text-xs bg-white ${current ? "" : "text-slate-400"}`}
                          data-testid={`import-map-col-${colIdx}`}
                        >
                          <option value="">— Skip —</option>
                          {known.map(f => (
                            <option
                              key={f}
                              value={f}
                              disabled={claimed.has(f) && current !== f}
                            >
                              {f.charAt(0).toUpperCase() + f.slice(1)}
                              {claimed.has(f) && current !== f ? " (used)" : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex-1 overflow-auto">
              {!rows.length ? (
                <div className="p-8 text-center text-slate-500 text-sm">
                  No contacts were extracted from this file.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500 border-b sticky top-0">
                    <tr>
                      <th className="w-8 px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selected.size === rows.length && rows.length > 0}
                          onChange={toggleAll}
                          data-testid="import-select-all"
                        />
                      </th>
                      <th className="px-3 py-2 text-left">Name</th>
                      <th className="px-3 py-2 text-left">Email</th>
                      <th className="px-3 py-2 text-left">Phone</th>
                      <th className="px-3 py-2 text-left">Type</th>
                      <th className="px-3 py-2 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c, i) => (
                      <tr key={i} className={`border-b border-slate-100 ${selected.has(i) ? "" : "opacity-40"}`}>
                        <td className="px-3 py-1.5">
                          <input
                            type="checkbox"
                            checked={selected.has(i)}
                            onChange={() => toggleRow(i)}
                            data-testid={`import-row-check-${i}`}
                          />
                        </td>
                        <td className="px-3 py-1.5">
                          <input
                            value={c.name}
                            onChange={(e) => editRow(i, "name", e.target.value)}
                            className="w-full bg-transparent border-0 focus:outline-none focus:border-b focus:border-slate-400 px-0"
                          />
                        </td>
                        <td className="px-3 py-1.5">
                          <input
                            value={c.email || ""}
                            onChange={(e) => editRow(i, "email", e.target.value)}
                            className="w-full bg-transparent border-0 focus:outline-none focus:border-b focus:border-slate-400 px-0 text-slate-600 text-[13px]"
                          />
                        </td>
                        <td className="px-3 py-1.5">
                          <input
                            value={c.phone || ""}
                            onChange={(e) => editRow(i, "phone", e.target.value)}
                            className="w-full bg-transparent border-0 focus:outline-none focus:border-b focus:border-slate-400 px-0 text-slate-600 text-[13px]"
                          />
                        </td>
                        <td className="px-3 py-1.5">
                          <select
                            value={c.type}
                            onChange={(e) => editRow(i, "type", e.target.value)}
                            className="border rounded px-1.5 py-0.5 text-xs bg-white"
                          >
                            <option value="customer">Customer</option>
                            <option value="vendor">Vendor</option>
                          </select>
                        </td>
                        <td className="px-3 py-1.5">
                          {c.existing ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 uppercase tracking-wide">
                              Will update
                            </span>
                          ) : (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 uppercase tracking-wide">
                              New
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="px-5 py-3 border-t bg-slate-50/60 flex items-center gap-3">
              <span className="text-xs text-slate-600">
                {selected.size} of {rows.length} selected
              </span>
              <button
                onClick={() => onClose(false)}
                disabled={busy}
                className="ml-auto px-3 py-1.5 rounded-md border text-sm"
              >
                Cancel
              </button>
              <button
                onClick={commit}
                disabled={busy || !selected.size}
                className="px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm inline-flex items-center gap-1.5 disabled:opacity-50"
                data-testid="import-commit"
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                Import {selected.size} contact{selected.size !== 1 ? "s" : ""}
              </button>
            </div>
          </>
        )}

        {/* ---------- Step: Done ---------- */}
        {step === "done" && result && (
          <div className="p-8 text-center space-y-4">
            <div className="w-14 h-14 mx-auto rounded-full bg-emerald-100 flex items-center justify-center">
              <Check size={28} className="text-emerald-700" />
            </div>
            <div>
              <h4 className="text-lg font-semibold">Import complete</h4>
              <p className="text-sm text-slate-600 mt-1">
                Added <b>{result.created}</b>, updated <b>{result.updated}</b>
                {result.skipped ? <>, skipped <b>{result.skipped}</b></> : ""}.
              </p>
            </div>
            <button
              onClick={() => onClose(true)}
              className="px-4 py-2 rounded-md bg-slate-900 text-white text-sm"
              data-testid="import-done-close"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}



/**
 * DropZone — the dashed upload target for the Contacts Import modal.
 * Supports both click-to-pick AND actual drag-and-drop (which the
 * original inline version didn't). Highlights on dragenter and
 * routes the first dropped file to the parent's ``onFile`` handler.
 */
function DropZone({ busy, onFile, inputRef }) {
  const [over, setOver] = React.useState(false);
  const dragCount = React.useRef(0);

  // dragenter/leave fire for every child element the pointer crosses,
  // so we track a nesting counter to keep the highlight steady.
  const onDragEnter = (e) => {
    e.preventDefault(); e.stopPropagation();
    dragCount.current += 1;
    if (e.dataTransfer?.types?.includes("Files")) setOver(true);
  };
  const onDragLeave = (e) => {
    e.preventDefault(); e.stopPropagation();
    dragCount.current -= 1;
    if (dragCount.current <= 0) { dragCount.current = 0; setOver(false); }
  };
  const onDragOver = (e) => {
    // Must preventDefault to allow drop.
    e.preventDefault(); e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (e) => {
    e.preventDefault(); e.stopPropagation();
    dragCount.current = 0;
    setOver(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) onFile(f);
  };

  return (
    <div
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`rounded-lg border-2 border-dashed transition-colors p-6 text-center ${over
        ? "border-indigo-500 bg-indigo-100/70"
        : "border-slate-300 hover:border-indigo-400 hover:bg-indigo-50/30"}`}
      data-testid="import-dropzone"
    >
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,.xlsm,.csv,.txt,.pdf"
        className="hidden"
        onChange={(e) => onFile(e.target.files?.[0])}
        data-testid="import-file-input"
      />
      <div className="flex items-center justify-center gap-2 text-slate-400 mb-3 pointer-events-none">
        <FileSpreadsheet size={22} /> <FileText size={22} />
      </div>
      <div className="text-sm font-medium text-slate-700 mb-1 pointer-events-none">
        {over ? "Drop to upload" : "Drop an Excel / CSV / PDF here"}
      </div>
      <div className="text-xs text-slate-500 mb-3 pointer-events-none">
        Auto-detects columns for name, email, phone, address, and type.
      </div>
      <button
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm disabled:opacity-50"
        data-testid="import-pick-file"
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
        Choose file
      </button>
    </div>
  );
}

