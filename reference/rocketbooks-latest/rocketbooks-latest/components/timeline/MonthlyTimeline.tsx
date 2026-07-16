'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { MilestoneStep, MilestoneGroup, MilestoneStatus } from '@/lib/monthly-timeline';
import { openClientBooksAction } from '@/app/(enterprise)/enterprise/_actions/openBooks';

/** When rendered for a firm's CLIENT (enterprise dashboard/client pages), a step
 *  must open that client's books first — otherwise the href resolves in the firm
 *  user's own org. Set this to route each step through openClientBooksAction. */
export interface OpenBooksAs {
  ownerUserId: string;
  orgId: string;
}

/**
 * A timeline step target. Plain <Link> for your own books; when openBooksAs is set
 * (firm viewing a client) a form opens the client's books then lands on href.
 * `display:contents` on the form keeps the flex layout identical to the Link.
 */
function StepLink({
  href,
  className,
  openBooksAs,
  children,
}: {
  href: string;
  className: string;
  openBooksAs?: OpenBooksAs;
  children: React.ReactNode;
}) {
  if (openBooksAs) {
    return (
      <form action={openClientBooksAction} className="contents">
        <input type="hidden" name="targetUserId" value={openBooksAs.ownerUserId} />
        <input type="hidden" name="orgId" value={openBooksAs.orgId} />
        <input type="hidden" name="next" value={href} />
        <button type="submit" className={className}>
          {children}
        </button>
      </form>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

type View = 'close' | 'activity' | 'all';
type Orientation = 'vertical' | 'horizontal';

const VIEWS: { id: View; label: string }[] = [
  { id: 'close', label: 'To close this month' },
  { id: 'activity', label: 'This month' },
  { id: 'all', label: 'All' },
];

const STATUS_LABEL: Record<MilestoneStatus, string> = {
  done: 'Done',
  in_progress: 'In progress',
  not_started: 'Not started',
  waiting: 'Waiting',
};

/** Ring + fill classes for the numbered node, keyed by status. */
function nodeClasses(status: MilestoneStatus): string {
  switch (status) {
    case 'done':
      return 'border-emerald-500 bg-emerald-500 text-white dark:border-emerald-500 dark:bg-emerald-500';
    case 'in_progress':
      return 'border-indigo-500 bg-indigo-500 text-white dark:border-indigo-400 dark:bg-indigo-500';
    case 'waiting':
      return 'border-amber-500 bg-amber-500 text-white dark:border-amber-400 dark:bg-amber-500';
    case 'not_started':
    default:
      return 'border-zinc-300 bg-white text-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-500';
  }
}

function badgeClasses(status: MilestoneStatus): string {
  switch (status) {
    case 'done':
      return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300';
    case 'in_progress':
      return 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300';
    case 'waiting':
      return 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300';
    case 'not_started':
    default:
      return 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400';
  }
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

/** Stacked rows — represents the vertical timeline. */
function VerticalIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="5" cy="6" r="1.6" /><line x1="9" y1="6" x2="19" y2="6" />
      <circle cx="5" cy="12" r="1.6" /><line x1="9" y1="12" x2="19" y2="12" />
      <circle cx="5" cy="18" r="1.6" /><line x1="9" y1="18" x2="19" y2="18" />
    </svg>
  );
}

/** Columns — represents the horizontal timeline. */
function HorizontalIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="6" cy="5" r="1.6" /><line x1="6" y1="9" x2="6" y2="19" />
      <circle cx="12" cy="5" r="1.6" /><line x1="12" y1="9" x2="12" y2="19" />
      <circle cx="18" cy="5" r="1.6" /><line x1="18" y1="9" x2="18" y2="19" />
    </svg>
  );
}

