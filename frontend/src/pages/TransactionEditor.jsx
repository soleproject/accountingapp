import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, fmtMoney } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { toast } from "sonner";
import {
  ArrowLeft, Save, Plus, Trash2, Send, Paperclip, X,
} from "lucide-react";
import ContactCombobox from "@/components/ContactCombobox";
import SearchableAccountPicker from "@/components/SearchableAccountPicker";

/**
 * Config-driven full-page transaction editor. One component drives all
 * five entity types (Purchase, SalesReceipt, Deposit, CreditMemo,
 * RefundReceipt) via the {@link ENTITY_CONFIGS} table so the editors
 * stay in lockstep — a UX fix here ripples to all of them at once.
 *
 * Routes wire in via thin wrappers (`PurchaseEditor.jsx`, etc.) that
 * pass the appropriate `entityType` prop.
 *
 * Submits to `POST /companies/{cid}/transactions` with an explicit
 * `txn_type` + `line_items` payload — the backend qualifier in
 * `routes/transactions.py::_maybe_autopush_purchase` short-circuits
 * on explicit `txn_type` and fires the entity-specific QBO autopush.
 */

const iso = (d) => new Date(d).toISOString().slice(0, 10);

// ─── Entity configs ────────────────────────────────────────────────
// One line per entity type. Keep this table dense — it's the single
// source of truth for what each editor looks like.

const ENTITY_CONFIGS = {
  Purchase: {
    label: "Expense",
    plural: "Expenses",
    icon: "💸",
    direction: "out",
    contactType: "vendor",
    contactLabel: "Vendor",
    contactRequired: false,
    bankLabel: "Paid from",
    bankRequired: true,
    // Which account types are valid on line items.
    lineAccountFilter: (a) => {
      const t = (a.type || "").toLowerCase();
      return t === "expense" || t === "liability" || t === "asset";
    },
    showPaymentType: true,
    showRefundedInvoice: false,
    numberPrefix: "EXP",
    testIdPrefix: "purchase-editor",
    lineItemField: "expense_account_id",
    tint: "amber",
  },
  SalesReceipt: {
    label: "Sales Receipt",
    plural: "Sales Receipts",
    icon: "🧾",
    direction: "in",
    contactType: "customer",
    contactLabel: "Customer",
    contactRequired: true,
    bankLabel: "Deposit to",
    bankRequired: true,
    lineAccountFilter: (a) => {
      const t = (a.type || "").toLowerCase();
      return t === "revenue" || t === "income";
    },
    showPaymentType: true,
    showRefundedInvoice: false,
    numberPrefix: "SR",
    testIdPrefix: "sales-receipt-editor",
    lineItemField: "category_account_id",
    tint: "emerald",
  },
  Deposit: {
    label: "Bank Deposit",
    plural: "Bank Deposits",
    icon: "🏦",
    direction: "in",
    contactType: null, // no contact — pure bank inflow
    contactLabel: "",
    contactRequired: false,
    bankLabel: "Deposit to",
    bankRequired: true,
    lineAccountFilter: (a) => {
      // Deposits can post to income, other-income, or (for owner
      // contributions / loan proceeds) equity/liability.
      const t = (a.type || "").toLowerCase();
      return t === "revenue" || t === "income" || t === "equity"
             || t === "liability";
    },
    showPaymentType: false,
    showRefundedInvoice: false,
    numberPrefix: "DEP",
    testIdPrefix: "deposit-editor",
    lineItemField: "category_account_id",
    tint: "cyan",
  },
  CreditMemo: {
    label: "Credit Memo",
    plural: "Credit Memos",
    icon: "↩️",
    direction: "in", // reduces A/R, doesn't hit bank
    contactType: "customer",
    contactLabel: "Customer",
    contactRequired: true,
    bankLabel: "", // no bank — A/R adjustment
    bankRequired: false,
    lineAccountFilter: (a) => {
      const t = (a.type || "").toLowerCase();
      return t === "revenue" || t === "income";
    },
    showPaymentType: false,
    showRefundedInvoice: true,
    numberPrefix: "CM",
    testIdPrefix: "credit-memo-editor",
    lineItemField: "category_account_id",
    tint: "rose",
  },
  RefundReceipt: {
    label: "Refund Receipt",
    plural: "Refund Receipts",
    icon: "💰",
    direction: "out", // cash refund back to customer
    contactType: "customer",
    contactLabel: "Customer",
    contactRequired: true,
    bankLabel: "Refunded from",
    bankRequired: true,
    lineAccountFilter: (a) => {
      const t = (a.type || "").toLowerCase();
      return t === "revenue" || t === "income";
    },
    showPaymentType: true,
    showRefundedInvoice: false,
    numberPrefix: "RR",
    testIdPrefix: "refund-receipt-editor",
    lineItemField: "category_account_id",
    tint: "orange",
  },
};

