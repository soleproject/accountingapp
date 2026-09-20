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
  Plus, X, AlertTriangle, Loader2, Sparkles, MoreHorizontal, RotateCcw,
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

export default function ChatReview({ embedded = false, companyId: companyIdProp } = {}) {
  const nav = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const ctxCompany = useCompany();
  const currentId = companyIdProp || ctxCompany.currentId;
  const companies = ctxCompany.companies;
  const company = companies?.find(c => c.id === currentId);
  const [queue, setQueue] = useState(null);
  const [loading, setLoading] = useState(true);
  const initialTab = (() => {
    const t = searchParams.get("tab");
    return ["no_category", "transactions", "checks"].includes(t) ? t : "no_category";
  })();
  const [tab, setTab] = useState(initialTab);
  const [idx, setIdx] = useState(0);
  // Snapshot of the URL's `card` param taken ONCE at first mount — we
  // use it to seek the queue to the right position after the initial
  // fetch, then never read from the URL again (subsequent navigation
  // WRITES to the URL, but reads back can trigger flicker loops).
  const initialCardKeyRef = useRef(searchParams.get("card"));

  // Keep the URL in sync with the active tab AND the current card_key
  // so a browser refresh lands the CPA back on the same question. The
  // card_key is more robust than an index because peels/booked cards
  // can shift the queue between refreshes.
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
      // Idx reconciliation happens in the effect below (watches
      // `cards`), because idx needs to line up with the REORDERED
      // cards array, not the raw queue. `opts.resetIdx === false`
      // means "keep the user where they are"; the effect uses
      // `anchorTargetRef` (set by refreshInPlace / onAskSeparately)
      // to find the right ordered index. If nothing is targeted and
      // this is a top-of-tab reload, we reset to 0.
      if (opts.resetIdx !== false) setIdx(0);
    } catch (e) {
      toast.error("Couldn't load chat review queue");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load({ resetIdx: false }); /* eslint-disable-next-line */ }, [currentId]);

  // Global refresh signal — used by the "Ask separately" Undo toast so
  // clicking Undo after the SamplesList unmounts still gets the queue
  // to re-render. Cheap, decoupled, and doesn't require plumbing a ref
  // through props for a corner-case action.
  useEffect(() => {
    const onExt = () => { refreshInPlace(); };
    window.addEventListener("chat-review:refresh", onExt);
    return () => window.removeEventListener("chat-review:refresh", onExt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, tab]);

  // When the tab changes reset the pointer to the top card AND drop any
  // "just-peeled" ordering hints for the tab we left. But skip the very
  // first tick so the URL-restore effect can seek to `?card=...` on
  // initial mount without being clobbered.
  const didInitialTabResetRef = useRef(false);
  useEffect(() => {
    if (!didInitialTabResetRef.current) {
      didInitialTabResetRef.current = true;
      return;
    }
    setIdx(0);
    setPendingPeels([]);
  }, [tab]);

  // Peels created during this session — used to slot the freshly-created
  // pinned card RIGHT AFTER its anchor (the card the user was on when
  // they clicked "Ask separately"), overriding the backend's default
  // total_dollars sort. Cleared on tab change or company change.
  const [pendingPeels, setPendingPeels] = useState([]);
  // Toggles the "Answered" drawer.
  const [answeredOpen, setAnsweredOpen] = useState(false);
  // Kept as a ref so async callbacks can push without going stale.
  const pendingPeelsRef = useRef(pendingPeels);
  useEffect(() => { pendingPeelsRef.current = pendingPeels; }, [pendingPeels]);

  const rawCards = queue ? (queue[tab] || []) : [];
  // Reorder cards: peeled cards get spliced in right after their anchor,
  // in the order the user peeled them. Non-peeled cards keep their
  // backend order. If the anchor is missing (fully answered) the peeled
  // cards fall back to their backend-sorted position.
  const cards = useMemo(() => {
    if (!rawCards.length || !pendingPeels.length) return rawCards;
    const peelById = new Map(pendingPeels.map(p => [p.group_id, p]));
    const peeled = [];
    const rest = [];
    for (const c of rawCards) {
      if (c.pinned_group_id && peelById.has(c.pinned_group_id)) peeled.push(c);
      else rest.push(c);
    }
    if (!peeled.length) return rawCards;
    // Group peeled cards by their anchor
    const bucketByAnchor = new Map();
    for (const c of peeled) {
      const anchor = peelById.get(c.pinned_group_id)?.anchor_card_key;
      if (!bucketByAnchor.has(anchor)) bucketByAnchor.set(anchor, []);
      bucketByAnchor.get(anchor).push(c);
    }
    const out = [];
    for (const c of rest) {
      out.push(c);
      const attach = bucketByAnchor.get(c.card_key);
      if (attach) { out.push(...attach); bucketByAnchor.delete(c.card_key); }
    }
    // Anchor(s) missing → append leftover peels at the end
    for (const arr of bucketByAnchor.values()) out.push(...arr);
    return out;
  }, [rawCards, pendingPeels]);
  const activeCard = cards[idx] || null;

  // Combined URL <-> queue-position sync.
  //
  // Phase 1 (one-shot, until didInitialSeekRef is set):
  //   If the URL had `?card=<key>` at first mount, seek the queue to
  //   that card's index. We DON'T mark the seek done inside the same
  //   effect run that calls setIdx — otherwise the URL-write branch
  //   below would fire against the STALE activeCard (still cards[0]).
  //   Instead we `return` after setIdx and let the effect re-fire on
  //   the next render, at which point activeCard has caught up and we
  //   mark the seek done.
  //
  // Phase 2 (always after seek is done):
  //   Write the current activeCard.card_key to the URL so the CPA
  //   lands on the same question after a browser refresh.
  const didInitialSeekRef = useRef(false);
  useEffect(() => {
    if (loading || cards.length === 0) return;
    if (!activeCard?.card_key) return;

    if (!didInitialSeekRef.current) {
      const target = initialCardKeyRef.current;
      if (!target) {
        didInitialSeekRef.current = true;
      } else {
        const foundIdx = cards.findIndex(c => c.card_key === target);
        if (foundIdx < 0) {
          // Target no longer in this queue (booked / peeled / tab
          // changed) — abandon the seek and let URL sync take over.
          didInitialSeekRef.current = true;
        } else if (foundIdx !== idx) {
          setIdx(foundIdx);
          return;   // wait for next render — activeCard hasn't caught up
        } else {
          didInitialSeekRef.current = true;
        }
      }
    }

    if (searchParams.get("card") !== activeCard.card_key) {
      const next = new URLSearchParams(searchParams);
      next.set("card", activeCard.card_key);
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCard?.card_key, cards.length, loading]);

  const onDone = async () => {
    // Advance to next card. Reload if we've cleared the tab so the
    // progress bar / counts stay honest.
    if (idx + 1 < cards.length) {
      setIdx(idx + 1);
    } else {
      await load();
    }
  };

  // Refresh queue counts + samples WITHOUT resetting to the top.
  // Used after side actions like Link-to-invoice that may remove a row
  // from the current card's samples but shouldn't move the CPA off the
  // question they were reading. Also used by "Ask separately" — the
  // caller passes the card_key we want to keep the user on after the
  // peel (with an optional fallback peel group_id if the anchor might
  // disappear entirely).
  const anchorTargetRef = useRef(null); // { card_key, fallback_peel? }
  const refreshInPlace = (keepCardKey = null, fallback_peel = null) => {
    anchorTargetRef.current = {
      card_key: keepCardKey || activeCard?.card_key || null,
      fallback_peel,
    };
    return load({ resetIdx: false });
  };

  // Register a peel-off so the useMemo above splices its new card in
  // right after the anchor. Called from onAskSeparately in the parent
  // wiring below.
  const registerPeel = (group_id, anchor_card_key) => {
    setPendingPeels(prev => [...prev, { group_id, anchor_card_key }]);
  };

  // After the reordered cards update, resolve idx to the anchor (if it
  // still exists) or to the first peel group (fallback for the "peeled
  // everything, parent card gone" case). Runs whenever the ordered
  // array changes and consumes the target ref so subsequent renders
  // don't jump around.
  useEffect(() => {
    const target = anchorTargetRef.current;
    if (!target || !cards.length) return;
    let at = target.card_key
      ? cards.findIndex(c => c.card_key === target.card_key)
      : -1;
    if (at < 0 && target.fallback_peel) {
      at = cards.findIndex(c => c.pinned_group_id === target.fallback_peel);
    }
    if (at >= 0) setIdx(at);
    anchorTargetRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards]);

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

  // ── Embedded mode: skip the page chrome (min-h-screen wrapper,
  // Back-to-dashboard header, max-width column) so the same UI can
  // render inline inside a responsibilities-panel expansion.
  const Body = (
    <>
      {!embedded && (
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => nav("/dashboard")}
              className="flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900"
              data-testid="chat-review-back"
            >
              <ArrowLeft size={16} /> Back to dashboard
            </button>
            <button
              type="button"
              onClick={() => setAnsweredOpen(true)}
              className="text-sm text-indigo-700 hover:text-indigo-900 underline"
              data-testid="chat-review-open-answered"
              title="See questions you've already answered"
            >
              Answered
            </button>
          </div>
          <div className="text-sm text-slate-500">
            {company?.name || ""}
          </div>
        </div>
      )}

      {/* Progress bar */}
      <ProgressHeader progress={queue?.progress} />

      {/* NOTE: The AI cleanup queue banner used to live here. Removed
          per owner spec — cleanup suggestions still surface on the
          CPA To Do and Client Cockpit AI-cleanup tiles; we keep the
          Chat Review flow focused on the current card only. */}
      <ChatReviewBody
        tab={tab} setTab={setTab} cards={cards} idx={idx} setIdx={setIdx}
        queue={queue} activeCard={activeCard} accounts={accounts}
        contacts={contacts} companyId={currentId}
        onDone={onDone} onRefresh={refreshInPlace}
        onContactCreated={refreshInPlace}
        onAskSeparately={async (ids) => {
          const anchor = activeCard?.card_key;
          const groupId = await askSeparately(currentId, ids);
          if (groupId && anchor) registerPeel(groupId, anchor);
          // Prefer to keep the user on the anchor; if all its rows were
          // peeled, fall through to the peel itself so the user still
          // sees a Jamie-style card next instead of jumping to a random
          // higher-dollar contact.
          await refreshInPlace(anchor, groupId);
          return !!groupId;
        }}
        embedded={embedded}
      />
      {!embedded && answeredOpen && (
        <AnsweredDrawer
          companyId={currentId}
          onClose={() => setAnsweredOpen(false)}
          onReopened={async () => { await refreshInPlace(); }}
        />
      )}
    </>
  );

  if (embedded) {
    return (
      <div data-testid="chat-review-embedded" className="min-w-0">
        {Body}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50" data-testid="chat-review-page">
      <div className="max-w-6xl mx-auto px-6 pt-6 pb-24">
        {Body}
      </div>
    </div>
  );
}

// Body extracted so both embedded and standalone modes share the exact
// same rendering path. Keeps ChatReview's outer shell trivial.
function ChatReviewBody({
  tab, setTab, cards, idx, setIdx, queue, activeCard, accounts, contacts,
  companyId, onDone, onRefresh, onContactCreated, onAskSeparately, embedded,
}) {
  const tabLabel = (t) => TABS.find(x => x.key === t)?.label || t;
  return (
    <>
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
                  companyId={companyId}
                  onDone={onDone}
                  onRefresh={onRefresh}
                  onAskSeparately={onAskSeparately}
                />
              )}
              {tab === "transactions" && (
                <TransactionsCard
                  key={activeCard.card_key}
                  card={activeCard}
                  accounts={accounts}
                  contacts={contacts}
                  companyId={companyId}
                  onDone={onDone}
                  onRefresh={onRefresh}
                  onContactCreated={onContactCreated}
                  onAskSeparately={onAskSeparately}
                />
              )}
              {tab === "checks" && (
                <CheckCard
                  key={activeCard.card_key}
                  card={activeCard}
                  accounts={accounts}
                  contacts={contacts}
                  companyId={companyId}
                  onDone={onDone}
                  onContactCreated={onContactCreated}
                />
              )}
              <ChatReviewFooter idx={idx} setIdx={setIdx} cards={cards} onSkip={onDone} embedded={embedded} />
            </>
          )}
        </div>
    </>
  );
}

