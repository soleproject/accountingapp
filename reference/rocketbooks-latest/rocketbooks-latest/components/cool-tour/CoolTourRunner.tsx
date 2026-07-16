'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';
import { useTourMuted } from '@/components/ai-assistant/useTourMuted';
import {
  enterTourSandboxAction,
  exitTourSandboxAction,
} from '@/app/(app)/dashboard/_actions/tour-sandbox';

/**
 * The cool tour drives the real AI assistant by injecting prompts as if the
 * user typed them, then narrating around the results. Each step is one of:
 *   - 'narrate': push assistant message into the sidecar (spoken via TTS)
 *   - 'actAsUser': inject a user message with the 🎬 badge, optionally wait
 *     for a specific tool to complete before advancing
 *   - 'wait': fixed delay (use sparingly; prefer awaitTool)
 *   - 'enterSandbox' / 'exitSandbox': swap the active org server-side
 *   - 'finish': stop running; runner renders the end card with the regular-
 *     tour handoff + restore-org options
 *
 * The runner is mounted at the app shell level (next to AIAssistantSidecar)
 * so it survives the navigation the steps trigger. While idle (coolTourActive
 * is false), it renders nothing.
 */

type CoolTourStep =
  | { kind: 'enterSandbox' }
  | { kind: 'exitSandbox' }
  | { kind: 'narrate'; text: string }
  | {
      kind: 'actAsUser';
      text: string;
      /** Tool name to await before advancing -- e.g. 'save_invoice_draft'.
       *  If the AI doesn't call it within `awaitMs`, advance anyway. */
      awaitTool?: string;
      awaitMs?: number;
      /** Deterministic navigation backstop: after the await, if the current
       *  pathname doesn't match this, the runner forces router.push(fallbackPath).
       *  Use on navigate-style prompts where the AI is sometimes flaky about
       *  actually calling the navigate tool deep into a long conversation. */
      fallbackPath?: string;
    }
  | {
      /** "For show" invoice step: skip the real save_invoice_draft chain and
       *  push a pre-built InvoicePreview card straight into the sidecar.
       *  Faster than waiting on the AI and avoids writing to the shared
       *  demo workspace. */
      kind: 'showInvoiceCard';
      /** Optional narration text shown above the card. */
      text?: string;
      /** Invoice snapshot to render. Use posted=true / status='posted' for
       *  the post-invoice step so the card flips from blue (draft) to green
       *  (posted) using the existing InvoicePreview styling. */
      invoice: Record<string, unknown>;
    }
  | {
      /** Scroll a `[data-tour="<anchor>"]` element into view, add a focus ring,
       *  narrate the accompanying text, then remove the ring. Used on the
       *  Pulse walk-through so each card is visually called out while the
       *  assistant explains it. */
      kind: 'highlight';
      anchor: string;
      text: string;
    }
  | { kind: 'wait'; ms: number }
  | { kind: 'finish' };

// Pre-built invoice snapshot for the "create" step. Mirrors what
// save_invoice_draft would return, so the InvoicePreview renderer in the
// sidecar treats it exactly like a real result.
const DEMO_INVOICE_DRAFT_ID = 'cool-tour-demo-invoice';
const DEMO_INVOICE_DATE = new Date().toISOString().slice(0, 10);
const DEMO_INVOICE_DRAFT = {
  draftId: DEMO_INVOICE_DRAFT_ID,
  status: 'draft',
  posted: false,
  invoiceNumber: '1001',
  invoiceDate: DEMO_INVOICE_DATE,
  dueDate: null,
  memo: null,
  contact: { id: 'cool-tour-captain-america', name: 'Captain America' },
  arAccount: { id: 'demo-ar', accountNumber: '1100', accountName: 'Accounts Receivable' },
  lines: [
    {
      id: 'cool-tour-line-1',
      description: 'Consulting work',
      quantity: 1,
      unitPrice: 2500,
      amount: 2500,
      revenueAccountId: 'demo-rev',
      revenueAccountLabel: '4000 · Service Revenue',
    },
  ],
  total: 2500,
  journalEntryId: null,
};
const DEMO_INVOICE_POSTED = {
  ...DEMO_INVOICE_DRAFT,
  status: 'posted',
  posted: true,
  journalEntryId: 'cool-tour-demo-je',
};

