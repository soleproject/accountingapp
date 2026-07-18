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
  // Specific patterns FIRST — the resolver returns on first match.
  { pat: /\b(?:show (?:me )?)?(?:flagged|for review|needs? review) transactions?\b/i,         url: "/accounting/transactions?filter=review", say: "Showing flagged transactions" },
  { pat: /\b(?:show (?:me )?)?overdue invoices?\b/i,                                          url: "/invoices?filter=overdue",      say: "Showing overdue invoices" },
  { pat: /\b(?:show (?:me )?)?overdue bills?\b/i,                                             url: "/bills?filter=overdue",         say: "Showing overdue bills" },
  { pat: /\b(?:go to |open |show (?:me )?)?suggested rules?\b/i,                              url: "/accounting/rules",             say: "Opening suggested rules" },
  { pat: /\b(?:go to |open |show (?:me )?)?journal entries\b/i,                               url: "/accounting/journal-entries",   say: "Opening journal entries" },
  { pat: /\b(?:go to |open |show (?:me )?)?general ledger\b/i,                                url: "/accounting/general-ledger",    say: "Opening general ledger" },
  { pat: /\b(?:go to |open |show (?:me )?)?book review\b/i,                                   url: "/accounting/book-review",       say: "Opening book review" },
  { pat: /\b(?:go to |open |show (?:me )?)?(?:close books?|close period|month end)\b/i,       url: "/accounting/close-books",       say: "Opening close books" },
  { pat: /\b(?:go to |open |show (?:me )?)?year end\b/i,                                      url: "/accounting/year-end",          say: "Opening year end" },
  { pat: /\b(?:go to |open |show (?:me )?)?(?:reconcile|reconciliation)\b/i,                  url: "/accounting/reconciliation",    say: "Opening reconciliation" },
  { pat: /\b(?:go to |open |show (?:me )?)?(?:coa|chart of accounts)\b/i,                     url: "/accounting/chart-of-accounts", say: "Opening chart of accounts" },
  { pat: /\b(?:go to |open |show (?:me )?)?(?:ai )?rules?\b/i,                                url: "/accounting/rules",             say: "Opening AI rules" },
  { pat: /\b(?:go to |open |show (?:me )?)?(?:clients?|my clients?)\b/i,                      url: "/pro/clients",                  say: "Opening clients" },
  { pat: /\b(?:go to |open |show (?:me )?)?(?:settings|company settings)\b/i,                 url: "/settings",                     say: "Opening settings" },
  { pat: /\b(?:go to |open |show (?:me )?)?communications?\b/i,                               url: "/communications",               say: "Opening communications" },
  { pat: /\b(?:go to |open |show (?:me )?)?connections?\b/i,                                  url: "/connections",                  say: "Opening connections" },
  { pat: /\b(?:go to |open |show (?:me )?)?onboarding\b/i,                                    url: "/onboarding",                   say: "Opening onboarding" },
  { pat: /\b(?:go to |open |show (?:me )?)?inventory\b/i,                                     url: "/accounting/inventory",         say: "Opening inventory" },
  { pat: /\b(?:go to |open |show (?:me )?)?assets?\b/i,                                       url: "/accounting/assets",            say: "Opening fixed assets" },
  { pat: /\b(?:go to |open |show (?:me )?)?loans?\b/i,                                        url: "/accounting/loans",             say: "Opening loans" },
  { pat: /\b(?:go to |open |show (?:me )?)?tags?\b/i,                                         url: "/accounting/tags",              say: "Opening tags" },
  { pat: /\b(?:go to |open |show (?:me )?)?admin\b/i,                                         url: "/admin",                        say: "Opening admin" },
  // Generic index pages LAST.
  { pat: /\b(?:go to |open |show (?:me )?)?transactions?\b/i,                                 url: "/accounting/transactions",      say: "Opening transactions" },
  { pat: /\b(?:go to |open |show (?:me )?)?contacts?\b/i,                                     url: "/contacts",                     say: "Opening contacts" },
  { pat: /\b(?:go to |open |show (?:me )?)?invoices?\b/i,                                     url: "/invoices",                     say: "Opening invoices" },
  { pat: /\b(?:go to |open |show (?:me )?)?bills?\b/i,                                        url: "/bills",                        say: "Opening bills" },
  { pat: /\b(?:go to |open |show (?:me )?)?payments?\b/i,                                     url: "/payments",                     say: "Opening payments" },
  { pat: /\b(?:go to |open |show (?:me )?)?receipts?\b/i,                                     url: "/receipts",                     say: "Opening receipts" },
  { pat: /\b(?:go to |open |show (?:me )?)?dashboard\b/i,                                     url: "/dashboard",                    say: "Opening dashboard" },
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

