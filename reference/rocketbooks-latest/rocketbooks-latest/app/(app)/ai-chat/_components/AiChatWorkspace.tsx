'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChatBox, type ChatBoxHandle } from './ChatBox';
import { VoiceMode, type VoiceModeHandle, type VoiceStatus, type VoiceActivity } from './VoiceMode';
import { OnboardingPanel, type OnboardingStatusView } from './OnboardingPanel';
import { TaskCardsPanel } from './TaskCardsPanel';
import { PlaidRelinkLauncher } from './PlaidRelinkLauncher';
import { CategorizationWorkspace } from './CategorizationWorkspace';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';
import type { ActionCard } from '@/lib/server/action-cards';
import type { OutlookData } from '@/lib/server/outlook';
import type { SessionView } from '@/lib/server/categorization-session';

interface CategorizationAccountOption {
  id: string;
  accountNumber: string;
  accountName: string;
  gaapType: string;
}

/** A dynamic, situation-derived suggestion chip shown under the chat composer. */
export interface SuggestionChip {
  label: string;
  prompt: string;
}

interface Props {
  /**
   * When true (URL ?onboarding=start, set by the dashboard welcome takeover's
   * "Set up my company" chip), eagerly load the onboarding status and render
   * OnboardingPanel even for fresh orgs whose onboarding_state row doesn't
   * exist yet.
   */
  resumeOnboarding: boolean;
  /** The signed-in user's first name, for warm greetings (text opener + voice). */
  firstName: string;
  /**
   * When false, the realtime voice surface is hidden entirely (no auto-start,
   * no UI). Non-super-admin users still see OnboardingPanel + ChatBox — the
   * text path drives the same onboarding flow without voice. The
   * /api/ai/realtime/token endpoint is also gated server-side so a UI bypass
   * can't mint a paid Realtime session.
   */
  canRealtime: boolean;
  /**
   * Server-rendered cards from page.tsx. The TaskCardsPanel uses these for
   * fast first paint and then takes over with its 15s poll loop.
   */
  initialCards: ActionCard[];
  /**
   * Server-rendered outlook for the right rail. Same first-paint pattern as
   * initialCards; the OutlookPanel re-fetches only when the user changes the
   * window dropdown.
   */
  initialOutlook: OutlookData;
  /**
   * When true (URL has ?categorize=...), the center column renders the
   * categorization workspace instead of ChatBox + welcome panels.
   */
  categorizeMode: boolean;
  categorizationSessionIdParam: string | null;
  initialCategorizationSession: SessionView | null;
  categorizationAccountOptions: CategorizationAccountOption[];
}

/**
 * Single source of truth for /ai-chat session state. Two writers (voice mode
 * tool-result handler, text chat tool-result handler) plus the eager fetch
 * below all converge on the same setOnboarding here, so only one
 * OnboardingPanel ever renders no matter how the user kicked it off.
 *
 * Also owns refs into ChatBox and VoiceMode so the additive cards panel can
 * inject AI prompts into whichever surface is currently active.
 */
