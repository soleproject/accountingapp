'use client';

import { type ReactNode } from 'react';
import { useCardFlip } from './CardFlipContext';
import { FlipHistoryPanel } from './FlipHistoryPanel';
import { TaskPlanChecklist } from './TaskPlanChecklist';

/**
 * Wraps the dashboard's left column (Schedule / Inbox / Texts / Notes) in a
 * 3D-flip container. When a message is open in the reply editor AND the user
 * taps the history icon on its row, the whole left column flips to a
 * conversation-thread panel that mirrors the reply editor on the right.
 *
 * The front face stays in normal flow so it defines the column's height; the
 * back face overlays it absolutely, so the thread panel matches the column's
 * height exactly (and lines up with the right editor box).
 */
export function FlippableLeftColumn({ children }: { children: ReactNode }) {
  const { target, historyOpen } = useCardFlip();
  const isPlan = target?.kind === 'task-plan';
  // The left column flips when either (a) a message is open AND its history was
  // toggled, or (b) a task plan is open (then it shows the step checklist).
  const flipped = isPlan || (!!target && historyOpen);

  return (
    <div className="[perspective:1800px]">
      <div
        className={`relative transition-transform duration-500 [transform-style:preserve-3d] ${
          flipped ? '[transform:rotateY(180deg)]' : ''
        }`}
      >
        {/* Front: the stacked cards (in flow → defines height) */}
        <div className={`[backface-visibility:hidden] ${flipped ? 'pointer-events-none' : ''}`}>
          {children}
        </div>
        {/* Back: conversation thread, or the task-plan step checklist, overlaid
            to match the column height. */}
        <div className="absolute inset-0 [transform:rotateY(180deg)] [backface-visibility:hidden]">
          {isPlan && target?.kind === 'task-plan' && <TaskPlanChecklist target={target} />}
          {!isPlan && flipped && <FlipHistoryPanel />}
        </div>
      </div>
    </div>
  );
}