/** The numbered/status circle, shared by both orientations. */
function Node({ step, index }: { step: MilestoneStep; index: number }) {
  return (
    <div
      className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold ${nodeClasses(step.status)}`}
    >
      {step.status === 'done' ? <CheckIcon /> : index + 1}
    </div>
  );
}

function CountBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
      {count > 99 ? '99+' : count}
    </span>
  );
}

function StatusBadge({ status }: { status: MilestoneStatus }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${badgeClasses(status)}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function MonthlyTimeline({
  steps,
  periodLabel,
  defaultView = 'close',
  defaultOrientation = 'horizontal',
  hoverHighlight = false,
  openBooksAs,
}: {
  steps: MilestoneStep[];
  periodLabel: string;
  defaultView?: View;
  defaultOrientation?: Orientation;
  /** Blue ring/border highlight on hover — for stacked month cards. */
  hoverHighlight?: boolean;
  /** Firm viewing a CLIENT: route each step through the client's books first. */
  openBooksAs?: OpenBooksAs;
}) {
  const [view, setView] = useState<View>(defaultView);
  const [orientation, setOrientation] = useState<Orientation>(defaultOrientation);

  const visible = steps.filter((s) => view === 'all' || s.group === (view as MilestoneGroup));
  const closeDone = steps.filter((s) => s.group === 'close' && s.status === 'done').length;
  const closeTotal = steps.filter((s) => s.group === 'close').length;

  return (
    <section
      className={`overflow-hidden rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950${
        hoverHighlight
          ? ' transition-shadow hover:border-blue-400 hover:ring-2 hover:ring-blue-400/40 dark:hover:border-blue-500 dark:hover:ring-blue-500/40'
          : ''
      }`}
    >
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Monthly bookkeeping · {periodLabel}
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {closeDone} of {closeTotal} close steps done
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-zinc-200 p-0.5 text-xs dark:border-zinc-800">
            {VIEWS.map((v) => {
              const active = v.id === view;
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setView(v.id)}
                  className={`rounded px-2.5 py-1 font-medium transition-colors ${
                    active
                      ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                      : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
                  }`}
                >
                  {v.label}
                </button>
              );
            })}
          </div>
          {/* Orientation toggle: vertical ⇄ horizontal */}
          <div className="inline-flex rounded-md border border-zinc-200 p-0.5 dark:border-zinc-800">
            <button
              type="button"
              onClick={() => setOrientation('vertical')}
              aria-pressed={orientation === 'vertical'}
              title="Vertical layout"
              className={`flex items-center rounded px-1.5 py-1 transition-colors ${
                orientation === 'vertical'
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                  : 'text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
              }`}
            >
              <VerticalIcon />
            </button>
            <button
              type="button"
              onClick={() => setOrientation('horizontal')}
              aria-pressed={orientation === 'horizontal'}
              title="Horizontal layout"
              className={`flex items-center rounded px-1.5 py-1 transition-colors ${
                orientation === 'horizontal'
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                  : 'text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
              }`}
            >
              <HorizontalIcon />
            </button>
          </div>
        </div>
      </header>

      {orientation === 'vertical' ? (
        <ol className="relative">
          {visible.map((step, i) => (
            <li key={step.id} className="relative flex gap-4 pb-5 last:pb-0">
              {i < visible.length - 1 && (
                <span
                  className="absolute left-4 top-9 -ml-px h-[calc(100%-1.75rem)] w-0.5 bg-zinc-200 dark:bg-zinc-800"
                  aria-hidden="true"
                />
              )}
              <Node step={step} index={i} />
              <StepLink
                href={step.href}
                openBooksAs={openBooksAs}
                className="group flex flex-1 items-center justify-between gap-3 rounded-md border border-transparent px-3 py-2 transition-colors hover:border-zinc-200 hover:bg-zinc-50 dark:hover:border-zinc-800 dark:hover:bg-zinc-900"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{step.label}</span>
                    <CountBadge count={step.count} />
                  </div>
                  {step.detail && (
                    <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">{step.detail}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusBadge status={step.status} />
                  <span className="text-zinc-300 transition-colors group-hover:text-zinc-500 dark:text-zinc-600 dark:group-hover:text-zinc-400">
                    <ArrowIcon />
                  </span>
                </div>
              </StepLink>
            </li>
          ))}
        </ol>
      ) : (
        <ol className="flex items-start gap-1 overflow-x-auto pb-1">
          {visible.map((step, i) => (
            <li key={step.id} className="relative flex min-w-[8rem] flex-1 flex-col items-center">
              {i < visible.length - 1 && (
                <span
                  className="absolute left-1/2 top-6 -mt-px h-0.5 w-full bg-zinc-200 dark:bg-zinc-800"
                  aria-hidden="true"
                />
              )}
              <StepLink
                href={step.href}
                openBooksAs={openBooksAs}
                className="group flex w-full flex-col items-center gap-2 rounded-md border border-transparent px-2 pb-2 pt-2 text-center transition-colors hover:border-zinc-200 hover:bg-zinc-50 dark:hover:border-zinc-800 dark:hover:bg-zinc-900"
              >
                <Node step={step} index={i} />
                <div className="flex flex-col items-center gap-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{step.label}</span>
                    <CountBadge count={step.count} />
                  </div>
                  {step.detail && (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">{step.detail}</p>
                  )}
                  <StatusBadge status={step.status} />
                </div>
              </StepLink>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