const PAYMENT_TYPES = [
  "Cash", "Check", "Credit Card", "Bank Transfer", "PayPal", "Other",
];

const TINT_CLASSES = {
  amber:   { chip: "bg-amber-100 text-amber-800",   bar: "bg-amber-500" },
  emerald: { chip: "bg-emerald-100 text-emerald-800", bar: "bg-emerald-500" },
  cyan:    { chip: "bg-cyan-100 text-cyan-800",     bar: "bg-cyan-500" },
  rose:    { chip: "bg-rose-100 text-rose-800",     bar: "bg-rose-500" },
  orange:  { chip: "bg-orange-100 text-orange-800", bar: "bg-orange-500" },
};


export default function TransactionEditor({ entityType }) {
  const cfg = ENTITY_CONFIGS[entityType];
  if (!cfg) {
    throw new Error(`TransactionEditor: unknown entityType ${entityType}`);
  }
  const tint = TINT_CLASSES[cfg.tint] || TINT_CLASSES.amber;

  const { id } = useParams();
  const editMode = !!id;
  const navigate = useNavigate();
  const { currentId } = useCompany();

  const [loading, setLoading] = useState(editMode);
  const [saving, setSaving] = useState(false);

  const [contacts, setContacts] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [allAccounts, setAllAccounts] = useState([]);
  const [banks, setBanks] = useState([]);
  // Only used by CreditMemo — list of open invoices to link.
  const [invoices, setInvoices] = useState([]);

  const [number, setNumber] = useState("");
  const [contact, setContact] = useState("");
  const [date, setDate] = useState(iso(new Date()));
  const [bankId, setBankId] = useState("");
  const [paymentType, setPaymentType] = useState(cfg.showPaymentType ? "Cash" : "");
  const [linkedInvoiceId, setLinkedInvoiceId] = useState("");
  const [lines, setLines] = useState([
    { description: "", category_account_id: null,
      category_account_name: "", amount: 0 },
  ]);
  const [memo, setMemo] = useState("");
  const [notes, setNotes] = useState("");
  const [attachments, setAttachments] = useState([]);

  // ─── Load reference data + (if editing) the transaction ───────────
  useEffect(() => {
    if (!currentId) return;
    let cancelled = false;
    (async () => {
      try {
        const [c, a] = await Promise.all([
          api.get(`/companies/${currentId}/contacts`),
          api.get(`/companies/${currentId}/accounts`),
        ]);
        if (cancelled) return;
        setContacts(c.data.contacts || []);
        const rawAccounts = a.data.accounts || [];
        setAllAccounts(rawAccounts);
        setAccounts(rawAccounts
          .filter(cfg.lineAccountFilter)
          .filter(x => x.active !== false)
          .sort((x, y) => String(x.code || "").localeCompare(String(y.code || ""))));
        const bankRows = rawAccounts.filter(x => {
          const code = String(x.code || "");
          const sub = (x.subtype || "").toLowerCase();
          return (
            (code.startsWith("10") && code.length === 4)
            || sub === "bank"
          ) && x.active !== false;
        });
        setBanks(bankRows);
        if (!editMode && bankRows.length && !bankId) {
          const dflt = bankRows.find(b => b.code === "1010") || bankRows[0];
          if (dflt) setBankId(dflt.id);
        }
        if (cfg.showRefundedInvoice) {
          try {
            const inv = await api.get(`/companies/${currentId}/invoices`);
            if (!cancelled) setInvoices(inv.data.invoices || []);
          } catch { /* invoices optional */ }
        }
        if (editMode) {
          const r = await api.get(`/companies/${currentId}/transactions/${id}`);
          if (cancelled) return;
          const t = r.data.transaction || r.data;
          setNumber(t.number || "");
          setContact(t.contact_id || "");
          setDate(t.date || iso(new Date()));
          setBankId(t.bank_account_id || "");
          setPaymentType(t.payment_type || (cfg.showPaymentType ? "Cash" : ""));
          setLinkedInvoiceId(t.linked_invoice_id || "");
          const li = t.line_items || [];
          setLines(li.length ? li.map(l => ({
            description: l.description || "",
            category_account_id:
              l[cfg.lineItemField] || l.category_account_id
              || l.expense_account_id || null,
            category_account_name:
              l[`${cfg.lineItemField.replace("_id", "_name")}`]
              || l.category_account_name
              || l.expense_account_name || "",
            amount: Number(l.amount || 0),
          })) : [{ description: t.description || "",
                    category_account_id: t.category_account_id || null,
                    category_account_name: t.category_account_name || "",
                    amount: Math.abs(Number(t.amount || 0)) }]);
          setMemo(t.memo || "");
          setNotes(t.notes || t.description || "");
          setAttachments(t.attachments || []);
        }
      } catch (e) {
        toast.error(e.response?.data?.detail || "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, id, editMode]);

  const updLine = (i, patch) => setLines(prev => prev.map((x, j) =>
    j === i ? { ...x, ...patch } : x));
  const addLine = () => setLines(prev => [...prev,
    { description: "", category_account_id: null,
      category_account_name: "", amount: 0 }]);
  const removeLine = (i) => setLines(prev => prev.length > 1
    ? prev.filter((_, j) => j !== i) : prev);

  const total = useMemo(
    () => lines.reduce((s, l) => s + Number(l.amount || 0), 0),
    [lines],
  );

  const onAttach = async (files) => {
    for (const f of files) {
      if (f.size > 6 * 1024 * 1024) {
        toast.error(`${f.name} > 6 MB, skipped`);
        continue;
      }
      const dataUrl = await new Promise((res) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.readAsDataURL(f);
      });
      setAttachments(prev => [...prev,
        { filename: f.name, data_url: dataUrl, size: f.size }]);
    }
  };
  const removeAttachment = (i) =>
    setAttachments(prev => prev.filter((_, j) => j !== i));

  // ─── Validation ───────────────────────────────────────────────────
  const validate = () => {
    if (cfg.contactRequired && !contact) {
      toast.error(`Pick a ${cfg.contactLabel.toLowerCase()}.`);
      return false;
    }
    if (cfg.bankRequired && !bankId) {
      toast.error(`Pick a bank account (${cfg.bankLabel}).`);
      return false;
    }
    if (!date) {
      toast.error("Pick a date.");
      return false;
    }
    const cleanLines = lines.filter(l => Number(l.amount || 0) !== 0);
    if (!cleanLines.length) {
      toast.error("Add at least one line item with a non-zero amount.");
      return false;
    }
    for (const l of cleanLines) {
      if (!l.category_account_id) {
        toast.error("Every line needs a category account.");
        return false;
      }
    }
    return true;
  };

  const buildPayload = () => {
    const c = contacts.find(x => x.id === contact);
    const cleanLines = lines
      .filter(l => Number(l.amount || 0) !== 0)
      .map(l => ({
        description: l.description || "",
        amount: Math.abs(Number(l.amount || 0)),
        [cfg.lineItemField]: l.category_account_id,
        [`${cfg.lineItemField.replace("_id", "_name")}`]:
          l.category_account_name || "",
      }));
    const headerAmount = cleanLines.reduce(
      (s, l) => s + Number(l.amount || 0), 0);
    // Route-level payload — the backend accepts these keys via the
    // editor-aware branch of `create_transaction` / `PATCH`.
    const payload = {
      txn_type: entityType,
      date,
      description: memo || cleanLines[0]?.description || cfg.label,
      merchant: c?.name || "",
      amount: headerAmount, // backend flips sign per direction
      bank_account_id: bankId || null,
      contact_id: contact || null,
      contact_name: c?.name || null,
      line_items: cleanLines,
      number: number || null,
      memo: memo || null,
      notes: notes || null,
      auto_categorize: false,
      // Use the first line's category as the header category for
      // ledger/report views that only look at header-level fields.
      category_account_id: cleanLines[0]?.category_account_id || null,
    };
    if (cfg.showPaymentType) payload.payment_type = paymentType || "Cash";
    if (cfg.showRefundedInvoice) payload.linked_invoice_id = linkedInvoiceId || null;
    return payload;
  };

  const save = async () => {
    if (saving) return;
    if (!validate()) return;
    setSaving(true);
    try {
      const body = buildPayload();
      let tid = id;
      if (editMode) {
        // PATCH accepts a subset of these fields (see TransactionUpdate).
        // Send what it understands; the mirror will react to relevant
        // header changes.
        const patchBody = {
          date: body.date,
          description: body.description,
          merchant: body.merchant,
          amount: (cfg.direction === "out" && entityType !== "CreditMemo")
                    ? -Math.abs(body.amount)
                    : Math.abs(body.amount),
          bank_account_id: body.bank_account_id,
          contact_id: body.contact_id,
          contact_name: body.contact_name,
          category_account_id: body.category_account_id,
        };
        await api.patch(`/companies/${currentId}/transactions/${id}`, patchBody);
        toast.success(`${cfg.label} saved`);
      } else {
        const r = await api.post(`/companies/${currentId}/transactions`, body);
        tid = r.data.id;
        toast.success(`${cfg.label} created`);
        navigate(`${routeFor(entityType, "editPrefix")}/${tid}/edit`,
                  { replace: true });
      }
      return tid;
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-[60vh] grid place-items-center text-slate-500">
        Loading…
      </div>
    );
  }

  const testId = cfg.testIdPrefix;

  return (
    <div className="max-w-5xl mx-auto pb-24" data-testid={testId}>
      {/* ── Sticky header ── */}
      <div className={`sticky top-0 z-10 border-b bg-white/95 backdrop-blur px-4 py-3 flex items-center justify-between`}>
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="p-1.5 rounded-md hover:bg-slate-100"
            data-testid={`${testId}-back-btn`}
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${tint.chip}`}>
                <span className="mr-1">{cfg.icon}</span>{cfg.label}
              </span>
              <h1 className="text-lg font-semibold text-slate-900">
                {editMode ? `Edit ${cfg.label}` : `New ${cfg.label}`}
              </h1>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              {editMode ? `#${number || id.slice(0, 8)}` : "Draft"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={save}
            disabled={saving}
            className={`px-3 py-1.5 text-sm font-medium rounded-md text-white ${tint.bar} disabled:opacity-60 flex items-center gap-1.5`}
            data-testid={`${testId}-save-btn`}
          >
            <Save size={14} /> {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {/* ── Header fields ── */}
      <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        {cfg.contactType && (
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              {cfg.contactLabel}{cfg.contactRequired && <span className="text-rose-500"> *</span>}
            </label>
            <ContactCombobox
              contacts={contacts}
              value={contact}
              onChange={setContact}
              onCreated={(c) => setContacts(prev => [c, ...prev])}
              type={cfg.contactType}
              currentId={currentId}
              testId={`${testId}-contact`}
            />
          </div>
        )}
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            Date <span className="text-rose-500">*</span>
          </label>
          <input
            type="date" value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
            data-testid={`${testId}-date-input`}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            {cfg.label} #
          </label>
          <input
            type="text" value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder={`${cfg.numberPrefix}-####`}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
            data-testid={`${testId}-number-input`}
          />
        </div>
        {cfg.bankLabel && (
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              {cfg.bankLabel}{cfg.bankRequired && <span className="text-rose-500"> *</span>}
            </label>
            <select
              value={bankId} onChange={(e) => setBankId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
              data-testid={`${testId}-bank-select`}
            >
              <option value="">— pick a bank —</option>
              {banks.map(b => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {cfg.showPaymentType && (
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Payment method
            </label>
            <select
              value={paymentType}
              onChange={(e) => setPaymentType(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
              data-testid={`${testId}-payment-type-select`}
            >
              {PAYMENT_TYPES.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        )}
        {cfg.showRefundedInvoice && (
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Applies to invoice
              <span className="text-slate-400 font-normal ml-1">(optional)</span>
            </label>
            <select
              value={linkedInvoiceId}
              onChange={(e) => setLinkedInvoiceId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
              data-testid={`${testId}-linked-invoice-select`}
            >
              <option value="">— not linked —</option>
              {invoices
                .filter(inv => !contact || inv.contact_id === contact)
                .filter(inv => inv.status !== "paid" && inv.status !== "void")
                .slice(0, 200)
                .map(inv => (
                  <option key={inv.id} value={inv.id}>
                    {inv.number || inv.id.slice(0, 8)} — {fmtMoney(inv.total)}
                  </option>
                ))}
            </select>
          </div>
        )}
      </div>

      {/* ── Line items ── */}
      <div className="px-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-slate-800">Line items</h2>
          <button
            onClick={addLine}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-50"
            data-testid={`${testId}-add-line-btn`}
          >
            <Plus size={12} /> Add line
          </button>
        </div>
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <div className="grid grid-cols-[1fr,1.6fr,160px,40px] text-xs font-medium text-slate-500 bg-slate-50 px-3 py-2 border-b">
            <div>Description</div>
            <div>Category</div>
            <div className="text-right">Amount</div>
            <div></div>
          </div>
          {lines.map((l, i) => (
            <div
              key={i}
              className="grid grid-cols-[1fr,1.6fr,160px,40px] items-center px-3 py-2 border-b last:border-b-0 gap-2"
              data-testid={`${testId}-line-row-${i}`}
            >
              <input
                type="text" value={l.description}
                onChange={(e) => updLine(i, { description: e.target.value })}
                placeholder="Line description"
                className="px-2 py-1.5 text-sm border border-slate-200 rounded"
                data-testid={`${testId}-line-desc-${i}`}
              />
              <SearchableAccountPicker
                accounts={accounts}
                allAccounts={allAccounts}
                value={l.category_account_id}
                onChange={(nid) => {
                  const acct = accounts.find(a => a.id === nid)
                                || allAccounts.find(a => a.id === nid);
                  updLine(i, {
                    category_account_id: nid,
                    category_account_name: acct?.name || "",
                  });
                }}
                currentId={currentId}
                testId={`${testId}-line-cat-${i}`}
              />
              <input
                type="number" step="0.01" value={l.amount}
                onChange={(e) => updLine(i, { amount: Number(e.target.value) })}
                className="px-2 py-1.5 text-sm text-right border border-slate-200 rounded tabular-nums"
                data-testid={`${testId}-line-amt-${i}`}
              />
              <button
                onClick={() => removeLine(i)}
                disabled={lines.length === 1}
                className="p-1 rounded hover:bg-rose-50 disabled:opacity-30"
                data-testid={`${testId}-line-remove-${i}`}
              >
                <Trash2 size={14} className="text-rose-500" />
              </button>
            </div>
          ))}
          <div className="grid grid-cols-[1fr,1.6fr,160px,40px] items-center px-3 py-2 bg-slate-50 text-sm font-semibold">
            <div></div>
            <div className="text-right text-slate-500">Total</div>
            <div className="text-right tabular-nums" data-testid={`${testId}-total`}>
              {fmtMoney(total)}
            </div>
            <div></div>
          </div>
        </div>
      </div>

      {/* ── Memo & attachments ── */}
      <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            Memo
          </label>
          <textarea
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            rows={3}
            placeholder="Optional memo (shown on the QBO transaction)"
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
            data-testid={`${testId}-memo-input`}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            Internal notes
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Notes for your team — not shown to the customer/vendor"
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
            data-testid={`${testId}-notes-input`}
          />
        </div>
      </div>

      {/* ── Attachments ── */}
      <div className="px-4 pb-6">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-slate-800">
            Attachments
          </h2>
          <label className="cursor-pointer inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-50">
            <Paperclip size={12} /> Add file
            <input
              type="file" multiple hidden
              onChange={(e) => onAttach(Array.from(e.target.files || []))}
              data-testid={`${testId}-attach-input`}
            />
          </label>
        </div>
        {attachments.length === 0 ? (
          <p className="text-xs text-slate-400">
            No attachments. Receipts and supporting docs live here.
          </p>
        ) : (
          <ul className="space-y-1">
            {attachments.map((a, i) => (
              <li
                key={i}
                className="flex items-center justify-between text-sm bg-slate-50 border border-slate-200 rounded px-3 py-1.5"
              >
                <span className="truncate">{a.filename}</span>
                <button
                  onClick={() => removeAttachment(i)}
                  className="p-1 rounded hover:bg-rose-50"
                >
                  <X size={12} className="text-rose-500" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// Map entityType → route base so the editor can redirect after save.
function routeFor(entityType) {
  return {
    Purchase: "/purchases",
    SalesReceipt: "/sales-receipts",
    Deposit: "/deposits",
    CreditMemo: "/credit-memos",
    RefundReceipt: "/refund-receipts",
  }[entityType] || "/transactions";
}
