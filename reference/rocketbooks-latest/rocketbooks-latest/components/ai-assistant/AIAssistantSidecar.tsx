'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useAssistant } from './AssistantContext';
import { useDictation } from './useDictation';
import { useTextToSpeech, type TtsApi } from './useTextToSpeech';
import { isTourMutedNow, useTourMuted } from './useTourMuted';
import { InvoicePreview, type InvoiceDraftView } from '@/app/(app)/ai-chat/_components/InvoicePreview';
import { CoaAccountCard, type CoaAccountView } from './CoaAccountCard';
import { RulePinnedCard } from './RulePinnedCard';
import { ContactPinnedCard } from './ContactPinnedCard';
import { SplitReturnBar } from './SplitReturnBar';
import { GUIDED_REVIEW_URLS, GUIDED_REVIEW_LABELS } from '@/lib/transactions/guided-review-urls';
import { DepositMatchCard, type DepositMatchView } from './DepositMatchCard';
import type { SuggestionChip } from '@/lib/ai/client-context';
import { isAllowedAppPath } from '@/lib/ai/app-routes';
import { normalizeLanguage } from '@/lib/i18n/languages';
import { TextPreview, type TextDraftView } from '@/components/cards/TextPreview';
import {
  OrganizerEmailCard,
  type OrganizerEmailDraftView,
  type OrganizerEmailSentView,
} from '@/components/ai-assistant/OrganizerEmailCard';
import {
  VideoInviteCard,
  type VideoInviteDraftView,
  type VideoInviteSentView,
} from '@/components/ai-assistant/VideoInviteCard';
import {
  SignatureRequestCard,
  type SignatureDraftView,
  type SignatureSentView,
} from '@/components/ai-assistant/SignatureRequestCard';
import {
  SendDocumentCard,
  type SendDocumentDraftView,
  type SendDocumentSentView,
} from '@/components/ai-assistant/SendDocumentCard';

type Mode = 'closed' | 'bar' | 'side';

/** The six "what is this deposit?" actions shown in the sidecar during deposit
 *  guided review. Clicking a chip sends its prompt as a normal chat message, so
 *  typing the same thing in works identically — no special button engine. */
const DEPOSIT_GUIDE_CHIPS: { label: string; prompt: string }[] = [
  {
    label: 'Transfer',
    prompt:
      'This deposit is an internal transfer between my own accounts. Call find_transfer_counterpart to find which of my accounts it came from, then tell me. Remember transfers are not income — don’t post a P&L entry.',
  },
  {
    label: 'Loan',
    prompt:
      'This deposit is a loan. Help me figure out which contact/lender it came from, check (via list_accounts) whether there’s already a loan sub-account named for them under our notes-payable/loan account, and book it there — creating that sub-account named for the lender if there isn’t one. A loan is a liability, not income.',
  },
  {
    label: 'Capitalization',
    prompt:
      'This deposit is a capital contribution. Help me figure out which contributor it came from, check whether there’s an equity sub-account named for them, and book it to that equity account — creating the sub-account named for the contributor if needed. It’s equity, not income.',
  },
  {
    label: 'Income',
    prompt:
      'This deposit is income. Call find_matching_invoice to check whether it pays an open invoice for that customer — if it matches, it’s a payment against that invoice (A/R), not fresh income. Otherwise figure out which income account it belongs to and categorize it.',
  },
  {
    label: 'Refund',
    prompt:
      'This deposit is a refund of a prior expense. Help me book it back against the original expense account it came from, not as income.',
  },
  {
    label: 'Split deposit',
    prompt:
      'This deposit needs to be split across multiple categories. Call open_transaction with split=true to open it directly in split mode, then ask me what each portion is for and walk me through entering each split line.',
  },
];

/** Which page-specific opener to fetch. Pages without a custom opener use the
 * generic books-grounded greeting ('home'). */
function openerPageKey(pathname: string | null): string {
  if (pathname?.startsWith('/enterprise')) return 'enterprise';
  if (pathname === '/organizer/dashboard' || pathname === '/organizer') return 'organizerdashboard';
  if (pathname === '/invoices' || pathname?.startsWith('/invoices/')) return 'invoices';
  if (pathname === '/bills' || pathname?.startsWith('/bills/')) return 'bills';
  if (pathname === '/transactions' || pathname?.startsWith('/transactions/')) return 'transactions';
  if (pathname === '/reports/form-1099') return 'form1099';
  if (pathname === '/reports' || pathname?.startsWith('/reports/')) return 'reports';
  if (pathname === '/reconciliation' || pathname?.startsWith('/reconciliation/')) return 'reconciliation';
  if (pathname === '/substantiation' || pathname?.startsWith('/substantiation/')) return 'substantiation';
  if (pathname === '/year-end-close') return 'yearend';
  if (pathname === '/imports' || pathname?.startsWith('/imports/')) return 'imports';
  if (pathname === '/receipts' || pathname?.startsWith('/receipts/')) return 'receipts';
  if (pathname === '/pulse') return 'pulse';
  if (pathname === '/tasks' || pathname?.startsWith('/tasks/')) return 'tasks';
  if (pathname === '/payments' || pathname?.startsWith('/payments/')) return 'payments';
  if (pathname === '/contacts' || pathname?.startsWith('/contacts/')) return 'contacts';
  if (pathname === '/integrations/plaid') return 'bankconnections';
  if (pathname === '/integrations/qbo') return 'qbo';
  if (pathname === '/plaid-feed') return 'plaidfeed';
  if (pathname === '/connections/communications') return 'communications';
  if (pathname === '/assets' || pathname?.startsWith('/assets/')) return 'assets';
  if (pathname === '/loans' || pathname?.startsWith('/loans/')) return 'loans';
  if (pathname === '/inventory') return 'inventory';
  if (pathname === '/tags' || pathname?.startsWith('/tags/')) return 'tags';
  if (pathname === '/rental-properties' || pathname?.startsWith('/rental-properties/')) return 'rentalproperties';
  if (pathname === '/book-review') return 'bookreview';
  if (pathname === '/period-close') return 'periodclose';
  if (pathname === '/chart-of-accounts') return 'chartofaccounts';
  if (pathname === '/journal-entries' || pathname?.startsWith('/journal-entries/')) return 'journalentries';
  if (pathname === '/general-ledger') return 'generalledger';
  return 'home';
}

/** Return URL with guideIndex advanced by one — used by the split screen's
 *  "Skip & back" so a skipped (unsaved) deposit isn't re-asked. */
function bumpGuideIndex(url: string): string {
  const [path, query = ''] = url.split('?');
  const params = new URLSearchParams(query);
  const cur = parseInt(params.get('guideIndex') ?? '0', 10) || 0;
  params.set('guideIndex', String(cur + 1));
  return `${path}?${params.toString()}`;
}

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolEvents?: Array<{ name: string; ok?: boolean }>;
  /**
   * Latest invoice draft snapshot produced by save_invoice_draft / post_invoice
   * during this turn. Rendered as an InvoicePreview card below the message.
   * The same `draftId` overwrites earlier states so post → posted swap is
   * automatic.
   */
  invoice?: InvoiceDraftView;
  /**
   * Chart-of-accounts entries created during this turn (via create_chart_account).
   * One turn can create multiple — each renders as its own card below the
   * assistant message.
   */
  coaAccounts?: CoaAccountView[];
  /**
   * Text messages sent during this turn (via send_text_to_contact). Each
   * renders as a TextPreview card below the assistant message.
   */
  texts?: TextDraftView[];
  /** A find_transfer_counterpart / find_matching_invoice match surfaced as a
   *  compact card below the assistant message (deposit-review visual aid). */
  depositMatch?: DepositMatchView;
  /**
   * Organizer AI email action: a draft (draft_organizer_email) renders a
   * confirm card with Send/Cancel; a sent result (send_organizer_email)
   * renders the completion directly.
   */
  organizerEmailDraft?: OrganizerEmailDraftView;
  organizerEmailSent?: OrganizerEmailSentView;
  /** Organizer AI video-call invite: draft (confirm + Join) / sent (completion). */
  videoInviteDraft?: VideoInviteDraftView;
  videoInviteSent?: VideoInviteSentView;
  /** Organizer AI send-for-signature: draft (confirm) / sent (completion). */
  signatureDraft?: SignatureDraftView;
  signatureSent?: SignatureSentView;
  /** Organizer AI send-document: draft (confirm) / sent (completion). */
  sendDocumentDraft?: SendDocumentDraftView;
  sendDocumentSent?: SendDocumentSentView;
  /**
   * True when the user message was injected by the cool-tour runner (via
   * seedPrompt with actingAsYou=true). Renders a 🎬 "acting as you" badge
   * next to the bubble so the user knows the AI typed it on their behalf.
   */
  actingAsYou?: boolean;
  /**
   * True when this user turn was seeded with `hidden` — it's sent to the model
   * as the first user message (to trigger + instruct the turn) but is filtered
   * out of the rendered thread so the user never sees the instruction text.
   */
  hidden?: boolean;
  /**
   * True when this assistant message was pushed by the cool-tour runner
   * via pushNarration() rather than streamed from the chat API. Used to
   * suppress the tool-event slot and TTS double-speak guards if needed.
   */
  pushedNarration?: boolean;
}

const MODE_KEY = 'rs_ai_sidecar_mode';

