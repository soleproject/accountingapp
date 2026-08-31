/**
 * Print Checks — /accounting/checks  (Feb 2026, MVP Phase 1)
 *
 * Flow:
 *   1. Pick a bank account (auto-fills next check #, editable).
 *   2. Pick a layout — voucher_top (default) or wallet_3up.
 *   3. Pick unpaid bills OR add an ad-hoc check (payee + amount + memo).
 *   4. Preview PDF (no ledger writes) → eyeball alignment on a
 *      blank sheet before wasting real check stock.
 *   5. Print & Commit → posts payments, marks bills paid, saves
 *      check history, bumps the next check number.
 *
 * See `/app/backend/routes/checks.py` for the backend counterpart.
 */
import { useEffect, useMemo, useState } from "react";
import { api, API } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { toast } from "sonner";
import { Printer, Eye, RefreshCw, Ban, PlusCircle, Loader2, FileText } from "lucide-react";

function Money({ v }) {
  return <span className="font-mono-num tabular-nums">${Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>;
}

/**
 * LayoutPreview — renders an inline SVG "example" of a check layout
 * from its registry `preview` schema. Not a pixel-perfect mockup —
 * enough to show the operator where the check band vs. stub bands
 * sit on the sheet so they can grab the matching pre-printed stock.
 */
function LayoutPreview({ layout }) {
  if (!layout) return null;
  const W = 220;                  // pretend the sheet is 220 x 285 px
  const H = 285;
  const bands = layout.preview?.page_bands || [];
  return (
    <div className="rounded-xl border bg-slate-50 p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500 font-semibold mb-3">Example</div>
      <div className="flex gap-4 items-start">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-40 h-52 shrink-0 shadow-md rounded-sm bg-white border border-slate-300">
          <rect x={0} y={0} width={W} height={H} fill="white" />
          {bands.map((b, i) => {
            const inset = (b.inset || 0) * W;
            const y = b.top * H;
            const h = b.height * H;
            const fill = b.kind === "check" ? "#ecfeff" : "#f8fafc";
            const stroke = b.kind === "check" ? "#0891b2" : "#94a3b8";
            return (
              <g key={i}>
                <rect x={4 + inset} y={y + 4} width={W - 8 - inset * 2} height={h - 8}
                      fill={fill} stroke={stroke} strokeWidth={b.kind === "check" ? 1.5 : 0.6}
                      strokeDasharray={b.kind === "stub" ? "3,2" : "0"} rx={2} />
                <text x={W / 2} y={y + h / 2 + 3} textAnchor="middle"
                      fontFamily="ui-sans-serif" fontSize="9"
                      fill={b.kind === "check" ? "#0e7490" : "#64748b"}
                      fontWeight={b.kind === "check" ? "700" : "500"}>
                  {b.label}
                </text>
                {b.kind === "check" && (
                  <>
                    {/* Fake check details — payee line + amount box + words + signature */}
                    <line x1={20 + inset} y1={y + h / 2 + 14} x2={W - 60 - inset} y2={y + h / 2 + 14}
                          stroke="#0e7490" strokeWidth={0.5} />
                    <rect x={W - 55 - inset} y={y + h / 2 + 6} width={40} height={12}
                          fill="none" stroke="#0e7490" strokeWidth={0.5} />
                    <line x1={20 + inset} y1={y + h / 2 + 26} x2={W - 20 - inset} y2={y + h / 2 + 26}
                          stroke="#0e7490" strokeWidth={0.5} />
                  </>
                )}
              </g>
            );
          })}
        </svg>
        <div className="flex-1 min-w-0 text-sm">
          <div className="font-heading font-semibold text-slate-900">{layout.label}</div>
          <p className="text-slate-600 mt-1 leading-snug">{layout.description}</p>
          <div className="mt-3 text-xs">
            <div className="uppercase tracking-wide text-slate-500 font-semibold">Compatible stock</div>
            <div className="text-slate-700 mt-0.5">{layout.stock_examples}</div>
          </div>
          <div className="mt-3 text-xs">
            <div className="uppercase tracking-wide text-slate-500 font-semibold">Checks per sheet</div>
            <div className="text-slate-700 mt-0.5">{layout.per_page}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PrintChecks() {
  const { currentId } = useCompany();
  const [loading, setLoading] = useState(true);
  const [ctx, setCtx] = useState({ bank_accounts: [], unpaid_bills: [], company: {} });
  const [layouts, setLayouts] = useState([]);
  const [bankId, setBankId] = useState("");
  const [layout, setLayout] = useState("voucher_top");
  const [nextNum, setNextNum] = useState(1001);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [selectedBills, setSelectedBills] = useState({});     // { [billId]: true }
  const [adhoc, setAdhoc] = useState([]);                     // [{payee_name, amount, memo}]
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState([]);

  const loadContext = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const [ctxR, laR] = await Promise.all([
        api.get(`/companies/${currentId}/checks/context`),
        api.get(`/companies/${currentId}/checks/layouts`),
      ]);
      setCtx(ctxR.data);
      setLayouts(laR.data.layouts || []);
      const banks = ctxR.data.bank_accounts || [];
      if (banks.length && !bankId) {
        setBankId(banks[0].id);
        setNextNum(banks[0].next_check_number || 1001);
      }
    } catch (e) {
      toast.error(`Failed to load: ${e.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
    }
  };
  const loadHistory = async () => {
    if (!currentId) return;
    try {
      const r = await api.get(`/companies/${currentId}/checks`);
      setHistory(r.data.checks || []);
    } catch {/* silent */}
  };
  useEffect(() => { loadContext(); loadHistory(); /* eslint-disable-next-line */ }, [currentId]);

  // When user changes bank, reload the persisted next check # for that account.
  useEffect(() => {
    const b = (ctx.bank_accounts || []).find(a => a.id === bankId);
    if (b) setNextNum(b.next_check_number || 1001);
  }, [bankId, ctx.bank_accounts]);

  // Group unpaid bills by contact so the operator can see "3 checks
  // to Acme, 1 to Beta". One check per contact — we bundle every
  // selected bill for the same payee into a single check with a stub.
  const grouped = useMemo(() => {
    const bills = (ctx.unpaid_bills || []).filter(b => selectedBills[b.id]);
    const byContact = new Map();
    for (const b of bills) {
      const key = b.contact_id || `__adhoc__${b.contact_name || "(no payee)"}`;
      if (!byContact.has(key)) {
        byContact.set(key, {
          contact_id: b.contact_id,
          payee_name: b.contact_name || "(no payee)",
          payee_address: b.contact_address || "",
          bills: [],
        });
      }
      byContact.get(key).bills.push(b);
    }
    return Array.from(byContact.values());
  }, [ctx.unpaid_bills, selectedBills]);

  const previewChecks = useMemo(() => {
    const list = grouped.map(g => ({
      payee_name: g.payee_name,
      payee_address: g.payee_address,
      amount: g.bills.reduce((a, b) => a + Number(b.balance_due || 0), 0),
      memo: g.bills.length === 1
        ? `Bill ${g.bills[0].number || ""}`
        : `${g.bills.length} bills`,
      date,
      bill_ids: g.bills.map(b => b.id),
    }));
    for (const a of adhoc) {
      if (!a.payee_name || !Number(a.amount)) continue;
      list.push({
        payee_name: a.payee_name,
        payee_address: "",
        amount: Number(a.amount),
        memo: a.memo || "",
        date,
        bill_ids: [],
      });
    }
    return list;
  }, [grouped, adhoc, date]);

  const totalAmount = previewChecks.reduce((a, c) => a + c.amount, 0);

  const buildPayload = () => ({
    layout,
    bank_account_id: bankId,
    starting_check_number: Number(nextNum) || 1001,
    checks: previewChecks,
  });

  const canRun = bankId && previewChecks.length > 0 && !busy;

  const openPdfBlob = async (path) => {
    setBusy(true);
    try {
      const token = localStorage.getItem("axiom_token");
      const res = await fetch(`${API}/companies/${currentId}/checks/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json",
                   Authorization: token ? `Bearer ${token}` : "" },
        body: JSON.stringify(buildPayload()),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      return true;
    } catch (e) {
      toast.error(`${path === "print" ? "Print" : "Preview"} failed: ${e.message}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const doPreview = async () => { await openPdfBlob("preview"); };

  const doPrint = async () => {
    if (!window.confirm(
      `Print ${previewChecks.length} check(s) totaling $${totalAmount.toFixed(2)}? ` +
      `This will record payments and mark the linked bills paid.`
    )) return;
    const ok = await openPdfBlob("print");
    if (ok) {
      toast.success(`Printed ${previewChecks.length} check(s)`);
      setSelectedBills({});
      setAdhoc([]);
      await loadContext();
      await loadHistory();
    }
  };

  const voidCheck = async (id, num) => {
    if (!window.confirm(`Void check #${num}? The number will be marked so it can't be reused.`)) return;
    try {
      await api.post(`/companies/${currentId}/checks/${id}/void`);
      toast.success(`Check #${num} voided`);
      await loadHistory();
    } catch (e) {
      toast.error(`Void failed: ${e.response?.data?.detail || e.message}`);
    }
  };

  if (!currentId) return <div className="p-8 text-sm text-slate-500">Pick a company first.</div>;

  return (
    <div className="max-w-6xl space-y-6" data-testid="print-checks-page">
      <div>
        <h1 className="font-heading text-3xl font-bold flex items-center gap-2">
          <Printer size={22} className="text-cyan-600" />
          Print Checks
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Print AP checks on pre-printed voucher stock (VersaCheck 1000, Deluxe 08019) or wallet-style 3-per-page stock.
          Preview alignment on a blank sheet before wasting real checks.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-slate-500 text-sm">
          <Loader2 size={16} className="animate-spin" /> Loading bank accounts + bills…
        </div>
      ) : (
        <>
          {/* Row 1: bank + layout + starting check #. */}
          <div className="rounded-xl border bg-white p-5 space-y-4">
            <h2 className="font-heading font-semibold text-lg">Setup</h2>
            <div className="grid md:grid-cols-3 gap-4">
              <div>
                <label className="text-xs uppercase tracking-wide text-slate-500 font-semibold">Bank account</label>
                <select
                  value={bankId}
                  onChange={(e) => setBankId(e.target.value)}
                  data-testid="check-bank-select"
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                >
                  {(ctx.bank_accounts || []).length === 0 && <option value="">No bank accounts</option>}
                  {(ctx.bank_accounts || []).map(a => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs uppercase tracking-wide text-slate-500 font-semibold">Starting check #</label>
                <input
                  type="number"
                  min={1}
                  value={nextNum}
                  onChange={(e) => setNextNum(e.target.value)}
                  data-testid="check-next-number"
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono-num"
                />
                <div className="text-xs text-slate-500 mt-1">Next {previewChecks.length} number(s) will be consumed.</div>
              </div>
              <div>
                <label className="text-xs uppercase tracking-wide text-slate-500 font-semibold">Check date</label>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  data-testid="check-date"
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div>
              <label className="text-xs uppercase tracking-wide text-slate-500 font-semibold mb-2 block">Layout</label>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <select
                    value={layout}
                    onChange={(e) => setLayout(e.target.value)}
                    data-testid="check-layout-select"
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm bg-white"
                  >
                    {layouts.map(l => (
                      <option key={l.key} value={l.key} data-testid={`check-layout-option-${l.key}`}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                  <div className="text-xs text-slate-500 mt-2 leading-snug">
                    Preview alignment on a blank sheet first — pre-printed check stock is expensive to waste on a mis-alignment.
                  </div>
                </div>
                <LayoutPreview layout={layouts.find(l => l.key === layout)} />
              </div>
            </div>
          </div>

          {/* Row 2: unpaid bills picker. */}
          <div className="rounded-xl border bg-white p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-heading font-semibold text-lg">Unpaid bills</h2>
              <div className="text-xs text-slate-500">{(ctx.unpaid_bills || []).length} open</div>
            </div>
            {(ctx.unpaid_bills || []).length === 0 ? (
              <div className="text-sm text-slate-500 italic">No unpaid bills. Add an ad-hoc check below to write a one-off.</div>
            ) : (
              <table className="w-full text-sm" data-testid="unpaid-bills-table">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
                    <th className="py-2 pl-2 w-8"></th>
                    <th className="py-2">Vendor</th>
                    <th className="py-2">Bill #</th>
                    <th className="py-2">Due</th>
                    <th className="py-2 text-right pr-2">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {(ctx.unpaid_bills || []).map(b => (
                    <tr key={b.id} className="border-b last:border-b-0 hover:bg-slate-50">
                      <td className="py-2 pl-2">
                        <input
                          type="checkbox"
                          checked={!!selectedBills[b.id]}
                          onChange={(e) =>
                            setSelectedBills(s => ({ ...s, [b.id]: e.target.checked }))
                          }
                          data-testid={`select-bill-${b.id}`}
                        />
                      </td>
                      <td className="py-2">{b.contact_name || "(no payee)"}</td>
                      <td className="py-2 font-mono-num">{b.number || "—"}</td>
                      <td className="py-2">{b.due_date || "—"}</td>
                      <td className="py-2 text-right pr-2"><Money v={b.balance_due} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Row 3: ad-hoc checks (no bill link). */}
          <div className="rounded-xl border bg-white p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-heading font-semibold text-lg">Ad-hoc checks <span className="text-xs font-normal text-slate-500">(no bill link)</span></h2>
              <button
                type="button"
                onClick={() => setAdhoc(a => [...a, { payee_name: "", amount: "", memo: "" }])}
                className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-300 hover:bg-slate-50"
                data-testid="add-adhoc-check"
              >
                <PlusCircle size={12} /> Add check
              </button>
            </div>
            {adhoc.length === 0 ? (
              <div className="text-xs text-slate-400 italic">None. Use these for reimbursements, refunds, or checks you'll book against an expense account manually.</div>
            ) : adhoc.map((a, i) => (
              <div key={i} className="grid grid-cols-12 gap-2" data-testid={`adhoc-row-${i}`}>
                <input
                  className="col-span-4 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                  placeholder="Payee name"
                  value={a.payee_name}
                  onChange={(e) => setAdhoc(l => l.map((x, j) => j === i ? { ...x, payee_name: e.target.value } : x))}
                />
                <input
                  type="number"
                  step="0.01"
                  className="col-span-2 rounded-md border border-slate-300 px-2 py-1.5 text-sm font-mono-num"
                  placeholder="0.00"
                  value={a.amount}
                  onChange={(e) => setAdhoc(l => l.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))}
                />
                <input
                  className="col-span-5 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                  placeholder="Memo"
                  value={a.memo}
                  onChange={(e) => setAdhoc(l => l.map((x, j) => j === i ? { ...x, memo: e.target.value } : x))}
                />
                <button
                  type="button"
                  onClick={() => setAdhoc(l => l.filter((_, j) => j !== i))}
                  className="col-span-1 text-slate-400 hover:text-red-600 text-xs"
                >Remove</button>
              </div>
            ))}
          </div>

          {/* Action bar — inline card on desktop, sticky-to-bottom on
              mobile so the Print button never scrolls off-screen. */}
          <div className="rounded-xl border bg-slate-900 text-white p-4 flex flex-wrap items-center justify-between gap-3
                          md:static md:shadow-none
                          max-md:fixed max-md:bottom-16 max-md:left-2 max-md:right-2 max-md:z-20 max-md:shadow-2xl">
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-400">Batch total</div>
              <div className="text-2xl font-heading font-bold" data-testid="batch-total">
                <Money v={totalAmount} />
              </div>
              <div className="text-xs text-slate-400 mt-0.5">
                {previewChecks.length} check(s) · numbers {nextNum} – {(Number(nextNum) + previewChecks.length - 1) || nextNum}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={doPreview}
                disabled={!canRun}
                data-testid="preview-checks-btn"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-slate-600 hover:bg-slate-800 text-sm font-medium disabled:opacity-40 min-h-[44px]"
              >
                <Eye size={14} /> <span className="max-md:hidden">Preview PDF</span><span className="md:hidden">Preview</span>
              </button>
              <button
                onClick={doPrint}
                disabled={!canRun}
                data-testid="print-checks-btn"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-cyan-600 hover:bg-cyan-500 text-sm font-semibold disabled:opacity-40 min-h-[44px]"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />}
                <span className="max-md:hidden">Print &amp; Commit</span><span className="md:hidden">Print</span>
              </button>
            </div>
          </div>
          {/* Spacer so the fixed bottom bar on mobile doesn't cover
              the History card underneath. */}
          <div className="md:hidden h-24" aria-hidden="true" />

          {/* History. */}
          <div className="rounded-xl border bg-white p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-heading font-semibold text-lg flex items-center gap-2">
                <FileText size={16} /> History
              </h2>
              <button
                type="button"
                onClick={loadHistory}
                className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-300 hover:bg-slate-50"
                data-testid="refresh-history"
              >
                <RefreshCw size={12} /> Refresh
              </button>
            </div>
            {history.length === 0 ? (
              <div className="text-sm text-slate-500 italic">No printed checks yet.</div>
            ) : (
              <table className="w-full text-sm" data-testid="check-history-table">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b">
                    <th className="py-2 pl-2">Check #</th>
                    <th className="py-2">Date</th>
                    <th className="py-2">Payee</th>
                    <th className="py-2">Memo</th>
                    <th className="py-2 text-right">Amount</th>
                    <th className="py-2">Status</th>
                    <th className="py-2 pr-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(c => (
                    <tr key={c.id} className={`border-b last:border-b-0 ${c.status === "voided" ? "text-slate-400 line-through" : ""}`}>
                      <td className="py-2 pl-2 font-mono-num">{c.check_number}</td>
                      <td className="py-2">{c.date}</td>
                      <td className="py-2">{c.payee_name}</td>
                      <td className="py-2 text-slate-500 truncate max-w-xs">{c.memo || "—"}</td>
                      <td className="py-2 text-right"><Money v={c.amount} /></td>
                      <td className="py-2">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${c.status === "voided" ? "bg-slate-200 text-slate-500" : "bg-green-100 text-green-700"}`}>
                          {c.status}
                        </span>
                      </td>
                      <td className="py-2 pr-2">
                        {c.status !== "voided" && (
                          <button
                            onClick={() => voidCheck(c.id, c.check_number)}
                            data-testid={`void-check-${c.check_number}`}
                            className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 hover:bg-red-50 hover:border-red-300 hover:text-red-700"
                          >
                            <Ban size={11} /> Void
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
