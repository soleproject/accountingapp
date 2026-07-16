'use client';

// Shared presentational pieces + types for the Recorder, used by both the
// live capture workspace (RecorderWorkspace) and the per-recording detail
// page (RecordingDetail). Keep these dumb/controlled — state lives in the
// parent.

export interface Segment {
  id: string;
  speakerLabel: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface ActionItem {
  text: string;
  ownerSpeakerLabel: string | null;
  dueHint: string | null;
}

export interface Draft {
  summaryMd: string;
  actionItems: ActionItem[];
  decisions: string[];
  approvedAt: string | null;
}

export type ApproveState = 'idle' | 'saving' | 'saved' | 'error';

export function Transcript({ segments }: { segments: Segment[] }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="mb-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">Transcript</h2>
      <ul className="space-y-2 text-sm">
        {segments.map((s) => (
          <li key={s.id} className="flex gap-3">
            <span className="w-12 shrink-0 font-medium text-sky-700 dark:text-sky-400">{s.speakerLabel}</span>
            <span className="text-zinc-700 dark:text-zinc-300">{s.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SummaryPanel({
  draft,
  checked,
  approve,
  approveError,
  canApprove = true,
  onSummaryChange,
  onActionItemChange,
  onToggle,
  onApprove,
}: {
  draft: Draft;
  checked: boolean[];
  approve: ApproveState;
  approveError: string | null;
  canApprove?: boolean;
  onSummaryChange: (text: string) => void;
  onActionItemChange: (i: number, text: string) => void;
  onToggle: (i: number) => void;
  onApprove: () => void;
}) {
  const alreadyApproved = !!draft.approvedAt || approve === 'saved';
  const anyChecked = checked.some(Boolean);
  const locked = alreadyApproved || !canApprove;
  return (
    <div className="space-y-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div>
        <h2 className="mb-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">Summary</h2>
        <textarea
          value={draft.summaryMd}
          onChange={(e) => onSummaryChange(e.target.value)}
          rows={6}
          disabled={locked}
          className="block w-full rounded-md border border-zinc-300 bg-white p-3 text-sm text-zinc-800 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
          placeholder="Summary will appear here…"
        />
      </div>

      {draft.decisions.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Decisions</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
            {draft.decisions.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
      )}

      {draft.actionItems.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Follow-up tasks</h3>
          <ul className="space-y-2">
            {draft.actionItems.map((it, i) => (
              <li key={i} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={!!checked[i]}
                  onChange={() => onToggle(i)}
                  disabled={locked}
                  className="mt-1.5 h-4 w-4 rounded border-zinc-300 text-sky-600 focus:ring-sky-500"
                />
                <div className="flex-1">
                  <input
                    type="text"
                    value={it.text}
                    onChange={(e) => onActionItemChange(i, e.target.value)}
                    disabled={locked}
                    className="block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-800 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
                  />
                  <div className="mt-1 flex gap-3 text-xs text-zinc-500 dark:text-zinc-500">
                    {it.ownerSpeakerLabel && <span>For: {it.ownerSpeakerLabel}</span>}
                    {it.dueHint && <span>Due: {it.dueHint}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center gap-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
        <button
          type="button"
          onClick={onApprove}
          disabled={locked || approve === 'saving' || !anyChecked}
          className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {alreadyApproved
            ? 'Saved — note + tasks created'
            : approve === 'saving'
              ? 'Saving…'
              : `Create note${anyChecked ? ' + ' + checked.filter(Boolean).length + ' task' + (checked.filter(Boolean).length === 1 ? '' : 's') : ''}`}
        </button>
        {!canApprove && !alreadyApproved && (
          <span className="text-sm text-zinc-500 dark:text-zinc-500">Read-only</span>
        )}
        {approve === 'error' && approveError && (
          <span className="text-sm text-rose-600 dark:text-rose-400">{approveError}</span>
        )}
      </div>
    </div>
  );
}
