import React, { useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Card, Pill, Big, Button, fmtDay, fmtWhole } from "./ui";
import { ReminderPreview } from "./OverdueInvoicesModal";
import { X, Check } from "lucide-react";

const SOURCE = { bill: "bill due", payroll: "payroll", sales_tax: "sales tax", loan: "loan payment", custom: "recurring", pattern: "recurring" };

export default function MoneyTab({ data, fmt, companyId, reload }) {
  const { money, cash } = data;
  const [previewing, setPreviewing] = useState(null);
  const [sent, setSent] = useState({});
  const [dates, setDates] = useState({});

  const remind = (inv) => setPreviewing(inv);
  const expect = async (inv) => {
    const d = dates[inv.id];
    if (!d) return;
    try {
      await api.post(`/companies/${companyId}/projections/invoices/${inv.id}/expected-date`, { expected_payment_date: d });
      toast.success(`${inv.number} now expected ${fmtDay(d)} — forecast updated.`);
      reload();
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not save."); }
  };

  const ledger = money.ledger;
  return (
    <div data-testid="owner-money-tab">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
        <Card eyebrow="Available cash" data-testid="owner-money-cash"><Big>{fmtWhole(fmt, cash.cash_today)}</Big><div className="text-xs text-slate-500 mt-2">{cash.accounts.map(a => `${a.name} ${fmtWhole(fmt, a.balance)}`).join(" · ")}</div></Card>
        <Card eyebrow="Customers owe you" data-testid="owner-money-ar"><Big>{fmtWhole(fmt, money.ar.total)}</Big><div className="text-xs text-slate-500 mt-2">{money.ar.overdue > 0 && <b className="text-rose-600">{fmtWhole(fmt, money.ar.overdue)} overdue · </b>}{money.ar.count} open invoice{money.ar.count === 1 ? "" : "s"}</div></Card>
        <Card eyebrow="Due in the next 30 days" data-testid="owner-money-due"><Big>{fmtWhole(fmt, Math.abs(cash.obligations_30d))}</Big><div className="text-xs text-slate-500 mt-2">Bills, loans, payroll, subscriptions and taxes</div></Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card data-testid="owner-money-ledger">
          <div className="flex items-center justify-between"><h2 className="font-heading text-xl">Your next 30 days</h2><span className="text-xs text-slate-500">{fmtDay(data.as_of)} → {fmtDay(cash.timeline[cash.timeline.length - 1]?.date)}</span></div>
          <div className="mt-3 divide-y divide-dashed divide-slate-200">
            {[
              ["Opening cash", "Today's bank balance", ledger.opening, ""],
              ["Expected collections", `Open invoices · each customer's usual pay timing${cash.excluded_ar.count ? ` · ${cash.excluded_ar.count} late invoice${cash.excluded_ar.count > 1 ? "s" : ""} not counted` : ""}`, ledger.collections, "up"],
              ["Bills & operating payments", "Vendor bills, payroll, taxes, loan payments", ledger.bills_operating, "down"],
              ["Recurring charges", "Subscriptions, insurance, utilities detected from your bank", ledger.recurring, "down"],
              ["Everyday spending", "Typical day-to-day activity not tied to a bill", ledger.drift_30d, ledger.drift_30d >= 0 ? "up" : "down"],
            ].map(([t, s, v, tone]) => (
              <div key={t} className="flex justify-between py-3">
                <div><div className="text-sm">{t}</div><div className="text-xs text-slate-500">{s}</div></div>
                <b className={`font-mono-num ${tone === "up" ? "text-emerald-600" : tone === "down" ? "text-rose-600" : ""}`}>{v > 0 && tone ? "+ " : v < 0 ? "− " : ""}{fmtWhole(fmt, Math.abs(v))}</b>
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-xl bg-slate-900 text-white p-4">
            <div className="text-xs text-slate-300">Projected ending cash · {fmtDay(cash.timeline[cash.timeline.length - 1]?.date)}</div>
            <div className="font-mono-num text-3xl font-medium mt-1" data-testid="owner-money-ending">{fmtWhole(fmt, ledger.ending)}</div>
            <div className={`text-xs mt-1 ${cash.shortfall ? "text-rose-300" : "text-emerald-300"}`}>{cash.shortfall ? "A shortfall is projected — see upcoming payments." : "No shortfall projected"} · worst case bottoms at {fmtWhole(fmt, cash.conservative_low_30d ?? cash.low_30d)}</div>
          </div>
        </Card>

        <Card data-testid="owner-money-upcoming">
          <h2 className="font-heading text-xl">Upcoming payments</h2>
          <div className="mt-3 divide-y divide-dashed divide-slate-200">
            {money.upcoming.map((u, i) => (
              <div key={i} className="flex justify-between py-2.5">
                <div><div className="text-sm">{u.label}</div><div className="text-xs text-slate-500">{fmtDay(u.date)} · {SOURCE[u.kind] || u.kind}{u.source === "plaid" ? " (from your bank)" : ""}</div></div>
                <b className="font-mono-num">{fmtWhole(fmt, Math.abs(u.amount))}</b>
              </div>
            ))}
            {money.upcoming.length === 0 && <div className="text-sm text-slate-500 py-6">Nothing scheduled in the next 30 days.</div>}
          </div>
          {money.upcoming_more > 0 && <div className="text-xs text-slate-500 mt-3">+ {money.upcoming_more} smaller items</div>}
        </Card>
      </div>

      <Card className="mt-4" data-testid="owner-money-collections">
        <div className="flex items-center justify-between"><h2 className="font-heading text-xl">Keep collections moving</h2><span className="text-xs text-slate-500">{money.invoices.length} open invoice{money.invoices.length === 1 ? "" : "s"}</span></div>
        {money.invoices.length === 0 ? <div className="text-sm text-slate-500 py-6">No open invoices — everyone has paid.</div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm mt-2">
              <thead><tr className="text-[10px] tracking-[0.1em] uppercase text-slate-500 border-b border-slate-200"><th className="text-left py-2 font-semibold">Customer / invoice</th><th className="text-left py-2 font-semibold">Due</th><th className="text-left py-2 font-semibold">Status</th><th className="text-right py-2 font-semibold">Amount</th><th className="text-right py-2 font-semibold">Action</th></tr></thead>
              <tbody>
                {money.invoices.map(inv => (
                  <tr key={inv.id} className="border-b border-slate-100" data-testid={`owner-invoice-row-${inv.id}`}>
                    <td className="py-3"><b>{inv.contact || "Customer"}</b> <span className="text-slate-500">· {inv.number}</span></td>
                    <td className="py-3 text-slate-600">{fmtDay(inv.due_date)}</td>
                    <td className="py-3">
                      {inv.days_overdue > 0 ? <Pill tone={inv.days_overdue > 30 ? "bad" : "warn"}>{inv.days_overdue} days overdue</Pill> : inv.status === "due_soon" ? <Pill tone="warn">Due soon</Pill> : <Pill tone="mute">Open</Pill>}
                      {inv.expected_payment_date && <span className="text-[11px] text-slate-500 ml-2">expected {fmtDay(inv.expected_payment_date)}</span>}
                    </td>
                    <td className="py-3 text-right font-mono-num">{fmtWhole(fmt, inv.balance)}</td>
                    <td className="py-3 text-right whitespace-nowrap">
                      {inv.days_overdue > 0 && !inv.expected_payment_date && (
                        <span className="inline-flex items-center gap-1 mr-2">
                          <input type="date" className="border rounded px-1.5 py-1 text-xs" value={dates[inv.id] || ""} onChange={e => setDates(p => ({ ...p, [inv.id]: e.target.value }))} data-testid={`owner-invoice-expect-date-${inv.id}`} />
                          <Button onClick={() => expect(inv)} disabled={!dates[inv.id]} data-testid={`owner-invoice-expect-save-${inv.id}`}>Expect</Button>
                        </span>
                      )}
                      {inv.days_overdue > 0
                        ? <Button primary={inv.days_overdue > 30} disabled={sent[inv.id]} onClick={() => remind(inv)} data-testid={`owner-invoice-remind-${inv.id}`}>{sent[inv.id] ? <span className="inline-flex items-center gap-1"><Check size={12} /> Sent</span> : "Send reminder"}</Button>
                        : <Button onClick={() => window.open(`/invoices/${inv.id}/edit`, "_self")} data-testid={`owner-invoice-view-${inv.id}`}>View</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {previewing && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget) setPreviewing(null); }} data-testid="money-reminder-modal">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl p-5 max-h-[calc(100dvh-2rem)] overflow-y-auto">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">{previewing.contact || "Customer"} · {previewing.number} · {fmtWhole(fmt, previewing.balance)}</div>
                <h2 className="font-heading text-xl">Review the reminder before it goes out</h2>
              </div>
              <button onClick={() => setPreviewing(null)} className="text-slate-500 hover:text-slate-900" data-testid="money-reminder-close"><X size={16} /></button>
            </div>
            <ReminderPreview companyId={companyId} inv={previewing} onBack={() => setPreviewing(null)}
              onSent={(inv) => { setSent((p) => ({ ...p, [inv.id]: true })); setPreviewing(null); }} />
          </div>
        </div>
      )}
    </div>
  );
}
