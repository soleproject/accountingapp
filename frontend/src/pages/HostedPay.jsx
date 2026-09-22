/**
 * HostedPay — public "Pay Now" page for an invoice's share link.
 *
 * URL: `/pay/:token`. No login required — possession of the token
 * (embedded in the invoice email link) is the auth.
 *
 * Card / ACH / Apple Pay / Google Pay are all captured by NMI's
 * `<NmiPayments>` Payment Component — the PAN never touches our
 * origin, which is what keeps us at SAQ-A. The one-time payment
 * token that comes back through `onPay` is POSTed to our public
 * `/pay/:token/sale` endpoint, which recomputes the amount
 * server-side (so a malicious browser can't dictate what to charge).
 */
import React, { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { NmiPayments } from "@nmipayments/nmi-pay-react";
import { Loader2, ShieldCheck, CheckCircle2, Info } from "lucide-react";
import axios from "axios";

const BASE = process.env.REACT_APP_BACKEND_URL;

async function fetchConfig(token) {
  const r = await axios.get(`${BASE}/api/pay/${token}/config`);
  return r.data;
}
async function postSale(token, body) {
  const r = await axios.post(`${BASE}/api/pay/${token}/sale`, body);
  return r.data;
}

function Money({ amount, currency = "USD" }) {
  return <>{new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount || 0)}</>;
}

function PayCard({ config, onPaid }) {
  const [method, setMethod] = useState("card"); // card | ach | apple_pay | google_pay
  const [saveToVault, setSaveToVault] = useState(false);
  const [customerEmail, setCustomerEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const inv = config.invoice;
  const dp = config.dual_pricing;
  const total = method === "card" ? dp.card_total : dp.ach_total;

  const onPay = async (event) => {
    setBusy(true); setMsg("");
    try {
      const res = await postSale(config.__token__, {
        payment_token: event.token,
        method,
        save_to_vault: saveToVault,
        customer_email: customerEmail,
      });
      if (res?.ok) {
        onPaid?.(res);
        return true;
      }
      return "Payment declined";
    } catch (e) {
      return e?.response?.data?.detail || "Payment failed — try again";
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-5">
      {/* Method chooser */}
      <div className="flex items-center gap-2 mb-4">
        {[
          { k: "card", label: "Card" },
          { k: "ach",  label: "Bank (ACH)" },
        ].map((m) => (
          <button
            key={m.k}
            type="button"
            onClick={() => setMethod(m.k)}
            className={`px-3 py-1.5 rounded-full text-[12px] font-semibold border ${
              method === m.k
                ? "bg-slate-900 text-white border-slate-900"
                : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
            }`}
            data-testid={`method-${m.k}`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Dual-pricing disclosure */}
      {dp.surcharge_pct > 0 && (
        <div className={`rounded-md text-[12px] px-3 py-2 mb-4 flex items-start gap-2 ${
          method === "card"
            ? "bg-amber-50 border border-amber-200 text-amber-800"
            : "bg-emerald-50 border border-emerald-200 text-emerald-800"
        }`}>
          <Info size={14} className="mt-0.5 shrink-0" />
          <div>
            {method === "card" ? (
              <>Card total includes a <b>{dp.surcharge_pct}%</b> surcharge of <b><Money amount={dp.surcharge_amount} /></b>.
              Pay by bank (ACH) to skip it: <b><Money amount={dp.ach_total} /></b>.</>
            ) : (
              <>Paying by bank saves the <b>{dp.surcharge_pct}%</b> card surcharge.</>
            )}
          </div>
        </div>
      )}

      {/* Customer email — helps us tie the transaction to a receipt */}
      <label className="block mb-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Email for receipt</div>
        <input
          type="email" value={customerEmail}
          onChange={(e) => setCustomerEmail(e.target.value)}
          placeholder="you@example.com"
          className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          data-testid="pay-email"
        />
      </label>

      {/* NMI Payment Component — hosted iframe fields */}
      <div className="rounded-xl border border-slate-200 p-3 bg-slate-50" data-testid="nmi-payment-mount">
        <NmiPayments
          tokenizationKey={config.tokenization_key}
          paymentMethods={method === "ach" ? ["ach"] : ["card", "apple-pay", "google-pay"]}
          expressCheckoutConfig={{
            amount: total.toFixed(2),
            currency: inv.currency || "USD",
            countryCode: "US",
          }}
          payButtonText={`Pay $${total.toFixed(2)}`}
          onPay={onPay}
        />
      </div>

      <label className="flex items-center gap-2 mt-3 text-[12px] text-slate-700">
        <input type="checkbox" checked={saveToVault} onChange={(e) => setSaveToVault(e.target.checked)} data-testid="save-vault" />
        Save this payment method for next time
      </label>

      <div className="mt-4 pt-3 border-t border-slate-200 flex items-center justify-between">
        <div className="text-[12px] text-slate-500 inline-flex items-center gap-1.5">
          <ShieldCheck size={12} className="text-emerald-600" /> Encrypted by NMI · your card is never sent to our servers
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-widest text-slate-500">You'll pay</div>
          <div className="text-xl font-bold text-slate-900"><Money amount={total} currency={inv.currency} /></div>
        </div>
      </div>

      {busy && <div className="mt-3 text-[12px] text-slate-500 inline-flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Processing…</div>}
      {msg  && <div className="mt-3 text-[12px] text-rose-700">{msg}</div>}
    </div>
  );
}

export default function HostedPay() {
  const { token } = useParams();
  const [config, setConfig] = useState(null);
  const [err, setErr] = useState("");
  const [paid, setPaid] = useState(null);

  useEffect(() => {
    fetchConfig(token)
      .then((c) => setConfig({ ...c, __token__: token }))
      .catch((e) => setErr(e?.response?.data?.detail || "Invoice not found"));
  }, [token]);

  const invoice = config?.invoice;
  const showPaidState = paid || invoice?.status === "paid";

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-white p-4 sm:p-8" data-testid="hosted-pay-page">
      <div className="max-w-lg mx-auto">
        {!config && !err && (
          <div className="flex justify-center py-24"><Loader2 className="animate-spin text-slate-400" /></div>
        )}
        {err && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 text-rose-800 p-6 text-center">
            <div className="font-semibold">Can't load this invoice</div>
            <div className="text-[13px] mt-1">{err}</div>
          </div>
        )}
        {config && (
          <>
            {/* Header — merchant + invoice summary */}
            <div className="text-center mb-5">
              <div className="text-[11px] uppercase tracking-widest font-semibold text-slate-500">{config.business_name}</div>
              <div className="text-2xl font-bold text-slate-900 mt-1">Invoice {invoice.number}</div>
              <div className="text-[13px] text-slate-500 mt-1">
                To {invoice.contact_name || "you"} · due {invoice.due_date || "on receipt"}
              </div>
              <div className="text-3xl font-extrabold text-slate-900 mt-4">
                <Money amount={invoice.balance_due} currency={invoice.currency} />
              </div>
            </div>

            {showPaidState ? (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 text-emerald-800 p-8 text-center" data-testid="paid-state">
                <CheckCircle2 size={40} className="mx-auto text-emerald-600" />
                <div className="text-lg font-bold mt-3">Payment received. Thank you!</div>
                <div className="text-[13px] mt-1">
                  A receipt will be emailed to you shortly.
                </div>
              </div>
            ) : (
              <PayCard config={config} onPaid={setPaid} />
            )}

            <div className="mt-6 text-center text-[11px] text-slate-400">
              Powered by <b>SmartBooks</b> · PCI DSS SAQ-A · NMI hosted fields
            </div>
          </>
        )}
      </div>
    </div>
  );
}
