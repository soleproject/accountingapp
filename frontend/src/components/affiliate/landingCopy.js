export const VARIANTS = {
  owner: {
    key: "owner", role: "business_owner", tab: "Business owner",
    eyebrow: "For business owners",
    h1: "Your books, done by AI — you just answer a few questions a week.",
    lead: "Connect your bank, snap receipts, and let {brand} categorize, reconcile and close the month. A 2-minute Quick Check-in replaces the end-of-year shoebox.",
    checks: ["Bank feed + receipt scanning included", "Month-close checklist with AI review", "Invite your accountant free"],
    formTitle: "Start your free trial", formSub: "No card needed.{refApplied}",
    companyLabel: "Business name", cta: "Create my account",
    fine: "Then: connect a bank in 60 seconds · we text you when the first review is ready",
    extra: { key: "books_today", label: "How do you do your books today?", options: ["Spreadsheet", "QuickBooks", "My accountant", "Not really"] },
    steps: ["Connect — link your bank & cards; history pulls in automatically.", "Answer — AI books what it knows; the rest becomes a tap-to-answer check-in on your phone.", "Close — month-end checklist, reconciliation and reports, shareable with your accountant."],
  },
  pro: {
    key: "pro", role: "accounting_pro", tab: "Accounting pro",
    eyebrow: "For accounting & bookkeeping firms",
    h1: "Flat $349/mo for your whole practice. $15 per client. White-label included.",
    lead: "Stop paying per tier per client. {brand} gives your firm one dashboard, AI categorization that learns each client, and a client-facing Quick Check-in so you stop chasing answers by email.",
    checks: ["Multi-client review queue with AI findings", "Your logo, your domain, your colours", "Flat pricing — no per-tier surprises"],
    formTitle: "Book a 20-minute walkthrough", formSub: "{refName} will join if you want — they use it for their own clients.",
    companyLabel: "Firm name", cta: "Request the walkthrough",
    fine: "We pre-load a sandbox firm with 2 sample clients before the call.",
    extra: { key: "clients", label: "Clients you serve", options: ["1–10", "11–30", "31–100", "100+"] },
    extra2: { key: "software", label: "Current software", options: ["QuickBooks Online", "Xero", "Desktop / other", "None"] },
    steps: ["Walkthrough — 20 minutes on a sandbox firm with real AI findings.", "Pilot — two of your clients, QBO import in one click each.", "Roll out — flat fee, white-label, migrate at your pace."],
  },
  enterprise: {
    key: "enterprise", role: "enterprise", tab: "Enterprise / multi-entity",
    eyebrow: "For groups, franchises & multi-entity owners",
    h1: "Every entity in one portfolio. One bill. One login.",
    lead: "Run 3 or 30 companies with a consolidated cash / P&L view, shared chart of accounts, and investor-grade reporting — with AI doing the first pass on every entity.",
    checks: ["Portfolio view across all entities", "Shared chart of accounts & rules", "Enterprise billing, one invoice"],
    formTitle: "Talk to us about your group", formSub: "A {brand} specialist calls within one business day.",
    companyLabel: "Company / group name", cta: "Request a call",
    fine: "We'll ask about entities, banks and who closes the books today.",
    extra: { key: "entities", label: "Number of entities", options: ["2–5", "6–20", "20+"] },
    extra2: { key: "best_time", label: "Best time to call", options: ["Mornings", "Afternoons", "Any time"] },
    steps: ["Discovery — a 15-minute call about your entities.", "Map — we structure your group as a portfolio.", "Pilot — two entities, free for 30 days."],
  },
};

export const FIRM_OWNER = {
  eyebrow: "{firm} · client portal",
  h1: "Work with {firm} and never send a shoebox again.",
  lead: "Our client portal connects to your bank, reads your receipts and asks you only what we can't figure out — in a 2-minute weekly check-in on your phone. {firm} handles the rest.",
  checks: ["Your accountant sees everything, you tap answers", "Receipts: snap and forget", `Branded portal from {firm}`],
  formTitle: "Become a {firm} client", formSub: "{firm} will set up your books and reach out within a day.",
  cta: "Send to {firm}", fine: "No charge until {firm} confirms your engagement.",
};

export function fill(text, ctx) {
  return (text || "").replace(/\{(\w+)\}/g, (m, k) => (ctx[k] ?? ""));
}
