'use client';

import { useState, useTransition } from 'react';
import { saveAiClientPrefs, removeAiClientLearning } from '../_actions/aiClientProfile';

type CommunicationStyle = 'brief' | 'standard' | 'detailed';

interface ClientLearning {
  id: string;
  note: string;
  at: string;
}

export interface AiClientProfileView {
  communicationStyle?: CommunicationStyle;
  skipBelowAmount?: number | null;
  standingInstructions?: string;
  learnings?: ClientLearning[];
}

/**
 * Edit how the AI assistant works with this client (communication style, a
 * small-amount threshold, standing instructions) and review/forget the durable
 * facts the assistant has learned over time. Read into the AI's context on
 * every chat/voice turn.
 */
export function AiMemoryCard({ profile }: { profile: AiClientProfileView }) {
  const [style, setStyle] = useState<CommunicationStyle>(profile.communicationStyle ?? 'standard');
  const [skipBelow, setSkipBelow] = useState<string>(
    profile.skipBelowAmount && profile.skipBelowAmount > 0 ? String(profile.skipBelowAmount) : '',
  );
  const [standing, setStanding] = useState<string>(profile.standingInstructions ?? '');
  const [learnings, setLearnings] = useState<ClientLearning[]>(profile.learnings ?? []);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const save = () => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const parsed = skipBelow.trim() === '' ? null : Number(skipBelow);
      const r = await saveAiClientPrefs({
        communicationStyle: style,
        skipBelowAmount: parsed != null && Number.isFinite(parsed) ? parsed : null,
        standingInstructions: standing,
      });
      if (r.ok) setSaved(true);
      else setError(r.error ?? 'Save failed');
    });
  };

  const forget = (id: string) => {
    startTransition(async () => {
      const r = await removeAiClientLearning(id);
      if (r.ok) setLearnings((cur) => cur.filter((l) => l.id !== id));
      else setError(r.error ?? 'Could not remove');
    });
  };

  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          AI assistant memory
        </h2>
      </header>
      <div className="flex flex-col gap-4 px-4 py-3 text-sm">
        <p className="text-xs text-zinc-500">
          How your AI bookkeeper works with you. These preferences and everything it has learned are
          used in every chat and voice conversation, so it stops re-asking what you’ve already told it.
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">Reply style</span>
            <select
              value={style}
              onChange={(e) => setStyle(e.target.value as CommunicationStyle)}
              className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
            >
              <option value="brief">Brief — short and to the point</option>
              <option value="standard">Standard</option>
              <option value="detailed">Detailed — thorough explanations</option>
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">Don’t bug me about amounts under</span>
            <div className="flex items-center gap-2">
              <span className="text-zinc-500">$</span>
              <input
                value={skipBelow}
                onChange={(e) => setSkipBelow(e.target.value.replace(/[^0-9]/g, ''))}
                inputMode="numeric"
                placeholder="0 (off)"
                className="w-28 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
              />
            </div>
          </label>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Standing instructions</span>
          <textarea
            value={standing}
            onChange={(e) => setStanding(e.target.value)}
            rows={3}
            placeholder="Anything the assistant should always keep in mind — e.g. “I review bills on Fridays”, “Always confirm before contacting a customer.”"
            className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
          />
        </label>

        <div className="flex items-center gap-3">
          <button
            onClick={save}
            disabled={isPending}
            className="w-fit rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {isPending ? 'Saving…' : 'Save'}
          </button>
          {saved && !isPending && <span className="text-xs text-emerald-600 dark:text-emerald-400">Saved</span>}
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>

        <div className="border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <div className="mb-2 font-medium text-zinc-700 dark:text-zinc-300">What the assistant has learned</div>
          {learnings.length === 0 ? (
            <p className="text-xs text-zinc-500">
              Nothing yet. As you tell the assistant how you like things done (“always code Home Depot to
              the rental property”), it’ll remember here.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {learnings.map((l) => (
                <li
                  key={l.id}
                  className="flex items-start justify-between gap-3 rounded-md border border-zinc-100 px-3 py-2 dark:border-zinc-800"
                >
                  <span className="text-zinc-700 dark:text-zinc-300">{l.note}</span>
                  <button
                    onClick={() => forget(l.id)}
                    disabled={isPending}
                    className="shrink-0 text-xs text-zinc-400 hover:text-red-600 disabled:opacity-50"
                  >
                    Forget
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
