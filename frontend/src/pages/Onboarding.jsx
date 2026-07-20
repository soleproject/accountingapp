import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { api, BACKEND_URL } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { useAuth } from "@/lib/auth";
import { emitAction, useActionListener } from "@/lib/createBus";
import { TID } from "@/constants/testIds";
import { CheckCircle2, ChevronRight, Loader2, Sparkles, ArrowLeft, Upload } from "lucide-react";
import { toast } from "sonner";
import PlaidLinkButton from "@/components/PlaidLinkButton";

// AI onboarding coach — greetings posted into the chat on each step to make
// the flow feel like a live accountant is walking you through. Each entry
// is fired once per step per session. When the coach knows how to extract
// structured fields from the user's freeform reply, `extractStep` is set
// and the frontend calls /onboarding/extract-step to auto-fill the form
// and (optionally) auto-advance to the next step.
const COACH_SCRIPTS = {
  0: {
    key: "onboarding.business_profile",
    // If we already have the essentials on the company record (e.g. Pro
    // pre-filled the profile when creating the client), open with a
    // recap-and-confirm instead of a cold "tell me about your business"
    // ask. The recap includes what we already know so the owner can either
    // wave us through ("nope, good to go") or tack on corrections in one
    // sentence.
    message: (ctx) => {
      const hello = ctx.userFirst ? `Hi ${ctx.userFirst}` : "Hi";
      const bt = ctx.answers?.business_type || ctx.current?.business_type;
      const bd = ctx.answers?.business_description || ctx.current?.business_description;
      if (bt || bd) {
        const cleanBd = bd ? String(bd).trim().replace(/[.!]+$/, "") : "";
        const bits = [bt && `a **${bt}**`, cleanBd && `— ${cleanBd}`].filter(Boolean).join(" ");
        return `${hello} — I have ${ctx.name || "this business"} down as ${bits}. Want to change anything, or should we move on? A quick "nope" / "good to go" works, or tell me what to tweak.`;
      }
      return `${hello} — let's set up ${ctx.name || "your"} books together. Tell me what kind of business this is and what it does (e.g. "we're an LLC doing IT security consulting for hospitals"). I'll fill in the fields on the right for you. You can also fill them manually if you prefer.`;
    },
    extractStep: "business_profile",
    // Auto-advance when we already had (or just captured) both essentials,
    // OR when the user tells us they're happy with what's there.
    ready: (fields, answers) => {
      const haveBoth =
        (fields.business_type || answers.business_type) &&
        (fields.business_description || answers.business_description);
      return haveBoth && (fields.confirm_move_on || Object.keys(fields).length > 0);
    },
    confirm: (bits, ready, fields) => {
      if (fields.confirm_move_on && Object.keys(fields).length === 1) {
        return `Great — moving on…`;
      }
      return ready
        ? `Got it — filled in ${bits}. Moving to the next step in a moment…`
        : `Got it — filled in ${bits}. Anything else to add?`;
    },
  },
  1: {
    key: "onboarding.qbo_link",
    message: (ctx) => {
      const hello = ctx.userFirst ? `${ctx.userFirst}, do` : "Do";
      return `${hello} you already use QuickBooks Online and want to migrate the information?`;
    },
    extractStep: "qbo_link",
    ready: (fields) => fields.qbo === "yes" || fields.qbo === "no",
    confirm: (_bits, _ready, fields) =>
      fields.qbo === "yes"
        ? `Perfect — I'll mock-link QuickBooks and sync your accounts + history in the background. Moving on…`
        : `Got it — we'll set up fresh together. Moving on…`,
  },
  2: {
    key: "onboarding.interview",
    message: (ctx) => {
      const hello = ctx.userFirst ? `${ctx.userFirst}, five` : "Five";
      return `${hello} short questions coming up — should take about 30 seconds. Your answers help me tailor the chart of accounts and pre-seed bank-feed rules for your exact business. Hit "Start AI interview" whenever you're ready.`;
    },
    // No extractStep — user drives the interview UI, not chat.
  },
  3: {
    key: "onboarding.coa",
    message: () =>
      `Time for your Chart of Accounts. I've got a GAAP baseline; hit "Suggest tailored accounts" and I'll propose 15-25 industry-specific ones you can review. If you want anything specific (e.g. "add a food-truck fuel account", "we don't need consulting revenue"), just tell me and I'll factor it in.`,
    extractStep: "coa_overrides",
    // Never auto-advance — user has to actually generate + apply the CoA.
    ready: () => false,
    confirm: (bits) => `Noted — ${bits}. I'll factor that in when generating your CoA.`,
  },
  4: {
    key: "onboarding.plaid",
    message: (ctx) => {
      const hello = ctx.userFirst ? `${ctx.userFirst}, we` : "We";
      return `${hello} are on a roll! Do you want to hook up your bank accounts so that we can download transactions automatically?`;
    },
    extractStep: "plaid_intent",
    // Advance on either explicit "skip"/"no" OR after they successfully
    // linked at least one Plaid account (handled by the local move-on
    // regex catching "yes" once accounts are visible).
    ready: (fields) => fields.skip === true,
    confirm: (_bits, _ready, fields) =>
      fields.skip
        ? `No problem — we'll skip Plaid for now. You can connect banks later from Settings. Moving on…`
        : `Got it — launch Plaid whenever you're ready.`,
  },
  5: {
    key: "onboarding.veryfi",
    message: () =>
      `Any statements Plaid couldn't reach? Old paper statements, credit-union PDFs, receipts — drop them here and Veryfi OCR will pull the transactions and I'll categorize each. Or say "skip" if you don't have any.`,
    extractStep: "veryfi_intent",
    ready: (fields) => fields.skip === true,
    confirm: (_bits, _ready, fields) =>
      fields.skip
        ? `Skipping statement uploads. Moving on…`
        : `Got it — upload whenever ready.`,
  },
  6: {
    key: "onboarding.ready",
    message: (ctx) => {
      const hello = ctx.userFirst ? `${ctx.userFirst}, you're` : "You're";
      return `${hello} all set. Every transaction I could categorize is ready to review; anything I wasn't sure about is flagged. Say "let's go" whenever you want me to take you into your books.`;
    },
    extractStep: "ready_confirm",
    ready: (fields) => fields.confirm === true,
    confirm: () => `Perfect — taking you in now.`,
  },
};

