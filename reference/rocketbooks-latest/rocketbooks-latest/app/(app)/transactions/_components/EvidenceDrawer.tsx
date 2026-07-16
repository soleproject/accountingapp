'use client';

import { useState, useTransition, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { getCategorizationEvidence, type CategorizationEvidence } from '../_actions/categorizationEvidence';

/**
 * Accountant-view confidence chip + lazy "Why?" provenance popover for one
 * transaction. The chip reads the persisted AI confidence; clicking "Why?"
 * fetches the full evidence (AI reason, vendor-memory matches, matching rules)
 * on demand so the queue list stays cheap to render.
 *
 * The popover renders through a portal to document.body with fixed positioning
 * so it escapes the transactions table's stacking contexts — otherwise the
 * guided-review spotlight (which elevates rows above a dim overlay) and the
 * table's overflow would paint over / clip it.
 */

const PANEL_WIDTH = 288; // w-72

function confidenceStyle(confidence: number | null): { label: string; cls: string } {
  if (confidence == null) return { label: '—', cls: 'text-zinc-400' };
  const pct = `${Math.round(confidence * 100)}%`;
  if (confidence >= 0.95)
    return { label: pct, cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300' };
  if (confidence >= 0.85)
    return { label: pct, cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' };
  return { label: pct, cls: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300' };
}

const SOURCE_LABELS: Record<string, string> = {
  rule: 'Deterministic rule',
  memory: 'Vendor memory',
  ai: 'AI inference',
  none: 'No confident match',
};

/** Don't leak internal fallback strings to the reviewer. */
function displayReason(reason: string | null): string {
  if (!reason || reason === 'AI returned malformed response') {
    return 'The AI couldn’t categorize this confidently — flagged for your review.';
  }
  return reason;
}

interface PanelPos {
  left: number;
  top?: number;
  bottom?: number;
}

export function EvidenceDrawer({
  transactionId,
  confidence,
}: {
  transactionId: string;
  confidence: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PanelPos | null>(null);
  const [evidence, setEvidence] = useState<CategorizationEvidence | null>(null);
  const [pending, startTransition] = useTransition();
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const chip = confidenceStyle(confidence);

  // Close on outside click / Escape / scroll while open.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    function onScroll() {
      setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      const left = Math.max(8, Math.min(rect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8));
      // Flip above the button when it sits in the lower part of the viewport so
      // the panel never runs off the bottom (common on the last rows).
      const openUp = rect.bottom > window.innerHeight * 0.55;
      setPos(openUp ? { left, bottom: window.innerHeight - rect.top + 6 } : { left, top: rect.bottom + 6 });
    }
    setOpen(true);
    if (!evidence) {
      startTransition(async () => {
        setEvidence(await getCategorizationEvidence(transactionId));
      });
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${chip.cls}`}>
        {chip.label}
      </span>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        className="rounded text-[11px] text-zinc-500 underline-offset-2 hover:text-zinc-800 hover:underline dark:hover:text-zinc-200"
        aria-expanded={open}
      >
        Why?
      </button>

      {open && pos && typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: 'fixed', left: pos.left, top: pos.top, bottom: pos.bottom, width: PANEL_WIDTH }}
            className="z-[60] rounded-lg border border-zinc-200 bg-white p-3 text-left shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
          >
            {pending && !evidence ? (
              <p className="text-xs text-zinc-500">Loading evidence…</p>
            ) : evidence?.error ? (
              <p className="text-xs text-rose-600 dark:text-rose-400">{evidence.error}</p>
            ) : evidence ? (
              <div className="space-y-2.5">
                <div>
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">AI reasoning</p>
                    {evidence.source && SOURCE_LABELS[evidence.source] && (
                      <span className="text-[10px] text-zinc-400">{SOURCE_LABELS[evidence.source]}</span>
                    )}
                  </div>
                  <p className="text-xs text-zinc-700 dark:text-zinc-300">{displayReason(evidence.reason)}</p>
                </div>

                {evidence.similar.length > 0 && (
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
                      This merchant, categorized before
                    </p>
                    <ul className="mt-0.5 space-y-0.5">
                      {evidence.similar.map((s) => (
                        <li key={s.categoryName} className="text-xs text-zinc-700 dark:text-zinc-300">
                          {s.categoryName} · {s.count}×
                          {s.mostRecent ? <span className="text-zinc-400"> (last {s.mostRecent})</span> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {evidence.rules.length > 0 && (
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Matching rule</p>
                    <ul className="mt-0.5 space-y-0.5">
                      {evidence.rules.map((r) => (
                        <li key={r.pattern} className="text-xs text-zinc-700 dark:text-zinc-300">
                          <span className="font-mono text-[11px]">“{r.pattern}”</span>
                          {r.categoryName ? ` → ${r.categoryName}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {evidence.similar.length === 0 && evidence.rules.length === 0 && !evidence.reason && (
                  <p className="text-xs text-zinc-500">No prior evidence — first time seeing this merchant.</p>
                )}
              </div>
            ) : null}
          </div>,
          document.body,
        )}
    </span>
  );
}
