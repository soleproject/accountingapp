// Client-side voice-command dispatcher for the Axiom Assistant.
//
// Three-tier design (cheap-first):
//   1) Local regex/keyword match  → nav, filters, meta, and simple company/
//      contact lookup. Zero backend cost, instant.
//   2) `remote: true` for CREATE intents → the caller (AiPanel) ships the
//      utterance to the backend Haiku parser, which returns structured
//      prefill JSON. The caller then dispatches an `axiom:create:*` event.
//   3) Fallthrough → normal chat stream to Claude Sonnet.

const now = () => new Date();
const ymd = (d) => d.toISOString().slice(0, 10);

// ---------------------------- Route table ----------------------------

const NAV_ROUTES = [
  { pat: /\b(?:go to |open |show (?:me )?)?dashboard\b/i,                                    url: "/dashboard",                    say: "Opening dashboard" },
  { pat: /\b(?:go to |open |show (?:me )?)?onboarding\b/i,                                    url: "/onboarding",                   say: "Opening onboarding" },
  { pat: /\b(?:go to |open |show (?:me )?)?transactions?\b/i,                                 url: "/accounting/transactions",      say: "Opening transactions" },
  { pat: /\b(?:show (?:me )?)?(?:flagged|for review|needs? review) transactions?\b/i,         url: "/accounting/transactions?filter=review", say: "Showing flagged transactions" },
  { pat: /\b(?:go to |open |show (?:me )?)?contacts?\b/i,                                     url: "/contacts",                     say: "Opening contacts" },
  { pat: /\b(?:go to |open |show (?:me )?)?invoices?\b/i,                                     url: "/invoices",                     say: "Opening invoices" },
  { pat: /\b(?:show (?:me )?)?overdue invoices?\b/i,                                          url: "/invoices?filter=overdue",      say: "Showing overdue invoices" },
  { pat: /\b(?:go to |open |show (?:me )?)?bills?\b/i,                                        url: "/bills",                        say: "Opening bills" },
  { pat: /\b(?:show (?:me )?)?overdue bills?\b/i,                                             url: "/bills?filter=overdue",         say: "Showing overdue bills" },
  { pat: /\b(?:go to |open |show (?:me )?)?payments?\b/i,                                     url: "/payments",                     say: "Opening payments" },
  { pat: /\b(?:go to |open |show (?:me )?)?receipts?\b/i,                                     url: "/receipts",                     say: "Opening receipts" },
  { pat: /\b(?:go to |open |show (?:me )?)?(?:coa|chart of accounts)\b/i,                     url: "/accounting/chart-of-accounts", say: "Opening chart of accounts" },
  { pat: /\b(?:go to |open |show (?:me )?)?journal entries\b/i,                               url: "/accounting/journal-entries",   say: "Opening journal entries" },
  { pat: /\b(?:go to |open |show (?:me )?)?general ledger\b/i,                                url: "/accounting/general-ledger",    say: "Opening general ledger" },
  { pat: /\b(?:go to |open |show (?:me )?)?(?:ai )?rules?\b/i,                                url: "/accounting/rules",             say: "Opening AI rules" },
  { pat: /\b(?:go to |open |show (?:me )?)?suggested rules?\b/i,                              url: "/accounting/rules",             say: "Opening suggested rules" },
  { pat: /\b(?:go to |open |show (?:me )?)?(?:reconcile|reconciliation)\b/i,                  url: "/accounting/reconciliation",    say: "Opening reconciliation" },
  { pat: /\b(?:go to |open |show (?:me )?)?book review\b/i,                                   url: "/accounting/book-review",       say: "Opening book review" },
  { pat: /\b(?:go to |open |show (?:me )?)?(?:close books?|close period|month end)\b/i,       url: "/accounting/close-books",       say: "Opening close books" },
  { pat: /\b(?:go to |open |show (?:me )?)?year end\b/i,                                      url: "/accounting/year-end",          say: "Opening year end" },
  { pat: /\b(?:go to |open |show (?:me )?)?inventory\b/i,                                     url: "/accounting/inventory",         say: "Opening inventory" },
  { pat: /\b(?:go to |open |show (?:me )?)?assets?\b/i,                                       url: "/accounting/assets",            say: "Opening fixed assets" },
  { pat: /\b(?:go to |open |show (?:me )?)?loans?\b/i,                                        url: "/accounting/loans",             say: "Opening loans" },
  { pat: /\b(?:go to |open |show (?:me )?)?tags?\b/i,                                         url: "/accounting/tags",              say: "Opening tags" },
  { pat: /\b(?:go to |open |show (?:me )?)?(?:clients?|my clients?)\b/i,                      url: "/pro/clients",                  say: "Opening clients" },
  { pat: /\b(?:go to |open |show (?:me )?)?admin\b/i,                                         url: "/admin",                        say: "Opening admin" },
  { pat: /\b(?:go to |open |show (?:me )?)?connections?\b/i,                                  url: "/connections",                  say: "Opening connections" },
  { pat: /\b(?:go to |open |show (?:me )?)?(?:settings|company settings)\b/i,                 url: "/settings",                     say: "Opening settings" },
  { pat: /\b(?:go to |open |show (?:me )?)?communications?\b/i,                               url: "/communications",               say: "Opening communications" },
];

