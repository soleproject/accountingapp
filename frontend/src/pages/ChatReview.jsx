// ---------------------------------------------------------------------------
// Chat Review — light-theme companion to the 1/2/3 "Set Up: Review Books"
// checklist. Standard-mode only. Reads /reviewv2/chat-review-queue and books
// via /reviewv2/chat-review-book (or /check-review/{id}/assign for checks).
//
// Three sidebar tabs mirror the 3 buckets we surface:
//   1. No Category — one card per (contact, direction). Chat only.
//   2. Transactions — one card per (desc_group, direction). Contact-then-cat.
//   3. Checks — one card per unassigned check with manual fields + AI box.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft, MessageCircle, Send, Mic, MicOff, Check as CheckIcon,
  Plus, X, AlertTriangle, Loader2, Sparkles, MoreHorizontal,
} from "lucide-react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { toast } from "sonner";
import AccountPicker from "@/components/AccountPicker";
import { LinkModal, RowMoreMenu, SplitModal, ManualTxnModal } from "@/pages/Transactions";
import AskClientButton from "@/components/AskClientButton";

const TABS = [
  { key: "no_category",  label: "No Category",  sub: "Contacts without a category" },
  { key: "transactions", label: "Transactions", sub: "No-contact groups" },
  { key: "checks",       label: "Checks",       sub: "Manual entry or AI" },
];

