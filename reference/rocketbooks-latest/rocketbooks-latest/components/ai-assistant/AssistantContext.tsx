'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isAllowedAppPath } from '@/lib/ai/app-routes';

/**
 * Page-level context the assistant ships with every chat turn so the model
 * knows what the user is currently looking at. Pages call `setPageContext`
 * from a `useEffect` (and clear it on unmount) to register themselves.
 *
 * Keep this small — anything that fits in a few hundred tokens. For long
 * lists, prefer letting the AI call a tool to read the data.
 */
export interface PageContext {
  /** Stable identifier — drives which toolset is exposed. */
  pageId: string;
  /** Human-readable page name shown in the system prompt. */
  pageTitle: string;
  /** URL/route the user is on (for deep-link tools). */
  route?: string;
  /**
   * Free-form payload the page wants the AI to know about — current filters,
   * sort, selection, counts, etc. Stringified into the system prompt.
   */
  data?: Record<string, unknown>;
  /** Allow-list of tool names. Empty/undefined → only global read tools. */
  toolNames?: string[];
}

/**
 * A client-side action the page exposes to the AI. Server-side tool execution
 * always returns its result; the assistant THEN can ask the page to perform a
 * follow-up effect (apply URL filters, refresh, scroll, etc.) via this hook.
 *
 * The dispatch loop is: server tool runs (mutates DB / queries) → result
 * streams back → if `client_action` is in the result, the assistant client
 * looks it up here and calls it.
 */
export type ClientActionHandler = (args: Record<string, unknown>) => void | Promise<void>;

/**
 * A prompt the page wants pushed into the assistant chat as if the user had
 * typed it. The bumping `id` lets the sidecar detect repeat seeds of the same
 * text (e.g. clicking "Explain" twice on the same card) without missing them.
 *
 * `mode` lets the seeding page request a specific sidecar layout (e.g. guided
 * triage seeds with mode='bar' so the floating chat doesn't cover the table).
 * Omitted → keep current mode if open, otherwise fall back to 'side'.
 */
export interface SeededPrompt {
  id: number;
  text: string;
  mode?: 'bar' | 'side';
  /** When true, the sidecar renders the seeded user message with a
   *  "🎬 acting as you" badge so the user can tell the AI typed it on
   *  their behalf (used by the cool-tour runner). */
  actingAsYou?: boolean;
  /** When true, the seeded text is still sent to the model as the first
   *  user message (so it triggers + instructs the turn) but is NOT rendered
   *  as a visible user bubble. Lets a page hand the AI a long operational
   *  instruction (e.g. "log a conversation, call lookup_contact on every
   *  create…") without showing that wall of text to the user. */
  hidden?: boolean;
}

/**
 * Which chat backend the sidecar should talk to.
 *
 * - 'default' (the only mode for almost every page): hits /api/ai/assistant/chat,
 *   which carries page-context-aware tools (filter, navigate, page state).
 * - 'onboarding': hits /api/ai/chat instead, which has the onboarding system
 *   prompt and the onboarding tools (get_onboarding_status, set_business_info,
 *   advance_onboarding). Only the /ai-chat page sets this, and only while the
 *   user is mid-onboarding without a realtime voice session. The page also
 *   registers an onboarding-tool-result handler so the OnboardingPanel state
 *   stays in sync as the AI advances the user through the phases.
 */
export type ChatChannel = 'default' | 'onboarding';

/** Handler the page registers so onboarding tool results can flow back into
 *  the page's shared onboarding state (which drives OnboardingPanel). The
 *  arg is the OnboardingStatusView returned by the tool — kept as
 *  `Record<string, unknown>` here to avoid a context↔chat circular dep. */
export type OnboardingToolResultHandler = (view: Record<string, unknown>) => void;

/** Generic tool-result handler -- fires for every successful tool result the
 *  AI surfaces (save_invoice_draft, post_invoice, apply_transactions_filters,
 *  etc.). Used by the cool-tour runner to await specific tools by name
 *  instead of relying on the AI's "I'm done speaking" signal. */
export type ToolResultHandler = (name: string, output: unknown) => void;

/** A piece of narration the cool-tour runner pushes into the floating
 *  sidecar's message history. Rendered like a normal assistant message but
 *  bypasses the chat API entirely -- it's just static text the runner
 *  wants the user to see + hear via TTS. */
export interface PushedNarration {
  id: number;
  text: string;
}

