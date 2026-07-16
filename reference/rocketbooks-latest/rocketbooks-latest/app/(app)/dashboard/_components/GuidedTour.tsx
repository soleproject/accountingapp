'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';
import { useTourMuted } from '@/components/ai-assistant/useTourMuted';
import { addBusinessAction } from '@/app/(app)/businesses/_actions/addBusiness';

interface Step {
	path: string;
	title: string;
	narration: string;
}

/**
 * Regular ("platform pages") tour. Narrates each page via the AI
 * sidecar (same visual surface as the cool tour) and actually
 * navigates to each page as it talks about it — so the user sees the
 * real screen instead of a tooltip pointing at the sidebar.
 *
 * Step machine mirrors CoolTourRunner: router.push → wait for the
 * page to settle → pushNarration into the sidecar → waitForSpeechToEnd
 * (or fall back to a length-based delay when muted). Pause / Skip
 * control pills sit top-right of the viewport, same place the cool
 * tour puts them.
 *
 * As each step runs, we also dispatch `rs:tour-nav-spotlight` so the
 * Sidebar wraps the matching nav item in a glowing ring — the user's eye
 * lands on where the page lives, not just the page itself.
 */
const STEPS: Step[] = [
	{
		path: '/dashboard',
		title: 'Dashboard',
		narration:
			"Let me show you around. This is your dashboard — revenue, expenses, and recent activity at a glance. One-stop view of how the business is doing. By the way, if you have a question about any page as we go, just type it in the chat — I'll pause the tour, answer, and then ask if you're ready to move on.",
	},
	{
		path: '/pulse',
		title: 'Pulse',
		narration:
			"Pulse is the deeper read on the numbers — cash flow trajectory, daily P&L, top categories, A/R and A/P aging. The dashboard tells you what; Pulse tells you why.",
	},
	{
		path: '/ai-chat',
		title: 'AI Assistant',
		narration:
			"This is where you and I work together. Ask anything about your books, categorize transactions, or walk through onboarding from right here. I'm also available as a floating chat on every other page.",
	},
	{
		path: '/tasks',
		title: 'Tasks',
		narration:
			"Tasks is the to-do list I generate for you — things that need your eyes, like uncategorized transactions, missing receipts, or pending approvals. Work through it top-down and your books stay current.",
	},
	{
		path: '/invoices',
		title: 'Invoices',
		narration:
			"Create, send, and track invoices. I can draft one from a description, or show you who still owes you money.",
	},
	{
		path: '/bills',
		title: 'Bills',
		narration:
			"Bills tracks what you owe and when it's due. I'll record bills from receipts and match incoming payments to the right bill automatically.",
	},
	{
		path: '/receipts',
		title: 'Receipts',
		narration:
			"Upload receipts here and I'll extract the vendor, total, and date — then match them against your bank transactions automatically.",
	},
	{
		path: '/transactions',
		title: 'Transactions',
		narration:
			"The ledger of everything moving through your accounts. I categorize them for you, but you can override any line here and I'll learn from it.",
	},
	{
		path: '/reports',
		title: 'Reports',
		narration:
			"Income Statement, Balance Sheet, and Trial Balance. Switch between cash and accrual basis any time.",
	},
	{
		path: '/contacts',
		title: 'Contacts',
		narration:
			"Customers and vendors live here. I keep them deduplicated and link them automatically when categorizing transactions.",
	},
	{
		path: '/integrations/plaid',
		title: 'Bank Connections',
		narration:
			"Connect your bank accounts through Plaid so new transactions stream in automatically. Once this is set up, you'll never upload another statement.",
	},
	{
		path: '/integrations/qbo',
		title: 'QuickBooks',
		narration:
			"Already using QuickBooks Online? Link it here and I'll mirror your chart of accounts and existing balances so nothing has to start from scratch.",
	},
	{
		path: '/imports',
		title: 'Imports',
		narration:
			"Imports is where you bring in historical data — PDF bank statements, CSV exports, or QuickBooks files. I'll parse them and stage the transactions for review.",
	},
	{
		path: '/settings',
		title: 'Settings',
		narration:
			"Settings is where you tweak reporting basis, fiscal year, and other preferences. The Tour button up top brings me back any time.",
	},
];

