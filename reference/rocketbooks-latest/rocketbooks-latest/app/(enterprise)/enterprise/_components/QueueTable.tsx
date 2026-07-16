'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { openClientBooksAction } from '../_actions/openBooks';
import { AiActionButton } from './AiActionButton';
import { AutoMatchButton } from './AutoMatchButton';
import { sendRowAiOutreachAction } from '../_actions/aiOutreach';
import { ownerLabel, outreachStatusLabel, type OutreachActionMode, type OutreachChannel, type OutreachIssueType, type OutreachOwner } from '@/lib/enterprise/ai-actions';

export interface QueueRowData {
  key: string;
  orgId: string;
  issueType: OutreachIssueType | null;
  owner: OutreachOwner;
  actionMode: OutreachActionMode | null;
  clientName: string;
  title: string;
  detail: string | null;
  aiDetail: string;
  ownerUserId: string;
  ownerIsSuper: boolean;
  next: string;
  severity: 'blocking' | 'normal';
  aiActionLabel: string | null;
  lastContactISO: string | null;
  lastMessage: string | null;
  searchText: string;
}

type BulkChannel = 'email' | 'sms' | 'both';
type RowStatus = 'sending' | 'done' | 'failed';

const BULK_CONCURRENCY = 5;

const CHANNEL_OPTS: { key: BulkChannel; label: string }[] = [
  { key: 'email', label: 'Email' },
  { key: 'sms', label: 'Text' },
  { key: 'both', label: 'Both' },
];

