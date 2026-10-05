// Guided walkthrough for /accounting/transactions — same engine and
// bookkeeper tone as the Review Chat tour. Read-only on real data: the
// only real click is the "To do" filter toggle; approving, the popup and
// the AI hand-off are demonstrated with pointers + ghost previews.
//
// Beat shape: see tours/chatReviewBeats.js. Extra: `dock: "left" | "top-left"`
// moves the narrator card away from an anchor that lives bottom-right.

export const TXN_CHAPTERS = [
  { key: "find", title: "Find the work" },
  { key: "approve", title: "Approving" },
  { key: "ask", title: "When something's off" },
  { key: "link", title: "Linking invoices & bills" },
  { key: "receipts", title: "Receipts" },
];

const HOLD_SHORT = 1500;
const HOLD_MED = 2600;
const HOLD_LONG = 3600;

// First unapproved row's controls. Rows render the approve check with a
// shared testid, so the first match is the first visible row.
const FIRST_ROW_CHECK = "css:tbody tr [data-testid='txn-approve-btn']";
const FIRST_ROW_SPARKLE = "css:tbody tr [data-testid^='txn-ai-']";
const FIRST_ROW_MORE = "css:tbody tr button[data-testid^='txn-more-']";
const FIRST_ROW_CATEGORY = "css:tbody tr [data-testid^='txn-cat-picker-']";
const FIRST_ROW_PAPERCLIP = "css:tbody tr [data-testid^='txn-receipt-badge-']";

export const TXN_BEATS = [
  {
    key: "welcome",
    chapter: "find",
    narrator:
      "Hi! Let me show you how the Transactions page works. It's very easy!",
    center: true,
    wait: HOLD_LONG,
  },
  {
    key: "todo",
    chapter: "find",
    narrator:
      "Start by clicking 'To do'. That hides everything that's already approved, so you only see the transactions still waiting on a category or your sign-off. I'll click it for you.",
    anchor: "txn-filter-unapproved",
    cursor: { click: true, delay: 2200 },
    wait: HOLD_MED,
  },
  {
    key: "check",
    chapter: "approve",
    narrator:
      "Each row has a green check on the right. If the category looks right, click it and the transaction is approved and posted — that's it. If a row is still Uncategorized, the check is greyed out until you give it a real category.",
    anchor: FIRST_ROW_CHECK,
    spotlights: [FIRST_ROW_CATEGORY],
    spotlightsDelay: 2800,   // lights up as the narrator says "If the category looks right"
    wait: HOLD_LONG,
  },
  {
    key: "popup",
    chapter: "approve",
    narrator:
      "When the same vendor has other unapproved transactions, a popup appears listing them, all checked. Approve them all in one go, or uncheck the ones you want to look at first — only the checked rows are categorized and approved. 'Approve and create rule' also teaches me where this vendor goes next time.",
    anchor: FIRST_ROW_CHECK,
    ghost: { kind: "popup", vendor: "Phoenix Business" },
    wait: HOLD_LONG,
  },
  {
    key: "sparkle",
    chapter: "ask",
    narrator:
      "Not sure about a category, or want to tell me what something really was? Click the sparkles just to the right of the check. That hands the transaction to me.",
    anchor: FIRST_ROW_SPARKLE,
    wait: HOLD_MED,
  },
  {
    key: "focus",
    chapter: "ask",
    narrator:
      "I focus on that one transaction over here. Now just tell me about it, in your own words — speak or type. Something like 'this was landscaping for one of my rental properties'. I'll pick the right account, offer to fix the similar ones, and you're done.",
    anchor: "ai-chat-input",
    emit: "ai-open",
    dock: "left",
    ghost: { kind: "typing", text: "this was landscaping for one of my rental properties" },
    wait: HOLD_LONG,
  },
  {
    key: "more",
    chapter: "link",
    narrator:
      "Next, every row has a three-dots menu at the far right — edit, split, link to paperwork, or ask your client. I'll open it so you can see.",
    anchor: FIRST_ROW_MORE,
    cursor: { click: true, delay: 1800 },
    dock: "left",
    wait: HOLD_SHORT,
  },
  {
    key: "link",
    chapter: "link",
    narrator:
      "Next see the line that says 'Link to invoice or bill'? When a payment belongs to an invoice you sent, or a bill you received, just click this and I match the money to the paperwork. Let me show you.",
    anchor: "txn-link-btn",
    cursor: { click: true, delay: 3200 },
    afterClickAnchor: "modal-panel",
    dock: "left",
    wait: HOLD_SHORT,
  },
  {
    key: "multilink",
    chapter: "link",
    narrator:
      "Pick the invoice or bill and the payment is applied — the totals at the bottom keep you balanced. In fact, you can tick several at once and link multiple invoices or bills to the same transaction, like one deposit that covers three invoices.",
    anchor: "modal-panel",
    exitClick: "cancel-btn",
    dock: "left",
    wait: HOLD_LONG,
  },
  {
    key: "paperclip",
    chapter: "receipts",
    narrator:
      "Now, see the orange paperclip on this row? It means a receipt is already attached — snapped on a phone, emailed in, or uploaded — and I matched it to the bank line for you. Orange is an exact match; amber means I'm fairly sure but want you to confirm.",
    anchor: FIRST_ROW_PAPERCLIP,
    wait: HOLD_LONG,
  },
  {
    key: "receipt-popup",
    chapter: "receipts",
    narrator:
      "Click it and the receipt opens: the photo on one side, the line items and the category I gave each one on the other. From here you can confirm the match, unlink it, swap in a different receipt, or snap a new one.",
    anchor: FIRST_ROW_PAPERCLIP,
    cursor: { click: true, delay: 1400 },
    afterClickAnchor: "receipt-popup-panel",
    exitClick: "receipt-popup-close",
    wait: HOLD_LONG,
  },
  {
    key: "wrap",
    chapter: "receipts",
    narrator:
      "That's it! Using this page your books will be accurate and up to date in just a few minutes!",
    center: true,
    wait: HOLD_MED,
  },
  {
    key: "recap",
    chapter: "receipts",
    narrator:
      "Again the steps are to click the To do toggle, click the green check to approve, click the sparkles when you want me, the three dots to link payments to invoices and bills, and the paperclip for receipts.",
    center: true,
    wait: HOLD_LONG,
  },
  {
    key: "finale",
    chapter: "receipts",
    narrator:
      "I will put you on the To do screen, and now it is your turn! You will have this done in no time!",
    center: true,
    finale: true,
    wait: HOLD_SHORT,
  },
];