export default function ChatReview() {
  const nav = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { currentId, companies } = useCompany();
  const company = companies?.find(c => c.id === currentId);
  const [queue, setQueue] = useState(null);
  const [loading, setLoading] = useState(true);
  const initialTab = (() => {
    const t = searchParams.get("tab");
    return ["no_category", "transactions", "checks"].includes(t) ? t : "no_category";
  })();
  const [tab, setTab] = useState(initialTab);
  const [idx, setIdx] = useState(0);

  // Keep the URL in sync with the active tab so the dashboard's chat-tile
  // deep-links land on the right section AND survive a browser refresh.
  useEffect(() => {
    const current = searchParams.get("tab");
    if (current !== tab) {
      setSearchParams({ tab }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  const [accounts, setAccounts] = useState([]);
  const [contacts, setContacts] = useState([]);

  const load = async (opts = {}) => {
    if (!currentId) return;
    setLoading(true);
    try {
      const [q, a, c] = await Promise.all([
        api.get(`/companies/${currentId}/reviewv2/chat-review-queue`),
        api.get(`/companies/${currentId}/accounts`),
        api.get(`/companies/${currentId}/contacts?limit=500`),
      ]);
      setQueue(q.data);
      setAccounts(a.data?.accounts || a.data || []);
      setContacts(c.data?.contacts || c.data?.items || c.data || []);
      if (opts.resetIdx !== false) setIdx(0);
    } catch (e) {
      toast.error("Couldn't load chat review queue");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentId]);

  // When the tab changes reset the pointer to the top card.
  useEffect(() => { setIdx(0); }, [tab]);

  const cards = queue ? (queue[tab] || []) : [];
  const activeCard = cards[idx] || null;

  const onDone = async () => {
    // Advance to next card. Reload if we've cleared the tab so the
    // progress bar / counts stay honest.
    if (idx + 1 < cards.length) {
      setIdx(idx + 1);
    } else {
      await load();
    }
  };

  // Refresh queue counts + samples WITHOUT advancing the pointer or
  // resetting to the top. Used after side actions like Link-to-invoice
  // that may remove a row from the current card's samples but shouldn't
  // move the CPA off the question they were reading.
  const refreshInPlace = () => load({ resetIdx: false });

  if (!currentId) {
    return <div className="p-8 text-slate-500">Pick a company first.</div>;
  }
  if (loading) {
    return (
      <div className="p-10 flex items-center gap-2 text-slate-500">
        <Loader2 className="animate-spin" size={16} /> Loading chat review…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50" data-testid="chat-review-page">
      <div className="max-w-6xl mx-auto px-6 pt-6 pb-24">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <button
            type="button"
            onClick={() => nav("/dashboard")}
            className="flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900"
            data-testid="chat-review-back"
          >
            <ArrowLeft size={16} /> Back to dashboard
          </button>
          <div className="text-sm text-slate-500">
            {company?.name || ""}
          </div>
        </div>

        {/* Progress bar */}
        <ProgressHeader progress={queue?.progress} />

        {/* Section tabs — horizontal 1/2/3 cards, styled like the
            "Set Up: Review Books" dashboard tile. */}
        <SectionTabs
          tab={tab} onTab={setTab}
          counts={{
            no_category:  queue?.no_category?.length  || 0,
            transactions: queue?.transactions?.length || 0,
            checks:       queue?.checks?.length       || 0,
          }}
        />

        {/* Body: single column card */}
        <div className="mt-4 min-w-0">
            {cards.length === 0 ? (
              <EmptyState tab={tab} />
            ) : (
              <>
                <div className="flex items-center justify-between mb-3 text-xs text-slate-500">
                  <span>
                    {tabLabel(tab)} · {idx + 1} of {cards.length}
                  </span>
                  <span>Biggest dollars first</span>
                </div>
                {tab === "no_category" && (
                  <NoCategoryCard
                    key={activeCard.card_key}
                    card={activeCard}
                    accounts={accounts}
                    contacts={contacts}
                    companyId={currentId}
                    onDone={onDone}
                    onRefresh={refreshInPlace}
                  />
                )}
                {tab === "transactions" && (
                  <TransactionsCard
                    key={activeCard.card_key}
                    card={activeCard}
                    accounts={accounts}
                    contacts={contacts}
                    companyId={currentId}
                    onDone={onDone}
                    onRefresh={refreshInPlace}
                    onContactCreated={c => setContacts([c, ...contacts])}
                  />
                )}
                {tab === "checks" && (
                  <CheckCard
                    key={activeCard.card_key}
                    card={activeCard}
                    accounts={accounts}
                    contacts={contacts}
                    companyId={currentId}
                    onDone={onDone}
                    onContactCreated={c => setContacts([c, ...contacts])}
                  />
                )}

              </>
            )}
        </div>
      </div>
      {cards.length > 0 && (
        <div
          className="fixed bottom-6 left-0 right-0 z-30 pointer-events-none"
          data-testid="chat-review-footer"
        >
          <div className="max-w-6xl mx-auto px-6 flex items-center justify-center gap-10 text-sm pointer-events-auto">
            <button
              type="button"
              onClick={() => setIdx(Math.max(0, idx - 1))}
              className="text-slate-500 hover:text-slate-800 disabled:opacity-40"
              disabled={idx === 0}
              data-testid="chat-review-back-card"
            >
              ← Back
            </button>
            <button
              type="button"
              onClick={onDone}
              className="text-slate-500 hover:text-slate-800"
              data-testid="chat-review-skip"
            >
              Skip for now
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// -------- pieces ----------------------------------------------------------

function ProgressHeader({ progress }) {
  const pct = progress?.pct_confirmed ?? 0;
  const q   = progress?.questions_left ?? 0;
  return (
    <div className="rounded-xl border bg-white p-4">
      <div className="flex items-center justify-between text-sm">
        <div>
          <span className="text-slate-600">Your books are </span>
          <span className="font-semibold text-slate-900">{pct}%</span>
          <span className="text-slate-600"> confirmed by dollar value</span>
        </div>
        <div className="text-slate-500" data-testid="chat-review-progress-count">
          {q} question{q === 1 ? "" : "s"} left
        </div>
      </div>
      <div className="mt-2 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-emerald-400 to-emerald-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function SectionTabs({ tab, onTab, counts }) {
  return (
    <div
      className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3"
      role="tablist"
      aria-label="Chat review sections"
    >
      {TABS.map((t, i) => {
        const active = t.key === tab;
        const n = counts[t.key] || 0;
        const empty = n === 0;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onTab(t.key)}
            data-testid={`chat-review-tab-${t.key}`}
            className={
              "flex items-center gap-3 rounded-xl p-3 text-left transition-colors " +
              (active
                ? "border border-indigo-300 bg-indigo-50/60 shadow-sm ring-1 ring-indigo-100"
                : "border border-slate-200 bg-white hover:bg-slate-50")
            }
          >
            <div className={
              "shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold " +
              (active ? "bg-indigo-600 text-white"
                      : empty ? "bg-emerald-100 text-emerald-600"
                              : "bg-slate-100 text-slate-500")
            }>
              {empty ? <CheckIcon size={14} /> : (i + 1)}
            </div>
            <div className="min-w-0 flex-1">
              <div className={"text-sm font-semibold " + (active ? "text-slate-900" : "text-slate-800")}>
                {t.label}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                {empty ? "All clear" : `${n} question${n === 1 ? "" : "s"}`}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function EmptyState({ tab }) {
  return (
    <div className="rounded-xl border bg-white p-10 text-center">
      <CheckIcon size={28} className="mx-auto text-emerald-500 mb-2" />
      <div className="font-semibold text-slate-900">All clear in this section</div>
      <div className="text-sm text-slate-500 mt-1">
        Nothing left to review under "{tabLabel(tab)}" right now.
      </div>
    </div>
  );
}

function tabLabel(tab) {
  return TABS.find(t => t.key === tab)?.label || "";
}

// -------- Card 1 — No Category (chat-only) --------------------------------

function NoCategoryCard({ card, accounts, contacts, companyId, onDone, onRefresh }) {
  const [text, setText] = useState("");
  const [proposing, setProposing] = useState(false);
  const [proposal, setProposal] = useState(null);
  const [override, setOverride] = useState(null);          // account id
  const [saveRule, setSaveRule] = useState(false);
  const [booking, setBooking] = useState(false);

  const propose = async () => {
    if (!text.trim()) return;
    setProposing(true);
    try {
      const r = await api.post(`/companies/${companyId}/reviewv2/ai-propose`, {
        context: card.context_row,
        user_answer: text,
      });
      setProposal(r.data);
      setOverride(null);
    } catch (e) {
      toast.error("AI proposal failed");
    } finally {
      setProposing(false);
    }
  };

  const accountIdToBook = override || findAccountIdFromProposal(proposal, accounts);
  const canConfirm = !!accountIdToBook;

  const book = async () => {
    if (!canConfirm) return;
    setBooking(true);
    try {
      await api.post(`/companies/${companyId}/reviewv2/chat-review-book`, {
        card_kind: "no_category",
        card_key: card.card_key,
        txn_ids: card.txn_ids,
        category_account_id: accountIdToBook,
        direction: card.direction,
        save_as_rule: saveRule,
        contact_id: card.contact_id,
      });
      toast.success(`Booked ${card.count} row${card.count === 1 ? "" : "s"}`);
      await onDone();
    } catch (e) {
      toast.error("Booking failed");
    } finally {
      setBooking(false);
    }
  };

  return (
    <div className="rounded-2xl border bg-white shadow-sm p-6" data-testid="chat-review-nocat-card">
      <DirBadge direction={card.direction} />
      <h2 className="mt-2 text-2xl font-heading font-semibold text-slate-900">
        {card.prompt}
      </h2>
      <div className="mt-1 text-sm text-slate-500">
        <b className="text-slate-700">{card.contact_name}</b>
        {" · "}{card.count} transaction{card.count === 1 ? "" : "s"}
        {" · "}${fmt(card.total_dollars)} total
      </div>
      <SamplesList samples={card.samples} companyId={companyId}
                   accounts={accounts} contacts={contacts}
                   onLinked={onRefresh} />
      <ChatBox
        text={text} setText={setText} onSend={propose} busy={proposing}
        placeholder="e.g. this is my landscape client — service revenue"
      />
      <ProposalBlock
        proposal={proposal}
        accounts={accounts}
        companyId={companyId}
        override={override} setOverride={setOverride}
        saveRule={saveRule} setSaveRule={setSaveRule}
        onConfirm={book} confirming={booking}
        canConfirm={canConfirm}
        ruleScope={
          card.direction === "in"
            ? `Every future deposit from ${card.contact_name}`
            : `Every future payment to ${card.contact_name}`
        }
      />
    </div>
  );
}

// -------- Card 2 — Transactions -------------------------------------------

function TransactionsCard({ card, accounts, contacts, companyId, onDone, onRefresh, onContactCreated }) {
  const [contactId, setContactId]  = useState(null);
  const [contactQ, setContactQ]    = useState("");
  const [contactPicked, setPicked] = useState(false);
  const [text, setText]            = useState("");
  const [proposing, setProposing]  = useState(false);
  const [proposal, setProposal]    = useState(null);
  const [override, setOverride]    = useState(null);
  const [saveRule, setSaveRule]    = useState(false);
  const [booking, setBooking]      = useState(false);
  const [busyContact, setBusy]     = useState(false);

  const matches = useMemo(() => {
    const n = contactQ.trim().toLowerCase();
    if (!n) return [];
    return contacts.filter(c =>
      ((c.display_name || c.name || "").toLowerCase().includes(n))
    ).slice(0, 8);
  }, [contactQ, contacts]);

  const pickContact = (c) => {
    setContactId(c.id);
    setContactQ(c.display_name || c.name || "");
    setPicked(true);
  };

  const createContact = async () => {
    const nm = contactQ.trim();
    if (!nm) return;
    setBusy(true);
    try {
      const r = await api.post(`/companies/${companyId}/contacts`, {
        name: nm, type: "vendor",
      });
      const c = r.data;
      onContactCreated?.(c);
      pickContact(c);
    } catch { toast.error("Couldn't create contact"); }
    finally { setBusy(false); }
  };

  const skipContact = () => setPicked(true);

  const propose = async () => {
    if (!text.trim()) return;
    setProposing(true);
    try {
      const r = await api.post(`/companies/${companyId}/reviewv2/ai-propose`, {
        context: card.context_row,
        user_answer: text,
      });
      setProposal(r.data);
      setOverride(null);
    } catch { toast.error("AI proposal failed"); }
    finally { setProposing(false); }
  };

  const accountIdToBook = override || findAccountIdFromProposal(proposal, accounts);
  const canConfirm = !!accountIdToBook;

  const book = async () => {
    if (!canConfirm) return;
    setBooking(true);
    try {
      await api.post(`/companies/${companyId}/reviewv2/chat-review-book`, {
        card_kind: "transactions",
        card_key: card.card_key,
        group_key: card.group_key,
        direction: card.direction,
        txn_ids: card.txn_ids,
        contact_id: contactId || null,
        category_account_id: accountIdToBook,
        save_as_rule: saveRule,
      });
      toast.success(`Booked ${card.count} row${card.count === 1 ? "" : "s"}`);
      await onDone();
    } catch { toast.error("Booking failed"); }
    finally { setBooking(false); }
  };

  return (
    <div className="rounded-2xl border bg-white shadow-sm p-6" data-testid="chat-review-txn-card">
      <DirBadge direction={card.direction} />
      <h2 className="mt-2 text-2xl font-heading font-semibold text-slate-900">
        {card.prompt}
      </h2>
      <div className="mt-1 text-sm text-slate-500">
        <b className="text-slate-700">{card.group_label}</b>
        {" · "}{card.count} transaction{card.count === 1 ? "" : "s"}
        {" · "}${fmt(card.total_dollars)} total
      </div>
      <SamplesList samples={card.samples} companyId={companyId}
                   accounts={accounts} contacts={contacts}
                   onLinked={onRefresh} />

      {/* Step A — contact question */}
      {!contactPicked && (
        <div className="mt-5 rounded-lg border border-indigo-200 bg-indigo-50/40 p-4"
             data-testid="chat-review-txn-contact-step">
          <div className="text-sm font-semibold text-slate-800">
            {card.contact_question}
          </div>
          <div className="mt-2 relative">
            <input
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white
                         focus:outline-none focus:ring-2 focus:ring-indigo-200"
              placeholder="Search a contact, or type a new name…"
              value={contactQ}
              onChange={e => { setContactQ(e.target.value); setContactId(null); }}
              data-testid="chat-review-txn-contact-input"
            />
            {contactQ && matches.length > 0 && !contactId && (
              <div className="absolute z-10 left-0 right-0 mt-1 rounded-lg border bg-white shadow max-h-52 overflow-y-auto">
                {matches.map(c => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => pickContact(c)}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50"
                  >
                    {c.display_name || c.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={createContact}
              disabled={!contactQ.trim() || busyContact}
              className="rounded-lg px-3 py-1.5 text-sm bg-indigo-600 text-white
                         hover:bg-indigo-700 disabled:opacity-40 flex items-center gap-1"
              data-testid="chat-review-txn-create-contact"
            >
              <Plus size={14} /> Create contact
            </button>
            <button
              type="button"
              onClick={() => contactId && setPicked(true)}
              disabled={!contactId}
              className="rounded-lg px-3 py-1.5 text-sm bg-emerald-600 text-white
                         hover:bg-emerald-700 disabled:opacity-40"
              data-testid="chat-review-txn-use-contact"
            >
              Use this contact
            </button>
            <button
              type="button"
              onClick={skipContact}
              className="rounded-lg px-3 py-1.5 text-sm bg-white border border-slate-300 hover:bg-slate-50"
              data-testid="chat-review-txn-skip-contact"
            >
              No specific contact
            </button>
          </div>
        </div>
      )}

      {/* Step B — category chat */}
      {contactPicked && (
        <>
          {contactId && (
            <div className="mt-4 text-xs text-slate-500">
              Contact linked: <b className="text-slate-700">{contactQ}</b>{" "}
              <button className="text-indigo-600 hover:underline"
                onClick={() => { setPicked(false); setContactId(null); }}>
                change
              </button>
            </div>
          )}
          <ChatBox
            text={text} setText={setText} onSend={propose} busy={proposing}
            placeholder="e.g. these are transfers to my Chase savings"
          />
          <ProposalBlock
            proposal={proposal}
            accounts={accounts}
            companyId={companyId}
            override={override} setOverride={setOverride}
            saveRule={saveRule} setSaveRule={setSaveRule}
            onConfirm={book} confirming={booking}
            canConfirm={canConfirm}
            ruleScope={
              card.direction === "in"
                ? `Every future deposit tagged "${card.group_label}"`
                : `Every future payment tagged "${card.group_label}"`
            }
          />
        </>
      )}
    </div>
  );
}

// -------- Card 3 — Checks (manual fields + AI box) ------------------------

function CheckCard({ card, accounts, contacts, companyId, onDone, onContactCreated }) {
  const [payeeQ, setPayeeQ]        = useState("");
  const [contactId, setContactId]  = useState(null);
  const [lines, setLines]          = useState([{ category_account_id: "", amount: card.amount }]);
  const [saveRule, setSaveRule]    = useState(false);
  const [aiText, setAiText]        = useState("");
  const [aiBusy, setAiBusy]        = useState(false);
  const [aiProposal, setAi]        = useState(null);
  const [busy, setBusy]            = useState(false);

  const matches = useMemo(() => {
    const n = payeeQ.trim().toLowerCase();
    if (!n) return [];
    return contacts.filter(c =>
      ((c.display_name || c.name || "").toLowerCase().includes(n))
    ).slice(0, 8);
  }, [payeeQ, contacts]);

  const pickContact = (c) => {
    setContactId(c.id);
    setPayeeQ(c.display_name || c.name || "");
  };

  const askAi = async () => {
    if (!aiText.trim()) return;
    setAiBusy(true);
    try {
      const r = await api.post(`/companies/${companyId}/reviewv2/ai-propose`, {
        context: {
          ...card.context_row,
          description: `Check #${card.check_number || "?"} · ${card.description || ""}`,
        },
        user_answer: aiText,
      });
      setAi(r.data);
      // Auto-fill category if the AI suggested one
      const acctId = findAccountIdFromProposal(r.data, accounts);
      if (acctId) setLines([{ category_account_id: acctId, amount: card.amount }]);
      if (r.data?.payee_name && !payeeQ) setPayeeQ(r.data.payee_name);
    } catch { toast.error("AI proposal failed"); }
    finally { setAiBusy(false); }
  };

  const addLine = () => setLines([...lines, { category_account_id: "", amount: 0 }]);
  const rmLine  = (i) => setLines(lines.filter((_, j) => j !== i));
  const setLine = (i, patch) => setLines(lines.map((l, j) => j === i ? { ...l, ...patch } : l));

  const total = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
  const balanced = Math.abs(total - card.amount) < 0.005;

  const save = async () => {
    if (!payeeQ.trim()) { toast.error("Pick or enter a payee"); return; }
    if (!balanced) { toast.error(`Lines total $${fmt(total)} ≠ check amount $${fmt(card.amount)}`); return; }
    if (lines.some(l => !l.category_account_id)) { toast.error("Every line needs a category"); return; }
    setBusy(true);
    try {
      await api.post(`/companies/${companyId}/check-review/${card.txn_id}/assign`, {
        contact_id: contactId || null,
        create_contact_name: contactId ? null : payeeQ.trim(),
        line_items: lines.map(l => ({
          category_account_id: l.category_account_id,
          amount: Number(l.amount),
          description: "",
        })),
        save_as_rule: saveRule,
        mark_reviewed: true,
      });
      toast.success(`Check #${card.check_number || ""} booked`);
      await onDone();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Save failed");
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-2xl border bg-white shadow-sm p-6" data-testid="chat-review-check-card">
      <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
        Checks · Check #{card.check_number || "—"}
      </div>
      <h2 className="mt-2 text-2xl font-heading font-semibold text-slate-900">
        {card.prompt}
      </h2>
      <div className="mt-1 text-sm text-slate-500">
        {card.date} · <b className="text-slate-700">${fmt(card.amount)}</b>
        {card.description && (
          <> · <span className="font-mono text-[11px]">{card.description}</span></>
        )}
      </div>

      <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* LEFT: manual fields */}
        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold text-slate-600">Payee</label>
            <div className="mt-1 relative">
              <input
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm
                           focus:outline-none focus:ring-2 focus:ring-indigo-200"
                placeholder="Search or type new payee…"
                value={payeeQ}
                onChange={e => { setPayeeQ(e.target.value); setContactId(null); }}
                data-testid="chat-review-check-payee-input"
              />
              {payeeQ && matches.length > 0 && !contactId && (
                <div className="absolute z-10 left-0 right-0 mt-1 rounded-lg border bg-white shadow max-h-52 overflow-y-auto">
                  {matches.map(c => (
                    <button key={c.id} type="button" onClick={() => pickContact(c)}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50">
                      {c.display_name || c.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="text-[11px] text-slate-400 mt-1">
              {contactId ? "Existing contact linked" : payeeQ ? "New contact will be created on save" : ""}
            </div>
          </div>

          {lines.map((l, i) => (
            <div key={i} className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <label className="text-xs font-semibold text-slate-600">
                  {lines.length === 1 ? "Category" : `Split ${i + 1}`}
                </label>
                <div className="mt-1">
                  <AccountPicker
                    value={l.category_account_id}
                    accounts={accounts}
                    onChange={id => setLine(i, { category_account_id: id })}
                    companyId={companyId}
                    testId={`chat-review-check-cat-${i}`}
                  />
                </div>
              </div>
              <div className="w-28 shrink-0">
                <label className="text-xs font-semibold text-slate-600">Amount</label>
                <input type="number" step="0.01"
                  className="w-full border border-slate-300 rounded-lg px-2 py-2 text-sm
                             focus:outline-none focus:ring-2 focus:ring-indigo-200"
                  value={l.amount}
                  onChange={e => setLine(i, { amount: e.target.value })}
                />
              </div>
              {lines.length > 1 && (
                <button type="button" onClick={() => rmLine(i)}
                  className="mt-6 text-slate-400 hover:text-rose-600" aria-label="Remove line">
                  <X size={16} />
                </button>
              )}
            </div>
          ))}
          <div className="flex items-center justify-between text-xs">
            <button type="button" onClick={addLine}
              className="text-indigo-600 hover:underline flex items-center gap-1">
              <Plus size={12} /> Add split line
            </button>
            <div className={balanced ? "text-emerald-600" : "text-amber-600 flex items-center gap-1"}>
              {balanced ? <CheckIcon size={12} /> : <AlertTriangle size={12} />}
              ${fmt(total)} / ${fmt(card.amount)}
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-600 mt-1">
            <input type="checkbox" checked={saveRule} onChange={e => setSaveRule(e.target.checked)}
                   data-testid="chat-review-check-save-rule" />
            Always book this payee to this category (create rule)
          </label>
          <RuleHint
            active={saveRule}
            scope={payeeQ.trim() ? `Every future check to ${payeeQ.trim()}` : null}
            accountName={accounts.find(a => a.id === lines[0]?.category_account_id)?.name}
          />
        </div>

        {/* RIGHT: AI chat */}
        <div className="rounded-lg border border-slate-200 bg-slate-50/40 p-3">
          <div className="text-xs font-semibold text-slate-600 flex items-center gap-1">
            <Sparkles size={12} className="text-indigo-500" /> Or describe it and let AI fill this in
          </div>
          <ChatBox
            text={aiText} setText={setAiText} onSend={askAi} busy={aiBusy}
            placeholder='e.g. "rent for June — Regus"'
            compact
          />
          {aiProposal && aiProposal.ok && (
            <div className="mt-3 text-xs text-slate-600 space-y-1">
              <div><b className="text-slate-800">AI:</b> {aiProposal.reason || "Suggestion applied to the form."}</div>
              {aiProposal.category_name && (
                <div>Category: <b className="text-slate-800">{aiProposal.category_name}</b></div>
              )}
              {aiProposal.payee_name && (
                <div>Payee: <b className="text-slate-800">{aiProposal.payee_name}</b></div>
              )}
              <div className="text-slate-400">Review the fields on the left, then Save.</div>
            </div>
          )}
        </div>
      </div>

      <div className="mt-5 flex items-center justify-end gap-2">
        <button type="button" onClick={save} disabled={busy}
          className="rounded-lg px-4 py-2 text-sm bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40"
          data-testid="chat-review-check-save">
          {busy ? "Saving…" : "Save check"}
        </button>
      </div>
    </div>
  );
}

// -------- shared UI bits --------------------------------------------------

function DirBadge({ direction }) {
  const cls = direction === "in"
    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
    : "bg-rose-50 text-rose-700 border-rose-200";
  const label = direction === "in" ? "↗ MONEY IN" : "↙ MONEY OUT";
  return (
    <span className={`inline-block text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded border ${cls}`}>
      {label}
    </span>
  );
}

function SamplesList({ samples, companyId, accounts, contacts, onLinked }) {
  // Modal state — same shape as Transactions.jsx (line 1043-1045, 1093).
  const [editing, setEditing]   = useState(null);
  const [splitting, setSplitting] = useState(null);
  const [linking, setLinking]   = useState(null);
  const [askClient, setAskClient] = useState(null);

  // Fetch the full txn record before opening Edit / Split / Ask-client
  // — the sample stub only carries id/date/amount/desc, and those
  // modals expect the full ledger row.
  const fetchFull = async (sample) => {
    try {
      const r = await api.get(`/companies/${companyId}/transactions/${sample.id}`);
      return r.data;
    } catch {
      toast.error("Couldn't load transaction");
      return null;
    }
  };

  const doEdit = async (s) => {
    const t = await fetchFull(s);
    if (t) setEditing(t);
  };
  const doSplit = async (s) => {
    const t = await fetchFull(s);
    if (t) setSplitting(t);
  };
  const doLink = async (s) => {
    // LinkModal only needs id + amount + contact_id — the sample has all three.
    setLinking({
      id:         s.id,
      amount:     s.amount_raw ?? s.amount,
      contact_id: s.contact_id || null,
    });
  };
  const doAskClient = async (s) => {
    const t = await fetchFull(s);
    if (t) setAskClient(t);
  };
  const doRecategorize = async (s) => {
    try {
      await api.post(`/companies/${companyId}/ai/recategorize/${s.id}`);
      toast.success("Re-categorized");
      onLinked?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "AI re-categorize failed");
    }
  };
  const doDelete = async (s) => {
    if (!window.confirm("Delete this transaction?")) return;
    try {
      await api.delete(`/companies/${companyId}/transactions/${s.id}`);
      toast.success("Deleted");
      onLinked?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Delete failed");
    }
  };
  const closeAndRefresh = () => {
    setEditing(null); setSplitting(null); setLinking(null); setAskClient(null);
    onLinked?.();
  };

  const contactOptions = useMemo(
    () => (contacts || []).map(c => ({
      value: c.id, label: c.display_name || c.name || "",
    })),
    [contacts],
  );

  if (!samples || samples.length === 0) return null;
  return (
    <div className="mt-3">
      <ul
        className={
          "space-y-1 text-[12px] text-slate-500 font-mono " +
          "max-h-40 overflow-y-auto pr-2 " +
          "scrollbar-thin scrollbar-thumb-slate-200 hover:scrollbar-thumb-slate-300 scrollbar-track-transparent"
        }
        data-testid="chat-review-samples"
      >
        {samples.map((s, i) => (
          <li key={s.id || i} className="flex items-center gap-3 group">
            <span className="text-slate-400 w-24 shrink-0">{s.date}</span>
            <span className="text-slate-700 w-24 shrink-0">${fmt(s.amount)}</span>
            <span className="text-slate-400 truncate flex-1 min-w-0" title={s.desc}>{s.desc}</span>
            {s.id && companyId && (
              <div className="shrink-0" data-testid={`chat-review-row-menu-${i}`}>
                <RowMoreMenu
                  t={{ id: s.id, ...s }}
                  onEdit={() => doEdit(s)}
                  onRecategorize={() => doRecategorize(s)}
                  onSplit={() => doSplit(s)}
                  onLink={() => doLink(s)}
                  onAskClient={() => doAskClient(s)}
                  onDelete={() => doDelete(s)}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
      {samples.length > 5 && (
        <div className="mt-1 text-[10px] text-slate-400">
          Scroll to see all {samples.length}
        </div>
      )}
      {editing && (
        <ManualTxnModal
          accts={accounts || []}
          currentId={companyId}
          contactOptions={contactOptions}
          invoices={[]} bills={[]}
          initialTxn={editing}
          onClose={closeAndRefresh}
          onOpenMultiLink={() => {
            setLinking({
              id: editing.id,
              amount: editing.amount,
              contact_id: editing.contact_id || null,
            });
            setEditing(null);
          }}
        />
      )}
      {splitting && (
        <SplitModal
          txn={splitting}
          accts={accounts || []}
          currentId={companyId}
          onClose={closeAndRefresh}
        />
      )}
      {linking && (
        <LinkModal
          txn={linking}
          invoices={null}
          bills={null}
          currentId={companyId}
          onClose={closeAndRefresh}
        />
      )}
      {askClient && (
        <AskClientButton
          txn={askClient}
          open
          onClose={() => setAskClient(null)}
          onAsked={closeAndRefresh}
        />
      )}
    </div>
  );
}

function ChatBox({ text, setText, onSend, busy, placeholder, compact }) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const mediaRef  = useRef(null);   // MediaRecorder
  const chunksRef = useRef([]);
  const streamRef = useRef(null);

  const stopStream = () => {
    try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch {}
    streamRef.current = null;
  };

  const startRecording = async () => {
    if (recording || transcribing) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error("Mic not supported in this browser");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      // Pick the first mime the browser supports. Safari doesn't support
      // audio/webm; audio/mp4 is a decent fallback there.
      const candidates = [
        "audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg",
      ];
      const mimeType = candidates.find(m => MediaRecorder.isTypeSupported?.(m)) || "";
      const mr = mimeType ? new MediaRecorder(stream, { mimeType })
                          : new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stopStream();
        const type = mr.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        if (blob.size === 0) return;
        setTranscribing(true);
        try {
          const ext = type.includes("mp4") ? "m4a"
                    : type.includes("ogg") ? "ogg"
                    : "webm";
          const fd = new FormData();
          fd.append("audio", blob, `clip.${ext}`);
          const r = await api.post(`/reviewv2/transcribe`, fd, {
            headers: { "Content-Type": "multipart/form-data" },
          });
          const t = (r.data?.text || "").trim();
          if (!t) toast.error("Didn't catch that — try again");
          else setText((prev) => (prev ? prev.trim() + " " + t : t));
        } catch (e) {
          toast.error(e?.response?.data?.detail || "Transcription failed");
        } finally { setTranscribing(false); }
      };
      mr.start();
      mediaRef.current = mr;
      setRecording(true);
    } catch (e) {
      stopStream();
      toast.error(e?.message || "Couldn't access the microphone");
    }
  };

  const stopRecording = () => {
    try { mediaRef.current?.stop(); } catch {}
    mediaRef.current = null;
    setRecording(false);
  };

  const toggleMic = () => (recording ? stopRecording() : startRecording());

  // Stop the recorder if the component unmounts mid-record.
  useEffect(() => () => { try { mediaRef.current?.stop(); } catch {} stopStream(); }, []);

  const micBusy = transcribing;
  const micActive = recording;
  return (
    <div className={compact ? "mt-2" : "mt-5"}>
      {!compact && (
        <div className="text-[11px] text-slate-500 flex items-center gap-1 mb-1">
          <MessageCircle size={12} /> Tell us in your own words —
          <span className="text-slate-400">the AI will propose a booking. Nothing posts until you confirm.</span>
        </div>
      )}
      <div className={
        "flex items-center gap-2 border rounded-lg bg-white focus-within:ring-2 focus-within:ring-indigo-200 " +
        (micActive ? "border-rose-300 ring-1 ring-rose-200" : "border-slate-300")
      }>
        <input
          type="text"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !busy) onSend(); }}
          className="flex-1 px-3 py-2 text-sm bg-transparent outline-none"
          placeholder={micActive ? "Listening…" : (micBusy ? "Transcribing…" : placeholder)}
          disabled={micActive || micBusy}
          data-testid="chat-review-input"
        />
        <button
          type="button"
          onClick={toggleMic}
          disabled={micBusy || busy}
          className={
            "p-2 rounded-md transition-colors " +
            (micActive ? "text-rose-600 hover:bg-rose-50" :
             micBusy   ? "text-slate-400" :
                          "text-slate-500 hover:text-slate-800 hover:bg-slate-50")
          }
          title={micActive ? "Stop recording" : "Hold to dictate (Whisper)"}
          data-testid="chat-review-mic"
          aria-label={micActive ? "Stop recording" : "Start recording"}
        >
          {micBusy ? <Loader2 size={16} className="animate-spin" />
                   : micActive ? <MicOff size={16} />
                               : <Mic size={16} />}
        </button>
        <button
          type="button" onClick={onSend} disabled={busy || !text.trim() || micActive || micBusy}
          className="mr-1 my-1 rounded-md p-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white"
          data-testid="chat-review-send"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        </button>
      </div>
      {micActive && (
        <div className="mt-1 text-[11px] text-rose-600 flex items-center gap-1" data-testid="chat-review-recording">
          <span className="inline-block w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
          Recording — click the mic again to stop
        </div>
      )}
    </div>
  );
}

function ProposalBlock({
  proposal, accounts, companyId,
  override, setOverride, saveRule, setSaveRule,
  onConfirm, confirming, canConfirm, ruleScope,
}) {
  if (!proposal) return null;
  if (!proposal.ok) {
    return (
      <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/50 p-3 text-xs text-amber-800">
        <b>AI couldn't parse a suggestion.</b>{" "}
        {proposal.reason || "Try describing it in a slightly different way."}
      </div>
    );
  }
  const aiAccountId = findAccountIdFromProposal(proposal, accounts);
  const currentId = override || aiAccountId;
  const currentAccount = accounts.find(a => a.id === currentId);
  return (
    <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/50 p-4"
         data-testid="chat-review-proposal">
      <div className="text-xs text-slate-500 uppercase tracking-wider mb-1 font-semibold">
        AI suggestion
      </div>
      <div className="text-sm text-slate-800">
        {proposal.reason || proposal.rationale || "Booking suggested below."}
      </div>
      <div className="mt-3">
        <div className="text-xs font-semibold text-slate-600 mb-1">Category</div>
        <AccountPicker
          value={currentId}
          accounts={accounts}
          onChange={id => setOverride(id)}
          companyId={companyId}
          isOverridden={!!override && override !== aiAccountId}
          testId="chat-review-proposal-account"
        />
      </div>
      <label className="mt-3 flex items-center gap-2 text-xs text-slate-600">
        <input type="checkbox" checked={saveRule} onChange={e => setSaveRule(e.target.checked)}
               data-testid="chat-review-save-rule" />
        Always book this to the same category (save as rule)
      </label>
      <RuleHint active={saveRule} scope={ruleScope} accountName={currentAccount?.name} />
      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button" onClick={onConfirm} disabled={!canConfirm || confirming}
          className="rounded-lg px-4 py-2 text-sm bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40"
          data-testid="chat-review-confirm"
        >
          {confirming ? "Booking…" : "Confirm & book"}
        </button>
      </div>
    </div>
  );
}

// Small animated banner under the "Save as rule" checkbox that spells out
// exactly what future rows will auto-book to. Only renders when the
// checkbox is ticked AND a category is picked.
function RuleHint({ active, scope, accountName }) {
  if (!active || !accountName || !scope) return null;
  return (
    <div
      className={
        "mt-2 rounded-md border border-indigo-200 bg-indigo-50/70 " +
        "px-3 py-2 text-[12px] text-indigo-900 flex items-start gap-2 " +
        "animate-in fade-in slide-in-from-top-1 duration-200"
      }
      role="status"
      data-testid="chat-review-rule-hint"
    >
      <Sparkles size={12} className="mt-0.5 shrink-0 text-indigo-500" />
      <div className="min-w-0">
        <b>{scope}</b> will book to{" "}
        <b className="text-indigo-700">{accountName}</b> automatically from now on.
        You can edit this rule anytime in Settings → Rules.
      </div>
    </div>
  );
}

// -------- helpers ---------------------------------------------------------

function fmt(n) {
  return Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

// The ai-propose endpoint returns free-form JSON — we try to find the
// account id in a couple of common shapes.
function findAccountIdFromProposal(p, accounts) {
  if (!p) return null;
  if (p.category_account_id) return p.category_account_id;
  const byCode = (c) => c && accounts.find(a => (a.code || "").toString() === c.toString())?.id;
  const byName = (n) => n && accounts.find(a =>
    (a.name || "").toLowerCase() === (n || "").toLowerCase())?.id;
  return (
    byCode(p.account_code || p.code) ||
    byName(p.category_name || p.account_name || p.name) ||
    null
  );
}
