'use client';

import { useState, useTransition } from 'react';
import { draftTaskMessageAction } from '../_actions/draftTaskMessage';

const TONE_OPTIONS: { value: string; label: string }[] = [
  { value: 'professional', label: 'Professional' },
  { value: 'casual', label: 'Casual' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'humorous', label: 'A little humor' },
  { value: 'serious', label: 'Serious' },
  { value: 'concise', label: 'Concise' },
];

/**
 * "AI draft" + tone control for the task compose editor. Mirrors
 * FlipDraftControls, but drafts a brand-new message from the task's context
 * pack (draftTaskMessageAction) instead of replying to an existing thread.
 */
export function FlipComposeDraftControls({
  taskId,
  channel,
  accent,
  disabled,
  onDraft,
  onError,
}: {
  taskId: string;
  channel: 'email' | 'text';
  accent: 'amber' | 'sky';
  disabled?: boolean;
  onDraft: (text: string) => void;
  onError: (msg: string | null) => void;
}) {
  const [tone, setTone] = useState('professional');
  const [drafting, start] = useTransition();

  const btnTone =
    accent === 'amber'
      ? 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300'
      : 'border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100 dark:border-sky-900/40 dark:bg-sky-950/30 dark:text-sky-300';

  const handleDraft = () => {
    onError(null);
    start(async () => {
      const r = await draftTaskMessageAction({ taskId, channel, tone });
      if (!r.ok || !r.text) {
        onError(r.error ?? 'Draft failed');
        return;
      }
      onDraft(r.text);
    });
  };

  const isDisabled = disabled || drafting;

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleDraft}
        disabled={isDisabled}
        className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${btnTone}`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
        </svg>
        {drafting ? 'Drafting…' : 'AI draft'}
      </button>
      <label className="sr-only" htmlFor={`compose-tone-${taskId}`}>
        Tone
      </label>
      <select
        id={`compose-tone-${taskId}`}
        value={tone}
        onChange={(e) => setTone(e.target.value)}
        disabled={drafting}
        title="Message tone"
        className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-700 focus:border-zinc-400 focus:outline-none disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
      >
        {TONE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
