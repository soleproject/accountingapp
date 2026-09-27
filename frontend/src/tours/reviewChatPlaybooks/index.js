// Review Chat Co-Pilot playbook library — Phase 1.
//
// A "playbook" is a scripted sequence of tour beats that guides the
// CPA through resolving a specific review-chat scenario. The
// classifier LLM picks a playbook key based on the CPA's utterance +
// current card snapshot; the deterministic tour engine executes the
// beats. This means the LLM never invents non-existent buttons —
// every action is authored by us.
//
// Beat shape is IDENTICAL to /app/frontend/src/tours/chatReviewBeats.js
// so the same ChatReviewTour component runs both the first-visit tour
// and any playbook. Fields we may use here that the tour doesn't:
//   - slotRef: "contact" | "category" — narrator text pulls a slot
//     value in via {contact}/{category} placeholders resolved before
//     the beats play.
//
// Note: `requires` is checked on the FRONTEND before triggering, and
// the FULL description passed to the LLM system prompt so it knows
// which playbooks are viable for the current card state.

const HOLD_SHORT = 1500;
const HOLD_MED = 2600;
const HOLD_LONG = 3600;

// 1) The whole card is under the wrong contact. One-shot fix.
export const wrongSingleContact = {
  key: "wrong-single-contact",
  match: "Every row on this card belongs to a DIFFERENT single contact than what I picked (e.g. 'this is really Bob, not Wells Fargo').",
  requires: [],
  slots: { targetContact: "string (name of the correct contact) — optional" },
  beats: (slots) => [
    {
      key: "wsc-intro",
      chapter: "copilot",
      narrator:
        "Got it — every row on this card belongs to " +
        (slots.targetContact ? `${slots.targetContact}` : "a different contact") +
        ". I'll walk you to the Update Contact panel where you can re-assign all of them in one shot.",
      center: true,
      wait: HOLD_MED,
    },
    {
      key: "wsc-open",
      chapter: "copilot",
      narrator: "Click 'Update contact' — I'll open it for you.",
      anchor: "chat-review-open-update-contact",
      cursor: { move: "chat-review-open-update-contact", click: true },
      wait: HOLD_MED,
    },
    {
      key: "wsc-outro",
      chapter: "copilot",
      narrator:
        "Type the correct contact name and confirm. I'll re-assign every transaction on the card so the next question is asked under the right vendor or customer.",
      anchor: "chat-review-update-contact-panel",
      wait: HOLD_LONG,
      finale: true,
    },
  ],
};

// 2) The card is a mix of DIFFERENT contacts. Coach through Show all + Split mode.
export const wrongMixedContacts = {
  key: "wrong-mixed-contacts",
  match: "Rows on this card belong to MULTIPLE different contacts (e.g. 'these aren't all Wells Fargo — some are Bob and some are Alice').",
  requires: ["sampleCount >= 5"],
  slots: {},
  beats: () => [
    {
      key: "wmc-intro",
      chapter: "copilot",
      narrator:
        "Different rows, different contacts — perfect case for Split mode. I'll open the full list and turn on selection for you.",
      center: true,
      wait: HOLD_MED,
    },
    {
      key: "wmc-showall",
      chapter: "copilot",
      narrator: "Opening 'Show all' so you can see every transaction on the card.",
      anchor: "chat-review-show-all",
      cursor: { move: "chat-review-show-all", click: true },
      wait: HOLD_MED,
    },
    {
      key: "wmc-split",
      chapter: "copilot",
      narrator:
        "Now flipping into Split mode — every row picks up a checkbox on the left.",
      anchor: "chat-review-show-all-split",
      cursor: { move: "chat-review-show-all-split", click: true },
      wait: HOLD_MED,
    },
    {
      key: "wmc-outro",
      chapter: "copilot",
      narrator:
        "Your turn: tick the rows for the first contact, click 'Update selected' to re-assign them all, then repeat for the next contact. When only one contact's rows remain, close this modal and answer normally. Ping me if you want me to peel a subgroup off with 'Ask separately' instead.",
      anchor: "chat-review-show-all-modal",
      spotlights: ["chat-review-show-all-update-selected", "chat-review-show-all-ask-separately"],
      wait: HOLD_LONG,
      finale: true,
    },
  ],
};

