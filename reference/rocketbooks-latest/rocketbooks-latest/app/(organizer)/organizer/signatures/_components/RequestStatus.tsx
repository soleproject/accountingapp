'use client';

import { useState, useTransition } from 'react';
import type { RequestRow, Recipient } from '@/lib/signatures/store';
import { resendInviteAction } from '../_actions/remind';

const RECIPIENT_STATUS: Record<string, string> = {
  pending: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  viewed: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300',
  signed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  declined: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
};

export function RequestStatus({ request, recipients, completedUrl }: { request: RequestRow; recipients: Recipient[]; completedUrl: string | null }) {
  const [copied, setCopied] = useState<string | null>(null);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  const copy = async (token: string, id: string) => {
    try {
      await navigator.clipboard.writeText(`${origin}/sign/${token}`);
      setCopied(id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <span className="inline-flex items-center rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium capitalize text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">{request.status}</span>
        <span className="text-sm text-zinc-500 dark:text-zinc-400">
          {recipients.filter((r) => r.status === 'signed').length}/{recipients.length} signed
        </span>
        {completedUrl && (
          <a href={completedUrl} target="_blank" rel="noopener noreferrer" className="ml-auto rounded-full bg-emerald-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-emerald-700">
            Download signed PDF
          </a>
        )}
      </div>

      <div className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <th className="px-4 py-2 font-medium">Recipient</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Signed</th>
              <th className="px-4 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {recipients.map((r) => (
              <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-4 py-2">
                  <div className="font-medium text-zinc-800 dark:text-zinc-100">{r.name || '—'}</div>
                  <div className="text-xs text-zinc-400">{r.email}</div>
                </td>
                <td className="px-4 py-2">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${RECIPIENT_STATUS[r.status] ?? RECIPIENT_STATUS.pending}`}>{r.status}</span>
                </td>
                <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400">{r.signedAt ? new Date(r.signedAt).toLocaleString() : '—'}</td>
                <td className="px-4 py-2">
                  {r.status !== 'signed' && r.status !== 'declined' && (
                    <div className="flex items-center justify-end gap-1.5">
                      {r.invitedAt && request.status === 'sent' && <RemindButton requestId={request.id} recipientId={r.id} />}
                      <button type="button" onClick={() => copy(r.token, r.id)} className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">
                        {copied === r.id ? 'Copied' : 'Copy link'}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RemindButton({ requestId, recipientId }: { requestId: string; recipientId: string }) {
  const [pending, start] = useTransition();
  const [label, setLabel] = useState('Remind');
  const remind = () =>
    start(async () => {
      const res = await resendInviteAction(requestId, recipientId);
      setLabel(res.ok ? 'Reminded' : res.error ?? 'Failed');
      setTimeout(() => setLabel('Remind'), 2500);
    });
  return (
    <button type="button" onClick={remind} disabled={pending} className="rounded-full border border-indigo-200 px-3 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-900/50 dark:text-indigo-300 dark:hover:bg-indigo-950/30">
      {pending ? 'Sending…' : label}
    </button>
  );
}