/** A pre-built invoice card the cool-tour runner pushes into the sidecar
 *  to demonstrate the invoice-creation experience without actually writing
 *  to the database. The shape mirrors what save_invoice_draft / post_invoice
 *  would return so the existing InvoicePreview renderer Just Works. */
export interface PushedInvoiceCard {
  id: number;
  /** Optional short text to render above the invoice card (assistant tone:
   *  "Here's the draft -- ready when you are"). Omitted by callers that
   *  only want the card. */
  text?: string;
  /** The same InvoiceDraftView shape the real tool emits. Kept loose here
   *  to avoid context↔invoice-preview circular deps. */
  invoice: Record<string, unknown>;
}

/** A categorization-rule suggestion pinned to the bottom of the sidecar (above
 *  the input) — set when the user clicks "Discuss with AI" from the rule popup. */
export interface PinnedRuleCard {
  pattern: string;
  categoryAccountId: string;
  categoryName: string;
  count: number;
  /** Direction the rule is scoped to ('deposit'|'withdrawal'|null). */
  transactionType?: string | null;
  /** The /transactions URL to return the user to after the rule is accepted. */
  returnTo?: string;
}

/** A "categorize the rest of this contact" suggestion pinned to the bottom of the
 *  sidecar — set in the verify flow when verify_transaction_ids returns a
 *  pendingContact. The guided review waits for the user to resolve it. */
export interface PinnedContactCard {
  contactId: string;
  contactName: string;
  categoryAccountId: string;
  categoryName: string;
  count: number;
  transactionType?: string | null;
  returnTo?: string;
}

/**
 * A prompt the floating sidecar wants the inline /ai-chat ChatBox to pick up
 * — the inverse direction of [[SeededPrompt]]. Used when the user is talking
 * to the floating bar on another page and the assistant navigates them to
 * /ai-chat: we want the message they just sent to land in the inline thread
 * so the conversation continues in the surface they're now looking at.
 *
 * Bumping `id` lets the inline workspace detect repeats without missing them
 * (same pattern as seededPrompt / openRequest).
 */
export interface PageHandoff {
  id: number;
  text: string;
}

