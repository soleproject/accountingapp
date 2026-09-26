// Guided walkthrough for /accounting/review-chat — a friendly,
// bookkeeper-toned tour that shows the CPA HOW they'll actually use
// the page, not just what each button does. Twelve beats grouped into
// three chapters. Each beat is data-driven so copy tweaks don't touch
// the controller.
//
// Beat shape:
//   { key, chapter, narrator, anchor?, cursor?, ghost?, wait? }
// - anchor       — data-testid to spotlight (dim everything else)
// - cursor       — { move: testid, click?: bool, delayMs?: number }
// - ghost        — inline mock UI shown near the anchor (text-typing,
//                  fake checkboxes ticking, faux toast) so the tour can
//                  demo interactions without mutating real data
// - wait         — auto-advance after N ms (default 3200)
// - narrator     — the friendly copy

export const CHAPTERS = [
  { key: "basics", title: "The basics" },
  { key: "when-its-off", title: "When something's off" },
  { key: "power-moves", title: "Power moves" },
];

export const CHAT_REVIEW_BEATS = [
  // ─────────── Chapter 1 — The basics ───────────
  {
    key: "welcome",
    chapter: "basics",
    narrator:
      "Hi! I'm the bookkeeper on your side of the screen. Give me 45 seconds and I'll show you exactly how we clear these transactions together — no accounting jargon required.",
    center: true,
    wait: 4200,
  },
  {
    key: "prompt",
    chapter: "basics",
    narrator:
      "Every review starts with a question from me right here. Read it in plain English — I'll never speak in debits and credits unless you want me to.",
    anchor: "chat-review-prompt",
    wait: 4200,
  },
  {
    key: "samples",
    chapter: "basics",
    narrator:
      "These are the transactions I'm asking about. I only show a handful so you're not overwhelmed — if there are more, you can scroll or open the full list.",
    anchor: "chat-review-samples",
    wait: 4200,
  },
  {
    key: "show-all",
    chapter: "basics",
    narrator:
      "Want to eyeball every one of them? Click 'Show all' and I'll pull them into a modal you can filter and scroll through.",
    anchor: "chat-review-show-all",
    cursor: { move: "chat-review-show-all", click: false },
    wait: 4200,
  },
  {
    key: "answer",
    chapter: "basics",
    narrator:
      "And this is where you talk back. Just tell me what these are — like 'company laptops for the team' — and I'll handle the accounting. No dropdowns to hunt through.",
    anchor: "chat-review-input",
    ghost: { kind: "typing", text: "company laptops for the team" },
    wait: 4800,
  },

  // ─────────── Chapter 2 — When something's off ───────────
  {
    key: "chapter-2-intro",
    chapter: "when-its-off",
    narrator:
      "Now the fun part — what to do when I'm partially wrong. Because I will be, sometimes.",
    center: true,
    wait: 3200,
  },
  {
    key: "update-contact",
    chapter: "when-its-off",
    narrator:
      "Say I grouped a bunch of 'WELLS FARGO' rows under one contact, but really they're three different people. Hit 'Update contact' right here and fix it for the whole card.",
    anchor: "chat-review-open-update-contact",
    cursor: { move: "chat-review-open-update-contact", click: false },
    wait: 4600,
  },
  {
    key: "split-subgroups",
    chapter: "when-its-off",
    narrator:
      "If the rows belong in different categories, don't answer once — split them first. This turns each transaction into a checkbox so you can peel groups apart.",
    anchor: "chat-review-enter-split-2",
    cursor: { move: "chat-review-enter-split-2", click: false },
    wait: 4600,
  },
  {
    key: "ask-separately-ghost",
    chapter: "when-its-off",
    narrator:
      "Tick the ones that belong together, then hit 'Ask separately'. I peel them into their own card so you can answer each group cleanly.",
    anchor: "chat-review-samples",
    ghost: { kind: "checkboxes" },
    wait: 4600,
  },

  // ─────────── Chapter 3 — Power moves ───────────
  {
    key: "chapter-3-intro",
    chapter: "power-moves",
    narrator:
      "Two power moves before I let you loose.",
    center: true,
    wait: 2600,
  },
  {
    key: "row-menu-link",
    chapter: "power-moves",
    narrator:
      "See a payment that matches an open bill or invoice? Open the row's ⋯ menu and pick 'Link'. I'll close out the AR/AP doc automatically — no double-counting.",
    anchor: "chat-review-row-menu-0",
    cursor: { move: "chat-review-row-menu-0", click: false },
    wait: 4600,
  },
  {
    key: "ai-panel",
    chapter: "power-moves",
    narrator:
      "And when I miss something, ask me directly. This 'Chat' tab on the right is your bookkeeper on demand — I remember every answer you've given me.",
    anchor: "ai-panel-mode-toggle",
    wait: 4200,
  },
  {
    key: "outro",
    chapter: "power-moves",
    narrator:
      "That's it. Click 'Skip for now' any time to move on — I queue harder questions for last. Ready to tackle your first card?",
    center: true,
    finale: true,
  },
];

// Convenience — how many beats total, and per chapter.
export const TOTAL_BEATS = CHAT_REVIEW_BEATS.length;
export const chapterOf = (beatKey) =>
  CHAT_REVIEW_BEATS.find((b) => b.key === beatKey)?.chapter;
