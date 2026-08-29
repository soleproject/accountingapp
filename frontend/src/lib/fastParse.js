/**
 * fastParse — Tier-0 client-side voice-action parser (Feb 2026).
 *
 * WHY IT EXISTS
 * -------------
 * Users complained that voice actions took multiple seconds before the
 * overlay appeared. Each transcript round-tripped to GPT before we
 * could show anything. This module runs INSTANTLY in the browser to:
 *   1. classify the intent from cheap keyword regexes,
 *   2. extract a local datetime via chrono-node (which knows English
 *      well and understands the user's local wall-clock),
 *   3. pull a duration, contact hint and title heuristically.
 *
 * The result is passed to <VoiceActionConfirm> to render the overlay
 * within ~50ms. The LLM parse still runs in the background and its
 * result is MERGED in when it arrives (preferring LLM's semantic
 * fields but keeping chrono's datetime — chrono is more reliable than
 * an LLM at "tomorrow 12pm" arithmetic).
 *
 * Return shape mirrors the /voice/actions/parse response so the
 * overlay doesn't need to know which tier produced it.
 */
import * as chrono from "chrono-node";

// ── Intent classifier ────────────────────────────────────────────
// The order matters: more specific patterns first.
const INTENT_PATTERNS = [
  // send_calendar_link — booking / scheduling / calendar link
  { intent: "send_calendar_link",
    re: /\b(?:send|share|email|shoot|give)\s+.{0,40}?(?:my|the)\s+(?:calendar\s+(?:link|url)?|booking\s+(?:link|page|url)|scheduling\s+link)\b/i },
  { intent: "send_calendar_link",
    re: /\b(?:send|share|email)\s+(?:my|the)\s+(?:calendar\s+(?:link|url)?|booking\s+(?:link|page|url)|scheduling\s+link)\s+to\b/i },
  // send_meeting_link — meet/zoom/teams link
  { intent: "send_meeting_link",
    re: /\b(?:send|share|email|shoot|give)\s+.{0,40}?(?:my|the)\s+(?:meeting|zoom|meet|teams|whereby)\s+link\b/i },
  { intent: "send_meeting_link",
    re: /\b(?:send|share|email)\s+(?:my|the)\s+(?:meeting|zoom|meet|teams|whereby)\s+link\s+to\b/i },
  // log_call
  { intent: "log_call",
    re: /\b(?:log|record|note)\s+(?:a\s+|my\s+|the\s+)?call\s+(?:with|to)\b/i },
  { intent: "log_call",
    re: /\b(?:just\s+(?:got\s+off\s+(?:a\s+call|the\s+phone)\s+with|hung\s+up\s+with|called|spoke\s+with)|had\s+a\s+(?:phone\s+)?call\s+with)\b/i },
  // move_deal_stage
  { intent: "move_deal_stage",
    re: /\b(?:move|push|drag|shift|advance)\s+.{1,60}?\s+(?:deal\s+)?(?:to|into|over\s+to)\s+(?:lead|qualified|proposal|negotiation|won|lost)\b/i },
  { intent: "move_deal_stage",
    re: /\b(?:mark|set|flag|change)\s+.{1,60}?\s+(?:deal\s+)?(?:as|to)\s+(?:won|lost|qualified|proposal|negotiation|lead)\b/i },
  // snooze_task
  { intent: "snooze_task",
    re: /\bsnooze\s+(?:my|the|this|.{0,20}?)\s*(?:task|follow[-\s]?up|reminder)\b/i },
  { intent: "snooze_task",
    re: /\b(?:push\s+out|reschedule)\s+(?:my|the|this)\s+.{0,40}?(?:task|follow[-\s]?up|reminder)\b/i },
  // follow_up_reminder — must come before create_task
  { intent: "follow_up_reminder",
    re: /\b(?:set|create|add|schedule|new)\s+(?:a\s+|an\s+)?follow[-\s]?up\b/i },
  { intent: "follow_up_reminder",
    re: /\bfollow[-\s]?up\s+with\s+[a-z]/i },
  { intent: "follow_up_reminder",
    re: /\bremind\s+me\s+to\s+follow[-\s]?up\b/i },
  // draft_proposal
  { intent: "draft_proposal",
    re: /\b(?:draft|write|compose|prepare|start|create)\s+(?:a\s+|an\s+|the\s+)?(?:proposal|sow|scope\s+of\s+work|quote|estimate)\b/i },
  // create_appointment — meetings / calls at a time
  { intent: "create_appointment",
    re: /\b(?:schedule|book|set\s+up|create|add|make|new|start)\s+(?:an?\s+|a\s+)?(?:meeting|appointment|call|catch[-\s]?up|sync)\b/i },
  { intent: "create_appointment",
    re: /\b(?:schedule|book|set\s+up|block)\s+(?:some\s+)?(?:time|hour)\b/i },
  // "block 30 minutes", "block an hour", "set aside 20 minutes"
  { intent: "create_appointment",
    re: /\b(?:block|set\s+aside|carve\s+out)\s+(?:\d+\s*(?:min(?:ute)?s?|hr|hours?)|an\s+hour|half\s+(?:an\s+)?hour)\b/i },
  // "block time tomorrow" / "block 30 minutes tomorrow"
  { intent: "create_appointment",
    re: /\bblock\s+.{0,40}?\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+week|tonight)\b/i },
  { intent: "create_appointment",
    re: /\bmeet\s+with\s+[a-z]/i },
  // create_task — TODOs
  { intent: "create_task",
    re: /\b(?:create|make|add|new|start)\s+(?:an?\s+|the\s+)?(?:task|to[-\s]?do|reminder)\b/i },
  { intent: "create_task",
    re: /\b(?:remind\s+me\s+to|i\s+need\s+to|i\s+have\s+to)\b/i },
];

