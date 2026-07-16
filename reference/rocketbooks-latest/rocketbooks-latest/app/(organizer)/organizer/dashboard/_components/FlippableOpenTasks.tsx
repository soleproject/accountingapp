'use client';

import { type ReactNode } from 'react';
import { useCardFlip } from './CardFlipContext';
import { FlipEmailEditor } from './FlipEmailEditor';
import { FlipTextEditor } from './FlipTextEditor';
import { FlipComposeEditor } from './FlipComposeEditor';
import { TaskStepRunner } from './TaskStepRunner';
import { FlipAppointmentDetail } from './FlipAppointmentDetail';

interface ContactOption {
  id: string;
  name: string;
}

/**
 * Wraps the Open Tasks card in a 3D-flip container. Normally shows the card
 * (front face). When an inbox email or text is selected (CardFlipContext), it
 * flips to a reply editor; when an appointment is selected it flips to that
 * appointment's detail panel, then flips back when closed.
 *
 * Sizing: for the email/text editors the container fills the grid-row height
 * (h-full + absolutely-positioned faces) so the textarea can stretch. For an
 * appointment the detail can be long, so we let the BACK face sit in normal
 * flow and define the height — the card grows to fit all the info instead of
 * scrolling internally.
 */
export function FlippableOpenTasks({ children, contacts }: { children: ReactNode; contacts: ContactOption[] }) {
  const { target } = useCardFlip();
  const flipped = !!target;
  const isAppt = target?.kind === 'appointment';
  const isPlan = target?.kind === 'task-plan';
  // Appointment detail and a task-plan's document step can be tall, so they sit
  // in normal flow and let the back face define the height (card grows). The
  // reply/compose editors fill the fixed grid-row height instead.
  const growsToFit = isAppt || isPlan;

  return (
    <div className={`min-h-[340px] [perspective:1800px] ${growsToFit ? '' : 'h-full'}`}>
      <div
        className={`relative w-full transition-transform duration-500 [transform-style:preserve-3d] ${
          growsToFit ? '' : 'h-full'
        } ${flipped ? '[transform:rotateY(180deg)]' : ''}`}
      >
        {/* Front: Open Tasks. Always absolute so it never adds height — the
            grid row (email/text) or the back face (appointment/plan) sizes things. */}
        <div className={`absolute inset-0 [backface-visibility:hidden] ${flipped ? 'pointer-events-none' : ''}`}>
          {children}
        </div>
        {/* Back: reply/compose editor (absolute, fills height) or appointment
            detail / task-plan step (relative, defines height so the card grows). */}
        <div
          className={`[transform:rotateY(180deg)] [backface-visibility:hidden] ${
            growsToFit ? 'relative' : 'absolute inset-0'
          }`}
        >
          {/* key per target → fresh editor instance per message, so compose
              state (and the saved-draft load) never carries across messages. */}
          {target?.kind === 'email' && <FlipEmailEditor key={`email:${target.id}`} email={target} />}
          {target?.kind === 'text' && <FlipTextEditor key={`text:${target.id}`} text={target} />}
          {target?.kind === 'compose' && (
            <FlipComposeEditor key={`compose:${target.taskId}:${target.channel}`} target={target} />
          )}
          {target?.kind === 'task-plan' && <TaskStepRunner key={`plan:${target.plan.taskId}`} target={target} />}
          {isAppt && <FlipAppointmentDetail contacts={contacts} />}
        </div>
      </div>
    </div>
  );
}