const STEPS = [
  "Business profile",
  "QuickBooks link",
  "AI Interview",
  "AI Chart of Accounts",
  "Bank connection (Plaid)",
  "Statement upload (Veryfi)",
  "Ready to review",
];

export default function Onboarding() {
  const nav = useNavigate();
  const { currentId, current, refresh } = useCompany();
  const { user } = useAuth();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState({});
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [coaSelected, setCoaSelected] = useState(new Set());
  const [previewing, setPreviewing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addedCount, setAddedCount] = useState(0);
  // AI Interview
  const [interviewQs, setInterviewQs] = useState([]);
  const [interviewAns, setInterviewAns] = useState({}); // {id: answer}
  const [interviewLoading, setInterviewLoading] = useState(false);
  const [interviewApplying, setInterviewApplying] = useState(false);
  const [interviewResult, setInterviewResult] = useState(null); // {accounts, rules, inserted_accounts, inserted_rules, rules_applied_to_transactions}
  const [plaidAccts, setPlaidAccts] = useState([]);
  const [selectedPlaid, setSelectedPlaid] = useState(new Set());
  const [imported, setImported] = useState({ plaid: 0, veryfi: 0 });
  // Latches the moment we auto-fire the Plaid download after Plaid Link so
  // a second linking (e.g. adding a second bank) or a component re-mount
  // doesn't retrigger the whole "Nice — I linked X accounts…" flow.
  const autoImportedRef = useRef(false);
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  // Guards the "greet on step change" effect from firing with the default
  // step=0 while onboarding state is still being fetched from the server.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!currentId) return;
    api.get(`/companies/${currentId}/onboarding`).then(r => {
      setStep(r.data.onboarding.step || 0);
      setAnswers(r.data.onboarding.answers || {});
      setLoaded(true);
    });
  }, [currentId]);

  // AI onboarding coach — fire a greeting whenever the step changes (and
  // once on initial load). Debounced via a ref so we only greet each step
  // once per session, even if React re-renders.
  const coachedStepsRef = useRef(new Set());
  useEffect(() => {
    if (!currentId || !loaded) return;
    const script = COACH_SCRIPTS[step];
    if (!script) return;
    const key = `${currentId}::${script.key}`;
    if (coachedStepsRef.current.has(key)) return;
    coachedStepsRef.current.add(key);
    // Open the AI panel and post the greeting. AiPanel treats
    // `onboarding-coach-greet` like a scripted assistant message — it will
    // wear the rainbow-outline bubble because the user hasn't replied yet.
    // Delay the emit so AiPanel has time to mount its listener; otherwise
    // TTS speaks it but the chat bubble never lands.
    emitAction("ai-open");
    const userFirst = (user?.name || "").split(" ")[0];
    setTimeout(() => {
      emitAction("onboarding-coach-greet", {
        message: script.message({
          name: current?.name,
          current,
          answers,
          userFirst,
        }),
      });
    }, 500);
  }, [currentId, step, current?.name, loaded]);

  // When the user replies in the chat while on this page, feed the reply
  // through the current step's extractor and apply the returned fields.
  //
  // `useActionListener` in createBus.js binds its handler ONCE per mount
  // (empty deps), so a naive closure would freeze `step`/`answers` at
  // their initial values. Route through refs so the handler always sees
  // the latest state.
  const stepRef = useRef(step);
  const answersRef = useRef(answers);
  const nextRef = useRef(() => {});
  const finishRef = useRef(() => {});
  const plaidAcctsRef = useRef([]);
  const currentRef = useRef(current);
  // Guards against double-advance when the user fires several move-on
  // phrases in quick succession ("looks good"…"next"…"good to go"). We
  // set this the moment we schedule a next()/finish() and clear it a few
  // ticks after the step actually changes (or a 3s fail-safe).
  const advancingRef = useRef(false);
  useEffect(() => { stepRef.current = step; advancingRef.current = false; }, [step]);
  useEffect(() => { answersRef.current = answers; }, [answers]);
  useEffect(() => { plaidAcctsRef.current = plaidAccts; }, [plaidAccts]);
  useEffect(() => { currentRef.current = current; }, [current]);
  // Coach Q&A fallback — when the user's message doesn't match any local
  // shortcut and the field extractor comes up empty, hand it to the LLM
  // with step-aware context so the coach can actually answer questions
  // like "what will connecting the bank do?" or "what if I don't have any
  // statements?" instead of sitting silent.
  //
  // Wrapped in a ref because `useActionListener` binds its handler once
  // (empty deps) — a plain fn reference would be captured before
  // `currentId` resolved.
  const coachAnswerRef = useRef(async () => {});
  useEffect(() => {
    coachAnswerRef.current = async (msg, extractStep) => {
      if (!currentId) return;
      try {
        const r = await api.post(
          `/companies/${currentId}/onboarding/coach-answer`,
          { step: extractStep, message: msg },
        );
        const text = (r.data?.answer || "").trim();
        const action = r.data?.action || null;
        if (text) emitAction("onboarding-coach-greet", { message: text });
        // Server can also tell us to launch a connect flow or advance the
        // step based on the user's phrasing — honour that.
        if (action === "advance") {
          scheduleAdvanceRef.current(() => nextRef.current());
        } else if (action === "launch:plaid") {
          setTimeout(() => emitAction("plaid-launch"), 600);
        } else if (action === "launch:upload") {
          // Trigger the on-page upload button by dispatching a click via a
          // known data-testid (kept selector-free here — the button's own
          // click handler owns the flow).
          setTimeout(() => {
            const btn = document.querySelector('[data-testid="onboarding-veryfi-upload"], [data-testid="onboarding-mock-veryfi"]');
            btn?.click();
          }, 600);
        }
      } catch { /* non-fatal — silent fallback is better than a stack trace */ }
    };
  }, [currentId]);
  // Expose scheduleAdvance via ref so coachAnswer can call it without
  // hoisting issues.
  const scheduleAdvanceRef = useRef(() => {});

  useActionListener("onboarding-user-message", async (payload) => {
    // Double-advance guard: if we JUST scheduled a next()/finish(), swallow
    // subsequent messages until the step actually changes. Users often say
    // "looks good"…"next"…"good to go" in a burst and we don't want each to
    // trigger its own advance.
    if (advancingRef.current) return;
    const currentStep = stepRef.current;
    const currentAnswers = answersRef.current;
    const currentCompany = currentRef.current;
    const script = COACH_SCRIPTS[currentStep];
    if (!script?.extractStep || !currentId) return;
    const msg = (payload?.text || "").trim();
    if (!msg) return;

    const scheduleAdvance = (fn, delayMs = 1200) => {
      advancingRef.current = true;
      setTimeout(fn, delayMs);
      // Safety-net: if the step somehow doesn't change within 3s, clear the
      // lock so the coach stays responsive.
      setTimeout(() => { advancingRef.current = false; }, 3000);
    };
    scheduleAdvanceRef.current = scheduleAdvance;

    // Broad "the user is fine, move on" detector — matches when ANY of a
    // rich set of natural affirmations appears in the message, not just as
    // a whole-string anchor. Handles filler words like "no that looks good"
    // or "yeah I think this looks good actually".
    const MOVE_ON_ANY_RE = /\b(?:looks (?:good|right|fine|great|correct)|(?:that'?s|this'?s|it'?s) (?:right|fine|correct|good|perfect|great)|good to go|all (?:good|set|done)|sounds (?:good|right|fine|great)|no (?:changes?|edits?|updates?|tweaks?)|nothing to (?:change|edit|update|tweak|add)|move on|next(?: step)?|proceed|continue|keep going|(?:let'?s )?carry on|(?:that|this) works|perfect|great|correct)\b/i;
    // Whole-string minimal move-on tokens ("yes", "yep", "sure", "ok",
    // "good", "done", "nope", "no", "skip") — used for steps where a bare
    // yes/no is enough.
    const MOVE_ON_SHORT_RE = /^(?:nope?|no(?:pe)?|yes|yeah|yep|yup|sure|ok(?:ay)?|good|great|done|next|proceed|continue|skip|move on)[\s.!,?]*$/i;

    const isMoveOn = (m) => MOVE_ON_ANY_RE.test(m) || MOVE_ON_SHORT_RE.test(m);
    // "Actually…" / "no wait" / "change…" style edits — user wants to
    // modify what's already there rather than move on. Block a move-on
    // interpretation when these appear.
    const WANTS_EDIT_RE = /\b(?:actually|wait|change|edit|update|tweak|fix|correct(?: this| it| that)?(?= to| into| please)|add(?:ing)? |remove|drop|instead|different|rename|it'?s (?:actually|not)|not (?:consulting|quite|really))\b/i;
    const moveOn = isMoveOn(msg) && !WANTS_EDIT_RE.test(msg);

    // Step-specific handling (all use `moveOn` above except step 4 which
    // has its own connect/skip/done regexes below):
    //   • business_profile — requires both business_type + business_description
    //     already populated (recap-and-confirm flow); nudges the user if not.
    //   • qbo_link — bare "yes"/"no" is ambiguous re: migration intent, so
    //     defer to the LLM extractor / on-page Yes/No pill.
    //   • plaid_intent — dedicated CONNECT / SKIP / DONE regexes; affirmative
    //     launches Plaid Link, skip advances, done also advances.
    //   • veryfi/coa/ready — universally treated as move-on.
    // Affirmative-connect phrases specific to step 4 — user WANTS to link.
    // Anchored at start with a word boundary (not `$`) so compound answers
    // like "yes let's do it" or "sure, connect them" match cleanly.
    const PLAID_CONNECT_RE = /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|please|absolutely|of course|do it|let'?s (?:do (?:it|this)|connect|link|hook (?:it )?up)|connect(?: it| them| my (?:bank|accounts?))?|link(?: it| them| my (?:bank|accounts?))?|hook (?:it |them |me )?up|launch(?: it| plaid)?|open(?: plaid)?)\b/i;
    // Negative-skip phrases specific to step 4 — user does NOT want to link.
    const PLAID_SKIP_RE = /^(?:nope?|no(?:pe)?|not (?:now|yet|today)|later|do (?:it |this )?later|skip(?: (?:this|it|for now))?|come back|maybe later|no thanks)\b/i;
    // Post-link "we're done here" phrases — user finished Plaid and wants
    // to move on. Also fires when Plaid Link already ran successfully
    // (plaidAccts populated) and the user gives ANY move-on signal.
    const PLAID_DONE_RE = /\b(?:done|all done|already (?:done|linked|completed|connected)|completed|linked|connected|finished|we'?re good|we'?re (?:all )?set|all set|next(?: step)?|move on|let'?s (?:move on|go (?:to (?:the )?next|next)|continue|proceed)|good (?:to go)?)\b/i;

    if (script.extractStep === "plaid_intent") {
      const plaidAlreadyLinked = plaidAcctsRef.current.length > 0;
      // "done" / "next step" / "all set" always means advance — this fires
      // regardless of whether Plaid was linked (user may have completed the
      // popup, or hit skip in Plaid, or just wants out). Also catches
      // "let's go to the next step" which used to (incorrectly) re-launch
      // Plaid via the "let's go" alternative in CONNECT_RE.
      if (PLAID_DONE_RE.test(msg) || (moveOn && plaidAlreadyLinked)) {
        emitAction("onboarding-coach-greet", {
          message: plaidAlreadyLinked
            ? "Nice — bank connected. Moving on…"
            : "Got it — moving on…",
        });
        scheduleAdvance(() => nextRef.current());
        return;
      }
      if (PLAID_CONNECT_RE.test(msg)) {
        if (plaidAlreadyLinked) {
          // Don't re-launch — they already linked. Ask if they want to add
          // another account or move on.
          emitAction("onboarding-coach-greet", {
            message: "Bank's already connected. Want to link another, or should we move on to statement uploads?",
          });
          return;
        }
        emitAction("onboarding-coach-greet", {
          message: "Great — launching Plaid now. Sign in with your bank and I'll take it from there.",
        });
        // Small delay so the confirm bubble lands before Plaid's popup steals focus.
        setTimeout(() => emitAction("plaid-launch"), 600);
        return;
      }
      if (PLAID_SKIP_RE.test(msg)) {
        emitAction("onboarding-coach-greet", {
          message: "No problem — you can connect banks later from Settings. Moving on…",
        });
        scheduleAdvance(() => nextRef.current());
        return;
      }
      // Anything else on Plaid (questions like "what will this do?" or
      // ambiguous statements) — hand to the LLM coach-answer.
      await coachAnswerRef.current(msg, "plaid_intent");
      return;
    } else if (moveOn) {
      let doAdvance = false;
      let confirmText = "Moving on…";
      switch (script.extractStep) {
        case "business_profile": {
          const haveBoth =
            (currentAnswers.business_type || currentCompany?.business_type) &&
            (currentAnswers.business_description || currentCompany?.business_description);
          if (haveBoth) {
            doAdvance = true;
            confirmText = "Great — moving on…";
          } else {
            // Nothing on file yet — tell the user we need a bit more.
            emitAction("onboarding-coach-greet", {
              message: "Almost — I still need to know what kind of business this is and what it does. One sentence like \"we're an LLC doing IT security consulting for hospitals\" and we can move on.",
            });
            return;
          }
          break;
        }
        case "qbo_link":
          // Ambiguous — leave to the extractor / on-page pill.
          break;
        case "veryfi_intent":
          doAdvance = true;
          confirmText = "Got it — skipping statement uploads. Moving on…";
          break;
        case "coa_overrides":
          doAdvance = true;
          confirmText = "Great — moving on…";
          break;
        case "ready_confirm":
          emitAction("onboarding-coach-greet", { message: "Perfect — taking you in now." });
          scheduleAdvance(() => finishRef.current());
          return;
        default:
          break;
      }
      if (doAdvance) {
        emitAction("onboarding-coach-greet", { message: confirmText });
        scheduleAdvance(() => nextRef.current());
        return;
      }
    }

    try {
      const r = await api.post(
        `/companies/${currentId}/onboarding/extract-step`,
        { step: script.extractStep, message: msg },
      );
      const fields = r.data?.fields || {};
      if (!Object.keys(fields).length) {
        // No typed fields — the user is likely asking a question or making
        // an off-script comment. Route through the coach-answer endpoint
        // so they get a real answer instead of silence.
        await coachAnswerRef.current(msg, script.extractStep);
        return;
      }

      // Per-step side effects that MUST run before we render a confirm bubble.
      // Keeps the extractor server-side generic while letting each step
      // apply UI-level nudges (e.g. click a "yes/no" pill, toast the QBO
      // mock-link, or close out onboarding).
      const nextAnswers = { ...currentAnswers, ...fields };
      if (script.extractStep === "qbo_link" && (fields.qbo === "yes" || fields.qbo === "no")) {
        if (fields.qbo === "yes") {
          toast.success("QBO mock-linked. Data will sync in background.");
        }
      }
      setAnswers(nextAnswers);
      await persist(fields);

      const label = (k) => k.replace(/_/g, " ");
      const fmt = (v) =>
        Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "yes" : "no") : String(v);
      const bits = Object.entries(fields)
        .map(([k, v]) => `**${label(k)}**: ${fmt(v)}`)
        .join(" · ");
      const ready = script.ready ? !!script.ready(fields, nextAnswers) : false;
      const confirmMsg = script.confirm
        ? script.confirm(bits, ready, fields)
        : ready
          ? `Got it — ${bits}. Moving on…`
          : `Got it — ${bits}.`;
      emitAction("onboarding-coach-greet", { message: confirmMsg });

      if (ready) {
        // 2.5s gives the confirmation time to visually register (and be
        // spoken aloud if voice output is on) before the page changes.
        // Step 6 (ready_confirm) is terminal — call finish() instead of next().
        setTimeout(() => {
          if (script.extractStep === "ready_confirm") {
            finishRef.current();
          } else {
            nextRef.current();
          }
        }, 2500);
      }
    } catch { /* non-fatal */ }
  });

  const persist = async (patch) => {
    await api.patch(`/companies/${currentId}/onboarding`, patch);
  };

  const mode = answers.onboarding_mode === "simple" ? "simple" : "guided";
  // AI-only steps get skipped in "simple" mode.
  // - 2: AI Interview
  // - 3: AI-tailored Chart of Accounts
  const AI_ONLY_STEPS = new Set([2, 3]);
  const isInterviewStep = (s) => s === 2;   // kept for existing UI conditions
  const isAiOnlyStep = (s) => AI_ONLY_STEPS.has(s);

  const skipForward = (target) => {
    while (mode === "simple" && isAiOnlyStep(target) && target < STEPS.length) target += 1;
    return target;
  };
  const skipBackward = (target) => {
    while (mode === "simple" && isAiOnlyStep(target) && target > 0) target -= 1;
    return target;
  };

  const next = async () => {
    const target = skipForward(step + 1);
    await persist({ step: target, answers });
    setStep(target);
  };
  const back = async () => {
    if (step <= 0) return;
    const target = Math.max(0, skipBackward(step - 1));
    await persist({ step: target });
    setStep(target);
  };
  const setMode = async (m) => {
    const nextAns = { ...answers, onboarding_mode: m };
    setAnswers(nextAns);
    // If flipping to simple while currently sitting on an AI-only step, hop
    // forward past every consecutive AI-only step.
    let nextStep = step;
    if (m === "simple" && isAiOnlyStep(step)) nextStep = skipForward(step);
    await persist({ answers: nextAns, step: nextStep });
    if (nextStep !== step) setStep(nextStep);
  };
  const finish = async () => {
    await persist({ complete: true, step: STEPS.length, answers });
    await refresh();
    toast.success("Onboarding complete! Welcome to Axiom Ledger.");
    nav("/accounting/transactions");
  };
  // Keep the coach-handler refs pointed at the latest closures.
  useEffect(() => { nextRef.current = next; });
  useEffect(() => { finishRef.current = finish; });

  const loadInterview = async () => {
    setInterviewLoading(true);
    try {
      const r = await api.post(`/companies/${currentId}/onboarding/interview/questions`);
      setInterviewQs(r.data.questions || []);
    } catch {
      toast.error("AI couldn't generate interview questions. You can skip.");
    } finally {
      setInterviewLoading(false);
    }
  };

  const applyInterview = async () => {
    if (!interviewQs.length) return;
    setInterviewApplying(true);
    try {
      const answers = interviewQs.map(q => ({
        id: q.id, question: q.question,
        answer: interviewAns[q.id] ?? "",
      }));
      const r = await api.post(
        `/companies/${currentId}/onboarding/interview/synthesize`,
        { answers, apply: true },
      );
      setInterviewResult(r.data);
      toast.success(
        `Added ${r.data.inserted_accounts} account${r.data.inserted_accounts === 1 ? "" : "s"}`
        + ` and ${r.data.inserted_rules} rule${r.data.inserted_rules === 1 ? "" : "s"}`
        + (r.data.rules_applied_to_transactions
            ? ` · back-filled ${r.data.rules_applied_to_transactions} txns`
            : "")
      );
    } catch {
      toast.error("Failed to apply interview answers.");
    } finally {
      setInterviewApplying(false);
    }
  };

  const setInterviewAnswer = (id, val) =>
    setInterviewAns(p => ({ ...p, [id]: val }));


  const generateCoa = async () => {
    setPreviewing(true);
    setSuggestions([]);
    setAddedCount(0);
    try {
      const r = await api.post(`/companies/${currentId}/onboarding/coa/suggest`);
      const list = (r.data.suggestions || []).filter(s => !s.already_exists);
      setSuggestions(list);
      // Default: select all
      setCoaSelected(new Set(list.map(s => s.code)));
      if (!list.length) toast.info("No additional accounts needed — your CoA is already tailored.");
    } catch (err) {
      toast.error("AI could not generate suggestions. Try again.");
    } finally {
      setPreviewing(false);
    }
  };

  const applyCoa = async () => {
    if (coaSelected.size === 0) return;
    setAdding(true);
    try {
      const r = await api.post(`/companies/${currentId}/onboarding/generate-coa`, {
        codes: [...coaSelected],
      });
      setAddedCount(r.data.added || 0);
      // Remove inserted from the pending list
      const insertedCodes = new Set((r.data.inserted || []).map(s => s.code));
      setSuggestions(prev => prev.filter(s => !insertedCodes.has(s.code)));
      setCoaSelected(new Set());
      toast.success(`Added ${r.data.added} industry-specific account${r.data.added === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error("Failed to add accounts.");
    } finally {
      setAdding(false);
    }
  };

  const toggleCoaSelected = (code) => setCoaSelected(prev => {
    const n = new Set(prev);
    n.has(code) ? n.delete(code) : n.add(code);
    return n;
  });
  const mockPlaid = async () => {
    setBusy(true);
    const r = await api.post(`/companies/${currentId}/onboarding/mock-plaid`);
    const accts = r.data.accounts || [];
    setBusy(false);
    // Reshape mock accounts into the same shape onPlaidLinked expects so we
    // reuse a single "auto-select + auto-import + coach announcement" path.
    onPlaidLinked(accts.map(a => ({
      account_id: a.id,
      name: a.name,
      mask: a.name.split("...")[1] || "",
      subtype: a.subtype,
      balance_current: a.balance,
      institution_name: a.institution || "Plaid Sandbox",
    })));
  };
  const onPlaidLinked = async (accounts) => {
    // Convert real Plaid accounts to the same UI shape as the mock
    const mapped = accounts.map(a => ({
      id: a.account_id, name: `${a.name || a.official_name} ...${a.mask || ""}`,
      institution: "Plaid Sandbox", subtype: a.subtype || a.type,
      balance: a.balance_current || 0,
    }));
    setPlaidAccts(mapped);
    // Auto-select every returned account so the user doesn't have to
    // babysit checkboxes — the whole point of "hook up my bank" is
    // "pull my transactions", not "let me pick which ones".
    const allIds = new Set(mapped.map(a => a.id));
    setSelectedPlaid(allIds);
    // Kick off the download + AI categorize immediately. Coach announces
    // it in the chat so the user knows what's happening.
    //
    // Idempotency guard: if we already auto-imported once in this session
    // (imported.plaid > 0), or another auto-import is currently running
    // (autoImportedRef flag), skip. The backend also guards against dupes,
    // but bailing early here avoids the confusing "Nice — I linked 3
    // accounts…" bubble firing on every re-mount.
    if (autoImportedRef.current || imported.plaid > 0) {
      return;
    }
    if (mapped.length && currentId) {
      autoImportedRef.current = true;
      const inst = accounts[0]?.institution_name || "your bank";
      emitAction("onboarding-coach-greet", {
        message: `Nice — I linked ${mapped.length} account${mapped.length === 1 ? "" : "s"} from ${inst}. Pulling in transactions now and categorizing each with AI. This usually takes a few seconds…`,
      });
      setBusy(true);
      try {
        let importedCount = 0;
        let alreadyImported = 0;
        try {
          const r = await api.post(
            `/companies/${currentId}/onboarding/plaid/import`,
            { account_ids: [...allIds] },
          );
          importedCount = r.data.imported || 0;
          alreadyImported = r.data.already_imported || 0;
        } catch {
          // Fallback if Plaid session isn't stored (rare — happens when the
          // exchange endpoint didn't persist the access token; e.g. mock).
          const r = await api.post(
            `/companies/${currentId}/onboarding/import-plaid`,
            [...allIds],
          );
          importedCount = r.data.imported || 0;
          alreadyImported = r.data.already_imported || 0;
        }
        setImported(v => ({ ...v, plaid: importedCount || alreadyImported }));
        const doneMsg = alreadyImported > 0 && importedCount === 0
          ? `These accounts are already in your books (${alreadyImported} transactions previously imported). Say "next" whenever you're ready to move on.`
          : `Done — pulled ${importedCount} transaction${importedCount === 1 ? "" : "s"} and AI-categorized each. Say "next" whenever you're ready to move on, or "link another" if you have more banks to connect.`;
        emitAction("onboarding-coach-greet", { message: doneMsg });
      } catch (e) {
        // Reset the guard so the user can retry if it truly failed.
        autoImportedRef.current = false;
        toast.error(`Import failed: ${e?.response?.data?.detail || e.message}`);
        emitAction("onboarding-coach-greet", {
          message: `Hmm — I hit a snag pulling transactions in. Try clicking "Import & AI-categorize selected" manually, or say "skip" to move on.`,
        });
      } finally { setBusy(false); }
    }
  };
  const importPlaid = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/companies/${currentId}/onboarding/plaid/import`,
                                { account_ids: [...selectedPlaid] });
      setImported(v => ({ ...v, plaid: r.data.imported }));
      toast.success(`AI categorized ${r.data.imported} imported transactions`);
    } catch (e) {
      // Fallback to mock import if Plaid session isn't stored (rare)
      const r = await api.post(`/companies/${currentId}/onboarding/import-plaid`, [...selectedPlaid]);
      setImported(v => ({ ...v, plaid: r.data.imported }));
      toast.success(`AI categorized ${r.data.imported} imported transactions`);
    } finally { setBusy(false); }
  };
  const mockVeryfi = async () => {
    setBusy(true);
    const r = await api.post(`/companies/${currentId}/onboarding/mock-veryfi`);
    setImported(v => ({ ...v, veryfi: r.data.imported }));
    setBusy(false);
    toast.success(`Veryfi OCR'd ${r.data.imported} statement lines`);
  };
  const uploadVeryfi = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const token = localStorage.getItem("axiom_token");
      const r = await fetch(`${BACKEND_URL}/api/companies/${currentId}/onboarding/veryfi/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json();
      setImported(v => ({ ...v, veryfi: d.imported }));
      toast.success(`Veryfi OCR'd ${d.imported} lines. AI categorized each.`);
    } catch (e) {
      toast.error(`Veryfi upload failed: ${e.message}`);
    } finally { setUploading(false); }
  };

  const setAns = (k, v) => setAnswers({ ...answers, [k]: v });

  if (!current) return <div>Select a company.</div>;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-indigo-100 flex items-center justify-center">
          <Sparkles className="text-indigo-600" size={20} />
        </div>
        <div className="flex-1">
          <h1 className="font-heading text-2xl font-bold">AI-assisted onboarding</h1>
          <p className="text-slate-500 text-sm">Getting {current.name} ready for the books.</p>
        </div>
        <div
          className="inline-flex rounded-md border border-slate-300 overflow-hidden text-xs"
          data-testid="onboarding-mode-toggle"
        >
          <button
            onClick={() => setMode("guided")}
            data-testid="onboarding-mode-guided"
            title="Include the 30-second AI interview + AI-tailored Chart of Accounts for a fully personalized setup."
            className={`px-3 py-1.5 flex items-center gap-1 ${
              mode === "guided" ? "bg-slate-900 text-white" : "bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            <Sparkles size={11} /> AI-guided
          </button>
          <button
            onClick={() => setMode("simple")}
            data-testid="onboarding-mode-simple"
            title="Skip the AI interview and AI-tailored Chart of Accounts. Just business profile + QBO + bank + statements."
            className={`px-3 py-1.5 border-l border-slate-300 ${
              mode === "simple" ? "bg-slate-900 text-white" : "bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            Simple
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {STEPS.map((s, i) => {
          if (mode === "simple" && isAiOnlyStep(i)) return null;
          return (
            <div key={i} className={`flex items-center gap-1 text-xs px-2 py-1 rounded-full border ${i < step ? "bg-emerald-50 border-emerald-300 text-emerald-700" : i === step ? "bg-slate-900 text-white" : "bg-white text-slate-500"}`}>
              {i < step && <CheckCircle2 size={12} />} {i + 1}. {s}
            </div>
          );
        })}
      </div>

      <div className="rounded-xl border bg-white p-6">
        {step === 0 && (
          <div className="space-y-3">
            <h2 className="font-heading text-xl font-semibold">Tell us about {current.name}</h2>
            <div>
              <label className="text-xs uppercase text-slate-500">Business type</label>
              <input placeholder="e.g. Marketing agency, restaurant, SaaS company"
                     value={answers.business_type || current.business_type || ""}
                     onChange={(e) => setAns("business_type", e.target.value)}
                     className="w-full mt-1 border rounded px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs uppercase text-slate-500">What does the business do?</label>
              <textarea rows={3} value={answers.business_description || current.business_description || ""}
                        onChange={(e) => setAns("business_description", e.target.value)}
                        className="w-full mt-1 border rounded px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs uppercase text-slate-500">Reporting basis</label>
              <div className="mt-1 inline-flex rounded-md border">
                {["accrual", "cash"].map(b => (
                  <button key={b} onClick={() => setAns("basis", b)}
                          className={`px-3 py-1.5 text-sm ${(answers.basis || "accrual") === b ? "bg-slate-900 text-white" : ""}`}>
                    {b[0].toUpperCase() + b.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <h2 className="font-heading text-xl font-semibold">Do you already use QuickBooks Online?</h2>
            <p className="text-sm text-slate-500">We can link via QBO API and pull your existing chart of accounts and transactions. (Mocked in this MVP.)</p>
            <div className="flex gap-2">
              <button onClick={() => { setAns("qbo", "yes"); toast.success("QBO mock-linked. Data will sync in background."); }}
                      className={`px-4 py-2 rounded-md border text-sm ${answers.qbo === "yes" ? "bg-slate-900 text-white" : ""}`}>
                Yes — link QuickBooks (mock)
              </button>
              <button onClick={() => setAns("qbo", "no")}
                      className={`px-4 py-2 rounded-md border text-sm ${answers.qbo === "no" ? "bg-slate-900 text-white" : ""}`}>
                No — set up fresh
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <h2 className="font-heading text-xl font-semibold">Quick AI interview</h2>
            <p className="text-sm text-slate-500">
              5 targeted questions (under 30 seconds). Claude uses your answers to sharpen the
              chart of accounts and pre-configure bank-feed rules for your exact business.
            </p>

            {interviewQs.length === 0 && !interviewLoading && (
              <button
                onClick={loadInterview}
                data-testid="onboarding-interview-start"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-slate-900 text-white text-sm"
              >
                <Sparkles size={13} /> Start AI interview
              </button>
            )}
            {interviewLoading && (
              <div className="text-sm text-slate-500 inline-flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" />
                Preparing questions tailored to your business…
              </div>
            )}

            {interviewQs.length > 0 && !interviewResult && (
              <div className="space-y-3 mt-2">
                {interviewQs.map((q, idx) => (
                  <div
                    key={q.id}
                    data-testid={`interview-q-${q.id}`}
                    className="rounded-md border bg-white p-3"
                  >
                    <div className="text-sm font-medium mb-1">
                      <span className="text-slate-400 mr-1">{idx + 1}.</span>{q.question}
                    </div>
                    {q.why && <div className="text-[11px] text-slate-500 mb-2">{q.why}</div>}
                    {q.answer_type === "yes_no" ? (
                      <div className="flex gap-2">
                        {["Yes", "No"].map(v => (
                          <button
                            key={v}
                            onClick={() => setInterviewAnswer(q.id, v)}
                            data-testid={`interview-a-${q.id}-${v.toLowerCase()}`}
                            className={`px-3 py-1 rounded-md border text-xs ${
                              interviewAns[q.id] === v
                                ? "bg-slate-900 text-white border-slate-900"
                                : "bg-white hover:bg-slate-50"
                            }`}
                          >
                            {v}
                          </button>
                        ))}
                      </div>
                    ) : q.answer_type === "multi_choice" ? (
                      <div className="flex flex-wrap gap-2">
                        {(q.options || []).map(opt => (
                          <button
                            key={opt}
                            onClick={() => setInterviewAnswer(q.id, opt)}
                            data-testid={`interview-a-${q.id}-${opt.substring(0,12)}`}
                            className={`px-3 py-1 rounded-md border text-xs ${
                              interviewAns[q.id] === opt
                                ? "bg-slate-900 text-white border-slate-900"
                                : "bg-white hover:bg-slate-50"
                            }`}
                          >
                            {opt}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <input
                        placeholder="Type your answer…"
                        value={interviewAns[q.id] || ""}
                        onChange={(e) => setInterviewAnswer(q.id, e.target.value)}
                        data-testid={`interview-a-${q.id}-text`}
                        className="w-full border rounded px-2 py-1.5 text-sm"
                      />
                    )}
                  </div>
                ))}
                <button
                  onClick={applyInterview}
                  disabled={interviewApplying
                    || interviewQs.some(q => !interviewAns[q.id])}
                  data-testid="onboarding-interview-apply"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-emerald-600 text-white text-sm disabled:opacity-50"
                >
                  {interviewApplying && <Loader2 size={14} className="animate-spin" />}
                  Apply AI recommendations
                </button>
              </div>
            )}

            {interviewResult && (
              <div className="mt-3 space-y-3">
                <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm">
                  ✓ Added <b>{interviewResult.inserted_accounts}</b> account{interviewResult.inserted_accounts === 1 ? "" : "s"}
                  {" "}and <b>{interviewResult.inserted_rules}</b> rule{interviewResult.inserted_rules === 1 ? "" : "s"}.
                  {interviewResult.rules_applied_to_transactions > 0 && (
                    <> Back-filled <b>{interviewResult.rules_applied_to_transactions}</b> un-reviewed transaction{interviewResult.rules_applied_to_transactions === 1 ? "" : "s"}.</>
                  )}
                </div>
                {interviewResult.accounts?.length > 0 && (
                  <div className="rounded-md border bg-white">
                    <div className="px-3 py-2 border-b text-xs uppercase tracking-wide text-slate-500 bg-slate-50">
                      New accounts
                    </div>
                    <div className="divide-y max-h-56 overflow-y-auto">
                      {interviewResult.accounts.map(a => (
                        <div key={a.code} className="px-3 py-2 text-sm">
                          <span className="font-mono-num text-slate-500 tabular-nums mr-2">{a.code}</span>
                          <span className="font-medium">{a.name}</span>
                          <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 ml-2">{a.type}</span>
                          {a.rationale && <div className="text-[11px] text-slate-500 mt-0.5">{a.rationale}</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {interviewResult.rules?.length > 0 && (
                  <div className="rounded-md border bg-white">
                    <div className="px-3 py-2 border-b text-xs uppercase tracking-wide text-slate-500 bg-slate-50">
                      Seed rules
                    </div>
                    <div className="divide-y max-h-56 overflow-y-auto">
                      {interviewResult.rules.map((r, i) => (
                        <div key={i} className="px-3 py-2 text-sm">
                          When merchant contains <b>{r.merchant}</b> → <b className="font-mono-num tabular-nums">{r.account_code}</b> {r.account_name}
                          {r.why && <div className="text-[11px] text-slate-500 mt-0.5">{r.why}</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}


        {step === 3 && (
          <div className="space-y-3">
            <h2 className="font-heading text-xl font-semibold">AI-tailored Chart of Accounts</h2>
            <p className="text-sm text-slate-500">
              We seed a GAAP baseline. Claude Sonnet reads your business type + description and
              proposes 15-25 industry-specific accounts you can review before adding.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                data-testid={TID.onboardingCoaGenerate}
                onClick={generateCoa}
                disabled={previewing || adding}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-slate-900 text-white text-sm disabled:opacity-50"
              >
                {previewing && <Loader2 size={13} className="animate-spin" />}
                {previewing ? "Analyzing…" : suggestions.length ? "Re-analyze" : "Suggest tailored accounts"}
              </button>
              {suggestions.length > 0 && (
                <button
                  onClick={applyCoa}
                  disabled={adding || coaSelected.size === 0}
                  data-testid="onboarding-coa-apply"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-emerald-600 text-white text-sm disabled:opacity-50"
                >
                  {adding && <Loader2 size={13} className="animate-spin" />}
                  Add {coaSelected.size} selected
                </button>
              )}
            </div>

            {addedCount > 0 && (
              <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2">
                ✓ Added {addedCount} account{addedCount === 1 ? "" : "s"} to your chart of accounts.
              </div>
            )}

            {suggestions.length > 0 && (
              <div className="mt-2 rounded-md border bg-white">
                <div className="flex items-center gap-2 px-3 py-2 border-b bg-slate-50">
                  <input
                    type="checkbox"
                    checked={coaSelected.size === suggestions.length && suggestions.length > 0}
                    onChange={() => setCoaSelected(
                      coaSelected.size === suggestions.length
                        ? new Set()
                        : new Set(suggestions.map(s => s.code))
                    )}
                    data-testid="onboarding-coa-select-all"
                  />
                  <div className="text-xs text-slate-600">
                    <b>{coaSelected.size}</b> of {suggestions.length} selected
                  </div>
                </div>
                <div className="divide-y max-h-[360px] overflow-y-auto">
                  {suggestions.map(s => (
                    <label
                      key={s.code}
                      data-testid={`onboarding-coa-option-${s.code}`}
                      className={`flex items-start gap-3 px-3 py-2 cursor-pointer ${
                        coaSelected.has(s.code) ? "bg-emerald-50/40" : "hover:bg-slate-50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={coaSelected.has(s.code)}
                        onChange={() => toggleCoaSelected(s.code)}
                        className="mt-1"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm flex items-baseline gap-2 flex-wrap">
                          <span className="font-mono-num text-slate-500 tabular-nums">{s.code}</span>
                          <span className="font-medium">{s.name}</span>
                          <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                            {s.type}
                          </span>
                        </div>
                        {s.rationale && (
                          <div className="text-[11px] text-slate-500 mt-0.5">{s.rationale}</div>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="space-y-3">
            <h2 className="font-heading text-xl font-semibold">Connect your bank via Plaid</h2>
            <p className="text-sm text-slate-500">
              Select which accounts belong to this company. We log the balance with every transaction so we can auto-reconcile later.
              <span className="block mt-1 text-[11px] text-slate-400">Sandbox credentials: <span className="font-mono-num">user_good</span> / <span className="font-mono-num">pass_good</span></span>
            </p>
            {!plaidAccts.length ? (
              <div className="flex gap-2 flex-wrap">
                <PlaidLinkButton companyId={currentId} onSuccess={onPlaidLinked} disabled={busy} />
                <button onClick={mockPlaid} disabled={busy}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-md border text-sm text-slate-600">
                  Or use mock accounts
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {plaidAccts.map(a => (
                  <label key={a.id} className="flex items-center gap-3 p-3 border rounded-md">
                    <input type="checkbox" checked={selectedPlaid.has(a.id)}
                           onChange={(e) => {
                             const s = new Set(selectedPlaid);
                             e.target.checked ? s.add(a.id) : s.delete(a.id);
                             setSelectedPlaid(s);
                           }} />
                    <div className="flex-1">
                      <div className="font-medium text-sm">{a.name}</div>
                      <div className="text-xs text-slate-500">{a.institution} · {a.subtype}</div>
                    </div>
                    <div className="font-mono-num text-sm">${Number(a.balance || 0).toLocaleString()}</div>
                  </label>
                ))}
                <button onClick={importPlaid} disabled={!selectedPlaid.size || busy}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-emerald-600 text-white text-sm disabled:opacity-50">
                  {busy && <Loader2 size={13} className="animate-spin" />} Import & AI-categorize selected
                </button>
                {imported.plaid > 0 && (
                  <div className="text-xs text-emerald-700">✓ Imported {imported.plaid} transactions. AI categorized each per GAAP.</div>
                )}
              </div>
            )}
          </div>
        )}

        {step === 5 && (
          <div className="space-y-3">
            <h2 className="font-heading text-xl font-semibold">Upload statements Plaid couldn't reach</h2>
            <p className="text-sm text-slate-500">Veryfi OCR pulls transactions off PDFs and images. AI categorizes the same way.</p>
            <div className="flex gap-2 flex-wrap">
              <input type="file" ref={fileInputRef} accept=".pdf,image/*"
                     onChange={(e) => uploadVeryfi(e.target.files?.[0])} className="hidden" />
              <button data-testid="onboarding-veryfi-upload"
                      onClick={() => fileInputRef.current?.click()} disabled={uploading}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-slate-900 text-white text-sm">
                {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                Upload real statement (PDF / image)
              </button>
              <button data-testid={TID.onboardingMockVeryfi} onClick={mockVeryfi} disabled={busy}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-md border text-sm text-slate-600">
                Or simulate Veryfi upload
              </button>
            </div>
            {imported.veryfi > 0 && (
              <div className="text-xs text-emerald-700">✓ Imported {imported.veryfi} lines. AI categorized each per GAAP.</div>
            )}
          </div>
        )}

        {step === 6 && (
          <div className="space-y-3">
            <h2 className="font-heading text-xl font-semibold">You're set.</h2>
            <p className="text-sm text-slate-500">
              I've categorized every transaction I could. Anything I wasn't sure about is flagged for review.
              You can scroll through transactions and tell me which ones look right — or hover a row and tell me anything about it.
            </p>
            <button data-testid={TID.onboardingComplete} onClick={finish}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-emerald-600 text-white text-sm">
              Enter my books <ChevronRight size={14} />
            </button>
          </div>
        )}

        <div className="flex items-center justify-between mt-6 pt-4 border-t">
          <button data-testid={TID.onboardingBack} disabled={step === 0} onClick={back}
                  className="inline-flex items-center gap-1 text-sm text-slate-600 disabled:opacity-40">
            <ArrowLeft size={13} /> Back
          </button>
          {step < STEPS.length - 1 && (
            <button data-testid={TID.onboardingNext} onClick={next}
                    className="inline-flex items-center gap-1 px-4 py-1.5 rounded-md bg-slate-900 text-white text-sm">
              Next <ChevronRight size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
