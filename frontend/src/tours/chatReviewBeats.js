// Guided walkthrough for /accounting/review-chat — friendly bookkeeper
// tone. Each beat drives one narrator card + optional cursor movement
// + optional real click(s) on the underlying UI. Since the tour swaps
// in a fixture during runtime, clicks are safe.
//
// Beat shape:
//   { key, chapter, narrator, anchor?, cursor?, ghost?, wait?, center?, finale? }
//
// - anchor        — data-testid to spotlight (dim everything else)
// - cursor.move   — data-testid the demo cursor points at (defaults to anchor)
// - cursor.click  — bool; dispatch a real .click() on cursor.move after the
//                   ripple. Safe because we're on the fixture during the tour.
// - cursor.clicks — array of testids to click sequentially (used for the
//                   "tick 3 checkboxes" beat)
// - ghost         — inline mock UI shown near the anchor (kind: "typing" | "checkboxes")
// - wait          — post-narration hold. When voice is on we wait for the
//                   voice to finish speaking THEN hold for this long before
//                   advancing (so users can actually read + hear the beat).
//                   When voice is off, this is the total dwell time.
// - center        — center the narrator card on screen (welcome/finale)
// - finale        — stop auto-advance; require "Start reviewing" click

export const CHAPTERS = [
  { key: "basics", title: "The basics" },
  { key: "show-all", title: "The full list" },
  { key: "when-its-off", title: "When something's off" },
  { key: "power-moves", title: "Power moves" },
];

// Approx post-narration hold. Voice/reader gets the beat.narrator text
// first, then we sit for `wait` ms so people can look at what the cursor
// did before advancing. Longer for narrator beats with concrete actions
// so the user has time to process the on-page reaction.
const HOLD_SHORT = 1500;
const HOLD_MED = 2600;
const HOLD_LONG = 3600;