// -------- pieces ----------------------------------------------------------

function ChatReviewFooter({ idx, setIdx, cards, onSkip, embedded }) {
  if (!cards || cards.length === 0) return null;
  // Standalone page: pin the footer to the viewport bottom so Back / Skip
  // stay reachable no matter how tall the card grows. The standalone
  // wrapper reserves 6rem of bottom padding (`pb-24`) so the fixed footer
  // never overlaps the last card. Embedded (Dashboard tile) mode keeps
  // static flow so the footer scrolls with the tile.
  if (embedded) {
    return (
      <div
        className="mt-6 flex items-center justify-center gap-10 text-sm"
        data-testid="chat-review-footer"
      >
        <FooterButtons idx={idx} setIdx={setIdx} onSkip={onSkip} />
      </div>
    );
  }
  return (
    <div
      className="fixed bottom-6 left-0 right-0 z-30 pointer-events-none"
      data-testid="chat-review-footer"
    >
      <div className="max-w-6xl mx-auto px-6 flex items-center justify-center gap-10 text-sm pointer-events-auto">
        <FooterButtons idx={idx} setIdx={setIdx} onSkip={onSkip} />
      </div>
    </div>
  );
}

function FooterButtons({ idx, setIdx, onSkip }) {
  return (
    <>
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
        onClick={onSkip}
        className="text-slate-500 hover:text-slate-800"
        data-testid="chat-review-skip"
      >
        Skip for now
      </button>
    </>
  );
}

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

// Build a synthetic prior-QA entry that captures "the AI just proposed X;
// user is typing again, so treat the previous proposal as rejected".
// Called from both cards' propose() when the composer fires while a
// proposal is already on screen. Feeds the rejection back to the LLM
// so its next turn doesn't repeat the same guess.
function buildRejectionQA(proposal, userMessage) {
  if (!proposal || typeof proposal !== "object") return null;
  const proposedName =
    proposal?.match?.name ||
    proposal?.match?.account_name ||
    proposal?.propose_create?.name ||
    proposal?.propose_create?.account_name ||
    (proposal?.clarify ? "(a follow-up question)" : null);
  if (!proposedName) return null;
  const reason = (proposal?.reason || "").slice(0, 240) || null;
  const qParts = [`You previously suggested "${proposedName}"`];
  if (reason) qParts.push(`(reason: ${reason})`);
  return {
    q: qParts.join(" "),
    a: `The client rejected that and now says: "${userMessage.trim()}". Do not re-propose that account.`,
  };
}