function classifyIntent(text) {
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(text)) return intent;
  }
  // Fallback: if the utterance mentions a future time AND a self-work
  // verb ("study", "review", "prep", "read", "draft", "write"), assume
  // it's a solo appointment. This catches free-form dumps like
  // "I want to schedule time tomorrow at 12pm so I can study X".
  const timeish = /\b(today|tonight|tomorrow|next\s+\w+|this\s+\w+|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\s*(?:am|pm|:\d{2}))\b/i;
  const solowork = /\b(?:study|review|prep|prepare|read|practice|research|write|draft)\b/i;
  if (timeish.test(text) && solowork.test(text)) return "create_appointment";
  return "unknown";
}

// ── Duration extractor ────────────────────────────────────────────
function extractDurationMin(text) {
  // "30 minutes", "for 30 min", "45-minute", "an hour", "1 hour", "1.5 hours"
  const m1 = text.match(/\b(\d{1,3})\s*(?:-|\s)?\s*(?:min(?:ute)?s?)\b/i);
  if (m1) return parseInt(m1[1], 10);
  const m2 = text.match(/\b(\d(?:\.\d)?)\s*(?:-|\s)?\s*(?:hr|hour)s?\b/i);
  if (m2) return Math.round(parseFloat(m2[1]) * 60);
  if (/\ban\s+hour\b/i.test(text)) return 60;
  if (/\bhalf\s+(?:an\s+)?hour\b/i.test(text)) return 30;
  return null;
}

// ── Contact-hint extractor ───────────────────────────────────────
//   Very rough — matches the "with <Capitalized Name>" or "call/email
//   <Name>" pattern. Only captures the segment; the backend will do
//   the actual DB lookup.
const CONTACT_STOPWORDS = new Set([
  "me", "myself", "you", "him", "her", "them", "it",
  "someone", "anybody", "everybody", "the", "a", "an",
  "regarding", "about", "for", "over", "on",
]);

