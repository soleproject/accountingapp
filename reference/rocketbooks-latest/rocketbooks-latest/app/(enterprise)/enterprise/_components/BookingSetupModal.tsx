'use client';

import { useEffect, useState } from 'react';
import { BookingSettings } from '@/app/(app)/settings/_components/BookingSettings';
import { loadMyBookingBundleAction, type BookingBundleProps } from '../_actions/bookingBundle';

/**
 * Large floating modal that embeds the full RocketSuite booking editor so a firm
 * can set up its scheduling page without leaving the onboarding step. "Use this
 * link" hands the public /book/<slug> URL back to the wizard's booking field.
 */
export function BookingSetupModal({ onClose, onUseLink }: { onClose: () => void; onUseLink: (url: string) => void }) {
  const [bundle, setBundle] = useState<BookingBundleProps | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    loadMyBookingBundleAction()
      .then((b) => { if (active) { setBundle(b); setLoading(false); } })
      .catch(() => { if (active) setLoading(false); });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { active = false; document.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const publicUrl = bundle ? `${bundle.baseUrl}${bundle.profile.slug}` : '';

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-12" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Set up your booking page"
        className="w-full max-w-3xl overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <h2 className="text-base font-semibold">Your booking page</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">✕</button>
        </div>

        <div className="max-h-[72vh] overflow-y-auto px-5 py-4">
          {loading && <p className="py-10 text-center text-sm text-zinc-500">Loading your booking settings…</p>}
          {!loading && !bundle && <p className="py-10 text-center text-sm text-red-600">Could not load booking settings. Try again.</p>}
          {!loading && bundle && (
            <>
              <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
                Set your availability and meeting types below. When you&rsquo;re done, drop this page&rsquo;s link into your client welcome email.
              </p>
              <BookingSettings {...bundle} />
            </>
          )}
        </div>

        {!loading && bundle && (
          <div className="flex items-center justify-between gap-3 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <span className="min-w-0 truncate text-xs text-zinc-500" title={publicUrl}>{publicUrl}</span>
            <div className="flex shrink-0 gap-2">
              <button type="button" onClick={onClose} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">Cancel</button>
              <button
                type="button"
                onClick={() => { onUseLink(publicUrl); onClose(); }}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700"
              >
                Use this link in my email
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