// ---------------------------- Reports table --------------------------

const REPORT_ALIASES = [
  { pat: /\b(?:trial ?balance|tb)\b/i,               kind: "trial-balance",    name: "Trial Balance" },
  { pat: /\b(?:balance ?sheet|bs)\b/i,               kind: "balance-sheet",    name: "Balance Sheet" },
  { pat: /\b(?:income statement|p ?& ?l|profit and loss|profit ?loss)\b/i, kind: "income-statement", name: "Income Statement" },
  { pat: /\b(?:general ledger|ledger)\b/i,           kind: "general-ledger",   name: "General Ledger" },
  { pat: /\b(?:cash ?flow|statement of cash flows?)\b/i, kind: "cash-flow",   name: "Cash Flow" },
  { pat: /\b(?:sales ?tax)\b/i,                      kind: "sales-tax",        name: "Sales Tax" },
  { pat: /\b(?:1099|form 1099|contractor summary)\b/i, kind: "1099-summary",  name: "1099 Summary" },
];

// Given a report utterance, extract optional basis + date range from natural
// language. Returns a URLSearchParams-ready object.
function extractReportFilters(text) {
  const filters = {};
  const t = text.toLowerCase();

  if (/\baccrual( basis)?\b/.test(t)) filters.basis = "accrual";
  else if (/\bcash( basis)?\b/.test(t)) filters.basis = "cash";

  const y = now().getFullYear();
  const jan = new Date(y, 0, 1);
  const today = now();
  const startOfMonth = new Date(y, today.getMonth(), 1);
  const endOfMonth = new Date(y, today.getMonth() + 1, 0);
  const lastMonthStart = new Date(y, today.getMonth() - 1, 1);
  const lastMonthEnd = new Date(y, today.getMonth(), 0);

  const setQuarter = (q) => {
    const s = new Date(y, (q - 1) * 3, 1);
    const e = new Date(y, q * 3, 0);
    filters.start = ymd(s);
    filters.end = ymd(e);
  };

  if (/\bytd\b|year to date|this year\b/.test(t)) {
    filters.start = ymd(jan); filters.end = ymd(today);
  } else if (/last year\b|previous year\b/.test(t)) {
    filters.start = `${y - 1}-01-01`; filters.end = `${y - 1}-12-31`;
  } else if (/\bq1\b|first quarter\b|quarter one\b/.test(t))       setQuarter(1);
  else if (/\bq2\b|second quarter\b|quarter two\b/.test(t))         setQuarter(2);
  else if (/\bq3\b|third quarter\b|quarter three\b/.test(t))        setQuarter(3);
  else if (/\bq4\b|fourth quarter\b|quarter four\b/.test(t))        setQuarter(4);
  else if (/this month\b|current month\b/.test(t)) {
    filters.start = ymd(startOfMonth); filters.end = ymd(endOfMonth);
  } else if (/last month\b|previous month\b/.test(t)) {
    filters.start = ymd(lastMonthStart); filters.end = ymd(lastMonthEnd);
  }
  return filters;
}