interface AssistantContextValue {
  /** Current registration. Null when no page has registered. */
  pageContext: PageContext | null;
  /** Page calls this from useEffect (with cleanup) to register. */
  setPageContext: (ctx: PageContext | null) => void;
  /** Register a client-side action the AI can trigger via tool result. */
  registerClientAction: (name: string, handler: ClientActionHandler) => () => void;
  /** Used by AIAssistantSidecar to dispatch a client action by name. */
  dispatchClientAction: (name: string, args: Record<string, unknown>) => Promise<void>;
  /** Latest pending seeded prompt; null after the sidecar has consumed it. */
  seededPrompt: SeededPrompt | null;
  /** Page-side: queue a prompt as if the user had typed it.
   *  `actingAsYou` flags the seed so the sidecar can render a
   *  "🎬 acting as you" badge on the resulting user message (cool tour). */
  seedPrompt: (text: string, opts?: { mode?: 'bar' | 'side'; actingAsYou?: boolean; hidden?: boolean }) => void;
  /** Sidecar-side: clear the queued prompt after submitting it. */
  consumeSeededPrompt: () => void;
  /** Latest page → assistant in-flow event; null after the sidecar consumes it. */
  pageEvent: { id: number; text: string } | null;
  /** Page-side: report an in-flow step (e.g. "Generate previews" clicked). The
   *  sidecar reacts only when it's already open; otherwise it's a no-op. */
  notifyAssistant: (text: string) => void;
  /** Sidecar-side: clear the consumed page event. */
  consumePageEvent: () => void;
  /** Current chat channel. Defaults to 'default'. */
  chatChannel: ChatChannel;
  /** Page calls this (with cleanup back to 'default') to switch endpoints. */
  setChatChannel: (channel: ChatChannel) => void;
  /** Page registers a handler that receives onboarding tool results from the
   *  sidecar so it can update its own onboarding state. Returns unsubscribe. */
  registerOnboardingToolResultHandler: (handler: OnboardingToolResultHandler) => () => void;
  /** Sidecar-side: dispatch an onboarding tool result to whoever's registered. */
  dispatchOnboardingToolResult: (view: Record<string, unknown>) => void;
  /** Cool-tour runner registers here to await specific tool completions by
   *  name. Fires for every successful tool result, not just onboarding. */
  registerToolResultHandler: (handler: ToolResultHandler) => () => void;
  /** Sidecar-side: dispatch a generic tool result to all registered handlers. */
  dispatchToolResult: (name: string, output: unknown) => void;
  /** Regular-tour runner registers here to learn when the user submits a
   *  chat message — so the tour can auto-pause and let the Q&A happen. */
  registerUserInterjectionHandler: (handler: (text: string) => void) => () => void;
  /** Sidecar-side: fire when the user submits a message. */
  dispatchUserInterjection: (text: string) => void;
  /** Regular-tour runner registers here to learn when the AI's response
   *  to an interjection finishes streaming, so it can prompt "Ready to
   *  move on?". */
  registerReplyCompleteHandler: (handler: () => void) => () => void;
  /** Sidecar-side: fire when the assistant turn finishes streaming. */
  dispatchReplyComplete: () => void;
  /** Latest pending narration push; null after the sidecar has consumed it. */
  pushedNarration: PushedNarration | null;
  /** Cool-tour runner pushes a static assistant message into the sidecar's
   *  history (no API call). The sidecar speaks it via TTS like a real reply. */
  pushNarration: (text: string) => void;
  /** Sidecar-side: clear the queued narration after appending it. */
  consumePushedNarration: () => void;
  /** Latest pending invoice-card push; null after consumed. */
  pushedInvoiceCard: PushedInvoiceCard | null;
  /** Cool-tour runner pushes a fake invoice card into the sidecar's history
   *  for the create / post demo steps. The card uses the same renderer as
   *  real save_invoice_draft results so it looks identical to the user. */
  pushInvoiceCard: (invoice: Record<string, unknown>, text?: string) => void;
  /** Sidecar-side: clear the queued invoice card after appending it. */
  consumePushedInvoiceCard: () => void;
  /** A rule card pinned to the bottom of the sidecar (above the input), set on
   *  "Discuss with AI". The sidecar renders it stationary while chat scrolls
   *  normally above. null = no card. */
  pinnedRule: PinnedRuleCard | null;
  setPinnedRule: (card: PinnedRuleCard | null) => void;
  /** The "categorize the rest of this contact" card (verify flow). */
  pinnedContact: PinnedContactCard | null;
  setPinnedContact: (card: PinnedContactCard | null) => void;
  /** Whether the cool tour is currently running. Toggles the CoolTourRunner
   *  state machine on/off; the runner is mounted at the app shell level so it
   *  survives the navigation steps it triggers. */
  coolTourActive: boolean;
  /** Welcome takeover (or any other surface) calls this to kick off the
   *  cool tour. Idempotent -- a second call while active is ignored. */
  startCoolTour: () => void;
  /** Runner calls this when the tour finishes (or the user skips). */
  endCoolTour: () => void;
  /** Whether the regular (platform pages) tour is currently running. Same
   *  mount pattern as the cool tour — runner sits at the app shell so it
   *  survives the page-to-page navigation it triggers. */
  regularTourActive: boolean;
  /** Surface that wants to start the regular tour calls this. */
  startRegularTour: () => void;
  /** Runner calls this when the regular tour finishes (or the user skips). */
  endRegularTour: () => void;
  /** Shared pause state for whichever tour is running. Read by both
   *  runners and by the sidecar's tour-only header controls. */
  tourPaused: boolean;
  setTourPaused: (next: boolean) => void;
  /** Sidecar header "Ask a question" button fires this; the active
   *  tour runner subscribes to pause + push a "what's up?" narration. */
  requestAskQuestion: () => void;
  registerAskQuestionHandler: (handler: () => void) => () => void;
  /** Bump-counter open request, plus optional target mode. Null after consumed. */
  openRequest: { id: number; mode: 'bar' | 'side' } | null;
  /** Page calls this to ask the sidecar to pop open. */
  requestSidecarOpen: (mode?: 'bar' | 'side') => void;
  /** Sidecar-side: clear the open request after honoring it. */
  consumeOpenRequest: () => void;
  /** Latest pending handoff from sidecar to page; null after consumed. */
  pageHandoff: PageHandoff | null;
  /** Sidecar-side: push the user's latest message into the inline ChatBox. */
  handoffToPage: (text: string) => void;
  /** Page-side: clear the handoff after injecting it. */
  consumePageHandoff: () => void;
  /** Whether the floating sidecar's chat request is currently in flight.
   *  The sidecar mirrors its own internal `pending` state here so the
   *  cool-tour runner can await chat-idle before firing the next
   *  seedPrompt — handleSubmit drops new prompts when pending=true, which
   *  would silently skip an actAsUser step and leave later narrations
   *  playing with no AI work behind them. */
  chatPending: boolean;
  /** Sidecar-side: mirror handleSubmit pending into the context. */
  setChatPending: (next: boolean) => void;
  /** Bump-counter mic-on request. The sidecar starts dictation on rising id. */
  micRequest: { id: number } | null;
  /** Page-side: ask the sidecar to flip the mic on (only effective after the
   *  sidecar is open and dictation is supported). Typical pairing is
   *  requestSidecarOpen('side') + seedPrompt(...) + requestMicOn(). */
  requestMicOn: () => void;
  /** Sidecar-side: clear the queued mic request after honoring it. */
  consumeMicRequest: () => void;
}