// Demo script. The invoice create / post steps are "for show" -- we render
// pre-built InvoicePreview cards via pushInvoiceCard instead of asking the
// AI to actually run save_invoice_draft + post_invoice on the shared demo.
// That keeps the demo workspace clean for everyone and finishes the demo
// far faster than waiting on a 4-tool chain. The other steps (navigate,
// filter, revenue) ARE real AI calls -- they're read-only so they don't
// pollute the demo and they show the genuine capability.
//
// Note: the runner intentionally never navigates to /ai-chat. The floating
// sidecar is hidden on that route -- if we navigated there, seedPrompt's
// consumer (the sidecar) would still submit prompts but the user couldn't
// see the conversation. Staying on dashboard / transactions / etc. keeps the
// floating chat visible as the consistent narration surface throughout.
const STEPS: CoolTourStep[] = [
  { kind: 'enterSandbox' },
  {
    kind: 'narrate',
    text: "Alright, I'm going to show you the cool part first. I've switched us into a sample workspace so we can play around. If you look at the bottom of the page I am the floating chat -- that's me, Hi! Just FYI - I'm available on every page.",
  },
  {
    kind: 'narrate',
    text: "Let me show you what I can do. I'll draft an invoice for you, no clicking required.",
  },
  {
    kind: 'showInvoiceCard',
    text: "Here's the kind of draft I'd build if you asked me to invoice Captain America for $2,500 of consulting. Look it over.",
    invoice: DEMO_INVOICE_DRAFT,
  },
  { kind: 'wait', ms: 3500 },
  {
    kind: 'narrate',
    text: "Looks good? Watch -- I'll post it.",
  },
  {
    kind: 'showInvoiceCard',
    text: 'Posted. Notice the card flipped from draft to posted -- that journal entry would now be on the books.',
    invoice: DEMO_INVOICE_POSTED,
  },
  { kind: 'wait', ms: 3500 },
  {
    kind: 'narrate',
    text: "Now let me show you how navigation works -- you can just tell me where to go.",
  },
  {
    kind: 'actAsUser',
    text: 'Take me to the transactions page.',
    awaitTool: 'navigate',
    awaitMs: 8000,
  },
  {
    kind: 'narrate',
    text: 'On any list page, you can filter by talking to me. Watch this.',
  },
  {
    kind: 'actAsUser',
    text: 'Filter transactions for Google.',
    awaitTool: 'apply_transactions_filters',
    awaitMs: 10000,
  },
  {
    kind: 'narrate',
    text: 'And I can answer questions about your books too -- numbers, trends, whatever you need.',
  },
  {
    kind: 'actAsUser',
    text: 'What was my revenue last month?',
    awaitTool: 'get_period_pnl',
    awaitMs: 10000,
  },
  // ---------------------------------------------------------------------
  // Onboarding tour: how to get your books current.
  // QBO migration / mirror → bank connections → imports. Each page is one
  // navigate + one or two narration beats. Pulse comes in a later phase
  // (with section highlighting).
  // ---------------------------------------------------------------------
  {
    kind: 'narrate',
    text: 'Getting your books up to speed is not an issue -- let me show you.',
  },
  {
    kind: 'actAsUser',
    text: 'Take me to the QuickBooks integration page.',
    awaitTool: 'navigate',
    awaitMs: 8000,
    fallbackPath: '/integrations/qbo',
  },
  {
    kind: 'narrate',
    text: "If you're currently on QuickBooks Online and you want to move over, rest assured -- it's just a click of a button and entering your QuickBooks login. I'll import all of your information, transactions, everything.",
  },
  {
    kind: 'narrate',
    text: "And if you want to stay on QuickBooks and have me mirror it for a period of time, we can do that. What that means is -- if you create an invoice inside Rocketbooks, it creates in QuickBooks. If you pay an invoice in QuickBooks, it pays in Rocketbooks. The two platforms marry each other.",
  },
  {
    kind: 'actAsUser',
    text: 'Take me to the bank connections page.',
    awaitTool: 'navigate',
    awaitMs: 8000,
    fallbackPath: '/integrations/plaid',
  },
  {
    kind: 'narrate',
    text: "And if you want to connect your bank accounts or credit cards, I can automatically download the transactions, review and categorize them, separate out the ones I need your input on, and then walk you through those when you're ready. In five or ten minutes, your books are up to date.",
  },
  {
    kind: 'actAsUser',
    text: 'Take me to the imports page.',
    awaitTool: 'navigate',
    awaitMs: 8000,
    fallbackPath: '/imports',
  },
  {
    kind: 'narrate',
    text: "On the imports page, you can drag and drop bank statements directly into this area, and I'll look through all the transactions, add them to your records, and categorize them for you -- no formatting an Excel sheet or CSV that breaks on upload because the columns don't match.",
  },
  {
    kind: 'narrate',
    text: "That's how I get your books current -- whether you're migrating from QuickBooks, connecting a bank, or just dropping in statements. Now let me show you how I help you interpret your books.",
  },
  {
    kind: 'actAsUser',
    text: 'Take me to the Pulse page.',
    awaitTool: 'navigate',
    awaitMs: 8000,
    fallbackPath: '/pulse',
  },
  // ---------------------------------------------------------------------
  // Pulse walk-through. Each beat scrolls the matching card into view and
  // wraps it with a focus ring while the assistant explains it.
  // ---------------------------------------------------------------------
  {
    kind: 'highlight',
    anchor: 'pulse-kpis',
    text: "At the top, your headline numbers for the selected window -- revenue, expenses, net P&L, cash on hand, projected cash, A/R, and A/P. One glance and you know where the business stands.",
  },
  {
    kind: 'highlight',
    anchor: 'pulse-cash-flow',
    text: "This is your cash trajectory -- where you've been and, if you turn on projections, where you're headed. The line is real cash; the dotted segment is the forecast.",
  },
  {
    kind: 'highlight',
    anchor: 'pulse-income-expense',
    text: "Income versus expenses, day by day. Green bars are money in, red is money out. Spikes are easy to spot here -- a big customer payment, an unusual expense, a slow week.",
  },
  {
    kind: 'highlight',
    anchor: 'pulse-profit-loss',
    text: "Your daily profit and loss. Above the line is a profitable day, below is a loss. Use this to see whether the business is making money on a normal week, not just at month-end.",
  },
  {
    kind: 'highlight',
    anchor: 'pulse-ar-aging',
    text: "Accounts receivable aging -- money customers owe you, bucketed by how late it is. The further right, the longer it's been outstanding. This is where I'd nudge you to follow up.",
  },
  {
    kind: 'highlight',
    anchor: 'pulse-ap-aging',
    text: "Accounts payable aging -- bills you owe, bucketed the same way. Use this to plan when to pay so you don't slide into late fees.",
  },
  {
    kind: 'highlight',
    anchor: 'pulse-top-categories',
    text: "And your top spending categories for the window. Quickest way to see where the money is going -- and if a category jumps unexpectedly, that's your cue to ask me why.",
  },
  {
    kind: 'narrate',
    text: "That's Pulse. And remember -- on any of these cards, just ask me to explain what you're seeing, or to dig deeper. Ready to drive?",
  },
  { kind: 'finish' },
];