export const CHAT_REVIEW_BEATS = [
  // ─────────── Chapter 1 — The basics ───────────
  {
    key: "welcome",
    chapter: "basics",
    narrator:
      "Hi! I'm the bookkeeper sitting on your side of the screen. Give me a minute and I'll walk you through exactly how we clear these transactions together — no accounting jargon required.",
    center: true,
    wait: HOLD_LONG,
  },
  {
    key: "prompt",
    chapter: "basics",
    narrator:
      "Every review starts with a question from me right here. Read it in plain English — I'll never speak in debits and credits unless you want me to.",
    anchor: "chat-review-prompt",
    wait: HOLD_MED,
  },
  {
    key: "samples",
    chapter: "basics",
    narrator:
      "These are the transactions I'm asking about. I only show a handful so you're not overwhelmed — if there are more, you can scroll or open the full list.",
    anchor: "chat-review-samples",
    wait: HOLD_MED,
  },
  {
    key: "answer",
    chapter: "basics",
    narrator:
      "And this is where you talk back. Just tell me what these are — like 'company laptops for the team' — and I'll handle the accounting. No dropdowns to hunt through.",
    anchor: "chat-review-input",
    ghost: { kind: "typing", text: "company laptops for the team" },
    wait: HOLD_LONG,
  },

  // ─────────── Chapter 2 — The full list (Show all sequence) ───────────
  {
    key: "show-all-open",
    chapter: "show-all",
    narrator:
      "Want to see every one of them at once? Click 'Show all' — here, I'll open it for you. This modal lets you filter, scroll, and bulk-edit every transaction on the card.",
    anchor: "chat-review-show-all",
    cursor: { move: "chat-review-show-all", click: true },
    wait: HOLD_LONG,
  },
  {
    key: "show-all-tour",
    chapter: "show-all",
    narrator:
      "Here's the full list. You can filter by date, amount, or description across all of them. If everything on this card really does belong together, you're good — close it and answer once.",
    anchor: "chat-review-show-all-modal",
    wait: HOLD_LONG,
  },
  {
    key: "show-all-split",
    chapter: "show-all",
    narrator:
      "But say they DON'T all belong together. Click 'Split into subgroups' at the bottom — every row picks up a checkbox so you can peel groups apart.",
    anchor: "chat-review-show-all-split",
    cursor: { move: "chat-review-show-all-split", click: true },
    wait: HOLD_LONG,
  },
  {
    key: "show-all-tick",
    chapter: "show-all",
    narrator:
      "Now tick the ones that share an answer. I'll tap three rows for you — say these three were laptop purchases for the team, and the rest are contractor invoices.",
    anchor: "chat-review-show-all-list",
    cursor: {
      clicks: [
        "chat-review-show-all-check-tour-t-1-6",
        "chat-review-show-all-check-tour-t-1-7",
        "chat-review-show-all-check-tour-t-1-8",
      ],
    },
    wait: HOLD_LONG,
  },
  {
    key: "show-all-update",
    chapter: "show-all",
    narrator:
      "'Update selected' lets you change the contact or category for ALL of them at once — huge time saver for messy imports.",
    anchor: "chat-review-show-all-update-selected",
    cursor: { move: "chat-review-show-all-update-selected", click: true },
    wait: HOLD_LONG,
  },
  {
    key: "show-all-update-close",
    chapter: "show-all",
    narrator:
      "You can hit Cancel to back out of a bulk update anytime — I never save changes until you confirm.",
    anchor: "chat-review-split-cancel",
    cursor: { move: "chat-review-split-cancel", click: true },
    wait: HOLD_MED,
  },
  {
    key: "show-all-ask-separately",
    chapter: "show-all",
    narrator:
      "Or click 'Ask separately' — I'll peel those three off into their own question card so you can answer them cleanly, separate from the rest. Two different tools, one selection.",
    anchor: "chat-review-show-all-ask-separately",
    wait: HOLD_LONG,
  },
  {
    key: "show-all-close",
    chapter: "show-all",
    narrator:
      "Alright, closing this up so we can keep moving.",
    anchor: "chat-review-show-all-close",
    cursor: { move: "chat-review-show-all-close", click: true },
    wait: HOLD_SHORT,
  },

  // ─────────── Chapter 3 — When something's off ───────────
  {
    key: "chapter-3-intro",
    chapter: "when-its-off",
    narrator:
      "Now the fun part — what to do when I'm partially wrong. Because I will be, sometimes.",
    center: true,
    wait: HOLD_MED,
  },
  {
    key: "update-contact",
    chapter: "when-its-off",
    narrator:
      "Sometimes I pick the wrong contact for the whole card — say I grouped all these payments under one vendor but the actual counterparty is different. Hit 'Update contact' here and I'll re-assign every transaction on the card in one shot. If different rows belong to different contacts, use Split mode instead.",
    anchor: "chat-review-open-update-contact",
    cursor: { move: "chat-review-open-update-contact" },
    wait: HOLD_LONG,
  },
  {
    key: "split-subgroups-inline",
    chapter: "when-its-off",
    narrator:
      "You can also split right from the card — each row picks up a checkbox on the left. Tick the ones that share an answer and use 'Update selected' to change contact or category for all of them, or 'Ask separately' to peel them into their own question.",
    anchor: "chat-review-samples",
    spotlights: ["chat-review-split-categorize", "chat-review-ask-separately"],
    wait: HOLD_LONG,
  },

  // ─────────── Chapter 4 — Power moves ───────────
  {
    key: "chapter-4-intro",
    chapter: "power-moves",
    narrator:
      "Two power moves before I let you loose.",
    center: true,
    wait: HOLD_SHORT,
  },
  {
    key: "row-menu-link",
    chapter: "power-moves",
    narrator:
      "See a payment that matches an open bill or invoice? Open the row's three-dot menu — here, I'll click it for you — then pick 'Link to invoice / bill'. I'll close out the AR or AP doc automatically, no double-counting.",
    anchor: "chat-review-row-menu-0",
    cursor: { move: "txn-more-tour-t-1-1", click: true },
    spotlights: ["txn-link-btn"],
    wait: HOLD_LONG,
  },
  {
    key: "ai-panel",
    chapter: "power-moves",
    narrator:
      "And when I miss something, ask me directly. This 'Chat' tab on the right is your bookkeeper on demand — I remember every answer you've given me.",
    anchor: "ai-panel-mode-toggle",
    wait: HOLD_MED,
  },
  {
    key: "outro",
    chapter: "power-moves",
    narrator:
      "That's it! Click 'Skip for now' any time to move on — I queue the harder questions for last. Ready to tackle your first card?",
    center: true,
    finale: true,
  },
];

export const TOTAL_BEATS = CHAT_REVIEW_BEATS.length;
export const chapterOf = (beatKey) =>
  CHAT_REVIEW_BEATS.find((b) => b.key === beatKey)?.chapter;