export function AIAssistantSidecar({ orgId }: { orgId?: string } = {}) {
  const {
    pageContext,
    registerClientAction,
    dispatchClientAction,
    seededPrompt,
    consumeSeededPrompt,
    pageEvent,
    consumePageEvent,
    chatChannel,
    dispatchOnboardingToolResult,
    dispatchToolResult,
    pushedNarration,
    consumePushedNarration,
    pushedInvoiceCard,
    consumePushedInvoiceCard,
    coolTourActive,
    regularTourActive,
    tourPaused,
    setTourPaused,
    requestAskQuestion,
    openRequest,
    consumeOpenRequest,
    micRequest,
    consumeMicRequest,
    pinnedRule,
    setPinnedRule,
    pinnedContact,
    setPinnedContact,
    handoffToPage,
    dispatchUserInterjection,
    dispatchReplyComplete,
    setChatPending,
  } = useAssistant();
  const router = useRouter();
  // When the AI opens a deposit in split mode from a guided review, remember the
  // review URL so the split screen can show "back to review" buttons (the model
  // is unreliable at navigating back on its own).
  const [splitReturn, setSplitReturn] = useState<string | null>(null);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const onGuidedOnboardingRoute = pathname === '/ai-chat' && searchParams.get('onboarding') === 'start';
  // Clear the pinned rule/contact cards when the user navigates to a different page.
  const prevPinnedPathRef = useRef(pathname);
  useEffect(() => {
    if (prevPinnedPathRef.current !== pathname) {
      prevPinnedPathRef.current = pathname;
      setPinnedRule(null);
      setPinnedContact(null);
    }
  }, [pathname]);

  // Derive the split-return target from the URL (?mode=split&returnTo=…) so the
  // back-to-review bar survives a reload + direct navigation, not just an
  // in-session navigate. Re-reads whenever the pathname changes.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    setSplitReturn(sp.get('mode') === 'split' ? sp.get('returnTo') : null);
  }, [pathname]);
  // /ai-chat hosts its own full-fidelity inline ChatBox that looks identical
  // to this floating surface — rendering both would show two identical chats
  // on the same page. We hide entirely while on that route. State (turns,
  // mode) is preserved because the component stays mounted via the (app)
  // layout, so navigating back to another page restores the bar in whatever
  // state the user left it.
  const onAiChatRoute = pathname === '/ai-chat';
  // Mode must START at the SSR-safe default ('closed') so the first client render
  // matches the server — reading localStorage during the initial render (lazy init)
  // caused a hydration mismatch on hard page loads where a prior session had stored
  // 'side'/'bar' (the server has no localStorage). We restore the stored mode in an
  // effect right after mount instead (below). Soft navigations keep the live `mode`
  // because the component stays mounted via the layout.
  const [mode, setMode] = useState<Mode>('closed');
  // Until the post-mount restore runs, don't let the persist effect write 'closed'
  // back over a stored 'side'/'bar'.
  const modeRestoredRef = useRef(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  // Proactive opener — the same books-grounded greeting + chips the /ai-chat
  // page leads with, fetched from /api/ai/opener the first time the sidecar
  // opens (once per session) and injected as the first assistant turn.
  const [openerGreeting, setOpenerGreeting] = useState<string | null>(null);
  const [openerChips, setOpenerChips] = useState<SuggestionChip[]>([]);
  const openerFetchedRef = useRef<string | null>(null);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Floating-bar mode shows only the most recent turn by default. "Show more"
  // expands to the full history. Reset on every new send so the user sees
  // the latest answer first.
  const [barExpanded, setBarExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Bar-mode root — measured so we can push --rs-sidecar-bar-height onto
  // <body> and let CSS reserve scroll room below the page content. Side
  // mode doesn't need this (it's full-height and uses padding-right instead).
  const barRef = useRef<HTMLDivElement>(null);
  // Stable handle for the dictation auto-submit hook — handleSubmit is
  // declared further down and rebound every render.
  const submitRef = useRef<() => void>(() => {});
  // Mirror of `turns` so the `navigate` client-action closure can read the
  // latest user message at fire time without re-registering the action on
  // every turn change. Used for the /ai-chat handoff.
  const turnsRef = useRef<ChatTurn[]>([]);

  const dictation = useDictation({
    input,
    setInput,
    pending,
    onAutoSubmit: () => submitRef.current(),
  });
  const tts = useTextToSpeech();
  // Track which assistant turn we've already auto-spoken so a re-render of
  // the same content doesn't re-trigger speech.
  const autoSpokenIdRef = useRef<string | null>(null);

  // Post-mount: restore the mode the user left the sidecar in last session. Runs once
  // after the first (SSR-matching) render, so it can't cause a hydration mismatch.
  useEffect(() => {
    const stored = window.localStorage.getItem(MODE_KEY);
    if (stored === 'side' || stored === 'bar') setMode(stored);
    modeRestoredRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist mode changes — but only after the restore above, so the initial 'closed'
  // render doesn't overwrite a stored 'side'/'bar' before we've read it.
  useEffect(() => {
    if (!modeRestoredRef.current) return;
    window.localStorage.setItem(MODE_KEY, mode);
  }, [mode]);

  // On /ai-chat the sidecar render returns null but the component stays
  // mounted (it lives in the (app) layout). That means useDictation's
  // SpeechRecognition session and any in-flight TTS would keep running
  // invisibly — leaving the tab mic indicator lit and double-capturing audio
  // alongside the inline ChatBox's own mic. Shut them down on entry.
  useEffect(() => {
    if (!onAiChatRoute) return;
    if (dictation.listening) dictation.stop();
    if (tts.speaking) tts.stop();
  }, [onAiChatRoute, dictation, tts]);

  // While in side mode, mark <body> so globals.css can push the rest of the
  // page over by 380px — otherwise the panel covers data on the right. The
  // /ai-chat route hides the sidecar entirely, so treat it like 'closed' here
  // to avoid reserving gutter space for a panel that won't render.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const cls = 'rs-sidecar-side';
    if (mode === 'side' && !onAiChatRoute) document.body.classList.add(cls);
    else document.body.classList.remove(cls);
    return () => document.body.classList.remove(cls);
  }, [mode, onAiChatRoute]);

  // While in bar mode, mark <body> for the bottom-padding rule AND keep a
  // CSS variable in sync with the bar's actual rendered height so the
  // padding tracks "Show more" expansions, growing chat history, etc.
  // Otherwise the bar can sit on top of page content the user wants to
  // scroll to (e.g. the bottom of the onboarding panel). Same /ai-chat carve
  // out as the side-mode effect above.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const cls = 'rs-sidecar-bar';
    const varName = '--rs-sidecar-bar-height';
    if (mode !== 'bar' || onAiChatRoute) {
      document.body.classList.remove(cls);
      document.body.style.removeProperty(varName);
      return;
    }
    document.body.classList.add(cls);
    const el = barRef.current;
    if (!el) return;
    const update = () => {
      document.body.style.setProperty(varName, `${el.offsetHeight}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.body.classList.remove(cls);
      document.body.style.removeProperty(varName);
    };
  }, [mode, onAiChatRoute]);

  // Auto-scroll to bottom on new turns.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  // Keep the turnsRef synchronized so non-reactive consumers (the navigate
  // client-action closure) can read the latest user turn at fire time.
  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  // Mirror handleSubmit's pending state into the assistant context so the
  // cool-tour runner can await chat-idle before firing the next seedPrompt.
  // Without this, a slow chat turn (>8s) causes the runner to fire the next
  // seedPrompt while pending is still true; handleSubmit drops it and the
  // step's AI action silently skips while later narrations keep playing.
  useEffect(() => {
    setChatPending(pending);
  }, [pending, setChatPending]);

  // Focus the input when the panel opens.
  useEffect(() => {
    if (mode !== 'closed') {
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [mode]);

  // Auto-speak completed assistant turns. Fires once per assistant turn --
  // we tag each spoken turn id in a ref so re-renders don't replay the same
  // message. During the cool tour, the speaker icon is the master mute: AI
  // replies (to actAsUser prompts) speak regardless of the user's autoSpeak
  // preference, and only the tour-mute toggle silences them. Outside the
  // tour, the user's autoSpeak preference applies as usual.
  useEffect(() => {
    if (pending) return;
    // During either tour, the tour-mute toggle is the master gate; the
    // user's autoSpeak preference is overridden so AI replies always
    // speak unless explicitly muted. Outside a tour, respect autoSpeak.
    if (coolTourActive || regularTourActive) {
      if (isTourMutedNow()) return;
    } else {
      if (!tts.autoSpeak) return;
    }
    const last = turns[turns.length - 1];
    if (!last || last.role !== 'assistant' || !last.content.trim()) return;
    // Pushed narrations (cool/regular tour) are spoken by the pushedNarration
    // effect at the moment they're appended. Speaking again here cancels the
    // in-flight utterance, and Chrome's cancel→speak race then silently drops
    // the replacement — narration dies a couple of words in.
    if (last.pushedNarration) {
      autoSpokenIdRef.current = last.id;
      return;
    }
    if (autoSpokenIdRef.current === last.id) return;
    autoSpokenIdRef.current = last.id;
    tts.speak(stripSuggestions(last.content));
  }, [pending, turns, tts, coolTourActive, regularTourActive]);

  // Built-in client actions every page gets for free.
  useEffect(() => {
    const offRefresh = registerClientAction('refresh_page', () => {
      router.refresh();
    });
    const offOpenTxn = registerClientAction('open_transaction', (args) => {
      const id = String(args.transactionId ?? '');
      if (id) router.push(`/transactions/${id}`);
    });
    const offNavigate = registerClientAction('navigate', (args) => {
      let path = typeof args.path === 'string' ? args.path : '';
      // isAllowedAppPath checks the pathname (allows query strings like
      // ?onboarding=start) and silently ignores hallucinated routes → no 404.
      if (!isAllowedAppPath(path)) return;
      // Opening split mode from a guided review → carry the review URL IN the
      // split URL (?returnTo=…) so the back-to-review bar is DERIVED from the URL
      // and survives a reload, instead of fragile local state.
      if (path.includes('mode=split') && typeof window !== 'undefined') {
        const here = window.location.pathname + window.location.search;
        if (here.includes('guide=1')) {
          path += `${path.includes('?') ? '&' : '?'}returnTo=${encodeURIComponent(here)}`;
        }
      }
      // Going to /ai-chat means the user is about to see the inline ChatBox
      // instead of this floating surface. Forward their last user turn so the
      // conversation continues there rather than vanishing with the bar.
      if (path === '/ai-chat') {
        const recentUser = [...turnsRef.current].reverse().find((t) => t.role === 'user');
        if (recentUser?.content.trim()) handoffToPage(recentUser.content);
      }
      router.push(path);
    });
    // Open a client's books (firm assistant): a FULL browser navigation to the
    // open-books route handler, which sets the impersonation session server-side
    // then redirects into the books. router.push can't do this (it's an /api route
    // + a new httpOnly session needs a real load).
    const offOpenBooks = registerClientAction('open_client_books', (args) => {
      const path = typeof args.path === 'string' ? args.path : '';
      if (!path.startsWith('/api/enterprise/open-books')) return;
      if (typeof window !== 'undefined') window.location.href = path;
    });
    return () => {
      offRefresh();
      offOpenTxn();
      offNavigate();
      offOpenBooks();
    };
  }, [registerClientAction, router, handoffToPage]);

  async function handleSubmit(e?: FormEvent, overrideText?: string, opts?: { actingAsYou?: boolean; hidden?: boolean }) {
    e?.preventDefault();
    // overrideText lets `seedPrompt` push a message without depending on the
    // current `input` state — clicking an Explain button submits exactly the
    // prompt the page passed, even if the user has typing in progress.
    const text = (overrideText ?? input).trim();
    if (!text || pending) {
      console.warn('[sidecar] handleSubmit DROPPED', { reason: !text ? 'empty text' : 'pending=true', textLen: text.length, pending, actingAsYou: opts?.actingAsYou });
      return;
    }
    console.info('[sidecar] handleSubmit START', { text: text.slice(0, 60), actingAsYou: opts?.actingAsYou });
    // Reset the dictation buffer so the next spoken phrase starts a fresh
    // message — but keep the mic open. Mirrors the ai-chat ChatBox behavior:
    // user can talk continuously, each pause auto-sends, no need to re-click.
    dictation.reset();
    // Cut off any in-progress TTS so the assistant doesn't keep reading the
    // previous answer over the new one.
    if (tts.speaking) tts.stop();

    const userTurn: ChatTurn = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      actingAsYou: opts?.actingAsYou,
      hidden: opts?.hidden,
    };
    const assistantTurn: ChatTurn = {
      id: `a-${Date.now()}`,
      role: 'assistant',
      content: '',
      toolEvents: [],
    };
    setTurns((t) => [...t, userTurn, assistantTurn]);
    setInput('');
    setPending(true);
    setError(null);

    // New turn → collapse history view so the answer starts on a clean slate.
    setBarExpanded(false);

    // Let the regular tour (if running) know the user interjected. The
    // runner will auto-pause the tour so the Q&A can play out, then push
    // a "Ready to move on?" prompt once dispatchReplyComplete fires below.
    dispatchUserInterjection(text);

    try {
      // Drop turns with empty content before sending. The assistant
      // placeholder we push synchronously (just below) and any prior
      // placeholders left behind by failed requests would otherwise violate
      // the chat endpoint's Zod content.min(1) and cascade 400s into every
      // subsequent request.
      const history = [...turns, userTurn]
        .map((t) => ({ role: t.role, content: t.content }))
        .filter((m) => m.content.trim().length > 0);
      // Onboarding channel routes to /api/ai/chat — that endpoint owns the
      // onboarding system prompt + get_onboarding_status/set_business_info/
      // advance_onboarding tools that the AI uses to walk a new user through
      // the 6 phases. It doesn't accept pageContext; tools are pre-baked.
      // Everything else (the normal "filter this page" use case) keeps
      // hitting /api/ai/assistant/chat with the page tool surface.
      const onboardingMode = chatChannel === 'onboarding';
      const endpoint = onboardingMode ? '/api/ai/chat' : '/api/ai/assistant/chat';
      const language = normalizeLanguage(window.localStorage.getItem('rs_language'));
      const body = onboardingMode
        ? { messages: history, language }
        : {
            messages: history,
            language,
            // The accounting basis the user is currently viewing (report
            // Accrual/Cash toggle lives in the URL as ?basis=). Read live at
            // submit time so get_period_pnl mirrors exactly what's on screen;
            // null → the org's default method.
            viewBasis:
              typeof window !== 'undefined' &&
              ['cash', 'accrual'].includes(new URLSearchParams(window.location.search).get('basis') ?? '')
                ? (new URLSearchParams(window.location.search).get('basis') as 'cash' | 'accrual')
                : null,
            pageContext: pageContext
              ? {
                  pageId: pageContext.pageId,
                  pageTitle: pageContext.pageTitle,
                  route: pageContext.route,
                  data: pageContext.data,
                  toolNames: pageContext.toolNames,
                }
              : null,
          };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      console.info('[sidecar] fetch response', res.status, res.ok ? 'OK' : 'FAIL', { hasBody: !!res.body });
      if (!res.ok || !res.body) {
        const errorRef = res.headers.get('X-RocketSuite-Request-Id');
        const msg = res.status === 401 ? 'Please sign in.' : `Request failed (${res.status})${errorRef ? ` Reference: ${errorRef}` : ''}`;
        console.error('[sidecar] handleSubmit ABORT', { status: res.status, msg });
        setError(msg);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }

          if (typeof evt.delta === 'string') {
            const delta = evt.delta;
            setTurns((all) =>
              all.map((t) => (t.id === assistantTurn.id ? { ...t, content: t.content + delta } : t)),
            );
          } else if (evt.tool_use && typeof evt.tool_use === 'object') {
            const tu = evt.tool_use as { name?: string };
            if (tu.name) {
              setTurns((all) =>
                all.map((t) =>
                  t.id === assistantTurn.id
                    ? { ...t, toolEvents: [...(t.toolEvents ?? []), { name: tu.name! }] }
                    : t,
                ),
              );
            }
          } else if (evt.tool_result && typeof evt.tool_result === 'object') {
            const tr = evt.tool_result as { name?: string; ok?: boolean; output?: unknown };
            // Broadcast every successful tool result on the generic channel so
            // outside subscribers (cool-tour runner, future analytics) can
            // await specific tools by name. Onboarding gets its own dispatch
            // below so the OnboardingPanel keeps its existing contract.
            if (tr.name) {
              console.info('[sidecar] tool', tr.name, tr.ok ? '✓ ok' : '✕ failed');
            }
            if (tr.ok && tr.name) {
              dispatchToolResult(tr.name, tr.output);
              // The pinned cards are resolved once the AI creates a rule, aligns
              // the contact, or ushers the user back — clear them.
              if (tr.name === 'create_categorization_rule' || tr.name === 'restore_view') {
                setPinnedRule(null);
              }
              if (tr.name === 'categorize_filtered_transactions' || tr.name === 'restore_view') {
                setPinnedContact(null);
              }
            }
            // Update toolEvents with ok/fail status.
            if (tr.name) {
              setTurns((all) =>
                all.map((t) => {
                  if (t.id !== assistantTurn.id) return t;
                  const events = [...(t.toolEvents ?? [])];
                  // Find the most recent matching pending event and stamp it.
                  for (let i = events.length - 1; i >= 0; i--) {
                    if (events[i].name === tr.name && events[i].ok === undefined) {
                      events[i] = { ...events[i], ok: tr.ok };
                      break;
                    }
                  }
                  return { ...t, toolEvents: events };
                }),
              );
            }
            // Dispatch any client_action returned by the tool.
            const output = tr.output as { client_action?: { name?: string; args?: Record<string, unknown> } } | null;
            const ca = output?.client_action;
            if (ca?.name) {
              try {
                await dispatchClientAction(ca.name, ca.args ?? {});
              } catch (err) {
                console.warn('[ai-sidecar] client action failed', err);
              }
            }
            // Onboarding tools (only called when chatChannel='onboarding')
            // carry an OnboardingStatusView in their output. Forward it to
            // the page so its shared onboarding state — and therefore the
            // OnboardingPanel — stays in sync as the AI advances the user.
            if (
              tr.ok &&
              tr.output &&
              typeof tr.output === 'object' &&
              (tr.name === 'get_onboarding_status' ||
                tr.name === 'set_business_info' ||
                tr.name === 'advance_onboarding')
            ) {
              const view = tr.output as Record<string, unknown>;
              if (typeof view.phase === 'string') {
                dispatchOnboardingToolResult(view);
              }
            }
            // Invoice tool results carry the full DraftSnapshot — attach it to
            // the turn so we can render the InvoicePreview card. post_invoice
            // overwrites save_invoice_draft on the same draftId so the card
            // flips from blue (draft) to green (posted) on the post call.
            if (
              (tr.name === 'save_invoice_draft' || tr.name === 'post_invoice') &&
              tr.ok &&
              tr.output &&
              typeof tr.output === 'object'
            ) {
              const snap = tr.output as Partial<InvoiceDraftView>;
              if (snap.draftId && Array.isArray(snap.lines) && typeof snap.total === 'number') {
                const invoice = snap as InvoiceDraftView;
                setTurns((all) =>
                  all.map((t) =>
                    t.id === assistantTurn.id ? { ...t, invoice } : t,
                  ),
                );
              }
            }
            // send_text_to_contact result carries a TextDraftView. Push it
            // onto the turn's texts list so it renders as a TextPreview
            // card. We attach on every call (ok or not) so failed sends
            // still get a card with the error visible — the user can fix
            // the contact phone and retry.
            if (
              tr.name === 'send_text_to_contact' &&
              tr.output &&
              typeof tr.output === 'object'
            ) {
              const out = tr.output as Partial<TextDraftView>;
              if (
                typeof out.id === 'string' &&
                typeof out.contactId === 'string' &&
                typeof out.contactName === 'string' &&
                typeof out.contactPhone === 'string' &&
                typeof out.body === 'string' &&
                typeof out.status === 'string' &&
                typeof out.sentAt === 'string'
              ) {
                const text = out as TextDraftView;
                setTurns((all) =>
                  all.map((t) =>
                    t.id === assistantTurn.id
                      ? { ...t, texts: [...(t.texts ?? []), text] }
                      : t,
                  ),
                );
              }
            }
            // create_chart_account result carries the new CoA row. Append it
            // to the turn's coaAccounts list so it renders as a green
            // CoaAccountCard below the assistant message.
            if (
              tr.name === 'create_chart_account' &&
              tr.ok &&
              tr.output &&
              typeof tr.output === 'object'
            ) {
              const out = tr.output as { account?: Partial<CoaAccountView> };
              if (
                out.account &&
                typeof out.account.id === 'string' &&
                typeof out.account.accountNumber === 'string' &&
                typeof out.account.accountName === 'string'
              ) {
                const coa = out.account as CoaAccountView;
                setTurns((all) =>
                  all.map((t) =>
                    t.id === assistantTurn.id
                      ? { ...t, coaAccounts: [...(t.coaAccounts ?? []), coa] }
                      : t,
                  ),
                );
              }
            }
            // find_transfer_counterpart / find_matching_invoice → render a compact
            // match card below the message (deposit-review visual aid for Transfer/Income).
            if (tr.name === 'find_transfer_counterpart' && tr.ok && tr.output && typeof tr.output === 'object') {
              const out = tr.output as {
                found?: boolean;
                counterparts?: Array<{ id: string; date: string; amount: number; sourceAccount: string | null }>;
              };
              const c = out.found && Array.isArray(out.counterparts) ? out.counterparts[0] : null;
              if (c && typeof c.id === 'string') {
                const match: DepositMatchView = {
                  kind: 'transfer',
                  transactionId: c.id,
                  amount: Number(c.amount),
                  date: String(c.date),
                  sourceAccount: c.sourceAccount ?? null,
                };
                setTurns((all) => all.map((t) => (t.id === assistantTurn.id ? { ...t, depositMatch: match } : t)));
              }
            }
            if (tr.name === 'find_matching_invoice' && tr.ok && tr.output && typeof tr.output === 'object') {
              const out = tr.output as {
                found?: boolean;
                invoices?: Array<{ id: string; invoiceNumber: string | null; balance: number; dueDate: string | null; customerName: string | null }>;
              };
              const inv = out.found && Array.isArray(out.invoices) ? out.invoices[0] : null;
              if (inv && typeof inv.id === 'string') {
                const match: DepositMatchView = {
                  kind: 'invoice',
                  invoiceId: inv.id,
                  invoiceNumber: inv.invoiceNumber ?? null,
                  balance: Number(inv.balance),
                  dueDate: inv.dueDate ?? null,
                  customerName: inv.customerName ?? null,
                };
                setTurns((all) => all.map((t) => (t.id === assistantTurn.id ? { ...t, depositMatch: match } : t)));
              }
            }
            // verify_transaction_ids → if a rule is pending, pop the one-click rule
            // card (same RulePinnedCard the manual checkmark / Discuss flow uses).
            if (tr.name === 'verify_transaction_ids' && tr.ok && tr.output && typeof tr.output === 'object') {
              const out = tr.output as {
                pendingRule?: {
                  pattern: string;
                  categoryAccountId: string;
                  categoryName: string;
                  count: number;
                  transactionType: string | null;
                };
                pendingContact?: {
                  contactId: string;
                  contactName: string;
                  categoryAccountId: string;
                  categoryName: string;
                  count: number;
                  transactionType: string | null;
                };
              };
              const returnTo =
                typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/transactions';
              if (out.pendingRule && typeof out.pendingRule.pattern === 'string') {
                setPinnedRule({
                  pattern: out.pendingRule.pattern,
                  categoryAccountId: out.pendingRule.categoryAccountId,
                  categoryName: out.pendingRule.categoryName,
                  count: out.pendingRule.count,
                  transactionType: out.pendingRule.transactionType ?? null,
                  returnTo,
                });
              } else if (out.pendingContact && typeof out.pendingContact.contactId === 'string') {
                setPinnedContact({
                  contactId: out.pendingContact.contactId,
                  contactName: out.pendingContact.contactName,
                  categoryAccountId: out.pendingContact.categoryAccountId,
                  categoryName: out.pendingContact.categoryName,
                  count: out.pendingContact.count,
                  transactionType: out.pendingContact.transactionType ?? null,
                  returnTo,
                });
              }
            }
            // Organizer AI email: draft → confirm card; sent → completion card.
            if (tr.name === 'draft_organizer_email' && tr.output && typeof tr.output === 'object') {
              const out = tr.output as { kind?: string } & Partial<OrganizerEmailDraftView>;
              if (out.kind === 'organizer_email_draft' && out.draftId && out.toEmail && out.subject) {
                const draft = out as OrganizerEmailDraftView;
                setTurns((all) =>
                  all.map((t) => (t.id === assistantTurn.id ? { ...t, organizerEmailDraft: draft } : t)),
                );
              }
            }
            if (tr.name === 'send_organizer_email' && tr.ok && tr.output && typeof tr.output === 'object') {
              const out = tr.output as { kind?: string } & Partial<OrganizerEmailSentView>;
              if (out.kind === 'organizer_email_sent' && out.subject) {
                const sent = out as OrganizerEmailSentView;
                setTurns((all) =>
                  all.map((t) => (t.id === assistantTurn.id ? { ...t, organizerEmailSent: sent } : t)),
                );
              }
            }
            if (tr.name === 'draft_video_invite' && tr.output && typeof tr.output === 'object') {
              const out = tr.output as { kind?: string } & Partial<VideoInviteDraftView>;
              if (out.kind === 'video_invite_draft' && out.draftId && out.joinUrl && out.toEmail) {
                const draft = out as VideoInviteDraftView;
                setTurns((all) =>
                  all.map((t) => (t.id === assistantTurn.id ? { ...t, videoInviteDraft: draft } : t)),
                );
              }
            }
            if (tr.name === 'send_video_invite' && tr.ok && tr.output && typeof tr.output === 'object') {
              const out = tr.output as { kind?: string } & Partial<VideoInviteSentView>;
              if (out.kind === 'video_invite_sent' && out.joinUrl) {
                const sent = out as VideoInviteSentView;
                setTurns((all) =>
                  all.map((t) => (t.id === assistantTurn.id ? { ...t, videoInviteSent: sent } : t)),
                );
              }
            }
            if (tr.name === 'draft_signature_request' && tr.output && typeof tr.output === 'object') {
              const out = tr.output as { kind?: string } & Partial<SignatureDraftView>;
              if (out.kind === 'signature_draft' && out.draftId && out.documentId && out.toEmail) {
                const draft = out as SignatureDraftView;
                setTurns((all) =>
                  all.map((t) => (t.id === assistantTurn.id ? { ...t, signatureDraft: draft } : t)),
                );
              }
            }
            if (tr.name === 'send_signature_request' && tr.ok && tr.output && typeof tr.output === 'object') {
              const out = tr.output as { kind?: string } & Partial<SignatureSentView>;
              if (out.kind === 'signature_sent') {
                const sent = out as SignatureSentView;
                setTurns((all) =>
                  all.map((t) => (t.id === assistantTurn.id ? { ...t, signatureSent: sent } : t)),
                );
              }
            }
            if (tr.name === 'draft_send_document' && tr.output && typeof tr.output === 'object') {
              const out = tr.output as { kind?: string } & Partial<SendDocumentDraftView>;
              if (out.kind === 'send_document_draft' && out.draftId && out.documentId && out.toEmail) {
                const draft = out as SendDocumentDraftView;
                setTurns((all) =>
                  all.map((t) => (t.id === assistantTurn.id ? { ...t, sendDocumentDraft: draft } : t)),
                );
              }
            }
            if (tr.name === 'send_document' && tr.ok && tr.output && typeof tr.output === 'object') {
              const out = tr.output as { kind?: string } & Partial<SendDocumentSentView>;
              if (out.kind === 'send_document_sent') {
                const sent = out as SendDocumentSentView;
                setTurns((all) =>
                  all.map((t) => (t.id === assistantTurn.id ? { ...t, sendDocumentSent: sent } : t)),
                );
              }
            }
          } else if (typeof evt.error === 'string') {
            const errorRef = typeof evt.requestId === 'string' ? evt.requestId : null;
            setError(errorRef ? `${evt.error} Reference: ${errorRef}` : evt.error);
          }
        }
      }
    } catch (err) {
      console.error('[sidecar] handleSubmit THREW', err);
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setPending(false);
      console.info('[sidecar] handleSubmit END (pending=false)');
      // The tour runner uses this to prompt "Ready to move on?" once the
      // reply finishes streaming. Fires for every turn — runner ignores
      // it unless an interjection is in flight.
      dispatchReplyComplete();
    }
  }

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
    if (e.key === 'Escape') setMode('closed');
  }

  // Keep the dictation hook's auto-submit hooked to the latest handleSubmit.
  // Effect (not render) per React 19 lint — refs must not be touched during render.
  useEffect(() => {
    submitRef.current = () => {
      void handleSubmit();
    };
  });

  // When a page calls `requestSidecarOpen()` (e.g. ai-chat asks the floating
  // bar to pop open during onboarding), honor it once per bump — but only
  // promote 'closed' to the requested mode. If the user already has the
  // sidecar open in a different mode, don't yank it.
  const lastSeenOpenIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!openRequest) return;
    if (lastSeenOpenIdRef.current === openRequest.id) return;
    lastSeenOpenIdRef.current = openRequest.id;
    consumeOpenRequest();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (mode === 'closed') setMode(openRequest.mode);
    // mode is intentionally read at fire time; depending on it would refire
    // every time the user changes mode after the request landed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest, consumeOpenRequest]);

  // Proactive opener: fetch a greeting + chips the first time the sidecar opens
  // on a given surface. PAGE-AWARE — the /invoices opener comments on invoice
  // status and offers to chase overdue ones; other pages get the generic
  // books-grounded greeting. Refetches when you move to a different opener page
  // while the thread is still fresh (empty or only the prior opener) — never
  // disrupts an in-progress conversation.
  const threadFresh = turns.length === 0 || (turns.length === 1 && turns[0].id === 'opener');
  // Active company changed (e.g. an accounting pro used "Open books") → forget
  // the prior company's opener so we refetch for the new one instead of leaving
  // a stale greeting. Only clears a lone opener turn — never an in-progress chat.
  const prevOrgRef = useRef<string | undefined>(orgId);
  useEffect(() => {
    if (prevOrgRef.current === orgId) return;
    prevOrgRef.current = orgId;
    openerFetchedRef.current = null;
    /* eslint-disable react-hooks/set-state-in-effect */
    setOpenerGreeting(null);
    setTurns((prev) => (prev.length === 1 && prev[0]?.id === 'opener' ? [] : prev));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [orgId]);
  useEffect(() => {
    if (mode === 'closed' || !threadFresh) return;
    const pageKey = openerPageKey(pathname);
    // Key the opener by the ACTIVE org too. Switching companies (e.g. an
    // accounting pro using "Open books" to impersonate a client) keeps the same
    // page, so a page-only key would keep showing the previous company's
    // greeting. Including orgId forces a refetch for the new active company.
    const fetchKey = `${orgId ?? ''}:${pageKey}`;
    if (openerFetchedRef.current === fetchKey) return;
    openerFetchedRef.current = fetchKey;
    // Defer the page-specific opener fetch (a real, grounded DB read — page state,
    // action cards, etc.) so it doesn't race the page's own initial data load for
    // DB pool slots. That contention is exactly why the opener was gated to an
    // empty `light=1` response during stabilization; deferring restores the real
    // per-page greeting + chips without competing with first paint. The timer is
    // cleared on nav/close so a quick page change never fires a stale fetch.
    //
    // NOTE: intentionally OMIT light=1. The route short-circuits a light=1
    // request to an empty { greeting: null, chips: [] } (a first-paint
    // stabilization gate). The 1500ms defer above already removes that DB-pool
    // contention, so we ask for the REAL grounded per-page opener — otherwise
    // the sidecar only ever gets the empty response and no opener ever shows.
    const timer = setTimeout(() => {
      (async () => {
        try {
          const query = new URLSearchParams();
          if (pageKey !== 'home') query.set('page', pageKey);
          const res = await fetch(`/api/ai/opener?${query.toString()}`);
          if (!res.ok) return;
          const data = (await res.json()) as { greeting: string | null; chips: SuggestionChip[] };
          setOpenerGreeting(data.greeting ?? null);
          setOpenerChips(Array.isArray(data.chips) ? data.chips : []);
        } catch {
          /* best effort — leave the empty-state hint */
        }
      })();
    }, 1500);
    return () => clearTimeout(timer);
  }, [mode, pathname, threadFresh, orgId]);

  // Inject (or replace) the greeting as the opener turn once it arrives.
  useEffect(() => {
    if (!openerGreeting || !threadFresh) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTurns([{ id: 'opener', role: 'assistant', content: openerGreeting }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openerGreeting]);

  // Page-side mic-on bump: a button somewhere on the page asked us to start
  // dictation (e.g. the per-task "speak to AI" button). Idempotent — if mic
  // is already listening, we just consume the request and move on.
  const lastSeenMicIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!micRequest) return;
    if (lastSeenMicIdRef.current === micRequest.id) return;
    lastSeenMicIdRef.current = micRequest.id;
    consumeMicRequest();
    if (!dictation.supported) return;
    if (dictation.listening) return;
    // Tiny delay so the sidecar's open animation has a frame to land before
    // we trigger the mic prompt — otherwise Chrome can pop the permission
    // dialog on a not-yet-visible surface, which is jarring.
    const t = setTimeout(() => {
      dictation.start();
    }, 100);
    return () => clearTimeout(t);
  }, [micRequest, consumeMicRequest, dictation]);

  // When a page calls `seedPrompt(text)` (e.g. an Explain button on the Pulse
  // page), open the side panel and submit the prompt as if the user had typed
  // it. We pass the text via overrideText to dodge the stale-closure on
  // `input`. Consume the slot so the same id won't refire on re-render.
  // Setting `mode` here is the legitimate "sync UI to an incoming context
  // event" use of an effect — disable the over-eager set-state-in-effect lint.
  const lastSeenSeedIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!seededPrompt) return;
    if (lastSeenSeedIdRef.current === seededPrompt.id) return;
    // If the AI is mid-response, DON'T consume the seed yet — handleSubmit would
    // drop it (its pending guard) and the seed would be lost. `pending` is in the
    // deps, so this effect re-runs the moment the AI goes idle and the queued seed
    // (e.g. the guided auto-advance to the next group) fires then instead.
    if (pending) return;
    lastSeenSeedIdRef.current = seededPrompt.id;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (seededPrompt.mode) setMode(seededPrompt.mode);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    else if (mode === 'closed') setMode('side');
    const text = seededPrompt.text;
    const actingAsYou = seededPrompt.actingAsYou ?? false;
    const hidden = seededPrompt.hidden ?? false;
    console.info('[sidecar] seedPrompt consumed', { text: text.slice(0, 60), actingAsYou, hidden, pending });
    consumeSeededPrompt();
    void handleSubmit(undefined, text, { actingAsYou, hidden });
    // handleSubmit is defined inline and rebinds every render; we intentionally
    // omit it from deps to avoid re-firing on unrelated re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seededPrompt, mode, consumeSeededPrompt, pending]);

  // Page → assistant in-flow events (e.g. the user clicked "Generate previews").
  // Only react when the sidecar is OPEN — the client is already in an
  // AI-guided flow; we don't pop the panel open on every page click. The event
  // is fed as a hidden turn so only the assistant's reaction renders.
  const lastSeenPageEventIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!pageEvent) return;
    if (lastSeenPageEventIdRef.current === pageEvent.id) return;
    lastSeenPageEventIdRef.current = pageEvent.id;
    consumePageEvent();
    if (mode === 'closed' || pending) return;
    void handleSubmit(undefined, `[in-app event] ${pageEvent.text}`, { hidden: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageEvent, mode, consumePageEvent]);

  // Cool-tour narration push: pushedNarration carries text that should land
  // in the sidecar's history as an assistant message without hitting the
  // chat API. Spoken unless the tour-mute toggle is on -- independent of
  // autoSpeak (the tour is a "hear the AI" experience by default).
  const lastSeenNarrationIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!pushedNarration) return;
    if (lastSeenNarrationIdRef.current === pushedNarration.id) return;
    lastSeenNarrationIdRef.current = pushedNarration.id;
    if (mode === 'closed') setMode('bar');
    const text = pushedNarration.text;
    consumePushedNarration();
    setTurns((t) => [
      ...t,
      {
        id: `n-${Date.now()}`,
        role: 'assistant',
        content: text,
        pushedNarration: true,
      },
    ]);
    // Read mute fresh from localStorage at speak-time so a stale closure
    // can't let the next pushNarration leak through after a mute toggle.
    if (tts.supported && !isTourMutedNow()) tts.speak(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushedNarration, mode, consumePushedNarration]);

  // Cool-tour invoice push: drop a turn with both narration text and an
  // attached invoice draft into the sidecar so the user sees the
  // InvoicePreview card render exactly as it would if the AI had called
  // save_invoice_draft -- but without actually hitting the DB. Mirrors the
  // pushedNarration path; the existing post-process attachment logic isn't
  // involved.
  const lastSeenInvoiceCardIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!pushedInvoiceCard) return;
    if (lastSeenInvoiceCardIdRef.current === pushedInvoiceCard.id) return;
    lastSeenInvoiceCardIdRef.current = pushedInvoiceCard.id;
    if (mode === 'closed') setMode('bar');
    const { text, invoice } = pushedInvoiceCard;
    consumePushedInvoiceCard();
    setTurns((t) => [
      ...t,
      {
        id: `i-${Date.now()}`,
        role: 'assistant',
        content: text ?? '',
        invoice: invoice as unknown as InvoiceDraftView,
        pushedNarration: true,
      },
    ]);
    if (text && tts.supported && !isTourMutedNow()) tts.speak(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushedInvoiceCard, mode, consumePushedInvoiceCard]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // On /ai-chat the inline ChatBox is the only chat surface — render nothing
  // here. Hooks above still run, so body-class effects and the navigate
  // handoff continue to behave.
  if (onAiChatRoute && !onGuidedOnboardingRoute) return null;

  if (mode === 'closed') {
    return (
      <button
        type="button"
        onClick={() => setMode('bar')}
        aria-label="Open AI assistant"
        className="rs-rainbow-border fixed bottom-4 left-1/2 z-40 flex h-10 w-16 -translate-x-1/2 items-center justify-center rounded-full text-zinc-700 shadow-md transition hover:shadow-lg dark:text-zinc-200"
      >
        <SparkleIcon />
      </button>
    );
  }

  // Quick-reply chips: when the assistant's latest visible message is a yes/no
  // question and we're idle, offer one-tap Yes / No above the input. Tapping one
  // submits it as the user's reply.
  const lastVisibleTurn = [...turns].reverse().find((t) => !t.hidden);
  const quickReplies =
    !pending && lastVisibleTurn?.role === 'assistant'
      ? parseSuggestions(lastVisibleTurn.content)
      : [];
  // Deterministically verify the spotlighted guided group — the "Yes" button in
  // the verify flow. Calls the guarded verification endpoint directly (no model
  // in the loop, which was skipping verify_transaction_ids for trivial groups), pops the
  // rule/contact decision card, and refreshes so the guided review advances.
  const runDeterministicVerify = async (guide: { contactName?: string; transactionIds?: string[] }) => {
    const ids = (guide.transactionIds ?? []).filter(Boolean);
    if (ids.length === 0) return;
    const contact = guide.contactName || 'these';
    const uid = `u-${Date.now()}`;
    const aid = `a-${Date.now()}`;
    setTurns((t) => [
      ...t,
      { id: uid, role: 'user', content: 'Yes' },
      { id: aid, role: 'assistant', content: 'Verifying…' },
    ]);
    try {
      const response = await fetch('/api/transactions/verify-guide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionIds: ids }),
      });
      const res = await response.json() as {
        ok?: boolean;
        verified?: number;
        suggestion?: { pattern: string; categoryAccountId: string; categoryName: string; count: number; transactionType?: string | null } | null;
        contactSuggestion?: { contactId: string; contactName: string; categoryAccountId: string; categoryName: string; count: number; transactionType?: string | null } | null;
        error?: string;
      };
      if (!response.ok && !res.error) res.error = 'Could not verify those transactions.';
      const returnTo =
        typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/transactions';
      if (res?.ok) {
        const n = res.verified ?? ids.length;
        setTurns((all) =>
          all.map((t) =>
            t.id === aid ? { ...t, content: `Verified — ${n} ${contact} transaction${n === 1 ? '' : 's'}.` } : t,
          ),
        );
        if (res.suggestion) {
          setPinnedRule({
            pattern: res.suggestion.pattern,
            categoryAccountId: res.suggestion.categoryAccountId,
            categoryName: res.suggestion.categoryName,
            count: res.suggestion.count,
            transactionType: res.suggestion.transactionType ?? null,
            returnTo,
          });
        } else if (res.contactSuggestion) {
          setPinnedContact({
            contactId: res.contactSuggestion.contactId,
            contactName: res.contactSuggestion.contactName,
            categoryAccountId: res.contactSuggestion.categoryAccountId,
            categoryName: res.contactSuggestion.categoryName,
            count: res.contactSuggestion.count,
            transactionType: res.contactSuggestion.transactionType ?? null,
            returnTo,
          });
        }
        router.refresh();
      } else {
        setTurns((all) =>
          all.map((t) =>
            t.id === aid ? { ...t, content: res?.error ?? 'Could not verify those transactions.' } : t,
          ),
        );
      }
    } catch {
      setTurns((all) =>
        all.map((t) =>
          t.id === aid ? { ...t, content: 'Could not verify those transactions.' } : t,
        ),
      );
    }
  };

  const sendQuickReply = (text: string) => {
    const t = text.trim().toLowerCase();
    // "Start review" (the ReviewStartAsk offer on a review view) → enter the
    // current view's guided flow by adding guide=1 to the URL.
    if (t === 'start review' && typeof window !== 'undefined') {
      const sp = new URLSearchParams(window.location.search);
      sp.set('guide', '1');
      router.push(`${window.location.pathname}?${sp.toString()}`);
      return;
    }
    // "Start guided review" picker chips → navigate deterministically into the
    // chosen guided flow (no model in the loop).
    const reviewKey = GUIDED_REVIEW_LABELS[t];
    if (reviewKey) {
      router.push(GUIDED_REVIEW_URLS[reviewKey]);
      return;
    }
    // In the guided VERIFY flow, "Yes" verifies deterministically (client-side)
    // instead of trusting the model to call verify_transaction_ids.
    const guide = (pageContext?.data as
      | { guide?: { kind?: string; contactName?: string; transactionIds?: string[] } | null }
      | undefined)?.guide;
    if (guide?.kind === 'verify' && (guide.transactionIds?.length ?? 0) > 0 && /^\s*yes\b/i.test(text)) {
      void runDeterministicVerify(guide);
      return;
    }
    void handleSubmit(undefined, text);
  };

  // Opener chips: shown while only the proactive greeting is on screen. Each
  // sends its own prompt (which differs from its label), so it can't reuse the
  // Composer's yes/no quickReplies — render it as its own row above the input.
  // In deposit guided review the sidecar shows six fixed "what is this deposit?"
  // chips that PERSIST every turn (unlike the opener chips, which only show on
  // the first turn). Clicking sends the sentence as if typed — same path as chat.
  const guideKind = (pageContext?.data as { guide?: { kind?: string } | null } | undefined)?.guide?.kind;
  const showDepositChips = !pending && guideKind === 'deposits';
  const showOpenerChips =
    !pending && !showDepositChips && openerChips.length > 0 && turns.filter((t) => !t.hidden).length === 1;
  const OpenerChips = () =>
    showOpenerChips ? (
      <div className="flex flex-wrap gap-2 px-3 pb-2">
        {openerChips.map((c, i) => (
          <button
            key={i}
            type="button"
            onClick={() => void handleSubmit(undefined, c.prompt)}
            className="rounded-full border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {c.label}
          </button>
        ))}
      </div>
    ) : null;
  const DepositGuideChips = () =>
    showDepositChips ? (
      <div className="flex flex-wrap gap-1.5 px-3 pb-2">
        {DEPOSIT_GUIDE_CHIPS.map((c) => (
          <button
            key={c.label}
            type="button"
            onClick={() => void handleSubmit(undefined, c.prompt)}
            className="rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-900/40"
          >
            {c.label}
          </button>
        ))}
      </div>
    ) : null;

  // Side panel mode — pinned to the right edge with a chat thread + composer.
  if (mode === 'side') {
    return (
      <aside data-surface="chat" className="rs-sidecar-pinned fixed right-0 top-0 z-40 flex h-screen w-[380px] flex-col border-l border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="flex items-center gap-2 text-sm font-medium">
            <SparkleIcon className="h-4 w-4 text-blue-500" />
            <span>Assistant</span>
            {pageContext && (
              <span className="rounded-full border border-zinc-200 px-2 py-0.5 text-xs font-normal text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                {pageContext.pageTitle}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {(coolTourActive || regularTourActive) && (
              <TourHeaderControls
                paused={tourPaused}
                onTogglePause={() => setTourPaused(!tourPaused)}
                onAskQuestion={() => {
                  setMode('side');
                  requestAskQuestion();
                  // Focus the chat input so the user can start typing immediately.
                  window.setTimeout(() => inputRef.current?.focus(), 50);
                }}
              />
            )}
            <VoiceMenu tts={tts} tourActive={coolTourActive} />
            <IconButton onClick={() => setMode('bar')} title="Switch to floating bar">
              <BarIcon />
            </IconButton>
            <IconButton onClick={() => setMode('closed')} title="Close">
              <XIcon />
            </IconButton>
          </div>
        </header>
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
          <ChatThread turns={turns} pending={pending} tts={tts} />
          {(error || dictation.error) && (
            <ErrorBox
              message={error ?? dictation.error ?? ''}
              onDismiss={() => {
                setError(null);
                dictation.clearError();
              }}
            />
          )}
        </div>
        <DepositGuideChips />
        <OpenerChips />
        {pinnedRule && <RulePinnedCard rule={pinnedRule} onDone={() => setPinnedRule(null)} />}
        {pinnedContact && <ContactPinnedCard contact={pinnedContact} onDone={() => setPinnedContact(null)} />}
        {splitReturn && (
          <SplitReturnBar
            onBack={() => {
              const to = bumpGuideIndex(splitReturn);
              setSplitReturn(null);
              router.push(to);
            }}
            onDone={() => {
              setSplitReturn(null);
              router.push(splitReturn);
            }}
          />
        )}
        <Composer
          input={input}
          setInput={setInput}
          onSubmit={handleSubmit}
          onKeyDown={handleKey}
          inputRef={inputRef}
          pending={pending}
          dictation={dictation}
          placeholder={pageContext ? `Ask about ${pageContext.pageTitle.toLowerCase()}…` : 'Ask anything…'}
          quickReplies={quickReplies}
          onQuickReply={sendQuickReply}
        />
      </aside>
    );
  }

  // Floating bar mode — small chat with composer at the bottom-center of the viewport.
  return (
    <div ref={barRef} className="rs-rainbow-border fixed bottom-4 left-1/2 z-40 w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 rounded-xl shadow-xl">
      <header className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <div className="flex items-center gap-2 text-xs">
          <SparkleIcon className="h-3.5 w-3.5 text-blue-500" />
          <span className="font-medium">Assistant</span>
          {pageContext && <span className="text-zinc-500 dark:text-zinc-400">· {pageContext.pageTitle}</span>}
        </div>
        <div className="flex items-center gap-1">
          {(coolTourActive || regularTourActive) && (
            <TourHeaderControls
              paused={tourPaused}
              onTogglePause={() => setTourPaused(!tourPaused)}
              onAskQuestion={() => {
                requestAskQuestion();
                window.setTimeout(() => inputRef.current?.focus(), 50);
              }}
            />
          )}
          <VoiceMenu tts={tts} tourActive={coolTourActive} />
          <IconButton onClick={() => setMode('side')} title="Switch to side panel">
            <SidePanelIcon />
          </IconButton>
          <IconButton onClick={() => setMode('closed')} title="Close">
            <XIcon />
          </IconButton>
        </div>
      </header>
      {(turns.length > 0 || error || dictation.error) && (
        <div ref={scrollRef} className="max-h-[320px] overflow-y-auto px-3 py-2">
          <ChatThread
            // While the cool tour is running, always show the full history
            // so the user can see the AI's narration + the "🎬 acting as
            // you" injected prompts + the AI's responses together. Without
            // this, only the most recent turn renders and the acting-as-you
            // bubbles disappear behind the Show-more toggle.
            turns={barExpanded || coolTourActive ? turns : turns.slice(-1)}
            pending={pending}
            tts={tts}
          />
          {(error || dictation.error) && (
            <ErrorBox
              message={error ?? dictation.error ?? ''}
              onDismiss={() => {
                setError(null);
                dictation.clearError();
              }}
            />
          )}
        </div>
      )}
      {turns.filter((t) => !t.hidden).length > 1 && (
        <div className="flex justify-end px-3">
          <button
            type="button"
            onClick={() => setBarExpanded((v) => !v)}
            className="text-xs text-blue-600 hover:underline dark:text-blue-400"
          >
            {barExpanded ? 'Show less' : 'Show more'}
          </button>
        </div>
      )}
      <DepositGuideChips />
      <OpenerChips />
      {pinnedRule && <RulePinnedCard rule={pinnedRule} onDone={() => setPinnedRule(null)} />}
      {pinnedContact && <ContactPinnedCard contact={pinnedContact} onDone={() => setPinnedContact(null)} />}
      {splitReturn && (
        <SplitReturnBar
          onBack={() => {
            const to = bumpGuideIndex(splitReturn);
            setSplitReturn(null);
            router.push(to);
          }}
          onDone={() => {
            setSplitReturn(null);
            router.push(splitReturn);
          }}
        />
      )}
      <Composer
        input={input}
        setInput={setInput}
        onSubmit={handleSubmit}
        onKeyDown={handleKey}
        inputRef={inputRef}
        pending={pending}
        dictation={dictation}
        placeholder={pageContext ? `Ask about ${pageContext.pageTitle.toLowerCase()}…` : 'Ask anything…'}
        quickReplies={quickReplies}
        onQuickReply={sendQuickReply}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

// The assistant ends a message with `[[suggestions: A | B]]` (see the chat
// route's system prompt) when it's offering a small set of discrete answers.
// We parse those into one-tap chips and strip the marker from what's shown/read.
const SUGGESTIONS_RE = /\n*\[\[\s*suggestions?\s*:\s*([^\]]+)\]\]\s*$/i;
const SUGGESTIONS_PARTIAL_RE = /\n*\[\[\s*suggestions?\b[^\]]*$/i; // half-streamed marker

/** Pull the suggested quick-reply labels (2–4) from an assistant message. */
function parseSuggestions(content: string): string[] {
  const m = content.match(SUGGESTIONS_RE);
  if (!m) return [];
  return m[1]
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
}

/** The message text with the suggestions marker (complete or mid-stream) removed. */
function stripSuggestions(content: string): string {
  return content.replace(SUGGESTIONS_RE, '').replace(SUGGESTIONS_PARTIAL_RE, '').trimEnd();
}

function ChatThread({
  turns,
  pending,
  tts,
}: {
  turns: ChatTurn[];
  pending: boolean;
  tts: TtsApi;
}) {
  // Hidden turns (seeded with `hidden`) are still in the history sent to the
  // model but must never render — drop them before any display logic so the
  // empty-state check, halo target, and map all operate on what the user sees.
  const visibleTurns = turns.filter((t) => !t.hidden);
  if (visibleTurns.length === 0) {
    return (
      <div className="text-xs text-zinc-500 dark:text-zinc-400">
        Try: <em>show transactions from openai</em>, <em>what&apos;s my P&amp;L this month?</em>
      </div>
    );
  }
  // Halo the most recent settled assistant turn — the one waiting for the
  // user's reply. As soon as the user submits, `pending` flips true and the
  // halo disappears; when the new assistant turn finishes streaming, the halo
  // moves to it. Pending/streaming turns aren't haloed so the border doesn't
  // animate over partial content.
  const last = visibleTurns[visibleTurns.length - 1];
  const haloId = !pending && last?.role === 'assistant' && last.content.trim() ? last.id : null;
  return (
    <div className="flex flex-col gap-3">
      {visibleTurns.map((t) => (
        <div
          key={t.id}
          className={t.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
        >
          <div
            {...(t.role === 'user' ? { 'data-chat-user-bubble': '' } : {})}
            className={
              t.role === 'user'
                ? 'max-w-[85%] rounded-lg bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-800'
                : t.id === haloId
                  ? 'rs-rainbow-border max-w-[95%] rounded-lg px-3 py-2 text-sm text-zinc-800 shadow-sm dark:text-zinc-200'
                  : 'max-w-[95%] text-sm text-zinc-800 dark:text-zinc-200'
            }
          >
            {t.role === 'user' && t.actingAsYou && (
              <div className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-violet-700 dark:text-violet-300">
                🎬 acting as you
              </div>
            )}
            {t.role === 'assistant' && t.toolEvents && t.toolEvents.length > 0 && (
              <div className="mb-1 flex flex-wrap gap-1">
                {t.toolEvents.map((ev, i) => (
                  <span
                    key={i}
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${
                      ev.ok === false
                        ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300'
                        : ev.ok === true
                        ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300'
                        : 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300'
                    }`}
                  >
                    {ev.ok === undefined ? <Spinner /> : null}
                    {ev.name}
                  </span>
                ))}
              </div>
            )}
            <div className="whitespace-pre-wrap leading-relaxed">{(t.role === 'assistant' ? stripSuggestions(t.content) : t.content) || (pending && t.role === 'assistant' ? '…' : '')}</div>
            {t.role === 'assistant' && t.invoice && (
              <div className="mt-2">
                <InvoicePreview draft={t.invoice} />
              </div>
            )}
            {t.role === 'assistant' && t.coaAccounts && t.coaAccounts.length > 0 && (
              <div className="mt-2 flex flex-col gap-2">
                {t.coaAccounts.map((coa) => (
                  <CoaAccountCard key={coa.id} account={coa} />
                ))}
              </div>
            )}
            {t.role === 'assistant' && t.depositMatch && (
              <div className="mt-2">
                <DepositMatchCard match={t.depositMatch} />
              </div>
            )}
            {t.role === 'assistant' && t.texts && t.texts.length > 0 && (
              <div className="mt-2 flex flex-col gap-2">
                {t.texts.map((tx) => (
                  <TextPreview key={tx.id} draft={tx} />
                ))}
              </div>
            )}
            {t.role === 'assistant' && (t.organizerEmailDraft || t.organizerEmailSent) && (
              <div className="mt-2">
                <OrganizerEmailCard draft={t.organizerEmailDraft} sent={t.organizerEmailSent} />
              </div>
            )}
            {t.role === 'assistant' && (t.videoInviteDraft || t.videoInviteSent) && (
              <div className="mt-2">
                <VideoInviteCard draft={t.videoInviteDraft} sent={t.videoInviteSent} />
              </div>
            )}
            {t.role === 'assistant' && (t.signatureDraft || t.signatureSent) && (
              <div className="mt-2">
                <SignatureRequestCard draft={t.signatureDraft} sent={t.signatureSent} />
              </div>
            )}
            {t.role === 'assistant' && (t.sendDocumentDraft || t.sendDocumentSent) && (
              <div className="mt-2">
                <SendDocumentCard draft={t.sendDocumentDraft} sent={t.sendDocumentSent} />
              </div>
            )}
            {t.role === 'assistant' && tts.supported && t.content.trim() && (
              <button
                type="button"
                onClick={() => (tts.speaking ? tts.stop() : tts.speak(stripSuggestions(t.content)))}
                className="mt-1 inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                title={tts.speaking ? 'Stop' : 'Read aloud'}
              >
                {tts.speaking ? <StopIcon /> : <SpeakerIcon />}
                {tts.speaking ? 'Stop' : 'Read aloud'}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Voice picker popover. Lists every browser/OS voice grouped by language,
 * lets the user choose one, and toggles auto-speak. State is persisted to
 * localStorage by the hook itself.
 *
 * During an active tour, the speaker icon doubles as a one-click master mute
 * for ALL tour audio (cool-tour narration + the AI's replies to actAsUser
 * prompts). Click → slashed-speaker icon + everything goes silent until the
 * user clicks again. The settings popover is suppressed in this mode so a
 * single click is unambiguous.
 */
function VoiceMenu({ tts, tourActive }: { tts: TtsApi; tourActive: boolean }) {
  const [open, setOpen] = useState(false);
  const tourMute = useTourMuted();
  if (!tts.supported) return null;

  if (tourActive) {
    const muted = tourMute.muted;
    return (
      <IconButton
        onClick={() => {
          const next = !muted;
          tourMute.setMuted(next);
          if (next) tts.stop();
        }}
        title={muted ? 'Tour muted — click to unmute' : 'Mute tour audio'}
      >
        {muted ? <SpeakerOffIcon /> : <SpeakerIcon />}
      </IconButton>
    );
  }
  // Group voices by language so a user with 30+ system voices can find theirs.
  const grouped = new Map<string, SpeechSynthesisVoice[]>();
  for (const v of tts.voices) {
    const lang = v.lang || 'unknown';
    if (!grouped.has(lang)) grouped.set(lang, []);
    grouped.get(lang)!.push(v);
  }
  const sortedLangs = Array.from(grouped.keys()).sort((a, b) => {
    // English first, then everything else alphabetical.
    if (a.startsWith('en') && !b.startsWith('en')) return -1;
    if (b.startsWith('en') && !a.startsWith('en')) return 1;
    return a.localeCompare(b);
  });
  return (
    <div className="relative">
      <IconButton
        onClick={() => setOpen((o) => !o)}
        title={tts.autoSpeak ? 'Voice (auto-speak on)' : 'Voice settings'}
      >
        <SpeakerIcon className={tts.autoSpeak ? 'text-blue-500' : ''} />
      </IconButton>
      {open && (
        <>
          {/* Click-outside backdrop. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 bottom-full z-50 mb-1 max-h-[min(70vh,520px)] w-72 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-3 text-xs shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
            <label className="mb-2 flex items-center gap-2">
              <input
                type="checkbox"
                checked={tts.autoSpeak}
                onChange={(e) => tts.setAutoSpeak(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              <span>Read responses aloud automatically</span>
            </label>
            <div className="mb-1 text-zinc-500 dark:text-zinc-400">Voice</div>
            <select
              value={tts.selectedVoiceName ?? ''}
              onChange={(e) => tts.setSelectedVoiceName(e.target.value || null)}
              className="block max-h-64 w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-800 dark:bg-zinc-900"
            >
              <option value="">System default</option>
              {sortedLangs.map((lang) => (
                <optgroup key={lang} label={lang}>
                  {grouped.get(lang)!.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.name}
                      {v.default ? ' · default' : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {tts.selectedVoiceName && (
              <button
                type="button"
                onClick={() => tts.speak('Hi Michael, this is how I sound.')}
                className="mt-2 rounded-md border border-zinc-200 px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
              >
                Preview
              </button>
            )}
            {tts.voices.length === 0 && (
              <div className="mt-2 text-zinc-500 dark:text-zinc-400">
                Loading voices…
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SpeakerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className ?? 'h-4 w-4'}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

function SpeakerOffIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className ?? 'h-4 w-4'}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </svg>
  );
}

function StopIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className ?? 'h-3.5 w-3.5'}>
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </svg>
  );
}

function Composer({
  input,
  setInput,
  onSubmit,
  onKeyDown,
  inputRef,
  pending,
  dictation,
  placeholder,
  quickReplies = [],
  onQuickReply,
}: {
  input: string;
  setInput: (v: string) => void;
  onSubmit: (e?: FormEvent) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  pending: boolean;
  dictation: ReturnType<typeof useDictation>;
  placeholder: string;
  quickReplies?: string[];
  onQuickReply?: (text: string) => void;
}) {
  const livePlaceholder = dictation.listening
    ? dictation.interim || 'Listening… speak now'
    : placeholder;
  return (
    <>
      {quickReplies.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-2">
          {quickReplies.map((reply) => (
            <button
              key={reply}
              type="button"
              disabled={pending}
              onClick={() => onQuickReply?.(reply)}
              className="rounded-full border border-blue-300 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 transition hover:bg-blue-100 disabled:opacity-50 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200 dark:hover:bg-blue-900/50"
            >
              {reply}
            </button>
          ))}
        </div>
      )}
      <form onSubmit={onSubmit} className="flex items-end gap-2 px-3 py-2">
      {dictation.supported && (
        <button
          type="button"
          onClick={dictation.toggle}
          aria-label={dictation.listening ? 'Stop dictation (auto-submits on silence)' : 'Start voice dictation'}
          title={dictation.listening ? 'Stop dictation (auto-submits on silence)' : 'Start voice dictation'}
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition ${
            dictation.listening
              ? 'animate-pulse border-red-300 bg-red-50 text-red-600 dark:border-red-900 dark:bg-red-950 dark:text-red-300'
              : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-900'
          }`}
        >
          <MicIcon />
        </button>
      )}
      <textarea
        ref={inputRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        placeholder={livePlaceholder}
        className={`max-h-32 flex-1 resize-none rounded-md border bg-white px-3 py-2 text-sm placeholder:text-zinc-400 focus:outline-none dark:bg-zinc-950 dark:placeholder:text-zinc-500 ${
          dictation.listening
            ? 'border-red-300 focus:border-red-400 dark:border-red-900'
            : 'border-zinc-200 focus:border-zinc-400 dark:border-zinc-800'
        }`}
      />
      <button
        type="submit"
        disabled={pending || input.trim().length === 0}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-900 text-white transition hover:bg-zinc-700 disabled:bg-zinc-300 disabled:text-zinc-500 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-600"
        aria-label="Send"
      >
        {pending ? <Spinner /> : <ArrowUpIcon />}
      </button>
      </form>
    </>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 19v3" />
    </svg>
  );
}

function ErrorBox({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="mt-2 flex items-start justify-between gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
      <span>{message}</span>
      <button type="button" onClick={onDismiss} className="opacity-70 hover:opacity-100">
        <XIcon className="h-3 w-3" />
      </button>
    </div>
  );
}

/**
 * Tour-only header pills. Pause/Resume mirrors the top-right tour
 * pill's state (both flip the same context flag). Ask a question
 * pauses the tour and fires requestAskQuestion so the active tour
 * runner can push its "what's up?" narration.
 */
function TourHeaderControls({
  paused,
  onTogglePause,
  onAskQuestion,
}: {
  paused: boolean;
  onTogglePause: () => void;
  onAskQuestion: () => void;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onAskQuestion}
        title="Pause and ask a question"
        aria-label="Pause and ask a question"
        className="flex h-7 items-center gap-1 rounded-md border border-blue-300 bg-blue-50 px-2 text-xs font-medium text-blue-800 hover:bg-blue-100 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-200 dark:hover:bg-blue-900/50"
      >
        <span aria-hidden>💬</span>
        Ask a question
      </button>
      <button
        type="button"
        onClick={onTogglePause}
        title={paused ? 'Resume the tour' : 'Pause the tour'}
        aria-label={paused ? 'Resume the tour' : 'Pause the tour'}
        className="flex h-7 items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
      >
        {paused ? (
          <>
            <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" aria-hidden="true">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            Resume
          </>
        ) : (
          <>
            <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" aria-hidden="true">
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
            Pause
          </>
        )}
      </button>
    </>
  );
}

function IconButton({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Inline icons (no extra dep)
// ---------------------------------------------------------------------------

function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className ?? 'h-5 w-5'} aria-hidden="true">
      <path d="M12 2l1.7 5.3L19 9l-5.3 1.7L12 16l-1.7-5.3L5 9l5.3-1.7L12 2z" />
      <path d="M5 17l.7 2L8 20l-2.3.7L5 23l-.7-2.3L2 20l2.3-1L5 17z" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className ?? 'h-4 w-4'}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function SidePanelIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3v18" />
    </svg>
  );
}

function BarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <rect x="3" y="14" width="18" height="6" rx="2" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3 animate-spin" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" opacity="0.2" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" fill="none" />
    </svg>
  );
}