// How long to wait after pushing narration before advancing. Speech-synthesis
// reads at roughly 150 wpm (~65ms per character with the default voice), so
// we cap at the actual length of the line plus a half-second of breathing
// room. The runner can also be skipped via the X button.
const NARRATION_MS_PER_CHAR = 65;
const NARRATION_PADDING_MS = 700;
const NARRATION_MAX_MS = 22000;

function narrationDelay(text: string): number {
  return Math.min(text.length * NARRATION_MS_PER_CHAR + NARRATION_PADDING_MS, NARRATION_MAX_MS);
}

const COOL_TOUR_ASK_PROMPTS = [
  "Paused. What's on your mind?",
  "Tour paused — fire away.",
  'Hit pause for you. What questions do you have?',
  "On hold. What can I clarify?",
] as const;

function pickCoolTourAskPrompt(): string {
  return COOL_TOUR_ASK_PROMPTS[Math.floor(Math.random() * COOL_TOUR_ASK_PROMPTS.length)];
}

export function CoolTourRunner() {
  const router = useRouter();
  const tourMute = useTourMuted();
  const {
    coolTourActive,
    endCoolTour,
    pushNarration,
    pushInvoiceCard,
    seedPrompt,
    requestSidecarOpen,
    registerToolResultHandler,
    startCoolTour: _startCoolTour,
    startRegularTour,
    tourPaused,
    setTourPaused,
    registerAskQuestionHandler,
    chatPending,
  } = useAssistant();
  // Mirror tour-mute into a ref so the long-running step machine reads the
  // current value at each await without needing it in its deps (which would
  // tear down the in-flight step when the user toggles mute mid-tour).
  const mutedRef = useRef(tourMute.muted);
  useEffect(() => {
    mutedRef.current = tourMute.muted;
    // If the user mutes mid-utterance, cut the current speech off so the
    // runner's wait helpers fall through to their fallback delays.
    if (tourMute.muted && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }, [tourMute.muted]);

  const [stepIdx, setStepIdx] = useState(0);
  const [running, setRunning] = useState(false);
  const [showEndCard, setShowEndCard] = useState(false);
  // Mirror context chatPending into a ref so the step machine can poll
  // without re-rendering on every tick. See waitForChatIdle below for why
  // this gate is necessary.
  const chatPendingRef = useRef(false);
  useEffect(() => {
    chatPendingRef.current = chatPending;
  }, [chatPending]);
  // Mirror context tourPaused into a ref so the in-flight step machine
  // can poll without re-rendering on every tick.
  const pausedRef = useRef(false);
  useEffect(() => {
    pausedRef.current = tourPaused;
    if (tourPaused) {
      // Cancel in-flight speech so audio stops the moment Pause is clicked
      // (from anywhere — top-right pill, sidecar header, or context setter).
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      // Short-circuit any in-flight awaitTool wait so the step machine
      // reaches its post-step pause-hold immediately instead of stalling
      // for the awaitMs timeout (up to 12s) on a pause click.
      const w = awaitResolverRef.current;
      if (w) {
        if (w.timer !== null) window.clearTimeout(w.timer);
        awaitResolverRef.current = null;
        w.resolve();
      }
    }
  }, [tourPaused]);
  const setPaused = useCallback(
    (next: boolean) => {
      setTourPaused(next);
    },
    [setTourPaused],
  );
  // priorOrgId is a ref, not state, because the step machine's effect reads
  // it only from exitSandbox / end-card handlers -- callers that fire long
  // after step 0 sets it. If it were state, the setPriorOrgId call inside
  // step 0 would change the effect's deps, triggering a re-render that
  // re-runs the step machine with stepIdx still at 0, double-executing the
  // step (which double-fires the next narration's TTS and cuts off the
  // first one mid-sentence).
  const priorOrgIdRef = useRef<string | null>(null);
  const [sandboxError, setSandboxError] = useState<string | null>(null);
  // Promise resolver for the current awaitTool wait. Set when an actAsUser
  // step with awaitTool fires; cleared by the tool-result handler (resolves
  // the wait) or by the timeout (rejects gracefully and the step advances
  // anyway).
  const awaitResolverRef = useRef<{
    name: string;
    resolve: () => void;
    timer: number | null;
  } | null>(null);

  // Single subscription for the whole tour run -- mounting/unmounting the
  // handler per step would race against tool dispatch.
  useEffect(() => {
    if (!coolTourActive) return;
    const unsubscribe = registerToolResultHandler((name) => {
      const w = awaitResolverRef.current;
      if (!w) return;
      if (w.name === name) {
        if (w.timer !== null) window.clearTimeout(w.timer);
        awaitResolverRef.current = null;
        w.resolve();
      }
    });
    return unsubscribe;
  }, [coolTourActive, registerToolResultHandler]);

  // Reset state when the tour starts so a re-entry from end-card → start
  // begins at step 0 again.
  useEffect(() => {
    if (!coolTourActive) {
      setStepIdx(0);
      setRunning(false);
      setShowEndCard(false);
      setSandboxError(null);
      pausedRef.current = false;
      setTourPaused(false);
      // Cancel any pending await.
      const w = awaitResolverRef.current;
      if (w?.timer !== null && w?.timer !== undefined) window.clearTimeout(w.timer);
      awaitResolverRef.current = null;
      return;
    }
    setStepIdx(0);
    setRunning(true);
    setShowEndCard(false);
    setSandboxError(null);
    pausedRef.current = false;
    setTourPaused(false);
    // Open the sidecar so the user can see the narration land. mode='side'
    // would cover the page; we want the bar mode so the demo surface
    // (invoice card, transactions table) stays visible alongside.
    requestSidecarOpen('bar');
  }, [coolTourActive, requestSidecarOpen, setTourPaused]);

  // Sidecar header's "Ask a question" button. Pause + nudge the user
  // to ask. Cool tour doesn't have the regular tour's auto "Ready to
  // move on?" prompt (no Q&A scripting here), so the user clicks
  // Resume on the top-right pill or the sidecar pause button when
  // they're done.
  useEffect(() => {
    if (!coolTourActive) return;
    const unsubscribe = registerAskQuestionHandler(() => {
      setTourPaused(true);
      pushNarration(pickCoolTourAskPrompt());
    });
    return unsubscribe;
  }, [coolTourActive, registerAskQuestionHandler, setTourPaused, pushNarration]);

  const awaitTool = useCallback(
    (name: string, ms: number) =>
      new Promise<void>((resolve) => {
        const timer = window.setTimeout(() => {
          if (awaitResolverRef.current?.name === name) {
            awaitResolverRef.current = null;
            resolve();
          }
        }, ms);
        awaitResolverRef.current = { name, resolve, timer };
      }),
    [],
  );

  const sleep = useCallback(
    (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)),
    [],
  );

  // Wait until the sidecar's chat request settles before firing the next
  // seedPrompt. Without this, a slow chat turn (>awaitMs) lets the runner
  // race ahead — handleSubmit then drops the next prompt because pending is
  // still true, and the step's AI action silently skips while subsequent
  // narrations play with no AI work behind them. Pause and skip short-
  // circuit the wait so the user is never stuck. Caller picks maxMs based
  // on the slowest reasonable chat latency for that step.
  const waitForChatIdle = useCallback(
    async (maxMs: number = 30000) => {
      const deadline = Date.now() + maxMs;
      while (chatPendingRef.current && Date.now() < deadline && !pausedRef.current) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
      }
    },
    [],
  );

  // Pause-aware sleep: resolves when ms elapses OR when paused flips true.
  // Polls so the step machine can short-circuit a long wait on Pause click.
  const sleepUntilPaused = useCallback(
    async (ms: number) => {
      const target = Date.now() + ms;
      while (Date.now() < target && !pausedRef.current) {
        const slice = Math.min(120, target - Date.now());
        if (slice <= 0) break;
        await new Promise<void>((resolve) => window.setTimeout(resolve, slice));
      }
    },
    [],
  );

  // Wait for the browser's speech synthesis to finish whatever it's currently
  // speaking. Use this when we just called speak() ourselves (narrate, the
  // actAsUser preamble, showInvoiceCard) -- speaking flips true within
  // ~300ms, then this polls until it falls back to false. maxMs caps the
  // wait so the Chrome quirk where speaking sticks true on long utterances
  // can't lock the tour forever.
  //
  // When the tour is muted (either from the start of the step, or part-way
  // through via the mute toggle which cancels the in-flight utterance) we
  // top the wait up to fallbackMs of elapsed time so the runner keeps the
  // same step pacing it would have had with TTS playing -- otherwise muting
  // mid-utterance would skip ahead to the next step the moment speech is
  // cancelled.
  const waitForSpeechToEnd = useCallback(
    async (fallbackMs?: number, maxMs: number = 30000) => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
      const startedAt = Date.now();
      await sleep(300);
      if (pausedRef.current) return;
      if (window.speechSynthesis.speaking) {
        while (
          window.speechSynthesis.speaking &&
          Date.now() - startedAt < maxMs &&
          !pausedRef.current
        ) {
          await sleep(150);
        }
      }
      if (pausedRef.current) return;
      // Top up to the estimated duration when speech was never started (muted
      // from the get-go) or was cancelled early (mute hit mid-utterance).
      // sleepUntilPaused so Pause click short-circuits the top-up.
      if (fallbackMs) {
        const remaining = fallbackMs - (Date.now() - startedAt);
        if (remaining > 0) await sleepUntilPaused(remaining);
      }
    },
    [sleep, sleepUntilPaused],
  );

  // Wait for a full speech CYCLE -- first for speak() to begin, then for it
  // to finish. Needed after awaitTool resolves: the tool fires before the
  // AI finishes streaming, and the local TTS engine doesn't start speaking
  // the response until pending flips false. If we used waitForSpeechToEnd
  // here it would return instantly (speaking=false at the moment of the
  // tool result), and the next step would cancel the AI's reply before TTS
  // had a chance to start. The maxStartMs cap means "if speech never
  // starts within N seconds, give up and continue" -- protects against the
  // case where TTS is off entirely.
  const waitForSpeechCycle = useCallback(
    async (fallbackMs?: number, maxStartMs: number = 10000, maxEndMs: number = 30000) => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
      const startedAt = Date.now();
      // When muted from the get-go, don't burn 10s polling for speech that
      // will never start -- but still wait the fallback so the AI's streamed
      // reply has time to land.
      if (mutedRef.current) {
        if (fallbackMs) await sleepUntilPaused(fallbackMs);
        return;
      }
      const startDeadline = Date.now() + maxStartMs;
      while (
        !window.speechSynthesis.speaking &&
        Date.now() < startDeadline &&
        !pausedRef.current
      ) {
        await sleep(150);
      }
      if (pausedRef.current) return;
      if (window.speechSynthesis.speaking) {
        const endDeadline = Date.now() + maxEndMs;
        while (
          window.speechSynthesis.speaking &&
          Date.now() < endDeadline &&
          !pausedRef.current
        ) {
          await sleep(150);
        }
      }
      if (pausedRef.current) return;
      // Top up to the fallback when speech never started, or when mute was
      // hit mid-utterance (cancel() makes the inner loop exit early); keeps
      // step pacing consistent regardless of when the user muted.
      if (fallbackMs) {
        const remaining = fallbackMs - (Date.now() - startedAt);
        if (remaining > 0) await sleepUntilPaused(remaining);
      }
    },
    [sleep, sleepUntilPaused],
  );

  // The actual step machine. Recomputed when stepIdx flips so each step
  // gets its own scope. Bails immediately if the tour was skipped.
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const step = STEPS[stepIdx];
    if (!step) {
      setRunning(false);
      return;
    }

    (async () => {
      try {
        switch (step.kind) {
          case 'enterSandbox': {
            const r = await enterTourSandboxAction();
            if (cancelled) return;
            if (!r.ok) {
              setSandboxError(r.error ?? 'Could not start the tour sandbox');
              setRunning(false);
              return;
            }
            // Stored on a ref so the upcoming setState calls from
            // router.refresh / step advancement don't trigger the effect to
            // re-run with stepIdx still at 0.
            priorOrgIdRef.current = r.priorOrgId ?? null;
            // Refresh so the cookie + activeOrganizationId change is
            // reflected by the server components (org-scoped queries) that
            // paint next. We wait longer than the previous 700ms because
            // the refresh re-streams the whole dashboard's server queries;
            // the first narration was getting cut off when the page was
            // still mid-paint and the next render evicted TTS state.
            router.refresh();
            await sleep(2500);
            if (cancelled) return;
            break;
          }
          case 'exitSandbox': {
            await exitTourSandboxAction(priorOrgIdRef.current);
            if (cancelled) return;
            router.refresh();
            await sleep(500);
            break;
          }
          case 'narrate': {
            pushNarration(step.text);
            // Let the TTS engine actually finish reading the narration. The
            // old approach of sleeping for a fixed estimated duration cut
            // off longer lines when the voice ran slower than estimated.
            // When muted, fall back to the estimated duration so the user
            // has time to read the narration in the sidecar.
            await waitForSpeechToEnd(narrationDelay(step.text));
            break;
          }
          case 'showInvoiceCard': {
            pushInvoiceCard(step.invoice, step.text);
            if (step.text) {
              await waitForSpeechToEnd(narrationDelay(step.text));
            } else {
              // No accompanying text -- still hold for a beat so the user
              // can take in the card visually before advancing.
              await sleepUntilPaused(1800);
            }
            // Brief beat after the card narrates so the user can also look
            // at the invoice itself before the next step replaces it.
            await sleepUntilPaused(1200);
            break;
          }
          case 'actAsUser': {
            // The "acting as you" prompt bubble is a user message, which the
            // sidecar's TTS path never speaks (it only voices the AI's
            // replies). Without a preamble the user just hears the AI's
            // response with no audible context for what was just "asked".
            // So we push a brief narration that voices the prompt itself --
            // "If you were to say to me, 'X'" -- and wait for that TTS to
            // finish before firing seedPrompt, otherwise the AI's response
            // TTS would cancel the preamble mid-sentence.
            const preamble = `If you were to say to me, "${step.text}"`;
            pushNarration(preamble);
            await waitForSpeechToEnd(narrationDelay(preamble));
            // Block until any in-flight chat turn from a previous step has
            // fully settled. If the previous turn's awaitTool timed out but
            // the actual HTTP request is still streaming, firing seedPrompt
            // now would land while pending=true and handleSubmit would drop
            // it. Wait up to 30s — longer than any plausible chat latency
            // we'd want to keep the user staring at.
            await waitForChatIdle(30000);
            if (cancelled || pausedRef.current) break;
            console.info('[cool-tour] actAsUser → seedPrompt', { text: step.text, awaitTool: step.awaitTool });
            seedPrompt(step.text, { mode: 'bar', actingAsYou: true });
            if (step.awaitTool) {
              const t0 = Date.now();
              await awaitTool(step.awaitTool, step.awaitMs ?? 12000);
              const elapsed = Date.now() - t0;
              const timedOut = elapsed >= (step.awaitMs ?? 12000) - 50;
              console.info('[cool-tour] awaitTool', step.awaitTool, timedOut ? '✕ TIMED OUT' : '✓ resolved', `${elapsed}ms`);
            } else if (step.awaitMs) {
              await sleepUntilPaused(step.awaitMs);
            } else {
              // No await specified -- give the AI a moment to start.
              await sleepUntilPaused(2000);
            }
            // Deterministic navigation backstop. gpt-4o-mini gets flaky about
            // calling `navigate` after many turns in the conversation -- it
            // sometimes replies "I've taken you to X" without actually firing
            // the tool. If the step declared a fallbackPath, force the push
            // here. router.push is a no-op when we're already at the target.
            if (step.fallbackPath && typeof window !== 'undefined' && window.location.pathname !== step.fallbackPath) {
              router.push(step.fallbackPath);
              await sleep(600);
            }
            // The AI's reply ("Filtered to Google -- 3 transactions, $7,200.
            // What would you like to do next?") is streamed AFTER the tool
            // fires. With the local TTS engine the speak() call doesn't
            // happen until the AI's turn ends (pending flips false), which
            // is several seconds after awaitTool resolves. So we wait for
            // a full speech cycle: speech to start, then to end. If muted,
            // wait a fixed window so the streamed reply has time to land in
            // the sidecar before the next step.
            await waitForSpeechCycle(5000);
            break;
          }
          case 'highlight': {
            const el =
              typeof document !== 'undefined'
                ? (document.querySelector(`[data-tour="${step.anchor}"]`) as HTMLElement | null)
                : null;
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              // Brief beat so the scroll lands before the ring appears.
              await sleep(450);
              el.classList.add('rs-tour-highlight');
            }
            pushNarration(step.text);
            await waitForSpeechToEnd(narrationDelay(step.text));
            if (el) {
              el.classList.remove('rs-tour-highlight');
            }
            break;
          }
          case 'wait': {
            await sleepUntilPaused(step.ms);
            break;
          }
          case 'finish': {
            setShowEndCard(true);
            setRunning(false);
            return;
          }
        }
        // Post-step pause-hold: if Pause was clicked, sit at the boundary
        // between steps until Resume clears it. Speech was already cancelled
        // and the wait helpers short-circuited above, so this is the only
        // place the runner sits while paused.
        while (pausedRef.current && !cancelled) {
          await sleep(150);
        }
        if (!cancelled) setStepIdx((i) => i + 1);
      } catch (err) {
        if (cancelled) return;
        console.warn('[cool-tour] step failed', err);
        // Soft-fail: advance anyway so a single broken step doesn't strand
        // the user. Real errors surface in the sidebar's tool-event chips.
        setStepIdx((i) => i + 1);
      }
    })();

    return () => {
      cancelled = true;
    };
    // priorOrgIdRef intentionally omitted -- it's a ref, so changes don't
    // need to (and shouldn't) re-trigger the step machine. waitForSpeechEnd
    // / waitForSpeechCycle / pushInvoiceCard are stable hook callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIdx, running, awaitTool, sleep, pushNarration, seedPrompt, router]);

  const skip = useCallback(() => {
    setRunning(false);
    setShowEndCard(false);
    // Cancel any pending tool-await so the step machine doesn't fire a
    // stale resolver after we've ended.
    const w = awaitResolverRef.current;
    if (w?.timer !== null && w?.timer !== undefined) window.clearTimeout(w.timer);
    awaitResolverRef.current = null;
    // Restore the prior org -- otherwise the user is stuck on the sandbox.
    void exitTourSandboxAction(priorOrgIdRef.current).then(() => {
      router.refresh();
      endCoolTour();
    });
  }, [router, endCoolTour]);

  const finishAndRestore = useCallback(async () => {
    await exitTourSandboxAction(priorOrgIdRef.current);
    router.refresh();
    endCoolTour();
    // The dashboard takeover's "Tour" button covers re-entry; nothing else
    // to do here.
  }, [router, endCoolTour]);

  const finishAndStayOnSandbox = useCallback(() => {
    endCoolTour();
  }, [endCoolTour]);

  if (!coolTourActive) return null;

  return (
    <>
      {/* Always-visible control pills in the top-right of the viewport so
          the user can pause or bail at any point. Sit below the topbar so
          they don't cover the OrgSwitcher / Sign out. The mute control
          lives on the assistant sidecar's speaker icon (which is always
          visible during the cool tour). */}
      <div className="fixed right-4 top-16 z-[80] flex items-center gap-2">
        <button
          type="button"
          onClick={() => setPaused(!tourPaused)}
          aria-label={tourPaused ? 'Resume the cool tour' : 'Pause the cool tour'}
          title={tourPaused ? 'Resume the cool tour' : 'Pause the cool tour'}
          className="flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 shadow-md hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
        >
          {tourPaused ? (
            <>
              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              Resume
            </>
          ) : (
            <>
              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
                <rect x="6" y="4" width="4" height="16" />
                <rect x="14" y="4" width="4" height="16" />
              </svg>
              Pause
            </>
          )}
        </button>
        <button
          type="button"
          onClick={skip}
          className="flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 shadow-md hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
        >
          <span aria-hidden="true">✕</span> Skip the cool tour
        </button>
      </div>

      {sandboxError && (
        <div className="fixed left-1/2 top-20 z-[80] -translate-x-1/2 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800 shadow-md dark:border-red-900 dark:bg-red-950/60 dark:text-red-200">
          {sandboxError}
        </div>
      )}

      {showEndCard && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-zinc-950/50 px-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
            <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              ✨ Cool tour complete
            </div>
            <div className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              What now?
            </div>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              I can take you on the regular tour to show you where every page lives, or drop you
              back into your own workspace.
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => {
                  // Hand off to the layout-mounted GuidedTour directly via
                  // the AssistantContext flag — no URL routing needed.
                  void exitTourSandboxAction(priorOrgIdRef.current).then(() => {
                    endCoolTour();
                    startRegularTour();
                  });
                }}
                className="rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-left text-sm font-medium text-zinc-800 hover:border-violet-300 hover:bg-violet-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-violet-700 dark:hover:bg-violet-950/30"
              >
                🧭 Show me the regular tour
              </button>
              <button
                type="button"
                onClick={() => void finishAndRestore()}
                className="rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-left text-sm font-medium text-zinc-800 hover:border-violet-300 hover:bg-violet-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-violet-700 dark:hover:bg-violet-950/30"
              >
                🏠 Take me back to my workspace
              </button>
              <button
                type="button"
                onClick={finishAndStayOnSandbox}
                className="rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-left text-sm font-medium text-zinc-800 hover:border-violet-300 hover:bg-violet-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-violet-700 dark:hover:bg-violet-950/30"
              >
                🎮 Let me poke around the sandbox
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
