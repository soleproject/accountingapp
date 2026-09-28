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
      key: "wmc-opt1-intro",
      chapter: "copilot",
      narrator:
        "You've got two options here. Option one: if you already know the contact, tick the rows that belong to the same person or vendor — watch, I'll tick three of them for you.",
      anchor: "chat-review-show-all-list",
      cursor: {
        clicks: [
          "css:[data-testid=chat-review-show-all-list] > li:nth-of-type(2) input[type=checkbox]",
          "css:[data-testid=chat-review-show-all-list] > li:nth-of-type(3) input[type=checkbox]",
          "css:[data-testid=chat-review-show-all-list] > li:nth-of-type(4) input[type=checkbox]",
        ],
      },
      wait: HOLD_MED,
    },
    {
      key: "wmc-opt1-update",
      chapter: "copilot",
      narrator:
        "Now hit 'Update selected' — I'll open the panel where you pick the contact.",
      anchor: "chat-review-show-all-update-selected",
      cursor: { move: "chat-review-show-all-update-selected", click: true },
      wait: HOLD_MED,
    },
    {
      key: "wmc-opt1-popup",
      chapter: "copilot",
      narrator:
        "This is the update panel — pick a contact (and optionally a category), hit Save, and I'll re-book all the ticked rows against that contact in one shot.",
      anchor: "chat-review-split-modal",
      wait: 6000,
    },
    {
      key: "wmc-opt1-close",
      chapter: "copilot",
      narrator:
        "I'll close it now so we can look at option two.",
      anchor: "chat-review-split-cancel",
      cursor: { move: "chat-review-split-cancel", click: true, delay: 2400 },
      wait: HOLD_MED,
    },
    {
      key: "wmc-opt2-outro",
      chapter: "copilot",
      narrator:
        "Option two: if you're NOT sure of the contact yet, tick the rows that go together and hit 'Ask separately' — I'll peel them off into their own question card so we can figure out the contact over there. Same starting move; different button. Alright — it's your turn. I'll clear my selections and leave the full list open in Split mode so you can pick up from here.",
      anchor: "chat-review-show-all-ask-separately",
      cursor: { move: "chat-review-show-all-clear", click: true, delay: 8500 },
      wait: 1200,
      finale: true,
      autoClose: true,
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

// 5a) FAQ helper — just walk the CPA through the "Show all" affordance
// and open the modal for them. No decisions to make; used by the
// AiPanel FAQ "▶ Show me how" link.
export const viewAllTransactions = {
  key: "view-all-transactions",
  match: "The CPA wants to see every transaction on the card (not just the first 5 inline rows).",
  requires: [],
  slots: {},
  beats: () => [
    {
      key: "vat-intro",
      chapter: "copilot",
      narrator:
        "The inline list is clipped to 5 rows. Two ways to see everything: scroll the little list with your trackpad, or click 'Show all' at the top-right — I'll pop it open for you now.",
      center: true,
      wait: HOLD_MED,
    },
    {
      key: "vat-showall",
      chapter: "copilot",
      narrator:
        "Opening the full-page popup. Inside you can filter by date, amount, or description, and every row has a three-dot menu to edit, recategorize, split, or link.",
      anchor: "chat-review-show-all",
      cursor: { move: "chat-review-show-all", click: true },
      wait: HOLD_MED,
      finale: true,
    },
  ],
};

// 5b) Conversational — no playbook, just answer the CPA's question.
// The classifier LLM returns this key when nothing scripted fits.
export const explainWhy = {
  key: "explain-why",
  match: "The CPA is asking a conversational question that doesn't need a UI action — 'why did you categorize this X?' / 'what's the difference between Meals and Entertainment?' / any general help.",
  requires: [],
  slots: {},
  beats: null, // no beats — falls through to plain chat reply
};

// 6) Rows belong in DIFFERENT categories (not different contacts).
export const wrongMixedCategories = {
  key: "wrong-mixed-categories",
  match: "Rows on this card belong to MULTIPLE different accounts/categories (e.g. 'some are meals, some are travel, some are supplies').",
  requires: ["sampleCount >= 5"],
  slots: {},
  beats: () => [
    {
      key: "wmcat-intro",
      chapter: "copilot",
      narrator: "Mixed categories — I'll open the full list and turn on Split mode so you can peel each group off and answer them one bucket at a time.",
      center: true,
      wait: HOLD_MED,
    },
    {
      key: "wmcat-showall",
      chapter: "copilot",
      narrator: "Opening the full list.",
      anchor: "chat-review-show-all",
      cursor: { move: "chat-review-show-all", click: true },
      wait: HOLD_MED,
    },
    {
      key: "wmcat-split",
      chapter: "copilot",
      narrator: "Flipping into Split mode — each row now has a checkbox.",
      anchor: "chat-review-show-all-split",
      cursor: { move: "chat-review-show-all-split", click: true },
      wait: HOLD_MED,
    },
    {
      key: "wmcat-opt1-intro",
      chapter: "copilot",
      narrator:
        "You've got two options here. Option one: if you already know the category, tick the rows that belong together — watch, I'll tick three of them for you.",
      anchor: "chat-review-show-all-list",
      cursor: {
        clicks: [
          "css:[data-testid=chat-review-show-all-list] > li:nth-of-type(2) input[type=checkbox]",
          "css:[data-testid=chat-review-show-all-list] > li:nth-of-type(3) input[type=checkbox]",
          "css:[data-testid=chat-review-show-all-list] > li:nth-of-type(4) input[type=checkbox]",
        ],
      },
      wait: HOLD_MED,
    },
    {
      key: "wmcat-opt1-update",
      chapter: "copilot",
      narrator:
        "Now hit 'Update selected' — I'll open the panel where you pick the category.",
      anchor: "chat-review-show-all-update-selected",
      cursor: { move: "chat-review-show-all-update-selected", click: true },
      wait: HOLD_MED,
    },
    {
      key: "wmcat-opt1-popup",
      chapter: "copilot",
      narrator:
        "This is the categorize panel — pick a category (or a contact, or both) and hit Save and I'll re-book all the ticked rows in one shot.",
      anchor: "chat-review-split-modal",
      wait: 6000,
    },
    {
      key: "wmcat-opt1-close",
      chapter: "copilot",
      narrator:
        "I'll close it now so we can look at option two.",
      anchor: "chat-review-split-cancel",
      cursor: { move: "chat-review-split-cancel", click: true, delay: 2400 },
      wait: HOLD_MED,
    },
    {
      key: "wmcat-opt2-outro",
      chapter: "copilot",
      narrator:
        "Option two: if you're NOT sure of the category yet, tick the rows that go together and hit 'Ask separately' — I'll peel them off into their own question card so we can figure out the category over there. Same starting move; different button. Alright — it's your turn. I'll clear my selections and leave the full list open in Split mode so you can pick up from here.",
      anchor: "chat-review-show-all-ask-separately",
      cursor: { move: "chat-review-show-all-clear", click: true, delay: 8500 },
      wait: 1200,
      finale: true,
      autoClose: true,
    },
  ],
};

// 7) Link a payment to an open INVOICE (AR).
export const linkToInvoice = {
  key: "link-to-invoice",
  match: "A payment coming IN matches an open invoice on file (e.g. 'this deposit is for invoice #123 from ACME').",
  requires: [],
  slots: { invoiceHint: "invoice number or customer name — optional" },
  beats: (slots) => [
    {
      key: "lti-intro",
      chapter: "copilot",
      narrator:
        (slots.invoiceHint ? `Linking to ${slots.invoiceHint}. ` : "") +
        "Here's how linking works. When a payment matches an open invoice or bill, we link it so the AR or AP account clears automatically — no double-counting. Watch me walk through it.",
      center: true,
      wait: HOLD_MED,
    },
    {
      key: "lti-open-menu",
      chapter: "copilot",
      narrator: "Step one — open the three-dot menu on the row that matches your invoice.",
      anchor: "chat-review-row-menu-0",
      cursor: {
        clicks: ["css:[data-testid=chat-review-row-menu-0] button"],
        delay: 1600,
      },
      wait: HOLD_SHORT,
    },
    {
      key: "lti-highlight-link",
      chapter: "copilot",
      narrator: "This is 'Link to invoice / bill' — that's the one you want. I'll open the picker for you.",
      anchor: "txn-link-btn",
      cursor: { move: "txn-link-btn", click: true, delay: 3200 },
      wait: HOLD_SHORT,
    },
    {
      key: "lti-picker",
      chapter: "copilot",
      narrator:
        "This is the picker — every open invoice and bill is here. Search by number, customer, or amount; tick the docs that match; and hit Apply. I'll book the payment against Accounts Receivable so the invoice closes cleanly.",
      anchor: "modal-overlay",
      wait: 6500,
    },
    {
      key: "lti-close-handoff",
      chapter: "copilot",
      narrator:
        "Alright — it's your turn. I'll close the picker so you can pick the right invoice for this real payment yourself.",
      anchor: "modal-overlay",
      cursor: {
        clicks: ["css:[data-testid=modal-overlay] [data-testid=cancel-btn]"],
        delay: 3600,
      },
      wait: 1200,
      finale: true,
      autoClose: true,
    },
  ],
};

// 8) Link a payment to an open BILL (AP).
export const linkToBill = {
  key: "link-to-bill",
  match: "A payment going OUT matches an open vendor bill (e.g. 'this is paying the ACME bill from March').",
  requires: [],
  slots: { billHint: "bill number or vendor — optional" },
  beats: (slots) => [
    {
      key: "ltb-intro",
      chapter: "copilot",
      narrator:
        (slots.billHint ? `Linking to ${slots.billHint}. ` : "") +
        "Here's how linking a bill payment works. When a payment out matches an open vendor bill, I'll book it against Accounts Payable so the bill closes cleanly — no double-expensing. Watch me walk through it.",
      center: true,
      wait: HOLD_MED,
    },
    {
      key: "ltb-open-menu",
      chapter: "copilot",
      narrator: "Step one — open the three-dot menu on the row that matches your bill.",
      anchor: "chat-review-row-menu-0",
      cursor: {
        clicks: ["css:[data-testid=chat-review-row-menu-0] button"],
        delay: 1600,
      },
      wait: HOLD_SHORT,
    },
    {
      key: "ltb-highlight-link",
      chapter: "copilot",
      narrator: "This is 'Link to invoice / bill' — that's the one you want. I'll open the picker for you.",
      anchor: "txn-link-btn",
      cursor: { move: "txn-link-btn", click: true, delay: 3200 },
      wait: HOLD_SHORT,
    },
    {
      key: "ltb-picker",
      chapter: "copilot",
      narrator:
        "This is the picker — flip to the Bill tab, search by number, vendor, or amount, tick the docs that match, then hit Apply. I'll book the payment against Accounts Payable so the bill closes.",
      anchor: "modal-overlay",
      wait: 6500,
    },
    {
      key: "ltb-close-handoff",
      chapter: "copilot",
      narrator:
        "Alright — it's your turn. I'll close the picker so you can pick the right bill for this real payment yourself.",
      anchor: "modal-overlay",
      cursor: {
        clicks: ["css:[data-testid=modal-overlay] [data-testid=cancel-btn]"],
        delay: 3600,
      },
      wait: 1200,
      finale: true,
      autoClose: true,
    },
  ],
};

// 9) Owner contribution — money coming IN from the owner.
export const ownerContribution = {
  key: "owner-contribution",
  match: "Money coming IN that's the owner putting their own money into the business (e.g. 'this is my own money going in', 'personal funds').",
  requires: [],
  slots: {},
  beats: () => [
    {
      key: "oc-intro",
      chapter: "copilot",
      narrator:
        "Perfect — owner contributions belong in Equity, not Revenue. Type 'owner contribution' or 'personal funds in' in the answer box and I'll create an Owner's Equity or Contributed Capital account and book the row(s) against it.",
      anchor: "chat-review-input",
      ghost: { kind: "typing", text: "owner contribution" },
      wait: HOLD_LONG,
      finale: true,
    },
  ],
};

// 10) Owner draw — money going OUT to the owner personally.
export const ownerDraw = {
  key: "owner-draw",
  match: "Money going OUT to the owner personally (e.g. 'this is me paying myself', 'personal withdrawal').",
  requires: [],
  slots: {},
  beats: () => [
    {
      key: "od-intro",
      chapter: "copilot",
      narrator:
        "Got it — money out to the owner is Owner's Draw (equity), never a business expense. Type 'owner draw' or 'personal withdrawal' in the answer box and I'll book against the equity account so the P&L stays clean.",
      anchor: "chat-review-input",
      ghost: { kind: "typing", text: "owner draw" },
      wait: HOLD_LONG,
      finale: true,
    },
  ],
};

// 11) Client refund — money OUT to a customer, matches an existing invoice/deposit.
export const clientRefund = {
  key: "client-refund",
  match: "Money going OUT that's a refund back to a customer (e.g. 'refund to client Acme', 'we returned the deposit').",
  requires: [],
  slots: { customerHint: "customer name — optional" },
  beats: (slots) => [
    {
      key: "cr-intro",
      chapter: "copilot",
      narrator:
        (slots.customerHint ? `Refund to ${slots.customerHint}. ` : "") +
        "Refunds should link back to the original invoice/deposit so revenue reverses correctly. I'll open the row's ⋯ menu — pick 'Link to invoice / bill' and choose the matching doc.",
      center: true,
      wait: HOLD_MED,
    },
    {
      key: "cr-menu",
      chapter: "copilot",
      narrator: "Opening the row menu.",
      anchor: "chat-review-row-menu-0",
      cursor: { move: "txn-more-tour-t-1-1", click: true },
      spotlights: ["txn-link-btn"],
      wait: HOLD_MED,
      finale: true,
    },
  ],
};

// 12) Sales tax remittance — money OUT to the state.
export const salesTaxRemittance = {
  key: "sales-tax-remittance",
  match: "Money going OUT to a state or tax authority for sales tax (e.g. 'my sales tax payment to CA', 'state tax remittance').",
  requires: [],
  slots: {},
  beats: () => [
    {
      key: "str-intro",
      chapter: "copilot",
      narrator:
        "Sales tax remittances aren't an expense — they clear the Sales Tax Payable liability you already booked when you invoiced customers. Type 'sales tax payment' in the answer box and I'll book against Sales Tax Payable, not to any expense account.",
      anchor: "chat-review-input",
      ghost: { kind: "typing", text: "sales tax payment" },
      wait: HOLD_LONG,
      finale: true,
    },
  ],
};

// 13) Payroll run — money OUT to a payroll provider or employees.
export const payrollRun = {
  key: "payroll-run",
  match: "Money going OUT that's a paycheck, payroll provider run, or contractor payment (e.g. 'this is the Gusto run', 'paycheck for John').",
  requires: [],
  slots: { payeeHint: "employee/contractor name — optional" },
  beats: (slots) => [
    {
      key: "pr-intro",
      chapter: "copilot",
      narrator:
        (slots.payeeHint ? `Payroll for ${slots.payeeHint}. ` : "") +
        "Type 'payroll' for W-2 employees or 'contractor payment for [name]' for 1099 contractors and I'll book to the right account. If this is a Gusto/ADP lump sum, tell me 'payroll run' and I'll split it into Wages, Employer Taxes, and Fees for you.",
      anchor: "chat-review-input",
      ghost: { kind: "typing", text: "payroll run" },
      wait: HOLD_LONG,
      finale: true,
    },
  ],
};

// 14) Transfer between the owner's own accounts.
export const transferBetweenAccounts = {
  key: "transfer-between-accounts",
  match: "Money moving between the business's own bank/credit-card accounts, not a payment to or from a third party (e.g. 'I moved money from checking to savings', 'this pays down my credit card').",
  requires: [],
  slots: {},
  beats: () => [
    {
      key: "tba-intro",
      chapter: "copilot",
      narrator:
        "Transfers aren't income or expense — they just move dollars from one account to another. I'll open the row's ⋯ menu — pick 'Link to invoice / bill' and I'll show you the matching transaction on the other side so I can pair them up as a Transfer.",
      center: true,
      wait: HOLD_MED,
    },
    {
      key: "tba-menu",
      chapter: "copilot",
      narrator: "Opening the row menu.",
      anchor: "chat-review-row-menu-0",
      cursor: { move: "txn-more-tour-t-1-1", click: true },
      spotlights: ["txn-link-btn"],
      wait: HOLD_MED,
      finale: true,
    },
  ],
};

// 15) Skip with a note — CPA isn't sure yet.
export const skipWithNote = {
  key: "skip-with-note",
  match: "The CPA can't answer this card right now and wants to come back to it (e.g. 'not sure yet, ask me later', 'skip this one', 'I need to check with the client').",
  requires: [],
  slots: {},
  beats: () => [
    {
      key: "swn-intro",
      chapter: "copilot",
      narrator:
        "No problem — I'll queue this at the end so you can move on. Hit 'Skip for now' any time.",
      anchor: "chat-review-skip",
      cursor: { move: "chat-review-skip", click: true },
      wait: HOLD_MED,
      finale: true,
    },
  ],
};

export const PLAYBOOKS = {
  "wrong-single-contact": wrongSingleContact,
  "wrong-mixed-contacts": wrongMixedContacts,
  "wrong-mixed-categories": wrongMixedCategories,
  "one-transaction-odd": oneTransactionOdd,
  "sub-split-one-row": subSplitOneRow,
  "link-to-invoice": linkToInvoice,
  "link-to-bill": linkToBill,
  "view-all-transactions": viewAllTransactions,
  "owner-contribution": ownerContribution,
  "owner-draw": ownerDraw,
  "client-refund": clientRefund,
  "sales-tax-remittance": salesTaxRemittance,
  "payroll-run": payrollRun,
  "transfer-between-accounts": transferBetweenAccounts,
  "skip-with-note": skipWithNote,
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