// -------- Conversation thread (bubbles rendered below ChatBox) -----------
//
// No container chrome, no header, just messages. Scrolls internally at
// max-height so the yellow/green proposal boxes stay above the fold.
// Newest turn scrolls into view automatically.
function ConversationThread({ turns, onClear }) {
  const scrollRef = useRef(null);
  useEffect(() => {
    // Anchor to the bottom so the newest AI reply is visible without
    // pushing the yellow/green cards further down.
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns?.length]);
  if (!turns || turns.length === 0) return null;
  return (
    <div className="mt-3 relative" data-testid="chat-review-thread-wrap">
      {onClear && (
        <div className="flex justify-end mb-1">
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center gap-1 text-[11px] text-slate-500
                       hover:text-slate-700 underline underline-offset-2"
            data-testid="chat-review-thread-clear"
            title="Clear this conversation and start fresh"
          >
            <RotateCcw size={11} /> Clear conversation
          </button>
        </div>
      )}
      <div
        ref={scrollRef}
        className="pl-1 space-y-2.5 overflow-y-auto"
        style={{ maxHeight: 240 }}
        data-testid="chat-review-thread"
      >
        {turns.map((t, i) => {
          if (t.role === "user") {
            return (
              <div key={i} className="flex justify-end" data-testid="chat-review-thread-user">
                <div className="max-w-[80%] px-3 py-1.5 rounded-2xl rounded-br-sm
                                bg-indigo-600 text-white text-sm">
                  {t.text}
                </div>
              </div>
            );
          }
          return (
            <div key={i} className="flex gap-2 items-start" data-testid="chat-review-thread-ai">
              <div className="w-6 h-6 rounded-full bg-slate-900 text-white
                              text-[10px] font-semibold flex items-center
                              justify-center shrink-0 mt-0.5">
                AI
              </div>
              <div className="text-sm text-slate-800 flex-1">{t.text}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NoCategoryCard({ card, accounts, contacts, companyId, onDone, onRefresh, onAskSeparately }) {
  const [text, setText] = useState("");
  const [proposing, setProposing] = useState(false);
  const [proposal, setProposal] = useState(null);         // { match | propose_create | clarify, reason }
  const [override, setOverride] = useState(null);          // account id
  const [saveRule, setSaveRule] = useState(false);
  const [booking, setBooking] = useState(false);
  const [priorQAs, setPriorQAs] = useState([]);            // [{q, a}, …]
  // Conversation thread — persisted to db.chat_review_threads keyed by
  // card_key. Loaded on mount so reopening a card shows prior turns.
  const [thread, setThread] = useState([]);                // [{role, text, ts}]
  // When the AI recommends changing the contact for these txns
  // (e.g. Zelle/PayPal INDN mis-label), the CPA opts in with a chip;
  // the chosen name flies through to the booking call. `null` = no
  // override active. `""` = AI suggested one but user hasn't accepted.
  const [applyOverride, setApplyOverride] = useState(null);
  // Chat composer dims when the user is actively selecting rows in
  // split mode — the rescue-hatch path handles those rows separately.
  const [splitActive, setSplitActive] = useState(false);
  // Toggles the shared UpdateContactPanel — see definition near ChatBox.
  const [updateOpen, setUpdateOpen] = useState(false);

  // Load persisted thread on mount / when card_key changes.
  useEffect(() => {
    let ignore = false;
    (async () => {
      if (!card.card_key) return;
      try {
        const r = await api.get(
          `/companies/${companyId}/reviewv2/chat-review-thread`,
          { params: { card_key: card.card_key } });
        if (!ignore) setThread(r.data?.turns || []);
      } catch { /* thread is best-effort — silent */ }
    })();
    return () => { ignore = true; };
  }, [companyId, card.card_key]);

  const propose = async (extraQAs = null, userMessageOverride = null) => {
    const userMessage = (userMessageOverride ?? text).trim();
    if (!userMessage) return;
    setProposing(true);
    // Optimistically push the user's turn so the thread feels snappy.
    setThread(t => [...t, { role: "user", text: userMessage, ts: new Date().toISOString() }]);
    try {
      // If a proposal is already on screen and the user is typing again,
      // treat that as a soft rejection: append a synthetic QA capturing
      // what the AI previously suggested so it doesn't repeat itself.
      let qas = extraQAs ?? priorQAs;
      if (extraQAs === null && proposal) {
        const rej = buildRejectionQA(proposal, userMessage);
        if (rej) {
          qas = [...priorQAs, rej];
          setPriorQAs(qas);
        }
      }
      // Use the propose-or-create endpoint — it returns either an
      // existing-account `match` OR a `propose_create` payload with
      // full CoA fields so we can offer one-click account creation.
      const r = await api.post(`/companies/${companyId}/reviewv2/chat-propose-account`, {
        context:      card.context_row,
        user_answer:  userMessage,
        direction:    card.direction,
        card_kind:    "no_category",
        card_key:     card.card_key,          // enables thread persistence
        contact_name: card.contact_name || "",
        prior_qas:    qas,
      });
      setProposal(r.data);
      setOverride(null);
      setApplyOverride(null);
      // Append the AI turn to the visible thread. Backend also persisted it.
      const aiMsg = (r.data?.ai_message || r.data?.reason || "").trim();
      if (aiMsg) {
        setThread(t => [...t, { role: "ai", text: aiMsg, ts: new Date().toISOString() }]);
      }
      // Clear the input so the user can type their next turn.
      setText("");
    } catch (e) {
      toast.error("AI proposal failed");
    } finally {
      setProposing(false);
    }
  };

  // Answer a clarify follow-up: append the Q/A to the trail, then
  // re-invoke propose with the enriched context. The chosen chip
  // becomes a user turn in the thread.
  const answerClarify = async (question, answerText) => {
    const nextQAs = [...priorQAs, { q: question, a: answerText }];
    setPriorQAs(nextQAs);
    setProposal(null);
    await propose(nextQAs, answerText);
  };

  // Clear the whole conversation for this card — wipes local state
  // AND the persisted thread in db.chat_review_threads. Useful when
  // the user wants to start over without booking or skipping.
  const clearThread = async () => {
    try {
      if (card.card_key) {
        await api.delete(
          `/companies/${companyId}/reviewv2/chat-review-thread`,
          { params: { card_key: card.card_key } });
      }
    } catch { /* best-effort — clearing locally is what the user sees */ }
    setThread([]);
    setPriorQAs([]);
    setProposal(null);
    setApplyOverride(null);
    setOverride(null);
    setText("");
    toast.success("Conversation cleared");
  };

  // When the user accepts the yellow contact override, look for an
  // existing sub-account matching the new contact under the same
  // parent — if found, swap the proposal to that match; if not, rename
  // the pending propose_create so the new account uses the correct
  // counterparty (e.g. "JPMorgan Chase" → "Jamie Nexxes").
  const applyContactOverride = (overrideName) => {
    setApplyOverride(overrideName);
    if (!proposal?.propose_create || !overrideName) return;
    const pc = proposal.propose_create;
    const parentName = (pc.parent_account_name || "").toLowerCase();
    const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const targetKey = norm(overrideName);
    const existingSub = accounts.find((a) => {
      if (!a.parent_account_id) return false;
      const parent = accounts.find((p) => p.id === a.parent_account_id);
      if ((parent?.name || "").toLowerCase() !== parentName) return false;
      const nameKey = norm(a.name);
      return nameKey === targetKey
          || (nameKey && nameKey.includes(targetKey))
          || (targetKey && targetKey.includes(nameKey));
    });
    if (existingSub) {
      setProposal({
        ok:               true,
        match:            existingSub,
        contact_override: proposal.contact_override,
        reason:           `Found existing '${existingSub.name}' under ${pc.parent_account_name} — booking to it.`,
      });
      toast.success(`Matched existing account: ${existingSub.name}`);
    } else if (norm(pc.name) !== targetKey) {
      setProposal({
        ...proposal,
        propose_create: { ...pc, name: overrideName },
      });
    }
  };

  const accountIdToBook = override || proposal?.match?.id || null;
  const canConfirm = !!accountIdToBook;

  const book = async () => {
    if (!canConfirm) return;
    setBooking(true);
    try {
      const bookRes = await api.post(`/companies/${companyId}/reviewv2/chat-review-book`, {
        card_kind: "no_category",
        card_key: card.card_key,
        txn_ids: card.txn_ids,
        category_account_id: accountIdToBook,
        direction: card.direction,
        save_as_rule: saveRule,
        contact_id: card.contact_id,
        contact_override_name: applyOverride || undefined,
      });
      const backfill = bookRes.data?.override_backfilled || 0;
      toast.success(
        applyOverride
          ? `Contact updated to '${applyOverride}' · booked ${card.count} row${card.count === 1 ? "" : "s"}`
            + (backfill ? ` · relabeled ${backfill} more matching row${backfill === 1 ? "" : "s"}` : "")
          : `Booked ${card.count} row${card.count === 1 ? "" : "s"}`
      );
      await onDone();
    } catch (e) {
      toast.error("Booking failed");
    } finally {
      setBooking(false);
    }
  };

  // After creating a new account, we book all rows AND (optionally) save
  // the "always book here" rule in a single click, per the design spec.
  const createAndBook = async (fields, ruleOnCreate) => {
    setBooking(true);
    try {
      // Loan sub-accounts also get a matching Contact record tagged with
      // lender (money-in loan) or borrower (money-out loan), so the CRM
      // and the CoA stay in sync. Prefer the override name (the AI just
      // told us it's the real counterparty) over the current label.
      const parentName = (fields.parent_account_name || "").toLowerCase();
      const isLoanChild = parentName === "loans payable" || parentName === "loans receivable";
      const contact_hint = isLoanChild
        ? { name: applyOverride || card.contact_name || fields.name,
            loan_role: card.direction === "in" ? "lender" : "borrower" }
        : undefined;
      const ens = await api.post(`/companies/${companyId}/accounts/ensure`,
                                  { ...fields, contact_hint });
      const acct = ens.data;
      await api.post(`/companies/${companyId}/reviewv2/chat-review-book`, {
        card_kind: "no_category",
        card_key: card.card_key,
        txn_ids: card.txn_ids,
        category_account_id: acct.id,
        direction: card.direction,
        save_as_rule: !!ruleOnCreate,
        contact_id: card.contact_id,
        contact_override_name: applyOverride || undefined,
      });
      const rowLabel = `${card.count} row${card.count === 1 ? "" : "s"}`;
      if (acct.deduped) {
        toast.success(`${acct.dedupe_reason || `Merged into '${acct.name}'`} — booked ${rowLabel}`);
      } else {
        toast.success(
          (acct.created ? "Created " : "Reused ") + `'${acct.name}' and booked ${rowLabel}`
        );
      }
      await onDone();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Create & book failed");
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
                   card={card}
                   onSplitModeChange={setSplitActive}
                   onContactCreated={onRefresh}
                   onAskSeparately={onAskSeparately}
                   onLinked={onRefresh} />
      <div className={splitActive ? "opacity-40 pointer-events-none" : ""}
           data-testid="chat-review-nocat-composer">
        {splitActive && (
          <div className="mt-3 text-[11px] text-slate-500">
            Selection mode — clear the selection to type an answer for the rest.
          </div>
        )}
        {updateOpen && (
          <UpdateContactPanel
            companyId={companyId}
            contacts={contacts}
            cardContactId={card.contact_id}
            txnIds={card.txn_ids}
            onClose={() => setUpdateOpen(false)}
            onAfter={onRefresh}
            onContactCreated={onRefresh}
          />
        )}
        <ChatBox
          text={text} setText={setText} onSend={() => propose()} busy={proposing}
          placeholder="e.g. this is my landscape client — service revenue"
          rightSlot={!updateOpen && <UpdateContactLink onClick={() => setUpdateOpen(true)} />}
        />
        <ConversationThread turns={thread} onClear={clearThread} />
      {/* Contact override — the AI thinks the current contact is wrong. */}
      {proposal?.ok && proposal.contact_override && (
        <OverridePill
          override={proposal.contact_override}
          currentName={card.contact_name}
          applied={applyOverride}
          onApply={() => applyContactOverride(proposal.contact_override.name)}
          onDismiss={() => setApplyOverride(null)}
        />
      )}
      {/* Clarify path — the AI asked a follow-up question. */}
      {proposal?.ok && proposal.clarify && (
        <ClarifyBlock
          clarify={proposal.clarify}
          reason={proposal.reason}
          onAnswer={(a) => answerClarify(proposal.clarify.question, a)}
          busy={proposing}
        />
      )}
      {/* Match path — existing account found. */}
      {proposal?.ok && proposal.match && (
        <ProposalBlock
          proposal={{ ok: true, reason: proposal.reason }}
          matchAccountId={proposal.match.id}
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
      )}
      {/* Create path — no existing account. Show editable fields so
          the CPA can review name/type/subtype/code, then one-click
          Create & Book (+ optionally save as rule). */}
      {proposal?.ok && proposal.propose_create && (
        <CreateAccountProposal
          key={proposal.propose_create.name}
          proposal={proposal}
          contactName={card.contact_name}
          direction={card.direction}
          onCreate={createAndBook}
          busy={booking}
          accounts={accounts}
        />
      )}
      {proposal && !proposal.ok && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/50 p-3 text-xs text-amber-800">
          <b>AI couldn't parse a suggestion.</b>{" "}
          {proposal.reason || "Try describing it in a slightly different way."}
        </div>
      )}
      </div>
    </div>
  );
}

// -------- Create-account proposal (rendered when no CoA match) -----------

const ACCT_TYPES = [
  { value: "revenue",   label: "Revenue" },
  { value: "expense",   label: "Expense" },
  { value: "asset",     label: "Asset" },
  { value: "liability", label: "Liability" },
  { value: "equity",    label: "Equity" },
  { value: "cogs",      label: "Cost of Goods Sold" },
];

const SUBTYPES_BY_TYPE = {
  revenue:   ["sales", "service_revenue", "rental_income", "other_revenue", "interest_income"],
  expense:   ["operating_expense", "rent", "advertising", "software",
              "meals", "travel", "professional_fees", "office_expense", "utilities",
              "insurance", "taxes", "other_expense"],
  asset:     ["current_asset", "fixed_asset", "receivable", "prepaid", "inventory", "other_asset"],
  liability: ["current_liability", "long_term_liability", "credit_card",
              "loan", "accounts_payable"],
  equity:    ["owner_contribution_drawing", "retained_earnings", "opening_balance_equity"],
  cogs:      ["direct_materials", "direct_labor", "other_cogs"],
};

function CreateAccountProposal({ proposal, contactName, direction, onCreate, busy, accounts }) {
  const seed = proposal.propose_create;
  const [name, setName]     = useState(seed.name || "");
  const [type, setType]     = useState(seed.type || "revenue");
  const [subtype, setSub]   = useState(seed.subtype || "");
  const [code, setCode]     = useState(seed.code || "");
  const [saveRule, setRule] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  // Parent sub-account. The AI's suggestion is the default; the user
  // can pick a different parent (or clear it) from the "Edit details"
  // panel. Options are top-level accounts of the same type as the new
  // account (e.g. Loans Payable / Long-Term Debt for liabilities).
  const [parent, setParent] = useState({
    name: seed.parent_account_name || "",
    code: seed.parent_account_code || "",
  });
  const parentOptions = useMemo(() => {
    if (!Array.isArray(accounts)) return [];
    return accounts
      .filter(a => !a.parent_account_id
                    && (a.type || "").toLowerCase() === (type || "").toLowerCase())
      .map(a => ({
        name: a.name || "",
        code: String(a.code || ""),
        label: `${a.code || "?"} — ${a.name || ""}`,
      }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [accounts, type]);

  const subtypeOptions = SUBTYPES_BY_TYPE[type] || [];
  useEffect(() => {
    if (subtype && !subtypeOptions.includes(subtype)) {
      setSub(subtypeOptions[0] || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  const submit = () => {
    if (!name.trim()) { toast.error("Give the account a name"); return; }
    if (!code.trim()) { toast.error("Pick an account code"); return; }
    onCreate({
      name: name.trim(), type, subtype, code: code.trim(),
      parent_account_name: parent.name || undefined,
      parent_account_code: parent.code || undefined,
    }, saveRule);
  };

  const summaryLine = (
    <span>
      <b className="text-slate-900">{name || seed.name || "New account"}</b>
      <span className="text-slate-500">
        {/* For balance-sheet accounts (asset/liability/equity) the parent
            already implies the type, so we drop the '· type / subtype'
            noise. Keep it for revenue/expense/cogs where the subtype
            adds real information. */}
        {!["asset", "liability", "equity"].includes(type)
          && ` · ${type}${subtype ? ` / ${subtype.replace(/_/g, " ")}` : ""}`}
        {code ? ` · ${code}` : ""}
        {parent.name ? ` · under ${parent.name}` : ""}
      </span>
    </span>
  );

  return (
    <div className="mt-4 rounded-xl border border-emerald-300 bg-emerald-50 p-4"
         data-testid="chat-review-create-account">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] uppercase tracking-wider font-semibold text-emerald-700 flex items-center gap-1">
          <Sparkles size={12} /> New account · ready to book
        </div>
        <button
          type="button"
          onClick={() => setShowDetails(v => !v)}
          className="text-[11px] text-emerald-800 hover:underline"
          data-testid="chat-review-create-toggle-details"
        >
          {showDetails ? "Hide details" : "Edit details"}
        </button>
      </div>
      <div className="mt-2 text-sm">{summaryLine}</div>

      {showDetails && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className="text-xs font-semibold text-slate-600">Account name</label>
            <input
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm
                         focus:outline-none focus:ring-2 focus:ring-indigo-200"
              value={name} onChange={e => setName(e.target.value)}
              data-testid="chat-review-create-name"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-600">Type</label>
            <select
              className="mt-1 w-full border border-slate-300 rounded-lg px-2 py-2 text-sm bg-white
                         focus:outline-none focus:ring-2 focus:ring-indigo-200"
              value={type} onChange={e => setType(e.target.value)}
              data-testid="chat-review-create-type"
            >
              {ACCT_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-600">Subtype</label>
            <select
              className="mt-1 w-full border border-slate-300 rounded-lg px-2 py-2 text-sm bg-white
                         focus:outline-none focus:ring-2 focus:ring-indigo-200"
              value={subtype} onChange={e => setSub(e.target.value)}
              data-testid="chat-review-create-subtype"
            >
              {subtypeOptions.map(s => (
                <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-600">Code</label>
            <input
              className="mt-1 w-full border border-slate-300 rounded-lg px-2 py-2 text-sm
                         focus:outline-none focus:ring-2 focus:ring-indigo-200"
              value={code} onChange={e => setCode(e.target.value)}
              data-testid="chat-review-create-code"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="text-xs font-semibold text-slate-600">
              Parent (sub-account under)
            </label>
            <select
              className="mt-1 w-full border border-slate-300 rounded-lg px-2 py-2 text-sm bg-white
                         focus:outline-none focus:ring-2 focus:ring-indigo-200"
              value={parent.code || ""}
              onChange={e => {
                const v = e.target.value;
                if (!v) { setParent({ name: "", code: "" }); return; }
                const opt = parentOptions.find(o => o.code === v);
                setParent(opt ? { name: opt.name, code: opt.code } : { name: "", code: "" });
              }}
              data-testid="chat-review-create-parent"
            >
              <option value="">— top-level account (no parent) —</option>
              {parentOptions.map(o => (
                <option key={o.code} value={o.code}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      <label className="mt-3 flex items-center gap-2 text-xs text-slate-600">
        <input type="checkbox" checked={saveRule} onChange={e => setRule(e.target.checked)}
               data-testid="chat-review-create-rule" />
        Always book {contactName ? `${contactName}'s ${direction === "in" ? "deposits" : "payments"}` : "these"} to this new account (save as rule)
      </label>
      <div className="mt-3 flex items-center justify-end">
        <button
          type="button" onClick={submit} disabled={busy}
          className="rounded-full px-5 py-2 text-sm bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 font-medium"
          data-testid="chat-review-create-confirm"
        >
          {busy ? "Creating…" : "Create & book"}
        </button>
      </div>
    </div>
  );
}

// -------- Clarify block — the AI asked a follow-up question --------------

function OverridePill({ override, currentName, applied, onApply, onDismiss }) {
  const isApplied = applied === override.name;
  return (
    <div className="mt-3 flex items-center gap-2 text-sm px-3 py-2 rounded-lg
                    bg-amber-50 border border-amber-200"
         data-testid="chat-review-contact-override">
      <Sparkles size={14} className="text-amber-700 shrink-0" />
      <div className="text-slate-700 flex-1 min-w-0">
        Real counterparty looks like{" "}
        <b className="text-slate-900">{override.name}</b>
        {currentName ? <>, not <span className="text-slate-500">{currentName}</span></> : null}.
        {override.reason && (
          <span className="text-slate-500"> · {override.reason}</span>
        )}
      </div>
      {isApplied ? (
        <>
          <span className="inline-flex items-center gap-1 rounded-full border
                           border-emerald-300 bg-white px-2.5 py-0.5 text-xs
                           text-emerald-800 whitespace-nowrap">
            <CheckIcon size={12} /> Will change to {override.name}
          </span>
          <button
            type="button"
            onClick={onDismiss}
            className="text-xs text-slate-500 hover:text-slate-700 underline
                       whitespace-nowrap"
            data-testid="chat-review-contact-override-undo"
          >
            undo
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={onApply}
            className="text-xs px-2.5 py-1 rounded-full border border-amber-400
                       bg-white hover:bg-amber-100 whitespace-nowrap"
            data-testid="chat-review-contact-override-apply"
          >
            Change contact
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="text-xs text-slate-500 hover:text-slate-700 whitespace-nowrap"
            data-testid="chat-review-contact-override-dismiss"
          >
            Keep as-is
          </button>
        </>
      )}
    </div>
  );
}

function ClarifyBlock({ clarify, reason, onAnswer, busy }) {
  const [free, setFree] = useState("");
  const submitFree = () => {
    const t = free.trim();
    if (!t || busy) return;
    setFree("");
    onAnswer(t);
  };
  return (
    <div className="mt-4 rounded-lg border border-indigo-200 bg-indigo-50/40 p-4"
         data-testid="chat-review-clarify">
      <div className="text-xs uppercase tracking-wider mb-1 font-semibold text-indigo-700 flex items-center gap-1">
        <MessageCircle size={12} /> Quick question
      </div>
      <div className="text-sm text-slate-900 font-medium">{clarify.question}</div>
      {reason && (
        <div className="mt-1 text-xs text-slate-500">{reason}</div>
      )}
      {clarify.options?.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {clarify.options.map((opt, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onAnswer(opt)}
              disabled={busy}
              className="rounded-full border border-indigo-300 bg-white px-3 py-1.5
                         text-xs text-indigo-800 hover:bg-indigo-100 disabled:opacity-40"
              data-testid={`chat-review-clarify-opt-${i}`}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <input
          className="flex-1 border border-slate-300 rounded-lg px-3 py-1.5 text-sm bg-white
                     focus:outline-none focus:ring-2 focus:ring-indigo-200"
          placeholder="…or type your own answer"
          value={free}
          onChange={e => setFree(e.target.value)}
          onKeyDown={e => e.key === "Enter" && submitFree()}
          disabled={busy}
          data-testid="chat-review-clarify-input"
        />
        <button
          type="button"
          onClick={submitFree}
          disabled={busy || !free.trim()}
          className="rounded-lg px-3 py-1.5 text-xs bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40"
          data-testid="chat-review-clarify-send"
        >
          Send
        </button>
      </div>
    </div>
  );
}

// -------- Card 2 — Transactions -------------------------------------------

function TransactionsCard({ card, accounts, contacts, companyId, onDone, onRefresh, onContactCreated, onAskSeparately }) {
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
  const [priorQAs, setPriorQAs]    = useState([]);
  const [applyOverride, setApplyOverride] = useState(null);
  const [splitActive, setSplitActive] = useState(false);
  // Toggles the shared UpdateContactPanel — see definition near ChatBox.
  const [updateOpen, setUpdateOpen] = useState(false);
  // Conversation thread — persisted; loaded on mount by card_key.
  const [thread, setThread] = useState([]);

  useEffect(() => {
    let ignore = false;
    (async () => {
      if (!card.card_key) return;
      try {
        const r = await api.get(
          `/companies/${companyId}/reviewv2/chat-review-thread`,
          { params: { card_key: card.card_key } });
        if (!ignore) setThread(r.data?.turns || []);
      } catch { /* thread is best-effort — silent */ }
    })();
    return () => { ignore = true; };
  }, [companyId, card.card_key]);

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

  const propose = async (extraQAs = null, userMessageOverride = null) => {
    const userMessage = (userMessageOverride ?? text).trim();
    if (!userMessage) return;
    setProposing(true);
    setThread(t => [...t, { role: "user", text: userMessage, ts: new Date().toISOString() }]);
    try {
      // Soft-reject prior proposal on a re-typed reply — same pattern
      // as NoCategoryCard (see buildRejectionQA above).
      let qas = extraQAs ?? priorQAs;
      if (extraQAs === null && proposal) {
        const rej = buildRejectionQA(proposal, userMessage);
        if (rej) {
          qas = [...priorQAs, rej];
          setPriorQAs(qas);
        }
      }
      // Propose-or-create: either match an existing account or return
      // full CoA fields for one-click creation.
      const r = await api.post(`/companies/${companyId}/reviewv2/chat-propose-account`, {
        context:      card.context_row,
        user_answer:  userMessage,
        direction:    card.direction,
        card_kind:    "transactions",
        card_key:     card.card_key,
        contact_name: contactQ || card.group_label || "",
        prior_qas:    qas,
      });
      setProposal(r.data);
      setOverride(null);
      setApplyOverride(null);
      const aiMsg = (r.data?.ai_message || r.data?.reason || "").trim();
      if (aiMsg) {
        setThread(t => [...t, { role: "ai", text: aiMsg, ts: new Date().toISOString() }]);
      }
      setText("");
    } catch { toast.error("AI proposal failed"); }
    finally { setProposing(false); }
  };

  const answerClarify = async (question, answerText) => {
    const nextQAs = [...priorQAs, { q: question, a: answerText }];
    setPriorQAs(nextQAs);
    setProposal(null);
    await propose(nextQAs, answerText);
  };

  // Clear the persisted + local conversation thread for this card.
  const clearThread = async () => {
    try {
      if (card.card_key) {
        await api.delete(
          `/companies/${companyId}/reviewv2/chat-review-thread`,
          { params: { card_key: card.card_key } });
      }
    } catch { /* best-effort */ }
    setThread([]);
    setPriorQAs([]);
    setProposal(null);
    setApplyOverride(null);
    setOverride(null);
    setText("");
    toast.success("Conversation cleared");
  };

  // When the user accepts the yellow contact override, look for an
  // existing sub-account matching the new contact under the same
  // parent — if found, swap the proposal to that match; if not, rename
  // the pending propose_create so the new account uses the correct
  // counterparty (e.g. "JPMorgan Chase" → "Jamie Nexxes").
  const applyContactOverride = (overrideName) => {
    setApplyOverride(overrideName);
    if (!proposal?.propose_create || !overrideName) return;
    const pc = proposal.propose_create;
    const parentName = (pc.parent_account_name || "").toLowerCase();
    const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const targetKey = norm(overrideName);
    // Look for a sub-account under the same parent whose name matches
    // the new contact (either direction contains the other, once
    // punctuation / case is stripped).
    const existingSub = accounts.find((a) => {
      if (!a.parent_account_id) return false;
      const parent = accounts.find((p) => p.id === a.parent_account_id);
      if ((parent?.name || "").toLowerCase() !== parentName) return false;
      const nameKey = norm(a.name);
      return nameKey === targetKey
          || (nameKey && nameKey.includes(targetKey))
          || (targetKey && targetKey.includes(nameKey));
    });
    if (existingSub) {
      // Swap the propose_create to a match on the existing sub-account.
      setProposal({
        ok:               true,
        match:            existingSub,
        contact_override: proposal.contact_override,
        reason:           `Found existing '${existingSub.name}' under ${pc.parent_account_name} — booking to it.`,
      });
      toast.success(`Matched existing account: ${existingSub.name}`);
    } else if (norm(pc.name) !== targetKey) {
      // No existing sub — rename the pending new account to the correct
      // counterparty so booking creates '{override}' instead of the
      // (wrong) current contact name.
      setProposal({
        ...proposal,
        propose_create: { ...pc, name: overrideName },
      });
    }
  };

  const accountIdToBook = override || proposal?.match?.id || null;
  const canConfirm = !!accountIdToBook;

  const book = async () => {
    if (!canConfirm) return;
    setBooking(true);
    try {
      const bookRes = await api.post(`/companies/${companyId}/reviewv2/chat-review-book`, {
        card_kind: "transactions",
        card_key: card.card_key,
        group_key: card.group_key,
        direction: card.direction,
        txn_ids: card.txn_ids,
        contact_id: contactId || null,
        category_account_id: accountIdToBook,
        save_as_rule: saveRule,
        contact_override_name: applyOverride || undefined,
      });
      const backfill = bookRes.data?.override_backfilled || 0;
      toast.success(
        applyOverride
          ? `Contact updated to '${applyOverride}' · booked ${card.count} row${card.count === 1 ? "" : "s"}`
            + (backfill ? ` · relabeled ${backfill} more matching row${backfill === 1 ? "" : "s"}` : "")
          : `Booked ${card.count} row${card.count === 1 ? "" : "s"}`
      );
      await onDone();
    } catch { toast.error("Booking failed"); }
    finally { setBooking(false); }
  };

  // Atomically create a new account, book all rows in the group, and
  // optionally save the rule — same UX as the No Category tab.
  const createAndBook = async (fields, ruleOnCreate) => {
    setBooking(true);
    try {
      // Loan sub-accounts also upsert a matching Contact tagged with
      // lender (money-in) or borrower (money-out). Falls back to the
      // group label when the user hasn't picked a specific contact.
      const parentName = (fields.parent_account_name || "").toLowerCase();
      const isLoanChild = parentName === "loans payable" || parentName === "loans receivable";
      const contact_hint = isLoanChild
        ? { name: contactQ || card.group_label || fields.name,
            loan_role: card.direction === "in" ? "lender" : "borrower" }
        : undefined;
      const ens = await api.post(`/companies/${companyId}/accounts/ensure`,
                                  { ...fields, contact_hint });
      const acct = ens.data;
      await api.post(`/companies/${companyId}/reviewv2/chat-review-book`, {
        card_kind: "transactions",
        card_key: card.card_key,
        group_key: card.group_key,
        direction: card.direction,
        txn_ids: card.txn_ids,
        contact_id: contactId || acct.contact_id || null,
        category_account_id: acct.id,
        save_as_rule: !!ruleOnCreate,
        contact_override_name: applyOverride || undefined,
      });
      const rowLabel = `${card.count} row${card.count === 1 ? "" : "s"}`;
      if (acct.deduped) {
        toast.success(`${acct.dedupe_reason || `Merged into '${acct.name}'`} — booked ${rowLabel}`);
      } else {
        toast.success(
          (acct.created ? "Created " : "Reused ") + `'${acct.name}' and booked ${rowLabel}`
        );
      }
      await onDone();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Create & book failed");
    } finally {
      setBooking(false);
    }
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
                   card={card}
                   onSplitModeChange={setSplitActive}
                   onContactCreated={onContactCreated}
                   onAskSeparately={onAskSeparately}
                   onLinked={onRefresh} />
      <div className={splitActive ? "opacity-40 pointer-events-none" : ""}
           data-testid="chat-review-txn-composer">
        {splitActive && (
          <div className="mt-3 text-[11px] text-slate-500">
            Selection mode — clear the selection to type an answer for the rest.
          </div>
        )}

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
          {updateOpen && (
            <UpdateContactPanel
              companyId={companyId}
              contacts={contacts}
              cardContactId={card.contact_id || contactId}
              txnIds={card.txn_ids}
              onClose={() => setUpdateOpen(false)}
              onAfter={onRefresh}
              onContactCreated={onContactCreated}
            />
          )}
          <ChatBox
            text={text} setText={setText} onSend={() => propose()} busy={proposing}
            placeholder="e.g. these are transfers to my Chase savings"
            rightSlot={!updateOpen && <UpdateContactLink onClick={() => setUpdateOpen(true)} />}
          />
          <ConversationThread turns={thread} onClear={clearThread} />
          {/* Contact override — the AI thinks the current contact is wrong. */}
          {proposal?.ok && proposal.contact_override && (
            <OverridePill
              override={proposal.contact_override}
              currentName={card.group_label || contactQ}
              applied={applyOverride}
              onApply={() => applyContactOverride(proposal.contact_override.name)}
              onDismiss={() => setApplyOverride(null)}
            />
          )}
          {/* Clarify path — the AI asked a follow-up question. */}
          {proposal?.ok && proposal.clarify && (
            <ClarifyBlock
              clarify={proposal.clarify}
              reason={proposal.reason}
              onAnswer={(a) => answerClarify(proposal.clarify.question, a)}
              busy={proposing}
            />
          )}
          {/* Match path — existing account found. */}
          {proposal?.ok && proposal.match && (
            <ProposalBlock
              proposal={{ ok: true, reason: proposal.reason }}
              matchAccountId={proposal.match.id}
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
          )}
          {/* Create path — no existing account. Editable fields, one-click
              Create & Book (+ optional rule save). */}
          {proposal?.ok && proposal.propose_create && (
            <CreateAccountProposal
              key={proposal.propose_create.name}
              proposal={proposal}
              contactName={contactQ || card.group_label}
              direction={card.direction}
              onCreate={createAndBook}
              busy={booking}
              accounts={accounts}
            />
          )}
          {proposal && !proposal.ok && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/50 p-3 text-xs text-amber-800">
              <b>AI couldn't parse a suggestion.</b>{" "}
              {proposal.reason || "Try describing it in a slightly different way."}
            </div>
          )}
        </>
      )}
      </div>
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

// Helper used by NoCategoryCard + TransactionsCard for the shared
// "Ask separately" button in SamplesList. Peels the given txn_ids into
// their own card via the backend, then shows a toast with a 5s Undo.
// Returns the new pinned group_id (or null on failure). The caller is
// responsible for triggering the queue refresh — this lets the outer
// ChatReview component register the peel in `pendingPeels` BEFORE the
// refresh runs, so the useMemo reorders the new card right after its
// anchor. Not doing the refresh here also keeps the toast Undo action
// self-contained.
async function askSeparately(companyId, txnIds) {
  if (!txnIds?.length) return null;
  try {
    const r = await api.post(
      `/companies/${companyId}/reviewv2/chat-review-ask-separately`,
      { transaction_ids: txnIds },
    );
    const groupId = r.data?.group_id;
    toast.success(
      `${txnIds.length === 1 ? "Row" : `${txnIds.length} rows`} moved to their own question`,
      {
        duration: 5000,
        action: groupId ? {
          label: "Undo",
          onClick: async () => {
            try {
              await api.post(
                `/companies/${companyId}/reviewv2/chat-review-ask-separately-undo`,
                { group_id: groupId },
              );
              // Best-effort refresh — the caller's useEffect on the queue
              // will re-render. If the page is closed by the time the
              // user clicks Undo, this becomes a no-op.
              window.dispatchEvent(new CustomEvent("chat-review:refresh"));
            } catch { toast.error("Couldn't undo"); }
          },
        } : undefined,
      },
    );
    return groupId || null;
  } catch {
    toast.error("Couldn't move to a separate question");
    return null;
  }
}

function SamplesList({ samples, companyId, accounts, contacts, onLinked,
                      card, onSplitModeChange, onContactCreated, onAskSeparately }) {
  // Modal state — same shape as Transactions.jsx (line 1043-1045, 1093).
  const [editing, setEditing]   = useState(null);
  const [splitting, setSplitting] = useState(null);
  const [linking, setLinking]   = useState(null);
  const [askClient, setAskClient] = useState(null);

  // ── Split-into-subgroups mode ─────────────────────────────────────
  // Rescue-hatch for the 5% of cards where the N transactions aren't
  // homogeneous (e.g. a Venmo card that's actually 6 rows to Larry /
  // Meals + 8 rows to Bob / Travel). Client toggles this mode and
  // partitions the rows one subgroup at a time. Rows that get
  // resolved pop out of `hiddenIds`; when the visible list empties
  // we call `onLinked` to advance to the next card, same behaviour
  // as the primary chat path.
  const [splitMode, setSplitMode] = useState(false);
  const [selected, setSelected]   = useState(() => new Set());
  const [hiddenIds, setHiddenIds] = useState(() => new Set());
  const [splitEditor, setSplitEditor] = useState(null); // { rows: [{id,date,amount,desc}] }
  useEffect(() => {
    onSplitModeChange?.(splitMode && selected.size > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitMode, selected.size]);

  const visible = useMemo(
    () => (samples || []).filter(s => !hiddenIds.has(s.id)),
    [samples, hiddenIds],
  );
  const toggleOne = (id) => setSelected(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  const toggleAll = () => setSelected(prev => {
    const allSel = visible.length > 0 && visible.every(s => prev.has(s.id));
    if (allSel) return new Set();
    const n = new Set(prev);
    for (const s of visible) n.add(s.id);
    return n;
  });
  const clearSel = () => setSelected(new Set());
  const exitSplit = () => { setSplitMode(false); setSelected(new Set()); };
  const popIds = (ids) => {
    setHiddenIds(prev => { const n = new Set(prev); for (const i of ids) n.add(i); return n; });
    setSelected(new Set());
  };
  // If every row in the card has been resolved via split mode, advance
  // to the next question just like the chat path does.
  useEffect(() => {
    if (!splitMode) return;
    if (hiddenIds.size === 0) return;
    if (visible.length > 0) return;
    onLinked?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.length, hiddenIds.size, splitMode]);

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
  const allSelected = visible.length > 0 && visible.every(s => selected.has(s.id));
  return (
    <div className="mt-3">
      {/* Split-mode entry point lives at the bottom of the list next
          to "Scroll to see all N" — see below. Kept off the header
          on purpose so the primary chat flow reads clean. */}
      {splitMode && selected.size > 0 && (
        <div
          className="mb-2 rounded-xl bg-slate-100 border border-slate-200 px-3 py-2 flex flex-wrap items-center gap-2"
          data-testid="chat-review-split-toolbar"
        >
          <span className="text-xs font-semibold text-slate-800 mr-1"
                data-testid="chat-review-split-count">
            {selected.size} selected
          </span>
          <button
            type="button"
            onClick={() => setSplitEditor({
              rows: visible.filter(s => selected.has(s.id)),
            })}
            className="inline-flex items-center gap-1 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-3 py-1.5"
            data-testid="chat-review-split-categorize"
          >
            Update selected
          </button>
          {onAskSeparately && (
            <button
              type="button"
              onClick={async () => {
                const ids = visible.filter(s => selected.has(s.id)).map(s => s.id);
                if (!ids.length) return;
                const ok = await onAskSeparately(ids);
                if (ok) { setSelected(new Set()); setSplitMode(false); }
              }}
              className="inline-flex items-center gap-1 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white text-xs px-3 py-1.5"
              data-testid="chat-review-ask-separately"
              title="Peel these rows off into their own question"
            >
              Ask separately
            </button>
          )}
          <button
            type="button"
            onClick={clearSel}
            className="ml-auto text-[11px] text-slate-500 hover:text-slate-900 underline"
            data-testid="chat-review-split-clear"
          >
            Clear
          </button>
        </div>
      )}
      <ul
        className={
          "space-y-1 text-[12px] text-slate-500 font-mono " +
          "max-h-40 overflow-y-auto pr-2 " +
          "scrollbar-thin scrollbar-thumb-slate-200 hover:scrollbar-thumb-slate-300 scrollbar-track-transparent"
        }
        data-testid="chat-review-samples"
      >
        {splitMode && visible.length > 0 && (
          <li className="sticky top-0 z-[1] bg-slate-50 border-b border-slate-100 py-1 flex items-center gap-3 text-[10px] uppercase tracking-wider text-slate-500 font-sans">
            <input
              type="checkbox"
              onChange={toggleAll}
              checked={allSelected}
              className="h-3.5 w-3.5 accent-slate-900 shrink-0"
              data-testid="chat-review-split-select-all"
              aria-label="Select all visible transactions"
            />
            <span className="flex-1">Transaction</span>
          </li>
        )}
        {visible.map((s, i) => (
          <li key={s.id || i}
              className={`flex items-center gap-3 group ${
                splitMode && selected.has(s.id) ? "bg-sky-50/60 rounded" : ""
              }`}>
            {splitMode && (
              <input
                type="checkbox"
                checked={selected.has(s.id)}
                onChange={() => toggleOne(s.id)}
                className="h-3.5 w-3.5 accent-slate-900 shrink-0"
                data-testid={`chat-review-split-row-${s.id}`}
                aria-label={`Select ${s.desc || s.id}`}
              />
            )}
            <span className="text-slate-400 w-24 shrink-0">{s.date}</span>
            <span className="text-slate-700 w-24 shrink-0">${fmt(s.amount)}</span>
            <span className="text-slate-400 truncate flex-1 min-w-0" title={s.desc}>{s.desc}</span>
            {splitMode && (
              <div className="shrink-0" data-testid={`chat-review-split-row-menu-${s.id}`}>
                <RowMoreMenu
                  t={{ id: s.id, ...s }}
                  onEdit={() => setSplitEditor({ rows: [s] })}
                  onRecategorize={() => doRecategorize(s)}
                  onSplit={() => doSplit(s)}
                  onLink={() => doLink(s)}
                  onAskClient={() => doAskClient(s)}
                  onDelete={() => doDelete(s)}
                />
              </div>
            )}
            {!splitMode && s.id && companyId && (
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
      {samples.length > 5 && !splitMode && (
        <div className="mt-1 flex items-center justify-between text-[10px] text-slate-400">
          <span>Scroll to see all {samples.length}</span>
          <button
            type="button"
            onClick={() => setSplitMode(true)}
            className="text-indigo-700 hover:text-indigo-900 underline"
            data-testid="chat-review-enter-split-2"
            title="Not all these belong together? Split into subgroups."
          >
            Split into subgroups
          </button>
        </div>
      )}
      {samples.length <= 5 && !splitMode && (
        <div className="mt-1 flex justify-end text-[10px] text-slate-400">
          <button
            type="button"
            onClick={() => setSplitMode(true)}
            className="text-indigo-700 hover:text-indigo-900 underline"
            data-testid="chat-review-enter-split-2"
            title="Not all these belong together? Split into subgroups."
          >
            Split into subgroups
          </button>
        </div>
      )}
      {samples.length > 5 && splitMode && (
        <div className="mt-1 flex items-center justify-between text-[10px] text-slate-400">
          <span>Scroll to see all {samples.length}</span>
          <button
            type="button"
            onClick={exitSplit}
            className="text-slate-500 hover:text-slate-900 underline"
            data-testid="chat-review-exit-split"
          >
            Exit split mode
          </button>
        </div>
      )}
      {samples.length <= 5 && splitMode && (
        <div className="mt-1 flex justify-end text-[10px] text-slate-400">
          <button
            type="button"
            onClick={exitSplit}
            className="text-slate-500 hover:text-slate-900 underline"
            data-testid="chat-review-exit-split"
          >
            Exit split mode
          </button>
        </div>
      )}
      {splitEditor && (
        <SplitApplyModal
          rows={splitEditor.rows}
          card={card}
          accounts={accounts}
          contacts={contacts}
          companyId={companyId}
          onClose={() => setSplitEditor(null)}
          onApplied={(appliedIds) => {
            popIds(appliedIds);
            setSplitEditor(null);
            onContactCreated?.();
          }}
        />
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

// ---------------------------------------------------------------------------
// SplitApplyModal — Categorize-selected popover used by the "Split into
// subgroups" rescue-hatch on the Chat Review card. Accepts one or many rows
// and lets the CPA set contact + category + an optional "also make this a
// rule" toggle, posting to /reviewv2/chat-review-split-apply. Applies apply
// to the passed-in `rows` only.
// ---------------------------------------------------------------------------
function SplitApplyModal({ rows, card, accounts, contacts, companyId, onClose, onApplied }) {
  const [contactId, setContactId] = useState(null);
  const [contactQuery, setContactQuery] = useState("");
  // Dropdown stays closed on mount — user opts in by focusing or typing.
  // Prevents the contact list from covering the popover the moment it
  // opens.
  const [contactPickerOpen, setContactPickerOpen] = useState(false);
  const [accountId, setAccountId] = useState(null);
  const [makeRule, setMakeRule] = useState(false);
  const [busy, setBusy] = useState(false);

  const filteredContacts = useMemo(() => {
    const q = contactQuery.trim().toLowerCase();
    const opts = (contacts || []).map(c => ({
      id: c.id, name: c.display_name || c.name || "",
    }));
    if (!q) return opts.slice(0, 100);
    return opts.filter(c => c.name.toLowerCase().includes(q)).slice(0, 100);
  }, [contacts, contactQuery]);
  const selectedContactName = useMemo(() => {
    if (!contactId) return contactQuery.trim();
    const c = (contacts || []).find(x => x.id === contactId);
    return c?.display_name || c?.name || "";
  }, [contactId, contactQuery, contacts]);

  // Approve is enabled once we have at least one field set. "Make rule"
  // requires BOTH — mirror the toolbar spec.
  const contactSet = Boolean(contactId || contactQuery.trim());
  const canApply = rows.length > 0 && !busy && (contactSet || accountId);
  const canRule  = rows.length > 0 && !busy && contactSet && accountId;

  const apply = async () => {
    if (!canApply) return;
    setBusy(true);
    try {
      const body = {
        card_kind: card?.kind,
        card_key:  card?.card_key,
        direction: card?.direction,
        group_key: card?.group_key,
        txn_ids:   rows.map(r => r.id),
        save_as_rule: makeRule && canRule,
      };
      if (contactId) body.contact_id = contactId;
      else if (contactQuery.trim()) body.contact_name = contactQuery.trim();
      if (accountId) body.category_account_id = accountId;
      const r = await api.post(
        `/companies/${companyId}/reviewv2/chat-review-split-apply`, body);
      if (r.data?.booked) {
        toast.success(
          `Booked ${rows.length} row${rows.length === 1 ? "" : "s"}${
            r.data?.rule_saved ? " · rule saved" : ""}`);
      } else {
        toast.success(
          `Reassigned ${rows.length} row${rows.length === 1 ? "" : "s"} · pending category`);
      }
      onApplied?.(rows.map(r => r.id));
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Couldn't apply");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
         onClick={onClose}
         data-testid="chat-review-split-modal">
      <div className="w-full max-w-md rounded-xl bg-white shadow-2xl p-5"
           onClick={e => e.stopPropagation()}>
        <div className="text-sm font-semibold text-slate-900">
          Categorize {rows.length} transaction{rows.length === 1 ? "" : "s"}
        </div>
        <div className="mt-1 text-[11px] text-slate-500">
          Set either a contact, a category, or both — this only applies to the selected rows.
        </div>

        {/* Contact picker */}
        <label className="mt-4 block text-[11px] uppercase tracking-wider text-slate-500">
          Contact <span className="text-slate-400 normal-case tracking-normal">(optional)</span>
        </label>
        <div className="mt-1 relative">
          <input
            type="text"
            value={selectedContactName}
            onChange={e => {
              setContactQuery(e.target.value);
              setContactId(null);
              // Only open the dropdown once the user actually starts
              // typing — a fresh open shouldn't cover the popover.
              setContactPickerOpen(e.target.value.trim().length > 0);
            }}
            onClick={() => setContactPickerOpen(v => !v)}
            placeholder="Type to search or add a new contact…"
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm
                       focus:outline-none focus:ring-2 focus:ring-indigo-200"
            data-testid="chat-review-split-contact-input"
          />
          {contactPickerOpen && (
            <div className="absolute z-10 mt-1 left-0 right-0 max-h-52 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
              {contactQuery.trim() &&
               !filteredContacts.some(c => c.name.toLowerCase() === contactQuery.trim().toLowerCase()) && (
                <button
                  type="button"
                  onClick={() => {
                    setContactId(null);
                    setContactPickerOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-indigo-700 hover:bg-indigo-50 border-b border-slate-100"
                  data-testid="chat-review-split-contact-add-new"
                >
                  + Add new contact "<b>{contactQuery.trim()}</b>"
                </button>
              )}
              {filteredContacts.map(c => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    setContactId(c.id);
                    setContactQuery(c.name);
                    setContactPickerOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 border-b border-slate-100 last:border-0"
                  data-testid={`chat-review-split-contact-hit-${c.id}`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Category picker */}
        <label className="mt-4 block text-[11px] uppercase tracking-wider text-slate-500">
          Category <span className="text-slate-400 normal-case tracking-normal">(optional)</span>
        </label>
        <div className="mt-1">
          <AccountPicker
            value={accountId}
            accounts={accounts}
            onChange={setAccountId}
            companyId={companyId}
            testId="chat-review-split-category"
          />
        </div>

        {/* Rule checkbox */}
        <label className={`mt-4 flex items-center gap-2 text-xs ${
          canRule ? "text-slate-700" : "text-slate-400"
        }`}>
          <input
            type="checkbox"
            checked={makeRule && canRule}
            disabled={!canRule}
            onChange={e => setMakeRule(e.target.checked)}
            className="h-3.5 w-3.5 accent-slate-900"
            data-testid="chat-review-split-make-rule"
          />
          Also make this a rule for future imports
          {!canRule && (
            <span className="text-[10px] text-slate-400">(needs contact + category)</span>
          )}
        </label>

        <div className="mt-5 flex items-center gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-xs text-slate-500 hover:text-slate-700 disabled:opacity-40"
            data-testid="chat-review-split-cancel"
          >Cancel</button>
          <button
            type="button"
            onClick={apply}
            disabled={!canApply}
            className="rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-4 py-1.5 disabled:opacity-40 inline-flex items-center gap-1"
            data-testid="chat-review-split-apply"
          >
            {busy ? "Applying…" : `Apply to ${rows.length} row${rows.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// Shared "Update contact" panel used by both NoCategoryCard and
// TransactionsCard. Opens when the user clicks the "Update contact"
// link next to the Chat composer helper text; lets them (a) reassign
// this card's rows to a different or new contact, or (b) globally
// rename the currently-assigned contact.
//
// Deliberately does NOT include a "No specific contact" button — that
// affordance lives only on the initial "Is there one specific contact
// for…" picker in TransactionsCard, which this panel does not replace.
function UpdateContactPanel({
  companyId, contacts, cardContactId, txnIds,
  onClose, onAfter, onContactCreated,
}) {
  const [q, setQ] = useState("");
  const [selId, setSelId] = useState(null);
  const [busy, setBusy] = useState(false);
  const matches = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return [];
    return contacts
      .filter(c => (c.display_name || c.name || "").toLowerCase().includes(n))
      .slice(0, 8);
  }, [q, contacts]);

  const applyUse = async () => {
    if (!selId || !txnIds?.length) return;
    setBusy(true);
    try {
      await api.post(`/companies/${companyId}/transactions/bulk-set-contact`, {
        transaction_ids: txnIds,
        contact_id: selId,
      });
      toast.success("Contact updated for these transactions");
      onClose();
      await onAfter?.();
    } catch { toast.error("Couldn't update contact"); }
    finally { setBusy(false); }
  };

  const applyCreate = async () => {
    const nm = q.trim();
    if (!nm || !txnIds?.length) return;
    setBusy(true);
    try {
      const r = await api.post(`/companies/${companyId}/contacts`, {
        name: nm, type: "vendor",
      });
      const c = r.data;
      onContactCreated?.(c);
      await api.post(`/companies/${companyId}/transactions/bulk-set-contact`, {
        transaction_ids: txnIds,
        contact_id: c.id,
      });
      toast.success(`Created '${nm}' and assigned to these transactions`);
      onClose();
      await onAfter?.();
    } catch { toast.error("Couldn't create + assign contact"); }
    finally { setBusy(false); }
  };

  const applyRename = async () => {
    const nm = q.trim();
    if (!nm) return;
    if (!cardContactId) { toast.error("No contact to rename"); return; }
    setBusy(true);
    try {
      const r = await api.post(
        `/companies/${companyId}/contacts/${cardContactId}/rename-and-propagate`,
        { name: nm },
      );
      toast.success(
        `Renamed contact · ${r.data?.transactions_updated || 0} transactions relabeled`
      );
      onClose();
      await onAfter?.();
    } catch { toast.error("Couldn't rename contact"); }
    finally { setBusy(false); }
  };

  return (
    <div
      className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50/40 p-4"
      data-testid="chat-review-update-contact-panel"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-semibold text-slate-800">
          Update the contact of the above transactions.
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-slate-500 hover:text-slate-800"
          data-testid="chat-review-close-update-contact"
        >
          Cancel
        </button>
      </div>
      <div className="mt-2 relative">
        <input
          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white
                     focus:outline-none focus:ring-2 focus:ring-indigo-200"
          placeholder="Search a contact, or type a new name…"
          value={q}
          onChange={e => { setQ(e.target.value); setSelId(null); }}
          data-testid="chat-review-update-contact-input"
        />
        {q && matches.length > 0 && !selId && (
          <div className="absolute z-10 left-0 right-0 mt-1 rounded-lg border bg-white shadow max-h-52 overflow-y-auto">
            {matches.map(c => (
              <button
                key={c.id}
                type="button"
                onClick={() => { setSelId(c.id); setQ(c.display_name || c.name || ""); }}
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
          onClick={applyCreate}
          disabled={!q.trim() || busy}
          className="rounded-lg px-3 py-1.5 text-sm bg-indigo-600 text-white
                     hover:bg-indigo-700 disabled:opacity-40 flex items-center gap-1"
          data-testid="chat-review-update-create-contact"
        >
          <Plus size={14} /> Create contact
        </button>
        <button
          type="button"
          onClick={applyRename}
          disabled={!q.trim() || busy || !cardContactId}
          className="rounded-lg px-3 py-1.5 text-sm bg-white border border-indigo-300 text-indigo-700
                     hover:bg-indigo-50 disabled:opacity-40"
          data-testid="chat-review-update-rename-contact"
          title="Rename the currently-assigned contact everywhere it's used"
        >
          Rename contact
        </button>
        <button
          type="button"
          onClick={applyUse}
          disabled={!selId || busy}
          className="rounded-lg px-3 py-1.5 text-sm bg-emerald-600 text-white
                     hover:bg-emerald-700 disabled:opacity-40"
          data-testid="chat-review-update-use-contact"
        >
          Use this contact
        </button>
      </div>
    </div>
  );
}

// Underlined text link that opens the Update Contact panel. Same visual
// treatment as "Split into subgroups". Kept as a named component so
// both NoCategoryCard and TransactionsCard render an identical trigger.
function UpdateContactLink({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-indigo-700 hover:text-indigo-900 underline"
      data-testid="chat-review-open-update-contact"
      title="Reassign or rename the contact for these transactions"
    >
      Update contact
    </button>
  );
}

// ── "Answered" drawer ────────────────────────────────────────────────
// Slide-in panel triggered from the top-of-page "Answered · N" link.
// Lists booked Chat Review transactions most-recent-first with search
// + contact-name filter. Each row has a "Reopen" action that flips
// the txn back to `needs_review` so it re-enters the queue.
function AnsweredDrawer({ companyId, onClose, onReopened }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [reopenBusy, setReopenBusy] = useState(null);

  const load = async (query = "") => {
    setLoading(true);
    try {
      const r = await api.get(
        `/companies/${companyId}/reviewv2/chat-review-answered`,
        { params: { q: query || undefined, limit: 100 } },
      );
      setItems(r.data?.items || []);
      setTotal(r.data?.total || 0);
    } catch { toast.error("Couldn't load answered questions"); }
    finally { setLoading(false); }
  };

  // Load on mount + debounced re-search on q change
  useEffect(() => { load(""); /* eslint-disable-next-line */ }, [companyId]);
  useEffect(() => {
    const h = setTimeout(() => { load(q); }, 300);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const reopen = async (item) => {
    setReopenBusy(item.txn_ids[0]);
    try {
      await api.post(
        `/companies/${companyId}/reviewv2/chat-review-reopen`,
        { transaction_ids: item.txn_ids },
      );
      toast.success(
        item.count === 1
          ? "Question reopened"
          : `${item.count} transactions sent back to the review queue`
      );
      setItems(prev => prev.filter(x => x.txn_ids[0] !== item.txn_ids[0]));
      setTotal(t => Math.max(0, t - 1));
      await onReopened?.();
    } catch { toast.error("Couldn't reopen"); }
    finally { setReopenBusy(null); }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex justify-end"
      data-testid="chat-review-answered-drawer"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-slate-900/30" />
      <div
        className="relative w-full sm:w-[520px] max-w-full h-full bg-white shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <div className="text-base font-semibold text-slate-900">Answered questions</div>
            <div className="text-xs text-slate-500">
              {total} question{total === 1 ? "" : "s"} · most recent first
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-900"
            data-testid="chat-review-close-answered"
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-3 border-b border-slate-100">
          <input
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm
                       focus:outline-none focus:ring-2 focus:ring-indigo-200"
            placeholder="Search contact, description, or category…"
            value={q}
            onChange={e => setQ(e.target.value)}
            data-testid="chat-review-answered-search"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="p-6 text-center text-sm text-slate-500">
              <Loader2 size={16} className="inline animate-spin mr-2" />
              Loading…
            </div>
          )}
          {!loading && items.length === 0 && (
            <div className="p-6 text-center text-sm text-slate-500">
              {q ? "No matches." : "Nothing answered yet."}
            </div>
          )}
          {!loading && items.map((g) => (
            <div
              key={g.txn_ids[0]}
              className="px-5 py-3 border-b border-slate-100 hover:bg-slate-50 flex items-start gap-3"
              data-testid={`chat-review-answered-row-${g.txn_ids[0]}`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-slate-900 truncate">
                  {g.prompt}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {g.count} transaction{g.count === 1 ? "" : "s"}
                  {" · "}${Math.abs(g.total_dollars).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} total
                  {" · "}<span className="text-slate-700">{g.category_account_name || "Uncategorized"}</span>
                </div>
                {g.count === 1 && g.sample_description && (
                  <div className="text-[11px] text-slate-400 mt-0.5 truncate font-mono">
                    {g.sample_description}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => reopen(g)}
                disabled={reopenBusy === g.txn_ids[0]}
                className="text-xs text-indigo-700 hover:text-indigo-900 underline shrink-0 disabled:opacity-40"
                data-testid={`chat-review-reopen-${g.txn_ids[0]}`}
                title="Send these transactions back to the review queue"
              >
                Reopen
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ChatBox({ text, setText, onSend, busy, placeholder, compact, rightSlot }) {
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
        <div className="text-[11px] text-slate-500 flex items-center gap-1 flex-wrap mb-1">
          <MessageCircle size={12} /> Tell us in your own words —
          <span className="text-slate-400">the AI will propose a booking. Nothing posts until you confirm.</span>
          {rightSlot}
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
  matchAccountId,      // when the caller pre-resolved the match
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
  const aiAccountId = matchAccountId ?? findAccountIdFromProposal(proposal, accounts);
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
