import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Plus, Trash2, X, Pencil, GitMerge, ExternalLink, Tag, Sparkles } from "lucide-react";
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
  const [reportContact, setReportContact] = useState(null); // { contact } drilldown
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
            {items.map(c => (
              <tr
                key={c.id}
                onClick={() => view === "analytics"
                  ? setReportContact(c)
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
              <tr><td colSpan={view === "analytics" ? 9 : 7} className="text-center py-8 text-slate-500">No contacts.</td></tr>
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

      {reportContact && (
        <ContactReportDrawer
          currentId={currentId}
          contact={reportContact}
          onClose={() => setReportContact(null)}
          onEdit={() => { const c = reportContact; setReportContact(null); setModal({ mode: "edit", contact: c }); }}
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


function ContactReportDrawer({ currentId, contact, onClose, onEdit }) {
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
    <div className="fixed inset-0 z-50 flex" data-testid="contact-report-drawer">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-full max-w-3xl h-full bg-white shadow-2xl flex flex-col">
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

function ReclassifyPicker({ accounts, count, onCancel, onApply }) {
  const [q, setQ] = useState("");
  // Filter to accounts a category can post to: exclude bank/AR/AP/OBE-style rows.
  // Practical heuristic: show revenue, expense, cogs, and any *other* asset/liab
  // rows the user might want to hit (like Uncategorized/Owner's Draw).
  const options = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (accounts || [])
      .filter(a => ["revenue", "expense", "cogs"].includes((a.type || "").toLowerCase())
        || /uncategorized|owner|draw|contribution|refund|reimburs/i.test(a.name || ""))
      .filter(a => !s || (a.name || "").toLowerCase().includes(s)
                       || (a.code || "").includes(s))
      .sort((a, b) => (a.code || "").localeCompare(b.code || ""));
  }, [accounts, q]);

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md flex flex-col max-h-[80vh]">
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <div>
            <h3 className="font-heading font-semibold">Reclassify {count} transaction{count !== 1 ? "s" : ""}</h3>
            <p className="text-xs text-slate-500 mt-0.5">Pick the target category account.</p>
          </div>
          <button onClick={onCancel} data-testid="reclassify-close"><X size={16} /></button>
        </div>
        <div className="px-5 py-3 border-b">
          <input
            autoFocus
            placeholder="Search by name or code…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            data-testid="reclassify-search"
            className="w-full border rounded-md px-2.5 py-1.5 text-sm"
          />
        </div>
        <div className="overflow-y-auto flex-1 divide-y">
          {options.length === 0 ? (
            <div className="py-8 text-center text-sm text-slate-500">No matches.</div>
          ) : options.map(a => (
            <button
              key={a.id}
              onClick={() => onApply(a.id)}
              data-testid={`reclassify-option-${a.code || a.id}`}
              className="w-full text-left px-5 py-2.5 hover:bg-slate-50 flex items-center gap-3"
            >
              <span className="text-xs text-slate-500 tabular-nums w-12">{a.code || ""}</span>
              <span className="flex-1 text-sm">{a.name}</span>
              <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{a.type}</span>
            </button>
          ))}
        </div>
      </div>
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
