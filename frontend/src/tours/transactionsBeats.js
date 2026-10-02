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
];

const HOLD_SHORT = 1500;
const HOLD_MED = 2600;
const HOLD_LONG = 3600;

// First unapproved row's controls. Rows render the approve check with a
// shared testid, so the first match is the first visible row.
const FIRST_ROW_CHECK = "css:tbody tr [data-testid='txn-approve-btn']";
const FIRST_ROW_SPARKLE = "css:tbody tr [data-testid^='txn-ai-']";

export const TXN_BEATS = [
  {
    key: "welcome",
    chapter: "find",
    narrator:
      "Hi! Let me show you how the Transactions page works. It's three moves: find what needs you, approve with one click, and ask me about anything that looks off.",
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
    wait: HOLD_LONG,
  },
  {
    key: "popup",
    chapter: "approve",
    narrator:
      "When the same vendor has other unapproved transactions, a popup appears listing them, all ticked. Approve them all in one go, or untick the ones you want to look at first — only the ticked rows are categorized and approved. 'Approve + create rule' also teaches me where this vendor goes next time.",
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
    key: "finale",
    chapter: "ask",
    narrator:
      "That's the whole loop: To do, green check, sparkles when you want me. You can replay this anytime from the Tour button.",
    center: true,
    finale: true,
    wait: HOLD_SHORT,
  },
];
