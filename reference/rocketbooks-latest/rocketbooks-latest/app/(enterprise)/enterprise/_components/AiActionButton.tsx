'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  AI_ACTION_TAXONOMY,
  type OutreachChannel,
  type OutreachIssueType,
} from '@/lib/enterprise/ai-actions';
import { draftAiOutreachAction, commitAiOutreachAction } from '../_actions/aiOutreach';

interface Props {
  orgId: string;
  issueType: OutreachIssueType;
  clientName: string;
  /** Plain-English situation handed to the LLM, e.g. "47 transactions to review, oldest 31 days". */
  detail: string;
  /** Demo mode: show a read-only sample draft, no real send. */
  demo?: boolean;
  demoMessage?: string;
}

const CHANNELS: { key: OutreachChannel; label: string }[] = [
  { key: 'email', label: 'Email' },
  { key: 'sms', label: 'SMS' },
  { key: 'chat', label: 'In-app chat' },
];

export function AiActionButton({ orgId, issueType, clientName, detail, demo = false, demoMessage }: Props) {
  const router = useRouter();
  const def = AI_ACTION_TAXONOMY[issueType];
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<OutreachChannel>(def.defaultChannel);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState(demo ? demoMessage ?? '' : '');
  const [phase, setPhase] = useState<'idle' | 'drafting' | 'sending' | 'saving'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function generate() {
    setError(null);
    setPhase('drafting');
    const r = await draftAiOutreachAction({ orgId, issueType, channel, detail });
    setPhase('idle');
    if (!r.ok) { setError(r.error ?? 'Draft failed.'); return; }
    setSubject(r.subject ?? '');
    setBody(r.body ?? '');
  }

  async function commit(mode: 'send' | 'save') {
    setError(null);
    setPhase(mode === 'send' ? 'sending' : 'saving');
    const r = await commitAiOutreachAction({ orgId, issueType, channel, subject, body, mode });
    setPhase('idle');
    if (!r.ok) { setError(r.error ?? 'Failed.'); return; }
    setDone(mode === 'send' ? 'Sent ✓' : 'Draft saved ✓');
    router.refresh();
    setTimeout(() => { setOpen(false); setDone(null); }, 900);
  }

  function openModal() {
    setOpen(true);
    setError(null);
    setDone(null);
    if (!demo && !body) void generate();
  }

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className="shrink-0 rounded-md border border-violet-300 bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700 hover:bg-violet-100 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-300"
      >
        AI Action
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div
            className="w-full max-w-lg rounded-lg border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 text-sm font-semibold">{def.readyVerb}</div>
            <div className="mb-3 text-xs text-zinc-500">
              {clientName} · {detail}
              {def.requiresClientConfirmation && (
                <span className="ml-1 text-amber-600 dark:text-amber-400">· asks the client before contacting their customers</span>
              )}
            </div>

            <div className="mb-3 flex items-center gap-1">
              {CHANNELS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  disabled={demo}
                  onClick={() => setChannel(c.key)}
                  className={`rounded-md border px-2 py-1 text-xs ${
                    channel === c.key
                      ? 'border-violet-400 bg-violet-50 text-violet-700 dark:border-violet-700 dark:bg-violet-950/40 dark:text-violet-300'
                      : 'border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400'
                  } disabled:opacity-50`}
                >
                  {c.label}
                </button>
              ))}
            </div>

            {channel === 'email' && !demo && (
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Subject"
                className="mb-2 w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
            )}

            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              readOnly={demo}
              rows={7}
              placeholder={phase === 'drafting' ? 'Drafting…' : 'The AI draft will appear here.'}
              className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />

            {error && <div className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</div>}
            {done && <div className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">{done}</div>}

            <div className="mt-4 flex items-center justify-between">
              <div>
                {!demo && (
                  <button
                    type="button"
                    onClick={generate}
                    disabled={phase !== 'idle'}
                    className="rounded-md px-2.5 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-900"
                  >
                    {phase === 'drafting' ? 'Drafting…' : 'Regenerate'}
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-md px-2.5 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
                >
                  Cancel
                </button>
                {!demo && (
                  <button
                    type="button"
                    onClick={() => commit('save')}
                    disabled={phase !== 'idle' || !body.trim()}
                    className="rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                  >
                    {phase === 'saving' ? 'Saving…' : 'Save draft'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => commit('send')}
                  disabled={demo || phase !== 'idle' || !body.trim()}
                  title={demo ? 'Demo data — sending disabled' : undefined}
                  className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-violet-700 disabled:opacity-50"
                >
                  {phase === 'sending' ? 'Sending…' : 'Approve & send'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