// Detect a "vs last quarter" / "compared to last year" phrase and return
// the semantic prior-period name.
function extractComparisonPeriod(text) {
  const t = text.toLowerCase();
  if (/\b(?:vs|versus|compared to|against|change[sd]?|movers?|delta|from)\s+(?:the\s+)?(?:last|previous|prior)\s+quarter\b/.test(t))
    return { unit: "quarter", label: "last quarter" };
  if (/\b(?:vs|versus|compared to|against|change[sd]?|from)\s+(?:the\s+)?(?:last|previous|prior)\s+(?:year|annum)\b/.test(t)
      || /\byear over year|y ?o ?y\b/.test(t))
    return { unit: "year", label: "last year" };
  if (/\b(?:vs|versus|compared to|against|change[sd]?|from)\s+(?:the\s+)?(?:last|previous|prior)\s+month\b/.test(t)
      || /\bmonth over month|m ?o ?m\b/.test(t))
    return { unit: "month", label: "last month" };
  if (/\b(?:vs|versus|compared to|against|change[sd]?)\s+(?:the\s+)?prior period\b/.test(t))
    return { unit: "prior_period", label: "prior period" };
  return null;
}

// Given a filter object {start, end, basis} and a semantic prior-period
// reference, produce the equivalent filter for that prior window.
function buildPriorFilters(current, cmpPeriod) {
  const out = { ...current };
  const parse = (s) => new Date(`${s}T00:00:00Z`);
  const daysBetween = (a, b) => Math.round((b - a) / 86400000) + 1;
  const asYmd = (d) => d.toISOString().slice(0, 10);
  let s = current.start ? parse(current.start) : null;
  let e = current.end   ? parse(current.end)   : null;
  const now = new Date();
  // If we don't have a current window, default to YTD.
  if (!s || !e) {
    s = new Date(now.getFullYear(), 0, 1);
    e = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    out.start = asYmd(s); out.end = asYmd(e);
  }
  const unit = cmpPeriod?.unit || "prior_period";
  let ps, pe;
  if (unit === "quarter") {
    ps = new Date(s); pe = new Date(e);
    ps.setUTCMonth(ps.getUTCMonth() - 3);
    pe.setUTCMonth(pe.getUTCMonth() - 3);
  } else if (unit === "year") {
    ps = new Date(s); pe = new Date(e);
    ps.setUTCFullYear(ps.getUTCFullYear() - 1);
    pe.setUTCFullYear(pe.getUTCFullYear() - 1);
  } else if (unit === "month") {
    ps = new Date(s); pe = new Date(e);
    ps.setUTCMonth(ps.getUTCMonth() - 1);
    pe.setUTCMonth(pe.getUTCMonth() - 1);
  } else {
    // Same length immediately before start.
    const span = daysBetween(s, e);
    pe = new Date(s); pe.setUTCDate(pe.getUTCDate() - 1);
    ps = new Date(pe); ps.setUTCDate(ps.getUTCDate() - (span - 1));
  }
  return { ...out, start: asYmd(ps), end: asYmd(pe) };
}


