'use client';

import { useEffect, useRef } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';

export interface GuideGroup {
  key: string;
  contactName: string;
  count: number;
  totalAmount: number;
  sampleDescription: string | null;
  /** Category the group was AI-categorized as (verify mode). null = mixed. */
  categoryName?: string | null;
  transactionIds: string[];
}

interface Props {
  groups: GuideGroup[];
  /** 0-based index of the active group, already clamped to [0, groups.length-1]. */
  activeIndex: number;
  /** 'deposits' = the "what is this deposit?" flow; 'verify' = confirm the AI's
   *  categorizations ("I categorized X as Y — sound good?"). */
  mode?: 'triage' | 'deposits' | 'verify';
}

function formatDollars(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

/**
 * Spotlight + AI-driven walkthrough of /transactions?filter=to_review&guide=1.
 *
 * Active group is URL-driven via &guideIndex=N. Next/Prev push new URLs;
 * after a successful categorize_transaction_ids call the page refreshes,
 * the categorized group falls out, and the server clamps guideIndex back
 * into range — so the user always lands on a valid active group.
 *
 * Spotlight: a fixed backdrop dims the viewport. Active group's <tr>s pop
 * above it via z-index. The sidecar already sits at a higher z-index.
 */
export function GuidedTriage({ groups, activeIndex, mode = 'triage' }: Props) {
  const { seedPrompt, pinnedRule, pinnedContact } = useAssistant();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const lastSeededKeyRef = useRef<string | null>(null);
  const isFirstSeedRef = useRef(true);
  const active = groups[activeIndex] ?? null;
  const activeKey = active?.key ?? null;

  // Apply spotlight classes to rows by data-guide-group attr. Runs after
  // every render (server refresh swaps rows in/out of the DOM).
  useEffect(() => {
    if (!activeKey) return;
    const allRows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-guide-group]'),
    );
    for (const el of allRows) {
      const isActive = el.dataset.guideGroup === activeKey;
      el.classList.toggle('rs-guide-active', isActive);
      el.classList.toggle('rs-guide-dim', !isActive);
    }
    document.body.classList.add('rs-guide-mode');
    return () => {
      for (const el of allRows) {
        el.classList.remove('rs-guide-active', 'rs-guide-dim');
      }
      document.body.classList.remove('rs-guide-mode');
    };
  }, [activeKey, groups]);

  // Scroll active group into view.
  useEffect(() => {
    if (!activeKey) return;
    const first = document.querySelector<HTMLElement>(
      `[data-guide-group="${CSS.escape(activeKey)}"]`,
    );
    first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeKey]);

  // Seed the AI exactly once per active group transition.
  useEffect(() => {
    if (!active) return;
    if (lastSeededKeyRef.current === active.key) return;
    // Hold the auto-advance while a decision card (rule / contact-align) is open —
    // the user must answer it first. When the card clears, this effect re-runs
    // (pinnedRule/pinnedContact are in the deps) and seeds the next group.
    if (pinnedRule || pinnedContact) return;
    lastSeededKeyRef.current = active.key;
    const sample = active.sampleDescription
      ? ` Sample description: "${active.sampleDescription.slice(0, 120)}".`
      : '';
    const remaining = groups.length;
    const isMulti = active.count > 1;
    const groupPhrase = isMulti
      ? `these ${active.count} deposits from ${active.contactName} (totaling ${formatDollars(active.totalAmount)})`
      : `this ${formatDollars(active.totalAmount)} deposit from ${active.contactName}`;
    // Force bar mode only on the first seed of this guided session — keeps
    // the chat anchored at the bottom-center on entry but respects the user's
    // choice if they later switch to the side panel.
    // hidden:true → the AI's question shows, but this instruction seed doesn't
    // clutter the chat. mode:'bar' on the first seed opens the dock.
    const opts = isFirstSeedRef.current
      ? ({ mode: 'bar', hidden: true } as const)
      : ({ hidden: true } as const);
    isFirstSeedRef.current = false;
    const catPhrase = active.categoryName ? `as "${active.categoryName}"` : 'across a few categories';
    const prompt =
      mode === 'verify'
        ? // Static verify rules live in the system prompt (VERIFY REVIEW MODE) —
          // keep this per-group seed tiny so transitions stay fast.
          `Next group — ${remaining === 1 ? 'last one' : `${remaining} left`}. ${active.count} transaction${active.count === 1 ? '' : 's'} for ${active.contactName} I categorized ${catPhrase}, totaling ${formatDollars(active.totalAmount)}.${sample} ` +
          `Confirm in a short line like "I categorized ${active.contactName} ${catPhrase} — sound good?" and END with [[suggestions: Yes | No]]. Follow the verify-review rules in your system prompt for what to do on Yes / No.`
        : mode === 'deposits'
        ? // Static deposit playbook lives in the system prompt (DEPOSIT REVIEW
          // MODE) — keep this per-group seed tiny so transitions stay fast.
          `Next deposit group — ${remaining === 1 ? 'last one' : `${remaining} left`}. This group is ${groupPhrase}.${sample} ` +
          `Ask me what it's for, following the deposit-review instructions in your system prompt.`
        : `I'm in guided triage. There ${remaining === 1 ? 'is 1 group' : `are ${remaining} groups`} left to review. ` +
          `The active group is ${active.count} ${active.count === 1 ? 'transaction' : 'transactions'} for ` +
          `${active.contactName} totaling ${formatDollars(active.totalAmount)}.${sample} ` +
          `Ask me one short question to determine the right CoA account, then once I confirm, ` +
          `call categorize_transaction_ids with ALL of pageContext.data.guide.transactionIds at once.`;
    seedPrompt(prompt, opts);
  }, [active, groups.length, seedPrompt, mode, pinnedRule, pinnedContact]);

  // Build a URL preserving every param except guideIndex (which we set).
  const buildIndexHref = (idx: number): string => {
    const next = new URLSearchParams(searchParams.toString());
    if (idx <= 0) next.delete('guideIndex');
    else next.set('guideIndex', String(idx));
    const qs = next.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  const goPrev = () => router.push(buildIndexHref(activeIndex - 1));
  const goNext = () => router.push(buildIndexHref(activeIndex + 1));

  // Exit drops both guide=1 and guideIndex; the user lands on the same
  // /transactions?filter=to_review view they'd see without guided mode.
  const exitGuide = () => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete('guide');
    next.delete('guideIndex');
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  if (groups.length === 0) {
    return (
      <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-100">
        ✓ {mode === 'verify' ? 'All AI-categorized transactions reviewed.' : mode === 'deposits' ? 'All deposits reviewed.' : 'All transactions reviewed.'} Guided review complete.
      </div>
    );
  }

  const canPrev = activeIndex > 0;
  const canNext = activeIndex < groups.length - 1;

  return (
    <>
      {/* Backdrop: dims the viewport. Pointer-events-none so the user can
          still click the active group + the sidecar (both at higher z-index). */}
      <div
        className="pointer-events-none fixed inset-0 z-20 bg-zinc-900/30 dark:bg-black/50"
        aria-hidden="true"
      />
      {/* Floating control bar — sits above the backdrop, top-right. Lets the
          user step through groups without categorizing the current one.
          The rs-guide-controls class is shifted leftward when the sidecar is
          docked in side mode (see inline style below) so the buttons stay
          visible alongside the panel. */}
      <div className="rs-guide-controls fixed right-6 top-20 z-40 flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-2 py-1.5 shadow-md dark:border-zinc-700 dark:bg-zinc-900">
        <span className="px-1 text-xs text-zinc-500 dark:text-zinc-400">
          Group {activeIndex + 1} of {groups.length}
        </span>
        <button
          type="button"
          onClick={goPrev}
          disabled={!canPrev}
          className="rounded px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-300 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:disabled:text-zinc-600"
        >
          ← Previous
        </button>
        <button
          type="button"
          onClick={goNext}
          disabled={!canNext}
          className="rounded px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-300 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:disabled:text-zinc-600"
        >
          Next →
        </button>
        <span className="mx-1 h-4 w-px bg-zinc-200 dark:bg-zinc-700" aria-hidden="true" />
        <button
          type="button"
          onClick={exitGuide}
          aria-label="Exit guided review"
          title="Exit guided review"
          className="rounded px-2 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          ✕
        </button>
      </div>
      <style>{`
        body.rs-guide-mode .rs-guide-active {
          position: relative;
          z-index: 30;
          background-color: rgb(239 246 255 / 0.9);
        }
        body.rs-guide-mode :is(.dark) .rs-guide-active,
        :is(.dark) body.rs-guide-mode .rs-guide-active {
          background-color: rgb(30 58 138 / 0.4);
        }
        body.rs-guide-mode .rs-guide-dim {
          opacity: 0.35;
        }
        /* Shift the Prev/Next bar left when the AI sidecar is docked on the
           right (panel ≈ 380px wide; matches globals.css). */
        body.rs-sidecar-side .rs-guide-controls {
          right: calc(380px + 1.5rem);
        }
      `}</style>
    </>
  );
}
