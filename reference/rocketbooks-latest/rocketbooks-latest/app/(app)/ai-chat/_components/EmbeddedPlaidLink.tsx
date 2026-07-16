'use client';

import { useState, useCallback, useEffect, useRef, useTransition } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import Link from 'next/link';
import type { OnboardingPlaidAccount } from './OnboardingPanel';
import { promoteAccountAction } from '@/app/(app)/integrations/plaid/_actions/mapAccount';

interface Props {
  accounts: OnboardingPlaidAccount[];
  onLinked: () => void | Promise<void>;
}

export function EmbeddedPlaidLink({ accounts, onLinked }: Props) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleStart = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/plaid/link/token', { method: 'POST' });
      const body = (await r.json().catch(() => ({}))) as { linkToken?: string; error?: string; code?: string };
      if (!r.ok) {
        throw new Error(
          body.error ? `${body.error}${body.code ? ` (${body.code})` : ''}` : `Failed to get link token: HTTP ${r.status}`,
        );
      }
      if (!body.linkToken) throw new Error('No link token in response');
      setLinkToken(body.linkToken);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start');
      setBusy(false);
    }
  }, []);

  const onSuccess = useCallback(
    async (
      publicToken: string,
      metadata: {
        institution: { name: string; institution_id: string } | null;
        accounts: Array<{ id: string; name: string; mask: string; subtype: string; type: string }>;
      },
    ) => {
      try {
        const r = await fetch('/api/plaid/link/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            publicToken,
            institutionId: metadata.institution?.institution_id,
            institutionName: metadata.institution?.name,
            accounts: metadata.accounts,
          }),
        });
        if (!r.ok) throw new Error(`Exchange failed: ${r.status}`);
        await onLinked();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Exchange failed');
      } finally {
        setBusy(false);
        setLinkToken(null);
      }
    },
    [onLinked],
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit: () => {
      setBusy(false);
      setLinkToken(null);
    },
  });

  // Open the Plaid modal exactly once per token, in an effect — calling
  // open() during render would fire on every parent re-render (voice mode
  // re-renders constantly during transcripts) and the SDK's repeated
  // body-overflow toggling would leave the page un-scrollable.
  const openedTokenRef = useRef<string | null>(null);
  useEffect(() => {
    if (linkToken && ready && openedTokenRef.current !== linkToken) {
      openedTokenRef.current = linkToken;
      open();
    }
    if (!linkToken) openedTokenRef.current = null;
  }, [linkToken, ready, open]);

  // Defensive: if Plaid's own cleanup somehow leaves body locked, restore on
  // unmount. Cheap insurance for the user-reported "page won't scroll" bug.
  useEffect(() => {
    return () => {
      if (typeof document !== 'undefined') {
        document.body.style.overflow = '';
      }
    };
  }, []);

  const unmappedCount = accounts.filter((a) => !a.chartOfAccountId).length;
  const inScopeCount = accounts.filter((a) => a.inScope).length;
  const linkedButOutOfScope = accounts.length > 0 && inScopeCount === 0;

  return (
    <div className="space-y-3 text-sm">
      <p className="text-zinc-600 dark:text-zinc-400">
        Connect your bank via Plaid so transactions flow in automatically.{' '}
        <span className="text-zinc-500">
          Linking surfaces every account at the institution — only mark the ones that belong to this business as
          <em> in books</em>.
        </span>
      </p>

      {accounts.length > 0 && (
        <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-xs">
            <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
              <tr>
                <th className="px-3 py-1.5 font-medium uppercase tracking-wide text-zinc-500">Bank</th>
                <th className="px-3 py-1.5 font-medium uppercase tracking-wide text-zinc-500">Account</th>
                <th className="px-3 py-1.5 font-medium uppercase tracking-wide text-zinc-500">Mapped to COA</th>
                <th className="px-3 py-1.5 font-medium uppercase tracking-wide text-zinc-500">Scope</th>
                <th className="px-3 py-1.5 text-right"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="px-3 py-1.5 text-zinc-700 dark:text-zinc-300">{a.institutionName ?? '—'}</td>
                  <td className="px-3 py-1.5 text-zinc-700 dark:text-zinc-300">
                    {a.accountName ?? '—'}
                    {a.last4 && <span className="ml-1 text-zinc-500">···{a.last4}</span>}
                  </td>
                  <td className="px-3 py-1.5">
                    {a.chartOfAccountId ? (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
                        {a.chartOfAccountLabel}
                      </span>
                    ) : (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                        unmapped
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {a.inScope ? (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
                        In books
                      </span>
                    ) : (
                      <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-medium uppercase text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                        Excluded
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {a.inScope ? (
                      <Link
                        href={`/integrations/plaid/${a.id}`}
                        target="_blank"
                        className="text-xs text-blue-600 underline hover:text-blue-700 dark:text-blue-400"
                      >
                        Manage ↗
                      </Link>
                    ) : a.chartOfAccountId ? (
                      <AddToBooksButton accountId={a.id} onDone={onLinked} />
                    ) : (
                      <Link
                        href={`/integrations/plaid/${a.id}`}
                        target="_blank"
                        className="text-xs text-blue-600 underline hover:text-blue-700 dark:text-blue-400"
                      >
                        Map ↗
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {unmappedCount > 0 && (
            <div className="border-t border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
              {unmappedCount} account{unmappedCount === 1 ? '' : 's'} need a chart-of-accounts mapping before transactions can be added.
            </div>
          )}
          {linkedButOutOfScope && unmappedCount === 0 && (
            <div className="border-t border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
              No accounts are in the books yet. Click <strong>Add to books</strong> on each account that belongs to this business.
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleStart}
          disabled={busy}
          className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {busy ? 'Opening Plaid…' : accounts.length === 0 ? '+ Connect a bank' : '+ Add another bank'}
        </button>
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}

function AddToBooksButton({ accountId, onDone }: { accountId: string; onDone: () => void | Promise<void> }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleClick = () => {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set('plaidAccountId', accountId);
      const result = await promoteAccountAction(undefined, fd);
      if (result?.error) setError(result.error);
      // Always refresh — even on error, the in_scope flag may already be set
      // (it's flipped before promotePlaidAccount runs), so the row should
      // reflect the actual DB state regardless.
      await onDone();
    });
  };

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="rounded-md bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        {pending ? 'Adding…' : 'Add to books'}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}
