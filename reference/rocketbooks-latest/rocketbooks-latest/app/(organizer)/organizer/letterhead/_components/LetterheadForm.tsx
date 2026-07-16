'use client';

import { useActionState } from 'react';
import { saveLetterheadAction, type LetterheadState } from '../_actions/saveLetterhead';

interface Props {
  initial: {
    enabled: boolean;
    signatoryName: string;
    signatoryTitle: string;
  };
}

const inputClass =
  'w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950';

export function LetterheadForm({ initial }: Props) {
  const [state, formAction, pending] = useActionState<LetterheadState | undefined, FormData>(
    saveLetterheadAction,
    undefined,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <label className="flex items-center gap-2.5 text-sm">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={initial.enabled}
          className="h-4 w-4 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500 dark:border-zinc-700"
        />
        <span className="font-medium text-zinc-800 dark:text-zinc-200">
          Show letterhead on generated letters &amp; resolutions
        </span>
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="signatoryName" className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
            Default signatory
          </label>
          <input
            id="signatoryName"
            name="signatoryName"
            defaultValue={initial.signatoryName}
            placeholder="Jane Doe"
            maxLength={120}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="signatoryTitle" className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
            Signatory title
          </label>
          <input
            id="signatoryTitle"
            name="signatoryTitle"
            defaultValue={initial.signatoryTitle}
            placeholder="Managing Member"
            maxLength={120}
            className={inputClass}
          />
        </div>
      </div>
      <p className="-mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        When set, the assistant signs letters and resolutions with this name and title unless you tell it otherwise.
      </p>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
        {state?.ok && <span className="text-sm text-emerald-600 dark:text-emerald-400">Saved.</span>}
        {state?.error && <span className="text-sm text-rose-600 dark:text-rose-400">{state.error}</span>}
      </div>
    </form>
  );
}