const NARRATION_MS_PER_CHAR = 65;
const NARRATION_PADDING_MS = 700;
const NARRATION_MAX_MS = 22000;
const PAGE_SETTLE_MS = 500;

function narrationDelay(text: string): number {
	return Math.min(text.length * NARRATION_MS_PER_CHAR + NARRATION_PADDING_MS, NARRATION_MAX_MS);
}

const ASK_QUESTION_PROMPTS = [
	"Tour paused. What's on your mind?",
	"I paused the tour — fire away.",
	'Paused. What questions do you have?',
	"Hit pause for you. What's up?",
	"On hold. What can I clarify?",
] as const;

function pickAskQuestionPrompt(): string {
	return ASK_QUESTION_PROMPTS[Math.floor(Math.random() * ASK_QUESTION_PROMPTS.length)];
}

function spotlightSidebarNav(href: string | null): void {
	if (typeof window === 'undefined') return;
	window.dispatchEvent(new CustomEvent('rs:tour-nav-spotlight', { detail: { href } }));
}

export function GuidedTour() {
	const router = useRouter();
	const tourMute = useTourMuted();
	const {
		pushNarration,
		requestSidecarOpen,
		regularTourActive,
		endRegularTour,
		registerUserInterjectionHandler,
		registerReplyCompleteHandler,
		registerAskQuestionHandler,
		tourPaused,
		setTourPaused,
	} = useAssistant();

	const [stepIdx, setStepIdx] = useState(0);
	const [running, setRunning] = useState(false);
	const [showEndCard, setShowEndCard] = useState(false);
	/** True between "user asked a question mid-tour" and either resume or
	 *  another question. Shapes the pill — when set, the Pause button
	 *  reads "Move on" and clicking it resumes immediately. */
	const [interjected, setInterjected] = useState(false);

	// Mirror context tourPaused into a ref so the step machine can poll
	// without re-rendering on every tick. Keep it in sync.
	const pausedRef = useRef(false);
	useEffect(() => {
		pausedRef.current = tourPaused;
	}, [tourPaused]);
	// Latest user-interjection text — checked after a reply completes to
	// decide whether the user already said "continue" before the AI
	// finished answering.
	const lastInterjectionRef = useRef<string | null>(null);
	const runningRef = useRef(false);

	// Reset and arm the step machine when the tour goes active so a
	// re-entry from the picker starts at step 0.
	useEffect(() => {
		if (regularTourActive) {
			setStepIdx(0);
			setRunning(true);
			runningRef.current = true;
			setShowEndCard(false);
			setInterjected(false);
			lastInterjectionRef.current = null;
		} else {
			setRunning(false);
			runningRef.current = false;
			setShowEndCard(false);
		}
	}, [regularTourActive]);

	// Mirror tour-mute too so the speech-wait helpers see the latest value
	// without re-triggering the step machine when the user toggles mute.
	const mutedRef = useRef(tourMute.muted);
	useEffect(() => {
		mutedRef.current = tourMute.muted;
		if (tourMute.muted && typeof window !== 'undefined' && 'speechSynthesis' in window) {
			window.speechSynthesis.cancel();
		}
	}, [tourMute.muted]);

	// Open the sidecar in bar mode so narration bubbles are visible. Same
	// surface as cool tour.
	useEffect(() => {
		if (running) requestSidecarOpen('bar');
	}, [running, requestSidecarOpen]);

	const sleep = useCallback(
		(ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)),
		[],
	);

	// Pause-aware sleep: bails early when paused flips true.
	const sleepUntilPaused = useCallback(async (ms: number) => {
		const target = Date.now() + ms;
		while (Date.now() < target && !pausedRef.current) {
			const slice = Math.min(120, target - Date.now());
			if (slice <= 0) break;
			await new Promise<void>((resolve) => window.setTimeout(resolve, slice));
		}
	}, []);

	// Wait for the browser's speech synthesis to finish. Tops up to
	// fallbackMs when muted so the runner keeps the same pacing without
	// audio.
	const waitForSpeechToEnd = useCallback(
		async (fallbackMs: number, maxMs: number = 30000) => {
			if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
				await sleepUntilPaused(fallbackMs);
				return;
			}
			const startedAt = Date.now();
			await sleep(300);
			if (pausedRef.current) return;
			while (
				window.speechSynthesis.speaking
				&& Date.now() - startedAt < maxMs
				&& !pausedRef.current
			) {
				await sleep(150);
			}
			if (pausedRef.current) return;
			const remaining = fallbackMs - (Date.now() - startedAt);
			if (remaining > 0) await sleepUntilPaused(remaining);
		},
		[sleep, sleepUntilPaused],
	);

	// Wait for a full speech CYCLE: first for speak() to begin, then for
	// it to finish. Used after the AI answers an interjected question —
	// reply-complete fires before the sidecar's auto-speak effect has
	// run, so we have to wait for speech to START (otherwise our
	// "Ready to move on?" narration would land before any TTS plays).
	// maxStartMs caps "speech never started" cases (TTS unsupported,
	// user muted, etc.) so the runner doesn't stall the move-on prompt.
	const waitForSpeechCycle = useCallback(
		async (maxStartMs: number = 8000, maxEndMs: number = 60000) => {
			if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
			const startedAt = Date.now();
			while (
				!window.speechSynthesis.speaking
				&& Date.now() - startedAt < maxStartMs
			) {
				await sleep(120);
			}
			while (
				window.speechSynthesis.speaking
				&& Date.now() - startedAt < maxEndMs
			) {
				await sleep(150);
			}
		},
		[sleep],
	);

	// Heuristics for "let's keep going". Two passes:
	//
	//   1. Strict: standalone affirmations / single-verb commands.
	//      ("yes", "continue", "let's go", "proceed.")
	//
	//   2. Phrasal: any message that names the tour AND contains a
	//      forward-motion verb. Catches the natural variants users
	//      actually type — "let's just proceed with the tour", "back
	//      to the tour", "continue the tour", "go on with the tour",
	//      "next part of the tour".
	//
	// The phrasal pass requires the word "tour" so questions ABOUT
	// the tour without a verb ("how long is this tour?") don't match.
	// The verb-only fallback in pass 1 requires a standalone form
	// so it doesn't fire on "continue what?" or "next page would be…".
	const STANDALONE_CONTINUE_RE = /^(yes|yep|yeah|yup|sure|ok(ay)?|continue|go on|move on|next|let'?s go|keep going|proceed|ready|go(?: ahead)?|please continue|sounds good|all good|done|got it|onward|resume|carry on)\b[.!?\s]*$/i;
	const FORWARD_VERB_RE = /\b(continue|proceed|move on|go on|keep going|next|back|finish|resume|carry on|on with|move along)\b/i;
	const TOUR_RE = /\btour\b/i;

	const looksLikeContinue = useCallback((text: string) => {
		const t = text.trim();
		if (!t) return false;
		if (STANDALONE_CONTINUE_RE.test(t)) return true;
		if (TOUR_RE.test(t) && FORWARD_VERB_RE.test(t)) return true;
		return false;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const resumeTour = useCallback(() => {
		setInterjected(false);
		lastInterjectionRef.current = null;
		setTourPaused(false);
	}, [setTourPaused]);

	// Sidecar header's "Ask a question" button fires this. Pause + push a
	// short narration inviting the question; the existing interjection
	// flow (auto-pause + Ready-to-move-on prompt) takes it from there.
	useEffect(() => {
		if (!regularTourActive) return;
		const unsubscribe = registerAskQuestionHandler(() => {
			if (!runningRef.current) return;
			setInterjected(true);
			setTourPaused(true);
			pushNarration(pickAskQuestionPrompt());
		});
		return unsubscribe;
	}, [regularTourActive, registerAskQuestionHandler, pushNarration, setTourPaused]);

	// Auto-pause when the user types a chat message during the tour. If
	// the message itself was a "let's continue", flip out of any prior
	// interjected state immediately rather than pausing — the user is
	// answering our "Ready to move on?" prompt.
	useEffect(() => {
		if (!regularTourActive) return;
		const unsubscribe = registerUserInterjectionHandler((text) => {
			if (!runningRef.current) return;
			lastInterjectionRef.current = text;
			if (interjected && looksLikeContinue(text)) {
				resumeTour();
				return;
			}
			// New question (or first interjection of the tour) — pause and
			// wait for the AI to answer. Reply-complete handler will push
			// the "Ready to move on?" prompt.
			setInterjected(true);
			setTourPaused(true);
		});
		return unsubscribe;
	}, [regularTourActive, registerUserInterjectionHandler, interjected, looksLikeContinue, resumeTour, setTourPaused]);

	// After the AI finishes streaming a reply, prompt "Ready to move on?"
	// — but only if (a) the tour is running and (b) the user's last
	// interjection wasn't itself a "continue" command (which we already
	// handled by resuming).
	//
	// IMPORTANT: reply-complete fires when streaming ends, before the
	// sidecar's auto-speak effect has had a chance to actually start
	// reading the answer aloud. Pushing the move-on narration
	// synchronously would replace the not-yet-spoken answer in the
	// auto-speak queue (which only takes the LAST assistant turn). So
	// we wait for the answer's TTS cycle to start AND finish before
	// pushing the prompt.
	useEffect(() => {
		if (!regularTourActive) return;
		const unsubscribe = registerReplyCompleteHandler(() => {
			if (!runningRef.current) return;
			if (!interjected) return;
			const last = lastInterjectionRef.current ?? '';
			if (looksLikeContinue(last)) return; // already resumed
			void (async () => {
				await waitForSpeechCycle();
				if (!runningRef.current) return;
				if (!interjected) return;
				pushNarration(
					"Ready to move on with the tour? Just say 'continue' (or 'yes') in the chat, or hit Move on up top.",
				);
			})();
		});
		return unsubscribe;
	}, [regularTourActive, registerReplyCompleteHandler, interjected, looksLikeContinue, pushNarration, waitForSpeechCycle]);

	// Step machine. One in-flight async loop per stepIdx change; the
	// cleanup flag short-circuits it if the user skips or unmounts mid-step.
	useEffect(() => {
		if (!running) return;
		const step = STEPS[stepIdx];
		if (!step) {
			setShowEndCard(true);
			setRunning(false);
			return;
		}

		let cancelled = false;
		(async () => {
			try {
				router.push(step.path);
				await sleep(PAGE_SETTLE_MS);
				if (cancelled) return;
				while (pausedRef.current && !cancelled) {
					await sleep(150);
				}
				if (cancelled) return;

				spotlightSidebarNav(step.path);
				pushNarration(step.narration);
				await waitForSpeechToEnd(narrationDelay(step.narration));
				if (cancelled) return;

				// Post-step pause-hold so Pause clicked between steps actually
				// holds at the boundary.
				while (pausedRef.current && !cancelled) {
					await sleep(150);
				}
				spotlightSidebarNav(null);
				if (!cancelled) setStepIdx((i) => i + 1);
			} catch (err) {
				if (cancelled) return;
				console.warn('[regular-tour] step failed', err);
				spotlightSidebarNav(null);
				setStepIdx((i) => i + 1);
			}
		})();

		return () => {
			cancelled = true;
			spotlightSidebarNav(null);
		};
		// pushNarration / router / sleep / waitForSpeechToEnd are stable refs.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [stepIdx, running]);

	const skip = useCallback(() => {
		setRunning(false);
		setShowEndCard(false);
		if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
			window.speechSynthesis.cancel();
		}
		spotlightSidebarNav(null);
		endRegularTour();
	}, [endRegularTour]);

	const finish = useCallback(() => {
		if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
			window.speechSynthesis.cancel();
		}
		spotlightSidebarNav(null);
		setShowEndCard(false);
		endRegularTour();
	}, [endRegularTour]);

	const finishAndDashboard = useCallback(() => {
		finish();
		router.push('/dashboard');
	}, [finish, router]);

	const [createPending, startCreate] = useTransition();
	const [createError, setCreateError] = useState<string | null>(null);
	const finishAndCreateBusiness = useCallback(() => {
		setCreateError(null);
		startCreate(async () => {
			const r = await addBusinessAction();
			if (!r.ok || !r.redirectTo) {
				setCreateError(r.error ?? 'Failed to create business');
				return;
			}
			finish();
			if (r.redirectTo.startsWith('http')) {
				window.location.assign(r.redirectTo);
			} else {
				router.push(r.redirectTo);
			}
		});
	}, [finish, router]);

	if (!regularTourActive && !showEndCard) return null;

	const stepLabel = STEPS[stepIdx]?.title ?? '';

	return (
		<>
			{running && (
				<div className="fixed right-4 top-16 z-[80] flex flex-col items-end gap-1">
					<div className="flex items-center gap-2">
						<div className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 shadow-md dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
							Tour · {Math.min(stepIdx + 1, STEPS.length)} of {STEPS.length}
							{stepLabel && <span className="ml-1 text-zinc-400">· {stepLabel}</span>}
						</div>
						{interjected ? (
							<button
								type="button"
								onClick={resumeTour}
								aria-label="Move on with the tour"
								title="Move on with the tour"
								className="flex items-center gap-1.5 rounded-full border border-emerald-400 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 shadow-md hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200 dark:hover:bg-emerald-900/50"
							>
								<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
									<polygon points="5 3 19 12 5 21 5 3" />
								</svg>
								Move on
							</button>
						) : (
							<button
								type="button"
								onClick={() => setTourPaused(!tourPaused)}
								aria-label={tourPaused ? 'Resume the tour' : 'Pause the tour'}
								title={tourPaused ? 'Resume the tour' : 'Pause the tour'}
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
						)}
						<button
							type="button"
							onClick={skip}
							className="flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 shadow-md hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
						>
							<span aria-hidden="true">✕</span> Skip the tour
						</button>
					</div>
					<div className="rounded-full bg-zinc-900/85 px-2.5 py-1 text-[10px] font-medium text-zinc-100 shadow-md backdrop-blur-sm dark:bg-zinc-100/90 dark:text-zinc-900">
						{interjected
							? '💬 Ask anything else, or say "continue" to move on.'
							: '💬 Ask me a question below anytime — I\'ll wait.'}
					</div>
				</div>
			)}

			{showEndCard && (
				<div className="fixed inset-0 z-[80] flex items-center justify-center bg-zinc-950/50 px-4">
					<div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
						<div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
							🧭 Tour complete
						</div>
						<div className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
							That&rsquo;s the platform.
						</div>
						<p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
							You can replay this any time from the Tour button up top. I&rsquo;m
							always one chat away if you get stuck.
						</p>
						<div className="mt-4 flex flex-col gap-2">
							<button
								type="button"
								onClick={finishAndCreateBusiness}
								disabled={createPending}
								className="rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-left text-sm font-medium text-zinc-800 hover:border-violet-300 hover:bg-violet-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-violet-700 dark:hover:bg-violet-950/30"
							>
								{createPending ? '✨ Creating your new business…' : '✨ Create a new business'}
							</button>
							<button
								type="button"
								onClick={finishAndDashboard}
								disabled={createPending}
								className="rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-left text-sm font-medium text-zinc-800 hover:border-violet-300 hover:bg-violet-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-violet-700 dark:hover:bg-violet-950/30"
							>
								🏠 Take me to the dashboard
							</button>
							<button
								type="button"
								onClick={finish}
								disabled={createPending}
								className="rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-left text-sm font-medium text-zinc-800 hover:border-violet-300 hover:bg-violet-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-violet-700 dark:hover:bg-violet-950/30"
							>
								👍 Got it — close the tour
							</button>
						</div>
						{createError && (
							<div className="mt-2 text-xs text-red-600 dark:text-red-400">{createError}</div>
						)}
					</div>
				</div>
			)}
		</>
	);
}
