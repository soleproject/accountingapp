'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useCardFlip, type FlipText } from './CardFlipContext';
import { HistoryToggleButton } from './HistoryToggleButton';
import { dismissTextAction } from '../_actions/dismissText';

interface TextItem {
  id: string;
  body: string;
  createdAt: string;
  fromPhone: string;
  contactId: string | null;
  contactName: string | null;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n).trimEnd() + '…';
}

/**
 * A single Texts row. Clicking it flips the Open Tasks card to a text reply
 * editor for this message; clicking the one that's already open flips back.
 * The sender link to the contact stops propagation so it doesn't also flip.
 */
export function TextIssueItem({ text, demo }: { text: TextItem; demo: boolean }) {
  const { open, close, target } = useCardFlip();
  const router = useRouter();
  const [dismissing, startDismiss] = useTransition();
  const [hidden, setHidden] = useState(false);
  const sender = text.contactName ?? text.fromPhone;
  const isActive = target?.kind === 'text' && target.id === text.id;

  const dismiss = () => {
    // If this thread is open in the editor, close it as we clear the row.
    if (isActive) close();
    setHidden(true); // optimistic — instant feedback
    // Demo Co never truly clears: hide for this view only (returns on reload),
    // no server write, no refresh (a refresh would bring the seeded row back).
    if (demo) return;
    startDismiss(async () => {
      await dismissTextAction({ messageId: text.id });
      router.refresh();
    });
  };

  if (hidden) return null;

  const select = () => {
    if (isActive) {
      close();
      return;
    }
    const flip: FlipText = {
      kind: 'text',
      id: text.id,
      contactId: text.contactId,
      contactName: text.contactName,
      fromPhone: text.fromPhone,
      body: text.body,
    };
    open(flip);
  };

  return (
    <li
      role="button"
      tabIndex={0}
      aria-label={`Reply to ${sender}`}
      onClick={select}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select();
        }
      }}
      className={`-mx-2 cursor-pointer rounded-md px-2 py-2 text-sm transition-colors hover:bg-sky-50/60 dark:hover:bg-sky-950/20 ${
        isActive ? 'bg-sky-50 dark:bg-sky-950/30' : ''
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        {text.contactId && text.contactName ? (
          <Link
            href={`/organizer/contacts/${text.contactId}`}
            onClick={(e) => e.stopPropagation()}
            className="truncate font-medium text-zinc-800 hover:underline dark:text-zinc-200"
          >
            {sender}
          </Link>
        ) : (
          <span className="truncate font-medium text-zinc-800 dark:text-zinc-200">{sender}</span>
        )}
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-500">
          {timeAgo(text.createdAt)}
          {isActive && <HistoryToggleButton accent="sky" />}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              dismiss();
            }}
            disabled={dismissing}
            aria-label="Mark reviewed"
            title="Mark reviewed (clear from dashboard)"
            className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-emerald-100 hover:text-emerald-600 disabled:opacity-50 dark:hover:bg-emerald-900/40 dark:hover:text-emerald-300"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </button>
        </span>
      </div>
      <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-500">{truncate(text.body, 140)}</p>
    </li>
  );
}