function extractContactHint(text, intent) {
  // Don't pull a contact for self-referential blocks — study/review etc.
  if (intent === "create_appointment"
      && /\b(?:so\s+(?:that\s+)?i\s+can|to\s+(?:study|review|prep|prepare|read|practice))\b/i.test(text)) {
    return null;
  }

  const patterns = [
    /\b(?:with|call|email|to)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/,
    /\b(?:for)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/,
    /\bfollow[-\s]?up\s+with\s+([A-Za-z][A-Za-z' -]{1,40})\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const name = m[1].trim();
      const first = name.split(/\s+/)[0].toLowerCase();
      if (CONTACT_STOPWORDS.has(first)) continue;
      return name;
    }
  }
  return null;
}

// ── Deal stage extractor ─────────────────────────────────────────
const DEAL_STAGES = ["lead", "qualified", "proposal",
                     "negotiation", "won", "lost"];
function extractStage(text) {
  const m = text.match(new RegExp(
    `\\b(?:to|into|as)\\s+(${DEAL_STAGES.join("|")})\\b`, "i",
  ));
  if (m) return m[1].toLowerCase();
  // "won the X deal" / "lost the X deal"
  const m2 = text.match(/\b(won|lost)\s+the\b/i);
  if (m2) return m2[1].toLowerCase();
  return null;
}

// ── Snooze delta extractor ───────────────────────────────────────
function extractSnoozeDays(text) {
  const m = text.match(/\b(?:by|for|out|until)?\s*(\d+)\s*(day|week)s?\b/i);
  if (m) {
    const n = parseInt(m[1], 10);
    return /week/i.test(m[2]) ? n * 7 : n;
  }
  if (/\btomorrow\b/i.test(text)) return 1;
  if (/\bnext\s+week\b/i.test(text)) return 7;
  return null;
}

// ── Amount extractor (for draft_proposal) ────────────────────────
function extractAmount(text) {
  const m = text.match(/\$\s*(\d[\d,]*(?:\.\d+)?)\s*([kKmM]?)/);
  if (!m) {
    const m2 = text.match(/\bfor\s+(\d[\d,]*(?:\.\d+)?)\s*([kKmM])?\b/i);
    if (!m2) return null;
    return _toAmount(m2[1], m2[2]);
  }
  return _toAmount(m[1], m[2]);
}
function _toAmount(numStr, suffix) {
  let n = parseFloat(numStr.replace(/,/g, ""));
  if (suffix && /k/i.test(suffix)) n *= 1000;
  else if (suffix && /m/i.test(suffix)) n *= 1_000_000;
  return isFinite(n) ? n : null;
}

// ── Title synthesiser ────────────────────────────────────────────
function synthesiseTitle(intent, text, contactHint) {
  const t = text.trim();
  const firstSentence = t.split(/[.!?]/)[0].trim();
  const capped = firstSentence.length > 80 ? firstSentence.slice(0, 77) + "…" : firstSentence;
  switch (intent) {
    case "follow_up_reminder":
      return contactHint ? `Follow up with ${contactHint}` : "Follow up";
    case "log_call":
      return contactHint ? `Call with ${contactHint}` : "Phone call";
    case "send_calendar_link":
      return "Send calendar link";
    case "send_meeting_link":
      return "Send meeting link";
    case "draft_proposal":
      return contactHint ? `Proposal for ${contactHint}` : "Proposal";
    case "move_deal_stage":
      return "Move deal";
    case "snooze_task":
      return "Snooze task";
    default:
      return capped;
  }
}

// ── Main entry ───────────────────────────────────────────────────
/**
 * Produce a fast, deterministic parse of the utterance.
 *
 * @param {string} text - transcript
 * @param {Date}   nowLocal - current local time (Date object)
 * @returns {object|null} - null if we can't confidently classify;
 *                          otherwise the same shape as /voice/actions/parse
 */
// ── Compound-utterance detector ──────────────────────────────────
/**
 * Return true if the utterance almost certainly contains more than
 * one distinct action (e.g. "I want to schedule X ALSO email Y AND
 * send Z my calendar link").
 *
 * Heuristic: count distinct action-verbs plus split-connectors.
 */
export function looksCompound(text) {
  const t = (text || "").toLowerCase();
  if (t.length < 40) return false;

  // Any of these connectors, when repeated OR paired with a fresh
  // action verb, is a compound signal.
  const connectorRe = /\b(?:also|and then|then i|plus|next(?:,|\s)?\s?i|after that)\b/g;
  const connectors = (t.match(connectorRe) || []).length;

  const actionVerbs = [
    /\b(?:send|share|email|shoot)\b/g,
    /\b(?:schedule|book|set\s+up|block|carve\s+out|set\s+aside)\b/g,
    /\b(?:follow[-\s]?up|remind\s+me)\b/g,
    /\b(?:call|log\s+a\s+call|record\s+a\s+call)\b/g,
    /\b(?:draft|write|compose)\b/g,
    /\b(?:move|mark|push)\b.{0,15}\b(?:won|lost|qualified|proposal|negotiation|lead)\b/g,
    /\b(?:snooze|reschedule)\b/g,
  ];
  const verbCount = actionVerbs.reduce(
    (acc, re) => acc + (t.match(re) || []).length, 0,
  );
  return connectors >= 1 && verbCount >= 2;
}


export function fastParse(text, nowLocal = new Date()) {
  const raw = (text || "").trim();
  if (!raw) return null;

  const intent = classifyIntent(raw);
  if (intent === "unknown") return null;

  const contactHint = extractContactHint(raw, intent);
  const durationMin = extractDurationMin(raw);

  // Time — chrono works in the browser's local zone by default.
  let isoDatetime = null;
  try {
    const results = chrono.parse(raw, nowLocal, { forwardDate: true });
    if (results.length) {
      // Prefer results that explicitly named a clock time (contain
      // "am/pm", ":", or "at N"). Chrono greedily matches durations
      // like "30 minutes" first, which is almost never what the user
      // meant when they also said "tomorrow at 12 pm".
      const CLOCK_RE = /\b(?:\d{1,2}\s*(?::\d{2})?\s*(?:am|pm|p\.m\.|a\.m\.)|at\s+\d{1,2}(?::\d{2})?|noon|midnight)\b/i;
      const explicit = results.find(r => CLOCK_RE.test(r.text || ""));
      const chosen = explicit || results[0];
      const d = chosen.start.date();
      if (d && !isNaN(d.getTime())) {
        isoDatetime = _toLocalIso(d);
      }
    }
  } catch {
    // chrono failure → leave iso null; LLM will fill it.
  }

  const entities = {
    title:         synthesiseTitle(intent, raw, contactHint),
    contact_hint:  contactHint,
    iso_datetime:  isoDatetime,
    duration_min:  durationMin || (intent === "create_appointment" ? 30 : null),
    priority:      "medium",
  };
  if (intent === "move_deal_stage") entities.new_stage = extractStage(raw);
  if (intent === "snooze_task")     entities.snooze_by_days = extractSnoozeDays(raw);
  if (intent === "draft_proposal") {
    entities.amount = extractAmount(raw);
    entities.currency = "USD";
    entities.notes = raw;
  }
  if (intent === "log_call") entities.notes = raw;

  return {
    intent,
    confidence: 0.55,          // conservative — the LLM may bump it
    entities,
    resolution: {},            // contact/deal lookup requires a server call
    clarifications: [],
    preview: "",
    _model: "local-fast",
    _fast: true,
  };
}

/**
 * Convert a Date to an ISO 8601 string in the caller's LOCAL timezone
 * with a UTC offset (e.g. "2026-08-30T12:00:00-07:00"). Never returns
 * a "Z"-suffixed UTC string.
 */
function _toLocalIso(d) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const da = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return `${y}-${mo}-${da}T${hh}:${mm}:${ss}${sign}${oh}:${om}`;
}

/**
 * Merge a fresh parse (usually from the LLM) into an existing parse
 * (usually from fastParse). Rules:
 *   • prefer the incoming intent (LLM has more context),
 *   • prefer the incoming resolution (server did DB lookups),
 *   • merge entities: prefer chrono's iso_datetime/duration_min if
 *     set (LLM can hallucinate offsets), else fall through to LLM.
 */
export function mergeParse(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const merged = { ...incoming };
  const e = existing.entities || {};
  const i = incoming.entities || {};
  merged.entities = { ...i };
  if (e.iso_datetime && !i.iso_datetime) merged.entities.iso_datetime = e.iso_datetime;
  if (e.duration_min && !i.duration_min) merged.entities.duration_min = e.duration_min;
  // Preserve any user-typed edits carried on the existing parse.
  if (e._dirty) merged.entities = { ...merged.entities, ...e };
  return merged;
}