export function AiChatWorkspace({
  resumeOnboarding,
  firstName,
  canRealtime,
  initialCards,
  initialOutlook,
  categorizeMode,
  categorizationSessionIdParam,
  initialCategorizationSession,
  categorizationAccountOptions,
}: Props) {
  const router = useRouter();
  const {
    setChatChannel,
    registerOnboardingToolResultHandler,
    seedPrompt,
    pageHandoff,
    consumePageHandoff,
  } = useAssistant();
  const [onboarding, setOnboarding] = useState<OnboardingStatusView | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('idle');
  const [voiceActivity, setVoiceActivity] = useState<VoiceActivity>('idle');
  const [chatPending, setChatPending] = useState(false);
  const [displayFirstName, setDisplayFirstName] = useState(firstName);
  const [realtimeEnabled, setCanRealtime] = useState(canRealtime);
  const [pendingPlaidItemId, setPendingPlaidItemId] = useState<string | null>(null);
  // In-memory only — resets on navigation. Only meaningful at lg+ where the
  // side panels actually render; the toggle button is hidden below lg so
  // narrow-screen users can't get into a state where this matters. Default
  // to expanded when arriving from the welcome takeover -- the
  // onboarding-driven useEffect below handles the in-progress case once
  // get_onboarding_status returns.
  const [layoutExpanded, setLayoutExpanded] = useState(resumeOnboarding);
  // In-memory only. Default false so realtime-eligible users see the voice
  // card on first paint; hiding unmounts <VoiceMode> and tears down any
  // active WebRTC session — acceptable for v1 per the design.
  const [voiceCardHidden, setVoiceCardHidden] = useState(false);
  // Proactive opener + dynamic chips, fetched once on mount from /api/ai/opener.
  // Greeting is null for orgs still onboarding (the route short-circuits before
  // any LLM call) — ChatBox then keeps the existing onboarding greeting instead.
  const [openerGreeting, setOpenerGreeting] = useState<string | null>(null);
  const [chips, setChips] = useState<SuggestionChip[]>([]);
  const openerFetchedRef = useRef(false);

  const chatBoxRef = useRef<ChatBoxHandle>(null);
  const voiceModeRef = useRef<VoiceModeHandle>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai-chat/bootstrap', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { firstName?: string | null; canRealtime?: boolean };
        if (cancelled) return;
        setDisplayFirstName(data.firstName ?? '');
        setCanRealtime(data.canRealtime === true);
      } catch {
        // Optional metadata only. Text chat remains functional without it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (categorizeMode || openerFetchedRef.current) return;
    openerFetchedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai/opener?light=1');
        if (!res.ok) return;
        const data = (await res.json()) as { greeting: string | null; chips: SuggestionChip[] };
        if (cancelled) return;
        setOpenerGreeting(data.greeting);
        setChips(data.chips ?? []);
      } catch {
        // ignore — the chat still works without a proactive opener
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [categorizeMode]);

  // Handoff from the floating sidecar: when the user issued a navigate
  // command there that landed them here, the sidecar parks their last user
  // message in pageHandoff so the conversation continues in the inline
  // ChatBox instead of vanishing with the now-hidden bar. Guard by id so a
  // remount can't replay an already-injected handoff.
  const lastSeenHandoffIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!pageHandoff) return;
    if (lastSeenHandoffIdRef.current === pageHandoff.id) return;
    lastSeenHandoffIdRef.current = pageHandoff.id;
    chatBoxRef.current?.inject(pageHandoff.text);
    consumePageHandoff();
  }, [pageHandoff, consumePageHandoff]);

  // Eagerly load onboarding status when the user arrives via
  // ?onboarding=start (set by the dashboard welcome takeover). The fetch is
  // read-only -- get_onboarding_status only reads onboarding_state -- so it's
  // safe even for fresh orgs whose row doesn't exist yet; the default phase
  // it returns gives OnboardingPanel a valid starting state for the
  // business_info step.
  useEffect(() => {
    if (!resumeOnboarding) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai/realtime/tools', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'get_onboarding_status', args: {} }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as OnboardingStatusView & { error?: string };
        if (cancelled || data.error || !data.phase) return;
        setOnboarding(data);
      } catch {
        // ignore -- user can still trigger onboarding via the assistant
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resumeOnboarding]);

  // Strip ?onboarding=start from the URL once we've consumed it so a refresh
  // doesn't re-fire the eager fetch (and so the user can paste the URL
  // without dragging the onboarding flag along).
  useEffect(() => {
    if (!resumeOnboarding || typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (url.searchParams.has('onboarding')) {
      url.searchParams.delete('onboarding');
      window.history.replaceState({}, '', url.toString());
    }
  }, [resumeOnboarding]);

  // Unified busy gate. Cards panel disables click handlers when ANY surface
  // is non-idle — prevents a duplicate inject while the AI is still
  // responding. Voice activity is irrelevant unless the connection is up.
  const busy =
    chatPending || (voiceStatus === 'connected' && voiceActivity !== 'idle');

  // Onboarding is "active" when there's an in-progress panel — i.e. the
  // user has prior progress that isn't yet complete. A completed onboarding
  // (.completed === true) does NOT count: the panel renders as "✓ Complete"
  // but the user is effectively done, so the inline ChatBox should stay
  // visible. Categorize mode takes over the column entirely, so
  // onboarding-driven UI doesn't apply there.
  const onboardingActive =
    !categorizeMode && onboarding != null && !onboarding.completed;

  // When onboarding becomes active, auto-expand the layout so the panel
  // gets full width instead of being squeezed between the side rails.
  // Once active, we don't re-collapse on transitions (e.g. completing
  // onboarding) -- the user can still toggle the layout via the button
  // in the header. The dep on onboardingActive means manual collapse
  // while onboarding is on screen sticks until something else flips it.
  useEffect(() => {
    if (onboardingActive) {
      setLayoutExpanded(true);
    }
  }, [onboardingActive]);
  // Configure the floating sidecar for onboarding while onboarding is active.
  // The inline ChatBox is the primary surface (it already hits /api/ai/chat
  // with the onboarding tools), but if the user opens the floating sidecar
  // from ChatBox's header, it needs to (a) route to the onboarding endpoint
  // and (b) write tool results back to our `onboarding` state so
  // OnboardingPanel keeps updating. We don't auto-open the sidecar — the
  // user has the inline chat and can opt in to the floating one.
  useEffect(() => {
    if (!onboardingActive) return;
    setChatChannel('onboarding');
    const unsubscribe = registerOnboardingToolResultHandler((view) => {
      // The sidecar already gated on phase being a string before dispatching,
      // so this cast is safe — the shape matches OnboardingStatusView.
      setOnboarding(view as unknown as OnboardingStatusView);
    });
    return () => {
      unsubscribe();
      setChatChannel('default');
    };
  }, [onboardingActive, setChatChannel, registerOnboardingToolResultHandler]);

  const handleCardAction = useCallback(
    (card: ActionCard) => {
      if (card.action.kind === 'plaid-relink') {
        setPendingPlaidItemId(card.action.plaidItemId);
        return;
      }
      if (card.action.kind === 'open-categorization-workspace') {
        // Push a query-param URL — the page re-renders server-side, fetches
        // the session + account options, and the center column flips to the
        // workspace. ?categorize=open creates-or-resumes; the workspace
        // canonicalizes the URL to ?categorize=<sessionId> after load.
        router.push('/ai-chat?categorize=open');
        return;
      }
      if (card.action.kind === 'navigate') {
        router.push(card.action.href);
        return;
      }
      // ask-ai: route purely on connection state. No permission check —
      // when realtime expands beyond super-admins, voiceStatus stays 'idle'
      // for non-realtime users and prompts naturally fall through to text.
      // When the inline chat is hidden (onboarding without voice), there's
      // no chatBoxRef to inject into — seed the prompt into the floating
      // widget instead so the card-driven flow keeps working.
      if (voiceStatus === 'connected') {
        voiceModeRef.current?.inject(card.action.prompt);
      } else if (chatBoxRef.current) {
        chatBoxRef.current.inject(card.action.prompt);
      } else {
        seedPrompt(card.action.prompt, { mode: 'bar' });
      }
    },
    [voiceStatus, router, seedPrompt],
  );

  return (
    <>
      <div className="hidden lg:flex lg:justify-end">
        <button
          type="button"
          onClick={() => setLayoutExpanded((v) => !v)}
          title={layoutExpanded ? 'Collapse to default layout' : 'Expand to full width'}
          aria-label={layoutExpanded ? 'Collapse to default layout' : 'Expand to full width'}
          aria-pressed={layoutExpanded}
          className="inline-flex items-center justify-center rounded-md border border-zinc-300 p-1.5 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {layoutExpanded ? (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="4 14 10 14 10 20" />
              <polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="3" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          )}
        </button>
      </div>
      {/*
        Layout: at lg+ use CSS Grid with explicit 280px / 1fr / 280px columns
        so the 3-column layout is guaranteed and doesn't depend on a chain of
        flex-1 / min-h-0 distributions that can collapse under banners or
        viewport-unit edge cases. Below lg, stack as a flex column. When the
        user expands the layout (layoutExpanded), drop the side columns and
        let the center take the whole row.
      */}
      <div
        className={
          layoutExpanded
            ? 'flex flex-col gap-6'
            : 'flex flex-col gap-6 lg:grid lg:grid-cols-[280px_1fr]'
        }
      >
        <aside
          className={`w-full${layoutExpanded ? ' lg:hidden' : ''}`}
        >
          <TaskCardsPanel
            initialCards={initialCards}
            busy={busy}
            onAction={handleCardAction}
          />
        </aside>
        <div
          className="flex min-w-0 flex-col gap-4"
        >
          {categorizeMode ? (
            <CategorizationWorkspace
              sessionIdFromUrl={categorizationSessionIdParam}
              accountOptions={categorizationAccountOptions}
              initialSession={initialCategorizationSession}
            />
          ) : (
            <>
              {realtimeEnabled && !voiceCardHidden && (
                <VoiceMode
                  ref={voiceModeRef}
                  autoStart={false}
                  welcomeName={displayFirstName}
                  onboarding={onboarding}
                  setOnboarding={setOnboarding}
                  voiceStatus={voiceStatus}
                  setVoiceStatus={setVoiceStatus}
                  onActivityChange={setVoiceActivity}
                  onHide={() => setVoiceCardHidden(true)}
                />
              )}
              {realtimeEnabled && voiceCardHidden && (
                <button
                  type="button"
                  onClick={() => setVoiceCardHidden(false)}
                  className="self-start rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
                >
                  🎙 Show voice mode
                </button>
              )}
              {onboarding && (
                <OnboardingPanel
                  key={onboarding.phase}
                  status={onboarding}
                  onChanged={setOnboarding}
                  onClose={() => setOnboarding(null)}
                />
              )}
              <ChatBox
                ref={chatBoxRef}
                onboarding={onboarding}
                setOnboarding={setOnboarding}
                onPendingChange={setChatPending}
                onboardingMode={onboardingActive}
                openerGreeting={openerGreeting}
                chips={chips}
              />
            </>
          )}
        </div>
      </div>
      {pendingPlaidItemId && (
        <PlaidRelinkLauncher
          plaidItemId={pendingPlaidItemId}
          onClose={() => setPendingPlaidItemId(null)}
        />
      )}
    </>
  );
}