// 3) Just one row is different — peel it off.
export const oneTransactionOdd = {
  key: "one-transaction-odd",
  match: "One (or a few) specific rows are different from the rest of the card (e.g. 'all of these are meals except the $500 one — that's rent').",
  requires: [],
  slots: {
    targetDescription: "string — hint at which row(s) are odd, optional",
  },
  beats: (slots) => [
    {
      key: "oto-intro",
      chapter: "copilot",
      narrator:
        "One-off? Easy — I'll turn on Split mode so you can tick just the odd row" +
        (slots.targetDescription ? ` (${slots.targetDescription})` : "") +
        " and use 'Ask separately' to peel it into its own question card.",
      center: true,
      wait: HOLD_MED,
    },
    {
      key: "oto-split",
      chapter: "copilot",
      narrator: "Flipping into Split mode now.",
      anchor: "chat-review-enter-split-2",
      cursor: { move: "chat-review-enter-split-2", click: true },
      wait: HOLD_MED,
    },
    {
      key: "oto-outro",
      chapter: "copilot",
      narrator:
        "Tick the row (or rows) that don't belong, then hit 'Ask separately'. The rest of the card can be answered normally afterward.",
      anchor: "chat-review-samples",
      spotlights: ["chat-review-ask-separately"],
      wait: HOLD_LONG,
      finale: true,
    },
  ],
};

// 4) A single transaction needs to be split across MULTIPLE accounts.
export const subSplitOneRow = {
  key: "sub-split-one-row",
  match: "ONE transaction needs to be split across multiple accounts (e.g. '$500 Amazon = $450 office supplies + $50 sales tax').",
  requires: [],
  slots: {
    targetDescription: "string — hint at which row to split",
  },
  beats: () => [
    {
      key: "ssr-intro",
      chapter: "copilot",
      narrator:
        "That's a per-row split — different from splitting the CARD into subgroups. I'll open the row's three-dot menu so you can pick 'Split' and enter each line separately.",
      center: true,
      wait: HOLD_MED,
    },
    {
      key: "ssr-menu",
      chapter: "copilot",
      narrator: "Opening the row menu.",
      anchor: "chat-review-row-menu-0",
      cursor: { move: "txn-more-tour-t-1-1", click: true },
      spotlights: ["txn-split-btn"],
      wait: HOLD_MED,
    },
    {
      key: "ssr-outro",
      chapter: "copilot",
      narrator:
        "Click 'Split' from the menu, then enter each line's amount and account. Amounts must sum to the transaction total — I'll flag it if they don't.",
      wait: HOLD_LONG,
      finale: true,
    },
  ],
};

// 5) Conversational — no playbook, just answer the CPA's question.
// The classifier LLM returns this key when nothing scripted fits.
export const explainWhy = {
  key: "explain-why",
  match: "The CPA is asking a conversational question that doesn't need a UI action — 'why did you categorize this X?' / 'what's the difference between Meals and Entertainment?' / any general help.",
  requires: [],
  slots: {},
  beats: null, // no beats — falls through to plain chat reply
};

export const PLAYBOOKS = {
  "wrong-single-contact": wrongSingleContact,
  "wrong-mixed-contacts": wrongMixedContacts,
  "one-transaction-odd": oneTransactionOdd,
  "sub-split-one-row": subSplitOneRow,
  "explain-why": explainWhy,
};

// Compact manifest for LLM system prompt. Kept short so we don't blow
// the classifier's context on definitions.
export const PLAYBOOK_MANIFEST = Object.values(PLAYBOOKS).map((p) => ({
  key: p.key,
  match: p.match,
  requires: p.requires,
  slots: p.slots,
}));

// Frontend gate: reject an LLM pick if the card doesn't satisfy the
// playbook's `requires`. Returns the playbook if valid, else null.
export function resolvePlaybook(key, cardSnapshot) {
  const p = PLAYBOOKS[key];
  if (!p) return null;
  for (const req of p.requires || []) {
    // Tiny requirements DSL. Add more as we grow the library.
    const m = req.match(/^sampleCount\s*(>=|>|<=|<|==)\s*(\d+)$/);
    if (m) {
      const [, op, nStr] = m;
      const n = parseInt(nStr, 10);
      const val = cardSnapshot?.sampleCount ?? 0;
      const ok =
        op === ">=" ? val >= n
        : op === ">" ? val > n
        : op === "<=" ? val <= n
        : op === "<" ? val < n
        : val === n;
      if (!ok) return null;
    }
  }
  return p;
}
