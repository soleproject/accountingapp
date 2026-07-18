// Client-side voice-command dispatcher for the Axiom Assistant.
//
// Design: cheap-first. Try regex/keyword matches against a route registry
// and against the caller's list of company names. If we get a hit, execute
// it locally (navigate + spoken confirmation) and return `{ handled: true }`.
// Otherwise return `{ handled: false }` and the caller falls back to sending
// the message to the normal chat stream.
//
// Zero LLM cost, zero network round-trip, effectively instant.

const NAV_ROUTES = [
  { pat: /^(?:go to |open |show (?:me )?)?dashboard\b/i,           url: "/dashboard",                          say: "Opening dashboard" },
  { pat: /^(?:go to |open |show (?:me )?)?(?:reports?|financials?)\b/i, url: "/reports",                       say: "Opening reports" },
  { pat: /^(?:go to |open |show (?:me )?)?transactions?\b/i,        url: "/accounting/transactions",           say: "Opening transactions" },
  { pat: /^(?:show (?:me )?(?:flagged|review|the flagged)|flagged transactions?)\b/i, url: "/accounting/transactions?filter=review", say: "Showing flagged transactions" },
  { pat: /^(?:go to |open |show (?:me )?)?contacts?\b/i,            url: "/contacts",                          say: "Opening contacts" },
  { pat: /^(?:go to |open |show (?:me )?)?invoices?\b/i,            url: "/invoices",                          say: "Opening invoices" },
  { pat: /^(?:show (?:me )?)?overdue invoices?\b/i,                 url: "/invoices?filter=overdue",           say: "Showing overdue invoices" },
  { pat: /^(?:go to |open |show (?:me )?)?bills?\b/i,               url: "/bills",                             say: "Opening bills" },
  { pat: /^(?:show (?:me )?)?overdue bills?\b/i,                    url: "/bills?filter=overdue",              say: "Showing overdue bills" },
  { pat: /^(?:go to |open |show (?:me )?)?(?:coa|chart of accounts)\b/i, url: "/accounting/chart-of-accounts", say: "Opening chart of accounts" },
  { pat: /^(?:go to |open |show (?:me )?)?(?:ai )?rules?\b/i,       url: "/accounting/rules",                  say: "Opening AI rules" },
  { pat: /^(?:go to |open |show (?:me )?)?suggested rules?\b/i,     url: "/accounting/rules",                  say: "Opening suggested rules" },
  { pat: /^(?:go to |open |show (?:me )?)?(?:reconcile|reconciliation)\b/i, url: "/accounting/reconciliation", say: "Opening reconciliation" },
  { pat: /^(?:go to |open |show (?:me )?)?(?:clients?|my clients?)\b/i, url: "/pro/clients",                   say: "Opening clients" },
  { pat: /^(?:go to |open |show (?:me )?)?connections?\b/i,         url: "/connections",                       say: "Opening connections" },
  { pat: /^(?:go to |open |show (?:me )?)?settings\b/i,             url: "/settings",                          say: "Opening settings" },
  { pat: /^(?:go to |open |show (?:me )?)?receipts?\b/i,            url: "/receipts",                          say: "Opening receipts" },
  { pat: /^(?:go to |open |show (?:me )?)?payments?\b/i,            url: "/payments",                          say: "Opening payments" },
];

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Attempt to resolve the user's utterance to a local action.
 * @param {string} text - Raw transcribed / typed text.
 * @param {{ companies: Array<{id,name}>, navigate: (url:string)=>void, switchCompany: (id:string)=>void }} ctx
 * @returns {{ handled: boolean, say?: string }}
 */
export function resolveVoiceCommand(text, ctx) {
  const t = (text || "").trim();
  if (!t) return { handled: false };

  // 1. Route navigation
  for (const r of NAV_ROUTES) {
    if (r.pat.test(t)) {
      ctx.navigate(r.url);
      return { handled: true, say: r.say };
    }
  }

  // 2. Company switching:  "open bright beans", "switch to 317 llc", "go to <company>"
  const switchMatch = t.match(/^(?:open|switch(?:\s+to)?|go to|change to|load)\s+(.+)$/i);
  if (switchMatch && Array.isArray(ctx.companies)) {
    const target = norm(switchMatch[1]);
    const words = target.split(" ").filter(Boolean);
    if (target.length >= 2 && ctx.companies.length) {
      const scored = ctx.companies.map(c => {
        const n = norm(c.name);
        // Prefer exact-includes, then per-word hits.
        const exact = n === target ? 1000 : 0;
        const includes = n.includes(target) ? 500 : 0;
        const hits = words.reduce((s, w) => s + (n.includes(w) ? 1 : 0), 0);
        return { c, score: exact + includes + hits };
      }).sort((a, b) => b.score - a.score);
      if (scored[0] && scored[0].score >= (words.length ? words.length : 1)) {
        ctx.switchCompany(scored[0].c.id);
        return { handled: true, say: `Switched to ${scored[0].c.name}` };
      }
    }
  }

  // 3. Meta commands
  if (/^(stop|be quiet|shut up|silence|mute)\b/i.test(t)) {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    return { handled: true, say: "" };
  }
  if (/^(clear chat|clear|reset chat|new chat)\b/i.test(t)) {
    if (typeof ctx.clearChat === "function") ctx.clearChat();
    return { handled: true, say: "Cleared" };
  }

  return { handled: false };
}