// ---------------------------- Utilities ----------------------------

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Fuzzy score for name matching within a small list (companies/contacts).
function bestMatch(target, list, nameKey = "name") {
  if (!target) return null;
  const needle = norm(target);
  if (needle.length < 2) return null;
  const words = needle.split(" ").filter(Boolean);
  let best = null, bestScore = 0;
  for (const c of list) {
    const n = norm(c[nameKey] || "");
    let score = 0;
    if (n === needle) score = 1000;
    else if (n.includes(needle) || needle.includes(n)) score = 500;
    else score = words.reduce((s, w) => s + (n.includes(w) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= (words.length || 1) ? { record: best, score: bestScore } : null;
}

// Create-intent regexes — these DO NOT execute locally. They just tell the
// caller "this is a create intent, ship it to the backend parser".
const CREATE_INTENT_RE = /\b(create|make|new|draft|add|start)\s+(?:an?\s+)?(invoice|bill|contact|customer|vendor|account|chart of account|payment|receipt)\b/i;

// Explicit "open <entity> <name>" (contact/invoice/bill lookup by name/number)
const OPEN_ENTITY_RE = /^(?:open|show|find|pull up|bring up|view)\s+(?:the\s+)?(contact|customer|vendor|invoice|bill)\s+(?:#|number\s+)?(.+)$/i;

// ---------------------------- Main resolver ----------------------------

/**
 * Attempt to resolve the user's utterance to a local or remote action.
 *
 * @param {string} text - Raw transcribed / typed text.
 * @param {object} ctx
 * @param {Array<{id,name}>} ctx.companies
 * @param {(url:string)=>void} ctx.navigate
 * @param {(id:string)=>void} ctx.switchCompany
 * @param {()=>void} ctx.clearChat
 * @returns {{ handled: boolean, say?: string, remote?: 'intent'|'open', hint?: string }}
 *   - handled:false  → not a voice command, caller falls back to LLM chat
 *   - handled:true, remote:undefined → done locally
 *   - handled:true, remote:'intent'  → caller must POST utterance to the
 *     intent parser and dispatch a create modal based on the response
 *   - handled:true, remote:'open'    → caller does NOT need to call remote;
 *     `hint` describes what was already opened.
 */
export function resolveVoiceCommand(text, ctx) {
  const t = (text || "").trim();
  if (!t) return { handled: false };

  // ---- 1. Meta commands (highest priority) ----
  if (/^(stop|be quiet|shut up|silence|mute|cancel speech)\b/i.test(t)) {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    return { handled: true, say: "" };
  }
  if (/^(clear|reset)( chat| conversation)?\b/i.test(t) || /^new chat\b/i.test(t)) {
    if (typeof ctx.clearChat === "function") ctx.clearChat();
    return { handled: true, say: "Cleared" };
  }
  if (/^(confirm|yes,? create it?|save it?|do it|go ahead)\b/i.test(t)) {
    // Signal to caller to submit any pending intent.
    return { handled: true, pending: "confirm" };
  }
  if (/^(cancel|no,? don'?t|nevermind|never mind|forget it)\b/i.test(t)) {
    return { handled: true, pending: "cancel" };
  }

  // ---- 2. Report navigation with optional filters ----
  // "show me the income statement for Q1 on cash basis"
  for (const r of REPORT_ALIASES) {
    if (r.pat.test(t)) {
      const filters = extractReportFilters(t);
      const params = new URLSearchParams(filters);
      const qs = params.toString();
      ctx.navigate(`/reports/${r.kind}${qs ? `?${qs}` : ""}`);
      const bits = [];
      if (filters.basis) bits.push(`${filters.basis} basis`);
      if (filters.start && filters.end) bits.push(`${filters.start} to ${filters.end}`);
      return {
        handled: true,
        say: bits.length ? `Opening ${r.name}, ${bits.join(", ")}` : `Opening ${r.name}`,
      };
    }
  }
  // "reports" catch-all (goes to the index)
  if (/^(?:go to |open |show (?:me )?)?(?:reports?|financials?)$/i.test(t)) {
    ctx.navigate("/reports");
    return { handled: true, say: "Opening reports" };
  }

  // ---- 3. Explicit "open <entity> <name>" ----
  const openMatch = t.match(OPEN_ENTITY_RE);
  if (openMatch) {
    const entity = openMatch[1].toLowerCase();
    const target = openMatch[2].trim();
    if (entity === "contact" || entity === "customer" || entity === "vendor") {
      ctx.navigate(`/contacts?q=${encodeURIComponent(target)}`);
      return { handled: true, say: `Looking up ${target} in contacts` };
    }
    if (entity === "invoice") {
      ctx.navigate(`/invoices?q=${encodeURIComponent(target)}`);
      return { handled: true, say: `Looking up invoice ${target}` };
    }
    if (entity === "bill") {
      ctx.navigate(`/bills?q=${encodeURIComponent(target)}`);
      return { handled: true, say: `Looking up bill ${target}` };
    }
  }

  // ---- 4. Route navigation ----
  for (const r of NAV_ROUTES) {
    if (r.pat.test(t)) {
      // Exclude cases where the utterance is really about creating something
      // (e.g. "create a new invoice" would otherwise match /invoices/).
      if (CREATE_INTENT_RE.test(t)) break;
      ctx.navigate(r.url);
      return { handled: true, say: r.say };
    }
  }

  // ---- 5. Company switch — "open bright beans", "switch to 317 llc" ----
  const switchMatch = t.match(/^(?:open|switch(?:\s+to)?|go to|change to|load)\s+(.+)$/i);
  if (switchMatch && Array.isArray(ctx.companies)) {
    const hit = bestMatch(switchMatch[1], ctx.companies);
    if (hit) {
      ctx.switchCompany(hit.record.id);
      return { handled: true, say: `Switched to ${hit.record.name}` };
    }
  }

  // ---- 6. CREATE intents — defer to backend parser ----
  if (CREATE_INTENT_RE.test(t)) {
    return { handled: true, remote: "intent" };
  }

  return { handled: false };
}