const Ctx = createContext<AssistantContextValue | null>(null);

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [pageContext, setPageContextState] = useState<PageContext | null>(null);
  const [seededPrompt, setSeededPrompt] = useState<SeededPrompt | null>(null);
  // Page → assistant event channel: a page reports an in-flow step (e.g. the
  // user clicked "Generate previews") and the sidecar — when open — feeds it to
  // the assistant (hidden) so it reacts in context.
  const [pageEvent, setPageEvent] = useState<{ id: number; text: string } | null>(null);
  const pageEventIdRef = useRef(0);
  const [chatChannel, setChatChannelState] = useState<ChatChannel>('default');
  const [openRequest, setOpenRequest] = useState<{ id: number; mode: 'bar' | 'side' } | null>(null);
  const [pageHandoff, setPageHandoff] = useState<PageHandoff | null>(null);
  const [micRequest, setMicRequest] = useState<{ id: number } | null>(null);
  const micIdRef = useRef(0);
  const [pushedNarration, setPushedNarration] = useState<PushedNarration | null>(null);
  const [pushedInvoiceCard, setPushedInvoiceCard] = useState<PushedInvoiceCard | null>(null);
  const [pinnedRule, setPinnedRule] = useState<PinnedRuleCard | null>(null);
  const [pinnedContact, setPinnedContact] = useState<PinnedContactCard | null>(null);
  const [coolTourActive, setCoolTourActive] = useState(false);
  const [regularTourActive, setRegularTourActive] = useState(false);
  /** Single source of truth for tour pause state. Both runners read it
   *  (mirror to their own pausedRef for the step machine) and both can
   *  set it. The sidecar header's Pause button + the runner's own
   *  Pause pill + the regular-tour interjection logic all share this. */
  const [tourPaused, setTourPausedState] = useState(false);
  const [chatPending, setChatPendingState] = useState(false);
  const handlersRef = useRef(new Map<string, ClientActionHandler>());
  const onboardingHandlerRef = useRef<OnboardingToolResultHandler | null>(null);
  // Set so multiple subscribers (e.g. a tour runner + a debug logger) can
  // coexist; the existing onboarding handler is single-slot because only one
  // OnboardingPanel ever mounts, but the generic channel needs fan-out.
  const toolResultHandlersRef = useRef(new Set<ToolResultHandler>());
  // Tour-interjection hooks: the sidecar fires these when the user submits
  // a chat message and when the resulting AI reply finishes streaming.
  // The regular-tour runner subscribes so it can auto-pause on a question
  // and prompt "Ready to move on?" once the answer lands.
  const userInterjectionHandlersRef = useRef(new Set<(text: string) => void>());
  const replyCompleteHandlersRef = useRef(new Set<() => void>());
  // "Ask a question" header button in the sidecar fires this; the active
  // tour runner subscribes and handles it (pause + push a "what's up?"
  // narration). One bus for both cool tour + regular tour.
  const askQuestionHandlersRef = useRef(new Set<() => void>());
  const seedIdRef = useRef(0);
  const openIdRef = useRef(0);
  const handoffIdRef = useRef(0);
  const narrationIdRef = useRef(0);
  const invoiceCardIdRef = useRef(0);

  const setPageContext = useCallback((ctx: PageContext | null) => {
    setPageContextState(ctx);
  }, []);

  const registerClientAction = useCallback((name: string, handler: ClientActionHandler) => {
    handlersRef.current.set(name, handler);
    return () => {
      // Only delete if this exact handler is still the current one — prevents
      // a stale unmount from clobbering a fresh registration.
      if (handlersRef.current.get(name) === handler) handlersRef.current.delete(name);
    };
  }, []);

  const dispatchClientAction = useCallback(async (name: string, args: Record<string, unknown>) => {
    const handler = handlersRef.current.get(name);
    if (!handler) {
      // Not registered — page likely doesn't expose this action. Silent
      // no-op; the AI will get the server-side result regardless.
      return;
    }
    await handler(args);
  }, []);

  const seedPrompt = useCallback(
    (text: string, opts?: { mode?: 'bar' | 'side'; actingAsYou?: boolean; hidden?: boolean }) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      seedIdRef.current += 1;
      setSeededPrompt({
        id: seedIdRef.current,
        text: trimmed,
        mode: opts?.mode,
        actingAsYou: opts?.actingAsYou,
        hidden: opts?.hidden,
      });
    },
    [],
  );

  const consumeSeededPrompt = useCallback(() => setSeededPrompt(null), []);

  const notifyAssistant = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    pageEventIdRef.current += 1;
    setPageEvent({ id: pageEventIdRef.current, text: trimmed });
  }, []);
  const consumePageEvent = useCallback(() => setPageEvent(null), []);

  const setChatChannel = useCallback((channel: ChatChannel) => {
    setChatChannelState(channel);
  }, []);

  const registerOnboardingToolResultHandler = useCallback(
    (handler: OnboardingToolResultHandler) => {
      onboardingHandlerRef.current = handler;
      return () => {
        if (onboardingHandlerRef.current === handler) onboardingHandlerRef.current = null;
      };
    },
    [],
  );

  const dispatchOnboardingToolResult = useCallback((view: Record<string, unknown>) => {
    onboardingHandlerRef.current?.(view);
  }, []);

  const registerToolResultHandler = useCallback((handler: ToolResultHandler) => {
    toolResultHandlersRef.current.add(handler);
    return () => {
      toolResultHandlersRef.current.delete(handler);
    };
  }, []);

  const dispatchToolResult = useCallback((name: string, output: unknown) => {
    // The assistant can take the user to an in-app page (e.g. "yes, finish
    // onboarding" → the onboarding wizard). Same-origin paths only.
    if (name === 'open_app_page') {
      const path = (output as { path?: unknown })?.path;
      // isAllowedAppPath rejects hallucinated routes (checks pathname, allows query).
      if (isAllowedAppPath(path)) router.push(path);
    }
    for (const handler of toolResultHandlersRef.current) {
      try {
        handler(name, output);
      } catch (err) {
        // A misbehaving handler shouldn't break the others -- they may be
        // unrelated subscribers (tour runner + future analytics).
        console.warn('[assistant] tool-result handler threw', err);
      }
    }
  }, [router]);

  const registerUserInterjectionHandler = useCallback(
    (handler: (text: string) => void) => {
      userInterjectionHandlersRef.current.add(handler);
      return () => {
        userInterjectionHandlersRef.current.delete(handler);
      };
    },
    [],
  );

  const dispatchUserInterjection = useCallback((text: string) => {
    for (const handler of userInterjectionHandlersRef.current) {
      try {
        handler(text);
      } catch (err) {
        console.warn('[assistant] interjection handler threw', err);
      }
    }
  }, []);

  const registerReplyCompleteHandler = useCallback((handler: () => void) => {
    replyCompleteHandlersRef.current.add(handler);
    return () => {
      replyCompleteHandlersRef.current.delete(handler);
    };
  }, []);

  const dispatchReplyComplete = useCallback(() => {
    for (const handler of replyCompleteHandlersRef.current) {
      try {
        handler();
      } catch (err) {
        console.warn('[assistant] reply-complete handler threw', err);
      }
    }
  }, []);

  const pushNarration = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    narrationIdRef.current += 1;
    setPushedNarration({ id: narrationIdRef.current, text: trimmed });
  }, []);

  const consumePushedNarration = useCallback(() => setPushedNarration(null), []);

  const pushInvoiceCard = useCallback((invoice: Record<string, unknown>, text?: string) => {
    invoiceCardIdRef.current += 1;
    setPushedInvoiceCard({ id: invoiceCardIdRef.current, text, invoice });
  }, []);

  const consumePushedInvoiceCard = useCallback(() => setPushedInvoiceCard(null), []);

  const startCoolTour = useCallback(() => {
    setCoolTourActive(true);
    setTourPausedState(false);
  }, []);
  const endCoolTour = useCallback(() => {
    setCoolTourActive(false);
    setTourPausedState(false);
  }, []);
  const startRegularTour = useCallback(() => {
    setRegularTourActive(true);
    setTourPausedState(false);
  }, []);
  const endRegularTour = useCallback(() => {
    setRegularTourActive(false);
    setTourPausedState(false);
  }, []);
  const setTourPaused = useCallback((next: boolean) => {
    setTourPausedState(next);
    // Cancel in-flight speech the instant a pause flips on so the user
    // hears immediate feedback. Both runners do this too but they only
    // fire when their own state changes — doing it here covers
    // sidecar-triggered pauses without round-tripping through them.
    if (next && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const registerAskQuestionHandler = useCallback((handler: () => void) => {
    askQuestionHandlersRef.current.add(handler);
    return () => {
      askQuestionHandlersRef.current.delete(handler);
    };
  }, []);

  const requestAskQuestion = useCallback(() => {
    for (const handler of askQuestionHandlersRef.current) {
      try {
        handler();
      } catch (err) {
        console.warn('[assistant] ask-question handler threw', err);
      }
    }
  }, []);

  const setChatPending = useCallback((next: boolean) => {
    setChatPendingState(next);
  }, []);

  const requestSidecarOpen = useCallback((mode: 'bar' | 'side' = 'bar') => {
    openIdRef.current += 1;
    setOpenRequest({ id: openIdRef.current, mode });
  }, []);

  const consumeOpenRequest = useCallback(() => setOpenRequest(null), []);

  const handoffToPage = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    handoffIdRef.current += 1;
    setPageHandoff({ id: handoffIdRef.current, text: trimmed });
  }, []);

  const consumePageHandoff = useCallback(() => setPageHandoff(null), []);

  const requestMicOn = useCallback(() => {
    micIdRef.current += 1;
    setMicRequest({ id: micIdRef.current });
  }, []);
  const consumeMicRequest = useCallback(() => setMicRequest(null), []);

  const value = useMemo<AssistantContextValue>(
    () => ({
      pageContext,
      setPageContext,
      registerClientAction,
      dispatchClientAction,
      seededPrompt,
      seedPrompt,
      consumeSeededPrompt,
      pageEvent,
      notifyAssistant,
      consumePageEvent,
      chatChannel,
      setChatChannel,
      registerOnboardingToolResultHandler,
      dispatchOnboardingToolResult,
      registerToolResultHandler,
      dispatchToolResult,
      registerUserInterjectionHandler,
      dispatchUserInterjection,
      registerReplyCompleteHandler,
      dispatchReplyComplete,
      pushedNarration,
      pushNarration,
      consumePushedNarration,
      pushedInvoiceCard,
      pushInvoiceCard,
      consumePushedInvoiceCard,
      coolTourActive,
      startCoolTour,
      endCoolTour,
      regularTourActive,
      startRegularTour,
      endRegularTour,
      tourPaused,
      setTourPaused,
      requestAskQuestion,
      registerAskQuestionHandler,
      openRequest,
      requestSidecarOpen,
      consumeOpenRequest,
      pageHandoff,
      handoffToPage,
      consumePageHandoff,
      chatPending,
      setChatPending,
      micRequest,
      requestMicOn,
      consumeMicRequest,
      pinnedRule,
      setPinnedRule,
      pinnedContact,
      setPinnedContact,
}),
    [
      pageContext,
      setPageContext,
      registerClientAction,
      dispatchClientAction,
      seededPrompt,
      seedPrompt,
      consumeSeededPrompt,
      pageEvent,
      notifyAssistant,
      consumePageEvent,
      chatChannel,
      setChatChannel,
      registerOnboardingToolResultHandler,
      dispatchOnboardingToolResult,
      registerToolResultHandler,
      dispatchToolResult,
      registerUserInterjectionHandler,
      dispatchUserInterjection,
      registerReplyCompleteHandler,
      dispatchReplyComplete,
      pushedNarration,
      pushNarration,
      consumePushedNarration,
      pushedInvoiceCard,
      pushInvoiceCard,
      consumePushedInvoiceCard,
      coolTourActive,
      startCoolTour,
      endCoolTour,
      regularTourActive,
      startRegularTour,
      endRegularTour,
      tourPaused,
      setTourPaused,
      requestAskQuestion,
      registerAskQuestionHandler,
      openRequest,
      requestSidecarOpen,
      consumeOpenRequest,
      pageHandoff,
      handoffToPage,
      consumePageHandoff,
      chatPending,
      setChatPending,
      micRequest,
      requestMicOn,
      consumeMicRequest,
      pinnedRule,
      setPinnedRule,
      pinnedContact,
      setPinnedContact,
],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAssistant(): AssistantContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAssistant must be used inside <AssistantProvider>');
  return v;
}
