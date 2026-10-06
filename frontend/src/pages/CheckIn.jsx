import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { Loader2, Inbox, Camera, Mic, Check, Upload } from "lucide-react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import ClientReviewPage from "@/pages/ClientReviewPage";

const API = `${process.env.REACT_APP_BACKEND_URL}/api/client-review`;
const PHOTO_TYPES = new Set([3, 4, 9]);
const TELL_TYPES = new Set([1, 8, 10, 13, 14]);
const GROUPS = [
  { key: "tap", title: "Just tap", hint: "~1 min", test: (t) => !PHOTO_TYPES.has(t) && !TELL_TYPES.has(t) },
  { key: "photo", title: "Snap a photo", hint: "", test: (t) => PHOTO_TYPES.has(t) },
  { key: "tell", title: "Tell us about it", hint: "voice ok", test: (t) => TELL_TYPES.has(t) },
];
const isOpen = (i) => !i.answered_at && !i.deferred && !i.parked_at;
const money = (n) => `$${Math.abs(Number(n || 0)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function itemTitle(i) {
  const meta = (i.context || {}).meta || {};
  const who = meta.merchant || meta.vendor || meta.contact_name || meta.txn_desc || meta.description || "";
  const amt = meta.amount ?? meta.txn_amount;
  if (!who && amt == null) return (i.prompt || "Check-in item").replace(/^Tell me about this money (out|in) — /i, "").replace(/\s*[—-]\s*what.*$/i, "").slice(0, 80) || "Check-in item";
  const map = {
    1: `${who || "Transaction"}${amt != null ? ` · ${money(amt)}` : ""} — what was it for?`,
    3: `${who || "Purchase"}${amt != null ? ` · ${money(amt)}` : ""} receipt`,
    6: `${who || "New charge"}${amt != null ? ` ${money(amt)}` : ""} — business?`,
    9: `${who || "Loan"} statement${amt != null ? ` · ${money(amt)}` : ""}`,
    10: `${who || "Meal"}${amt != null ? ` ${money(amt)}` : ""} — who with?`,
    11: `Owner's draw?${amt != null ? ` ${money(amt)}` : ""}${who ? ` ${who}` : ""}`,
    12: `${amt != null ? `${money(amt)} ` : ""}deposit — where from?`,
    13: `Check${amt != null ? ` ${money(amt)}` : ""} — who was it to?`,
    14: `${who || "Trip"}${amt != null ? ` ${money(amt)}` : ""} — what for?`,
  };
  return map[i.item_type] || i.prompt || "Check-in item";
}

function ActionPill({ type }) {
  if (PHOTO_TYPES.has(type)) return <span className="inline-flex items-center gap-1 text-xs font-bold px-3 py-2 rounded-xl bg-indigo-50 text-indigo-700">{type === 3 ? <Camera size={13} /> : <Upload size={13} />} {type === 3 ? "Snap" : "Upload"}</span>;
  if (TELL_TYPES.has(type)) return <span className="inline-flex items-center gap-1 text-xs font-bold px-3 py-2 rounded-xl bg-indigo-50 text-indigo-700"><Mic size={13} /> Tell</span>;
  return <span className="text-xs font-bold px-3 py-2 rounded-xl bg-slate-900 text-white">Answer</span>;
}

export default function CheckIn() {
  const { currentId, current } = useCompany();
  const [token, setToken] = useState(null);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeItem, setActiveItem] = useState(null);

  const load = useCallback(async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const r = await api.get(`/client-review/latest-for-company/${currentId}`);
      const tok = r.data?.client_token || null;
      setToken(tok);
      setSession(tok ? (await axios.get(`${API}/${tok}`)).data : null);
    } catch { setToken(null); setSession(null); }
    finally { setLoading(false); }
  }, [currentId]);

  useEffect(() => { load(); }, [load]);

  if (!currentId) return <div className="p-8 text-center text-sm text-slate-500" data-testid="checkin-no-company">Pick a company first.</div>;
  if (loading) return <div className="flex items-center gap-2 text-sm text-slate-500 py-10 justify-center" data-testid="checkin-loading"><Loader2 size={16} className="animate-spin" /> Loading check-in…</div>;

  const items = session?.items || [];
  const done = items.filter((i) => !isOpen(i)).length;
  const period = session?.period_label || new Date().toLocaleString("en-US", { month: "long" });

  if (activeItem && token) {
    return <ClientReviewPage key={activeItem} embedded cardMode token={token} startItemId={activeItem} onExit={() => { setActiveItem(null); load(); }} />;
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-4 pb-24" data-testid="checkin-page">
      <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">My business</div>
      <div className="flex items-end justify-between gap-2">
        <h1 className="text-xl font-bold text-slate-900">Quick Check-in · {period}</h1>
        {items.length > 0 && <div className="text-xs text-slate-500 font-medium shrink-0" data-testid="checkin-progress">{done} of {items.length} done</div>}
      </div>
      {items.length > 0 && <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden mt-2"><div className="h-full bg-emerald-500 rounded-full" style={{ width: `${Math.round(100 * done / items.length)}%` }} /></div>}
      {current?.name && <div className="text-xs text-slate-500 mt-1">{current.name}</div>}

      {!token || items.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white px-6 py-12 text-center mt-6" data-testid="checkin-empty">
          <Inbox size={26} className="mx-auto text-slate-400 mb-2" />
          <div className="text-base font-semibold text-slate-900">Nothing to check in on</div>
          <div className="text-sm text-slate-600 mt-1">Your books don't need anything from you right now.</div>
        </div>
      ) : GROUPS.map((g) => {
        const rows = items.filter((i) => g.test(i.item_type));
        if (!rows.length) return null;
        const open = rows.filter(isOpen).length;
        return (
          <section key={g.key} className="mt-5" data-testid={`checkin-group-${g.key}`}>
            <div className="text-[10px] uppercase tracking-widest text-slate-500 font-bold mb-2">{g.title} ({open}){g.hint ? ` · ${g.hint}` : ""}</div>
            <div className="space-y-2">
              {rows.map((i) => {
                const o = isOpen(i);
                return (
                  <button key={i.item_id} onClick={() => setActiveItem(i.item_id)}
                    className="w-full text-left bg-white border border-slate-200 rounded-2xl px-3.5 py-3 flex items-center gap-3 min-h-[60px] active:bg-slate-50"
                    data-testid={`checkin-row-${i.item_id}`}>
                    <span className={`w-6 h-6 rounded-full border-2 grid place-items-center shrink-0 ${o ? "border-slate-300" : "border-emerald-500 bg-emerald-500 text-white"}`}>{!o && <Check size={13} />}</span>
                    <span className="flex-1 min-w-0">
                      <span className={`block text-sm font-semibold leading-tight truncate ${o ? "text-slate-900" : "text-slate-400 line-through"}`}>{itemTitle(i)}</span>
                      <span className="block text-[11px] text-slate-500 mt-0.5 truncate">{(i.context?.meta?.txn_date || i.context?.meta?.date || "").slice(0, 10)}{i.context?.meta?.category ? ` · ${i.context.meta.category}` : ""}</span>
                    </span>
                    {o ? <ActionPill type={i.item_type} /> : <span className="text-[11px] font-bold text-emerald-600">{i.deferred ? "Sent" : "Done"}</span>}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
