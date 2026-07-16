'use client';

import { useState, useTransition } from 'react';
import { setMeetingFollowupsAction } from '../_actions/meetingFollowups';
import { GRACE_OPTIONS } from '@/lib/meetings/constants';

interface Props {
	enabled: boolean;
	graceMinutes: number;
}

function graceLabel(m: number): string {
	if (m === 0) return 'Immediately after the meeting ends';
	if (m < 60) return `${m} minutes after the meeting ends`;
	const h = m / 60;
	return `${h} hour${h === 1 ? '' : 's'} after the meeting ends`;
}

/**
 * Org-level controls for the meeting follow-up loop: turn it on/off and pick how
 * long to wait before creating the "Get the notes" task. The cron reads these on
 * its next tick. Optimistic with rollback, matching AiContextWindowCard.
 */
export function MeetingFollowupsCard({ enabled, graceMinutes }: Props) {
	const [on, setOn] = useState(enabled);
	const [grace, setGrace] = useState(graceMinutes);
	const [saved, setSaved] = useState({ on: enabled, grace: graceMinutes });
	const [error, setError] = useState<string | null>(null);
	const [isPending, startTransition] = useTransition();

	const save = (next: { enabled?: boolean; graceMinutes?: number }) => {
		setError(null);
		startTransition(async () => {
			const r = await setMeetingFollowupsAction(next);
			if (!r.ok) {
				setError(r.error ?? 'Save failed');
				setOn(saved.on);
				setGrace(saved.grace);
				return;
			}
			setSaved({ on: next.enabled ?? on, grace: next.graceMinutes ?? grace });
		});
	};

	return (
		<section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
			<header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
				<h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Meeting Follow-ups</h2>
			</header>
			<div className="flex flex-col gap-4 px-4 py-3 text-sm">
				<p className="text-xs text-zinc-500">
					After a meeting with a contact ends, RocketSuite watches for notes (a recording or a note you
					attach). If none arrive it creates a task to get them; once notes land it drafts a Call Debrief
					with the follow-ups. It never emails or texts anyone on your behalf.
				</p>

				<label className="flex flex-col gap-1.5">
					<span className="font-medium text-zinc-700 dark:text-zinc-300">Status</span>
					<select
						value={on ? 'on' : 'off'}
						onChange={(e) => {
							const next = e.target.value === 'on';
							setOn(next);
							save({ enabled: next });
						}}
						disabled={isPending}
						className="max-w-xs rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950"
					>
						<option value="off">Off</option>
						<option value="on">On</option>
					</select>
				</label>

				<label className="flex flex-col gap-1.5">
					<span className="font-medium text-zinc-700 dark:text-zinc-300">Wait before chasing notes</span>
					<span className="text-xs text-zinc-500">
						How long to wait after a meeting ends before creating the &ldquo;Get the notes&rdquo; task.
					</span>
					<select
						value={grace}
						onChange={(e) => {
							const next = parseInt(e.target.value, 10);
							setGrace(next);
							save({ graceMinutes: next });
						}}
						disabled={isPending || !on}
						className="mt-1 max-w-xs rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950"
					>
						{GRACE_OPTIONS.map((m) => (
							<option key={m} value={m}>
								{graceLabel(m)}
							</option>
						))}
					</select>
				</label>

				{error && (
					<div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
						{error}
					</div>
				)}
				{isPending && <div className="text-xs text-zinc-500">Saving…</div>}
			</div>
		</section>
	);
}
