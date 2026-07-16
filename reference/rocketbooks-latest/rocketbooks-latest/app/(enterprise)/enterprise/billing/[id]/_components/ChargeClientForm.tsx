'use client';

import { useActionState, useEffect, useState } from 'react';
import { chargeClientAction, type ChargeClientState } from '../../../_actions/billing';

const fieldCls =
  'rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950';

interface Props {
  clientUserId: string;
  /** Human label for who gets charged, e.g. "the client" or "your firm". */
  payerLabel: string;
  cardOnFile: boolean;
}

export function ChargeClientForm({ clientUserId, payerLabel, cardOnFile }: Props) {
  const [state, action, pending] = useActionState<ChargeClientState, FormData>(chargeClientAction, {});
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [token, setToken] = useState(() => crypto.randomUUID());

  // Reset the form after a successful charge. The new token is required, not
  // cosmetic: it's the Stripe idempotency key, so the next charge must use a
  // fresh one or Stripe would treat it as a retry of the previous charge and
  // no-op. One-shot on success (state.ok), so it can't cascade.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (state?.ok) {
      setAmount('');
      setDescription('');
      setConfirming(false);
      setToken(crypto.randomUUID());
    }
  }, [state]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!cardOnFile) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        No card on file for whoever pays this client, so there&rsquo;s nothing to charge yet.
      </p>
    );
  }

  const amt = Number(amount);
  const validAmount = Number.isFinite(amt) && amt > 0;
  const canReview = validAmount && description.trim().length > 0;

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="clientUserId" value={clientUserId} />
      <input type="hidden" name="token" value={token} />

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Amount (USD)</span>
          <div className="flex items-center gap-1">
            <span className="text-zinc-500">$</span>
            <input
              name="amount"
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setConfirming(false);
              }}
              placeholder="0.00"
              className={`w-28 ${fieldCls}`}
            />
          </div>
        </label>
        <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">Description</span>
          <input
            name="description"
            type="text"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              setConfirming(false);
            }}
            placeholder="e.g. Cleanup project — extra hours"
            className={`w-full ${fieldCls}`}
          />
        </label>
      </div>

      {!confirming ? (
        <button
          type="button"
          disabled={!canReview}
          onClick={() => setConfirming(true)}
          className="self-start rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Charge…
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/30">
          <span className="text-amber-900 dark:text-amber-200">
            Charge <strong>${amt.toFixed(2)}</strong> to {payerLabel} now?
          </span>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {pending ? 'Charging…' : `Confirm — $${amt.toFixed(2)}`}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Cancel
          </button>
        </div>
      )}

      {state?.error && <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p>}
      {state?.ok && <p className="text-sm text-emerald-600 dark:text-emerald-400">{state.message} ✓</p>}
    </form>
  );
}