/** Run async work over items with a bounded number of concurrent workers. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-violet-300 border-t-violet-600"
    />
  );
}

export function QueueTable({
  rows,
  demo,
  hiddenCount,
  cap,
  emptyMessage,
}: {
  rows: QueueRowData[];
  demo: boolean;
  hiddenCount: number;
  cap: number;
  emptyMessage: string;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [channel, setChannel] = useState<BulkChannel>('email');
  const [rowStatus, setRowStatus] = useState<Record<string, RowStatus>>({});
  const [overrides, setOverrides] = useState<Record<string, { label: string; lastContactISO: string }>>({});
  const [toast, setToast] = useState<string | null>(null);

  // Only client-facing issues are bulk-nudgeable — route issues (reconciliation,
  // meeting debrief) are bookkeeper work, not nudges.
  const actionable = rows.filter((r) => r.issueType && r.actionMode !== 'route');
  const allSelected = actionable.length > 0 && actionable.every((r) => selected.has(r.key));

  const toggle = (key: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(actionable.map((r) => r.key)));

  async function runBulk() {
    const items = rows.filter((r) => selected.has(r.key) && r.issueType);
    if (!items.length) return;
    const channels: OutreachChannel[] = channel === 'both' ? ['email', 'sms'] : [channel];

    // Immediate, non-blocking feedback — the pro can move on right away.
    setToast(`Submitted ${items.length} ${items.length === 1 ? 'nudge' : 'nudges'} — you can keep working.`);
    setSelected(new Set());
    setRowStatus((prev) => {
      const n = { ...prev };
      for (const it of items) n[it.key] = 'sending';
      return n;
    });
    window.setTimeout(() => setToast(null), 4000);

    // Bounded concurrency so a big selection doesn't hammer OpenAI/Twilio/Resend.
    await pool(items, BULK_CONCURRENCY, async (it) => {
      try {
        const res = await sendRowAiOutreachAction({
          orgId: it.orgId,
          issueType: it.issueType as string,
          detail: it.aiDetail,
          channels,
        });
        setRowStatus((prev) => ({ ...prev, [it.key]: res.ok ? 'done' : 'failed' }));
        if (res.ok && it.issueType) {
          setOverrides((prev) => ({
            ...prev,
            [it.key]: {
              label: outreachStatusLabel('sent', it.issueType as OutreachIssueType),
              lastContactISO: new Date().toISOString(),
            },
          }));
        }
      } catch {
        setRowStatus((prev) => ({ ...prev, [it.key]: 'failed' }));
      }
    });

    // One sync at the end (after everything settles) — optimistic overrides
    // already updated the visible columns, so this never blocks the user.
    router.refresh();
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-emerald-200 bg-emerald-50/50 p-6 text-center text-sm text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-300">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-violet-200 bg-violet-50/60 px-3 py-2 text-sm dark:border-violet-900/60 dark:bg-violet-950/30">
          <span className="font-medium text-violet-800 dark:text-violet-200">{selected.size} selected</span>
          <span className="flex items-center gap-1">
            {CHANNEL_OPTS.map((c) => (
              <button
                key={c.key}
                type="button"
                disabled={demo}
                onClick={() => setChannel(c.key)}
                className={`rounded-md border px-2 py-0.5 text-xs ${
                  channel === c.key
                    ? 'border-violet-400 bg-white text-violet-700 dark:border-violet-600 dark:bg-zinc-900 dark:text-violet-300'
                    : 'border-transparent text-zinc-600 dark:text-zinc-400'
                } disabled:opacity-50`}
              >
                {c.label}
              </button>
            ))}
          </span>
          <button
            type="button"
            onClick={runBulk}
            disabled={demo}
            title={demo ? 'Demo data — sending disabled' : undefined}
            className="rounded-md bg-violet-600 px-3 py-1 text-xs font-medium text-white shadow-sm hover:bg-violet-700 disabled:opacity-50"
          >
            Send AI nudges ({selected.size})
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="rounded-md px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
          >
            Clear
          </button>
          {demo && <span className="text-xs text-zinc-500">Demo — sending disabled</span>}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="w-10 px-4 py-2.5">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={actionable.length === 0}
                  className="h-4 w-4 rounded border-zinc-300 accent-violet-600"
                />
              </th>
              <th className="px-4 py-2.5">Issue</th>
              <th className="px-4 py-2.5">AI Action</th>
              <th className="px-4 py-2.5 whitespace-nowrap">AI Last Contact</th>
              <th className="px-4 py-2.5">Last AI Message</th>
              <th className="px-4 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const st = rowStatus[r.key];
              const ov = overrides[r.key];
              const contactISO = ov?.lastContactISO ?? r.lastContactISO;
              // Bookkeeper-owned (route) rows send the pro to the workspace.
              const openLabel = r.actionMode === 'route' ? 'Open workspace' : 'Open client';
              return (
                <tr key={r.key} data-search={r.searchText} className="border-t border-zinc-100 align-top dark:border-zinc-800">
                  <td className="px-4 py-3">
                    {st === 'sending' ? (
                      <Spinner />
                    ) : (
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.title} for ${r.clientName}`}
                        checked={selected.has(r.key)}
                        onChange={() => toggle(r.key)}
                        disabled={!r.issueType || r.actionMode === 'route'}
                        className="h-4 w-4 rounded border-zinc-300 accent-violet-600 disabled:opacity-40"
                      />
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-start gap-2">
                      <span
                        aria-hidden
                        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                          r.severity === 'blocking' ? 'bg-red-500' : 'bg-amber-400'
                        }`}
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-zinc-900 dark:text-zinc-100">{r.title}</span>
                          <span
                            title={`Owned by: ${ownerLabel(r.owner)}`}
                            className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                              r.owner === 'pro'
                                ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300'
                                : r.owner === 'client'
                                  ? 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
                                  : 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300'
                            }`}
                          >
                            {ownerLabel(r.owner)}
                          </span>
                        </div>
                        <div className="text-xs text-zinc-500">{r.clientName}</div>
                        {r.detail && <div className="text-xs text-zinc-400">{r.detail}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {st === 'sending' ? (
                      <span className="inline-flex items-center gap-1.5 text-violet-600 dark:text-violet-300">
                        <Spinner /> Sending…
                      </span>
                    ) : st === 'failed' ? (
                      <span className="text-red-600 dark:text-red-400">Send failed — retry</span>
                    ) : (ov?.label ?? r.aiActionLabel) ? (
                      <span className="text-violet-700 dark:text-violet-300">{ov?.label ?? r.aiActionLabel}</span>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap tabular-nums text-zinc-600 dark:text-zinc-400">
                    {contactISO ? new Date(contactISO).toLocaleDateString() : <span className="text-zinc-400">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {r.lastMessage ? (
                      <span title={r.lastMessage} className="block max-w-[22rem] truncate italic text-zinc-500 dark:text-zinc-400">
                        “{r.lastMessage}”
                      </span>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1.5">
                      {r.issueType && r.actionMode !== 'route' && (
                        <AiActionButton
                          orgId={r.orgId}
                          issueType={r.issueType}
                          clientName={r.clientName}
                          detail={r.aiDetail}
                          demo={demo}
                          demoMessage={r.lastMessage ?? undefined}
                        />
                      )}
                      {r.issueType === 'recon_off' && <AutoMatchButton orgId={r.orgId} demo={demo} />}
                      {demo ? (
                        <button
                          type="button"
                          disabled
                          title="Demo data — sample client"
                          className="cursor-not-allowed rounded-md border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-400 dark:border-zinc-800 dark:text-zinc-600"
                        >
                          {openLabel}
                        </button>
                      ) : r.ownerIsSuper ? (
                        <Link
                          href={`/enterprise/clients/${r.ownerUserId}`}
                          className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                        >
                          View
                        </Link>
                      ) : (
                        <form action={openClientBooksAction} className="inline">
                          <input type="hidden" name="targetUserId" value={r.ownerUserId} />
                          <input type="hidden" name="orgId" value={r.orgId} />
                          <input type="hidden" name="next" value={r.next} />
                          <button
                            type="submit"
                            className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white shadow-sm hover:bg-blue-700"
                          >
                            {openLabel}
                          </button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {hiddenCount > 0 && (
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          + {hiddenCount} more — showing the {cap} highest-priority.
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-lg border border-emerald-200 bg-white px-4 py-3 text-sm text-emerald-800 shadow-lg dark:border-emerald-900/60 dark:bg-zinc-900 dark:text-emerald-200">
          <svg viewBox="0 0 24 24" className="h-5 w-5 text-emerald-500" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <path d="m9 11 3 3L22 4" />
          </svg>
          {toast}
        </div>
      )}
    </div>
  );
}