// for $26.99" into structured filters. Returns null if the shape doesn't
// look like a deep-link for a specific transaction (in which case the
// caller falls through to normal nav / chat).
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12, jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
function tryParseTxnDeepLink(text) {
  const t = text.trim();
  // Must reference a specific transaction (word 'transaction'/'purchase'/'charge')
  if (!/\b(transaction|purchase|charge|payment)\b/i.test(t)) return null;
  // Must start with an "open"/"show"/"find" verb (avoids accidentally
  // grabbing arbitrary chat questions).
  if (!/^(open|show|find|pull up|bring up|view|display)\b/i.test(t)) return null;

  // Extract date if present. Handles "July 15th", "Jul 15", "on 7/15",
  // "yesterday", "today".
  let date = null;
  const yr = now().getFullYear();
  const mDate = t.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (mDate) {
    const mo = MONTHS[mDate[1].toLowerCase()];
    const day = parseInt(mDate[2], 10);
    if (mo && day) date = `${yr}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  } else {
    const slash = t.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
    if (slash) {
      const mo = parseInt(slash[1], 10), day = parseInt(slash[2], 10);
      let y = slash[3] ? parseInt(slash[3], 10) : yr;
      if (y < 100) y += 2000;
      date = `${y}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    } else if (/\byesterday\b/i.test(t)) {
      const d = new Date(); d.setDate(d.getDate() - 1); date = ymd(d);
    } else if (/\btoday\b/i.test(t)) {
      date = ymd(new Date());
    }
  }

  // Extract merchant name — the noun BEFORE 'transaction' after stripping
  // date-y and money-y phrases. Not perfect, but good enough to seed a
  // text search on the backend.
  let stripped = t
    .replace(/^(open|show|find|pull up|bring up|view|display)\b\s*(the\s+)?/i, "")
    .replace(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/gi, "")
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, "")
    .replace(/\b(yesterday|today|last (week|month))\b/gi, "")
    .replace(/\bfor\s*\$?\d[\d,]*(?:\.\d{1,2})?\b/gi, "")
    .replace(/\$\d[\d,]*(?:\.\d{1,2})?/g, "")
    .replace(/\b(the|a|an|on|from|at|of)\b/gi, " ")
    .replace(/\btransactions?|purchases?|charges?|payments?\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  // Strip possessive 's — "McDonald's" is still McDonald in Mongo docs.
  stripped = stripped.replace(/'s\b/g, "");
  const q = stripped.length >= 2 ? stripped : null;

  if (!q && !date) return null;
  return { q, date };
}


// ---- Date-range extractor -----------------------------------------------
// Parses common English phrasings of a period out of a longer utterance
// (e.g. "open the Citi Card detail from March", "pull account 2110 for Q1",
// "show me Rocket Mortgage year to date"). Returns `{ start, end, stripped }`
// where `stripped` is the input with the recognized period phrase removed
// so downstream regexes (e.g. account-name matching) don't trip over it.
// Returns null if no period was recognized.
const _pad = (n) => String(n).padStart(2, "0");
const _ymd = (y, m, d) => `${y}-${_pad(m)}-${_pad(d)}`;
const _endOfMonth = (y, m) => new Date(y, m, 0).getDate(); // m: 1-12
function extractPeriod(text) {
  const yr = now().getFullYear();
  const t = text;

  const monthAlt = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

  // "from <month> to <month> [<year>]"
  let m = t.match(new RegExp(`\\b(?:from|between)\\s+${monthAlt}\\s+(?:to|through|thru|and)\\s+${monthAlt}(?:\\s+(\\d{4}))?\\b`, "i"));
  if (m) {
    const m1 = MONTHS[m[1].toLowerCase()], m2 = MONTHS[m[2].toLowerCase()];
    const y = m[3] ? parseInt(m[3], 10) : yr;
    return {
      start: _ymd(y, m1, 1),
      end: _ymd(y, m2, _endOfMonth(y, m2)),
      stripped: t.replace(m[0], " "),
    };
  }

  // "since <month> [<year>]" → from month-01 through today
  m = t.match(new RegExp(`\\bsince\\s+${monthAlt}(?:\\s+(\\d{4}))?\\b`, "i"));
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    const y = m[2] ? parseInt(m[2], 10) : yr;
    return { start: _ymd(y, mo, 1), end: ymd(now()), stripped: t.replace(m[0], " ") };
  }

  // "since <year>"
  m = t.match(/\bsince\s+(\d{4})\b/i);
  if (m) return { start: `${m[1]}-01-01`, end: ymd(now()), stripped: t.replace(m[0], " ") };

  // "in|for|during|from <month> [<year>]" — single-month window
  m = t.match(new RegExp(`\\b(?:in|for|during|from|of)\\s+${monthAlt}(?:\\s+(\\d{4}))?\\b`, "i"));
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    const y = m[2] ? parseInt(m[2], 10) : yr;
    return {
      start: _ymd(y, mo, 1),
      end: _ymd(y, mo, _endOfMonth(y, mo)),
      stripped: t.replace(m[0], " "),
    };
  }

  // Quarter: "Q1", "for Q1", "Q1 2025", "first quarter"
  m = t.match(/\b(?:for\s+|in\s+|during\s+)?(?:q([1-4])|(first|second|third|fourth)\s+quarter)(?:\s+(?:of\s+)?(\d{4}))?\b/i);
  if (m) {
    const qNum = m[1] ? parseInt(m[1], 10)
      : { first: 1, second: 2, third: 3, fourth: 4 }[m[2].toLowerCase()];
    const y = m[3] ? parseInt(m[3], 10) : yr;
    const startMo = (qNum - 1) * 3 + 1;
    const endMo = startMo + 2;
    return {
      start: _ymd(y, startMo, 1),
      end: _ymd(y, endMo, _endOfMonth(y, endMo)),
      stripped: t.replace(m[0], " "),
    };
  }

  // "last quarter" / "this quarter"
  m = t.match(/\b(this|last|previous)\s+quarter\b/i);
  if (m) {
    const d = now();
    let y = d.getFullYear();
    let q = Math.floor(d.getMonth() / 3) + 1;
    if (/last|previous/i.test(m[1])) { q -= 1; if (q < 1) { q = 4; y -= 1; } }
    const startMo = (q - 1) * 3 + 1;
    const endMo = startMo + 2;
    return {
      start: _ymd(y, startMo, 1),
      end: _ymd(y, endMo, _endOfMonth(y, endMo)),
      stripped: t.replace(m[0], " "),
    };
  }

  // "year to date" / "ytd" / "this year"
  m = t.match(/\b(?:year to date|ytd|(?:for|in)?\s*this year)\b/i);
  if (m) return { start: `${yr}-01-01`, end: ymd(now()), stripped: t.replace(m[0], " ") };

  // "last year"
  m = t.match(/\blast year\b/i);
  if (m) return { start: `${yr - 1}-01-01`, end: `${yr - 1}-12-31`, stripped: t.replace(m[0], " ") };

  // "this month" / "last month"
  m = t.match(/\b(this|last|previous)\s+month\b/i);
  if (m) {
    const d = now();
    let y = d.getFullYear(), mo = d.getMonth() + 1;
    if (/last|previous/i.test(m[1])) { mo -= 1; if (mo < 1) { mo = 12; y -= 1; } }
    return {
      start: _ymd(y, mo, 1),
      end: _ymd(y, mo, _endOfMonth(y, mo)),
      stripped: t.replace(m[0], " "),
    };
  }

  // "last N days" / "past N days"
  m = t.match(/\b(?:last|past)\s+(\d{1,3})\s+days?\b/i);
  if (m) {
    const n = parseInt(m[1], 10);
    const d = new Date(); d.setDate(d.getDate() - n);
    return { start: ymd(d), end: ymd(now()), stripped: t.replace(m[0], " ") };
  }

  return null;
}


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
  const raw = (text || "").trim();
  if (!raw) return { handled: false };
  // Keep the raw utterance for meta / review / read / create pattern matching
  // (they need phrases like "walk me through"). Below, we build a
  // `nav`-normalized form for the route table only.
  let t = raw;

  // ---- 0. Chat-question bailout ----
  // If the utterance is CLEARLY a question ("do you have any bills I need to
  // pay?", "what's my net income", "how much did we spend on meals"), we
  // must NOT swallow it into a nav command — it should reach the LLM chat
  // stream so the user gets an actual answer. Heuristic: starts with a
  // question word OR ends in '?'. Exceptions: "read/summarize/narrate" are
  // report-narration verbs that we DO want to intercept.
  const QUESTION_START = /^(what|when|where|who|why|how|do (you|we|i)|does|did (you|we|i)|is|are|can (you|we|i)|could (you|we|i)|should (i|we)|will|would|have|has|any|which)\b/i;
  const READ_VERB = /^(read|narrate|summari[sz]e|tell me about|give me)/i;
  const isQuestion = (QUESTION_START.test(t) || t.endsWith("?")) && !READ_VERB.test(t);

  // ---- 1. Meta commands (highest priority) ----
  if (/^(stop|be quiet|shut up|silence|mute|cancel speech)\b/i.test(t)) {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    return { handled: true, say: "" };
  }
  if (/^(clear|reset)( chat| conversation)?\b/i.test(t) || /^new chat\b/i.test(t)) {
    if (typeof ctx.clearChat === "function") ctx.clearChat();
    return { handled: true, say: "Cleared" };
  }

  // Weekly review mode — a paced 4-step morning stand-up.
  //   "walk me through the books", "review my books",
  //   "morning stand-up", "give me a briefing"
  if (/^(?:walk me through|take me through|give me a (?:briefing|walkthrough|stand[- ]?up|review)|review (?:my )?(?:books|the books)|start (?:review|morning) (?:mode)?|morning stand[- ]?up|weekly review|daily review)\b/i.test(t)) {
    return { handled: true, remote: "review-start" };
  }
  // Batch resolve mode — voice-driven reclass sprint through flagged transactions.
  //   "let's clear the flagged transactions"
  //   "clear the flagged"
  //   "resolve flagged"
  //   "review flagged transactions" (only trigger if it's imperative — not a question)
  if (/^(?:let'?s\s+)?(?:clear|resolve|process|clean up|knock out|go through|tackle|categorize|reclassify)\s+(?:the\s+)?(?:flagged|needs? review|for review|review)(?:\s+(?:transactions?|txns?|items|queue))?\b/i.test(t)
      || /^(?:start\s+)?batch\s+(?:resolve|reclass|review|mode)\b/i.test(t)) {
    return { handled: true, remote: "batch-start" };
  }
  // The following batch-mode responses ONLY fire when the caller signals
  // batch mode is active. Otherwise "yes" / "no it's meals" would collide
  // with the pending-intent confirm and normal chat.
  if (ctx.batchActive) {
    if (/^(?:yes|yep|yeah|correct|approve|accept|that'?s right|good|looks (?:good|right)|keep it|leave it)\b/i.test(t)) {
      return { handled: true, batch: { action: "accept" } };
    }
    if (/^(?:skip|pass|not now|next one|move on|next)\b/i.test(t)) {
      return { handled: true, batch: { action: "skip" } };
    }
    // "no it's X" / "actually X" / "put it in X" / "categorize as X"
    const batchReclass = t.match(/^(?:no,?\s*(?:it'?s|that'?s)\s+|actually\s+(?:it'?s\s+)?|put it (?:in|under)\s+|categorize (?:it )?as\s+|change (?:it )?to\s+|it should be\s+|(?:no it'?s|it'?s)\s+)(.+)$/i);
    if (batchReclass) {
      return {
        handled: true,
        batch: { action: "reclassify", target: batchReclass[1].trim().replace(/[.?!]+$/, "") },
      };
    }
    if (/^(?:exit|end|stop|quit|done|cancel)\s*(?:batch|resolve|reclass|review|mode)?\b/i.test(t)) {
      return { handled: true, batch: { action: "exit" } };
    }
  }
  // Review-mode navigation commands (only meaningful when a review is active
  // — but returning them here is cheap and lets the panel decide).
  if (/^(next|next step|continue|move on|keep going|and then)\b/i.test(t)) {
    return { handled: true, review: "next" };
  }
  if (/^(skip|pass|not now)\b/i.test(t)) {
    return { handled: true, review: "skip" };
  }
  if (/^(?:back|previous|go back)\b/i.test(t)) {
    return { handled: true, review: "back" };
  }
  if (/^(?:exit|end|stop|quit)\s+(?:review|walkthrough|stand[- ]?up|briefing)\b/i.test(t)) {
    return { handled: true, review: "exit" };
  }

  // Confirm synonyms — covers casual affirmatives users actually say ("looks good", "yep")
  if (/^(confirm|yes|yep|yeah|yup|sure|ok(ay)?|save it?|do it|go ahead|looks good|sounds good|that.?s good|create it|make it|book it|post it|approve it?)\b/i.test(t)) {
    return { handled: true, pending: "confirm" };
  }
  if (/^(cancel|no,?\s*don'?t|nope|nah|nevermind|never mind|forget it|scrap that|discard)\b/i.test(t)) {
    return { handled: true, pending: "cancel" };
  }

  // ---- 2. "read me the numbers" — TTS-narrated report summary ----
  //   "read (me) (my|the) P&L (for) Q2"
  //   "read the P&L vs last quarter"    → comparative narration
  //   "compare my P&L to last quarter"
  //   "narrate the balance sheet"
  //   "summarize the income statement year to date"
  //
  // Comparative mode is triggered by 'vs', 'versus', 'compared to', or a
  // leading 'compare'. It fetches two periods (current + prior) and speaks
  // the top movers in the SECOND sentence.
  const compareLead = /^(?:compare|contrast)\s+(?:me\s+)?(?:my |the )?(.+)$/i.exec(t);
  const readMatch = compareLead || t.match(/^(?:read|narrate|summari[sz]e|tell me about|give me)(?:\s+me)?\s+(?:my |the )?(.+)$/i);
  if (readMatch) {
    const rest = readMatch[1];
    for (const r of REPORT_ALIASES) {
      if (r.pat.test(rest)) {
        const filters = extractReportFilters(rest);
        const cmpPeriod = extractComparisonPeriod(rest);
        const isCompare = Boolean(compareLead) || Boolean(cmpPeriod) || /\b(?:vs|versus|compared to|change[sd]?|movers?|delta)\b/i.test(rest);
        if (isCompare) {
          const prior = buildPriorFilters(filters, cmpPeriod);
          return {
            handled: true,
            remote: "read-report-compare",
            reportKind: r.kind,
            reportName: r.name,
            filters,        // current period
            priorFilters: prior,
            priorLabel: cmpPeriod?.label || "prior period",
          };
        }
        return {
          handled: true,
          remote: "read-report",
          reportKind: r.kind,
          reportName: r.name,
          filters,
        };
      }
    }
  }

  // ---- 3. Report navigation with optional filters ----
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

  // ---- 4. Transaction filter / lookup commands ----
  //   "show me all the transactions for Walmart"
  //   "transactions for John Smith"
  //   "filter by meals"      → text search
  //   "filter transactions by Walmart"
  //   "search transactions for Uber"

  // Contextual filter — "filter by the/this contact" or "…by this vendor"
  // Uses the AI-focused row (set by hovering a transaction) so voice-only
  // users can zoom in on the record they're looking at.
  const contextRefFilter = /^(?:show (?:me )?)?(?:filter (?:transactions? )?by|search for)\s+(?:this|the)\s+(contact|vendor|customer|merchant|counterparty)\b/i;
  if (contextRefFilter.test(t)) {
    const merchant = ctx.focus?.merchant;
    if (merchant) {
      ctx.navigate(`/accounting/transactions?q=${encodeURIComponent(merchant)}`);
      return { handled: true, say: `Filtering transactions by ${merchant}` };
    }
    // No focused record — tell the user rather than silently opening a page.
    return { handled: true, say: "Hover a transaction first so I know which contact you mean." };
  }

  // "show me (all the) Walmart transactions"  — noun-adjective form where
  // the merchant/vendor name precedes 'transactions'. Also handles
  // "bring up the McDonald's transactions", "pull up Rocket Mortgage
  // charges", etc. Per user request, "show me" and "bring up" are treated
  // as synonyms of "filter by" in the Transactions context.
  const txFilterAdj = t.match(
    /^(?:show (?:me )?|bring (?:me )?up (?:the )?|pull (?:me )?up (?:the )?|find (?:me )?|display (?:me )?|view (?:me )?)(?:all\s+)?(?:the\s+)?(.+?)\s+(?:transactions?|txns?|purchases?|charges?|payments?|activity)\s*$/i
  );
  if (txFilterAdj) {
    let needle = txFilterAdj[1].trim().replace(/[.?!]+$/, "").replace(/^(the|any|all|my|our)\s+/i, "");
    // Skip if "merchant" is actually a status filter — let NAV_ROUTES
    // handle "flagged transactions" / "for-review transactions" further down.
    const isStatus = /^(?:the|a|an|all|any|my|our|flagged|needs? review|for review|reviewed|posted|new|recent|open|closed)$/i.test(needle);
    if (needle && needle.length >= 2 && !isStatus) {
      ctx.navigate(`/accounting/transactions?q=${encodeURIComponent(needle)}`);
      return { handled: true, say: `Filtering transactions by ${needle}` };
    }
  }

  const txFilter = t.match(
    /^(?:show (?:me )?(?:all )?(?:the )?)?(?:transactions? (?:for|from|with)|filter (?:transactions? )?(?:by|for)|search (?:transactions? )?for)\s+(.+)$/i
  );
  if (txFilter) {
    let needle = txFilter[1].trim().replace(/[.?!]+$/, "");
    // Strip filler ("the ", "any ") and trailing "transactions"
    needle = needle.replace(/^(the|any|all|my)\s+/i, "").replace(/\s+transactions?$/i, "");
    if (needle.length >= 2) {
      ctx.navigate(`/accounting/transactions?q=${encodeURIComponent(needle)}`);
      return { handled: true, say: `Filtering transactions by ${needle}` };
    }
  }
  // Bare "filter by X" on any current page — still route to Transactions
  // since that's the most common filterable view.
  const bareFilter = t.match(/^(?:filter|search)\s+(?:by |for )(.+)$/i);
  if (bareFilter) {
    const needle = bareFilter[1].trim().replace(/[.?!]+$/, "");
    if (needle.length >= 2) {
      ctx.navigate(`/accounting/transactions?q=${encodeURIComponent(needle)}`);
      return { handled: true, say: `Filtering transactions by ${needle}` };
    }
  }
  // Clear filters
  if (/^(clear|reset|remove)\s+(filters?|search)\b/i.test(t)) {
    ctx.navigate(`/accounting/transactions`);
    return { handled: true, say: "Filters cleared" };
  }

  // ---- 5. Deep-link a specific transaction ----
  //   "open the July 15th McDonald's transaction for $26.99"
  //   "open the Walmart transaction on July 15"
  //   "open the $26.99 transaction from McDonald's"
  const txDeepLink = tryParseTxnDeepLink(t);
  if (txDeepLink) {
    const params = new URLSearchParams();
    if (txDeepLink.q)     params.set("q", txDeepLink.q);
    if (txDeepLink.date)  { params.set("date_from", txDeepLink.date); params.set("date_to", txDeepLink.date); }
    ctx.navigate(`/accounting/transactions?${params.toString()}`);
    const bits = [txDeepLink.q, txDeepLink.date].filter(Boolean).join(" on ");
    return { handled: true, say: `Looking up ${bits} transaction` };
  }

  // ---- 6. Explicit "open <entity> <name>" ----
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

  // ---- 6b. "open/pull/show account <code or name> [<period phrase>]" ----
  //   "open account 2110"
  //   "pull the Citi Card detail"
  //   "show me account Mr. Cooper"
  //   "open the Citi Card detail from March"
  //   "pull account 2110 for Q1 2026"
  //   "show me Rocket Mortgage year to date"
  //   Requires a backend lookup (fuzzy match by code or name); the caller
  //   (AiPanel) handles the resolution and navigation. When a period phrase
  //   is present we strip it before the target extraction AND forward
  //   `start` / `end` so the drilldown lands pre-filtered.
  const OPEN_ACCOUNT_RE =
    /^(?:open|pull(?:\s+up)?|show(?:\s+me)?|bring\s+up|view)\s+(?:the\s+)?(?:account\s+)?(.+?)(?:\s+(?:detail|account|report))?$/i;
  const acctIntent =
    /^(?:open|pull|show|bring up|view)\b.*\b(?:account|detail)\b/i.test(t) ||
    /^(?:open|pull|show)\s+account\b/i.test(t);
  if (acctIntent) {
    // Pull any date/period phrase off the utterance first — the account-name
    // matcher shouldn't see "from March", "Q1", etc.
    const period = extractPeriod(t);
    const scrubbed = (period ? period.stripped : t).replace(/\s+/g, " ").trim();
    const m = scrubbed.match(OPEN_ACCOUNT_RE);
    if (m && m[1]) {
      const target = m[1]
        .replace(/^(?:the|an?)\s+/i, "")
        .replace(/\s+(?:detail|account|report)$/i, "")
        .trim();
      if (target.length >= 2) {
        const out = { handled: true, remote: "open-account", target };
        if (period) { out.start = period.start; out.end = period.end; }
        return out;
      }
    }
  }

  // ---- 7. Route navigation ----
  //
  // Only fire nav if the utterance LOOKS like a command (short, imperative,
  // or explicitly prefixed with a nav verb). If it's a chat question we
  // fall through to the LLM — otherwise "do you have any bills I need to
  // pay?" would just open the Bills page silently instead of answering.
  //
  // Normalize noisy prefixes so "take me to the reports page" ≈ "reports".
  const NAV_PREFIX = /^(?:please\s+)?(?:can you\s+)?(?:let'?s\s+)?(?:hey\s+)?(?:take|bring|get|show|open|go|navigate|jump)\s+(?:me\s+)?(?:to\s+)?(?:the\s+)?/i;
  const navT = (t.replace(NAV_PREFIX, "").replace(/\b(page|section|screen|view|tab)\s*$/i, "").trim() || t);

  // Report catch-all (index page): "reports" / "financials" after prefix strip.
  if (!isQuestion && /^(?:reports?|financials?)$/i.test(navT)) {
    ctx.navigate("/reports");
    return { handled: true, say: "Opening reports" };
  }

  if (!isQuestion) {
    for (const r of NAV_ROUTES) {
      if (r.pat.test(navT)) {
        // Exclude cases where the utterance is really about creating something
        // (e.g. "create a new invoice" would otherwise match /invoices/).
        if (CREATE_INTENT_RE.test(t)) break;
        ctx.navigate(r.url);
        return { handled: true, say: r.say };
      }
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
