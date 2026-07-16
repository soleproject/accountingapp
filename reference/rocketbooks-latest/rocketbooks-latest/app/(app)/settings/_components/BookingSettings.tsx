'use client';

import { useMemo, useState, useTransition } from 'react';
import {
	saveBookingProfileAction,
	saveAvailabilityAction,
	createEventTypeAction,
	updateEventTypeAction,
	deleteEventTypeAction,
	saveDateOverrideAction,
	deleteDateOverrideAction,
} from '../_actions/booking';
import {
	WEEKDAY_LABELS,
	MIN_NOTICE_OPTIONS,
	MAX_DAYS_OUT_OPTIONS,
	BUFFER_OPTIONS,
	DURATION_OPTIONS,
	minutesToHHMM,
	hhmmToMinutes,
	slugify,
} from '@/lib/booking/constants';
import { COMMON_TIMEZONES } from '@/lib/booking/time';

type ProfileInput = {
	slug: string;
	timezone: string;
	minNoticeMinutes: number;
	maxDaysOut: number;
	bufferMinutes: number;
	isActive: boolean;
};
type EventTypeInput = {
	id: string;
	name: string;
	slug: string;
	durationMinutes: number;
	description: string | null;
	location: string | null;
	isActive: boolean;
};
type RuleInput = { weekday: number; startMinute: number; endMinute: number };
type OverrideInput = { id: string; date: string; isBlocked: boolean; startMinute: number | null; endMinute: number | null };

type Window = { start: string; end: string };

const card = 'overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950';
const cardHead = 'border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900';
const cardTitle = 'text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400';
const input = 'rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950';
const btn = 'inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800';
const btnPrimary = 'inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300';

export function BookingSettings(props: {
	baseUrl: string;
	profile: ProfileInput;
	eventTypes: EventTypeInput[];
	rules: RuleInput[];
	overrides: OverrideInput[];
}) {
	return (
		<div className="space-y-6">
			<ProfileCard baseUrl={props.baseUrl} profile={props.profile} />
			<AvailabilityCard rules={props.rules} />
			<EventTypesCard baseUrl={props.baseUrl} slug={props.profile.slug} eventTypes={props.eventTypes} />
			<OverridesCard overrides={props.overrides} />
		</div>
	);
}

function Notice({ error, pending, ok }: { error?: string | null; pending?: boolean; ok?: boolean }) {
	if (error)
		return (
			<div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
				{error}
			</div>
		);
	if (pending) return <div className="text-xs text-zinc-500">Saving…</div>;
	if (ok) return <div className="text-xs text-green-600 dark:text-green-400">Saved.</div>;
	return null;
}

function ProfileCard({ baseUrl, profile }: { baseUrl: string; profile: ProfileInput }) {
	const [slug, setSlug] = useState(profile.slug);
	const [timezone, setTimezone] = useState(profile.timezone);
	const [minNotice, setMinNotice] = useState(profile.minNoticeMinutes);
	const [maxDays, setMaxDays] = useState(profile.maxDaysOut);
	const [buffer, setBuffer] = useState(profile.bufferMinutes);
	const [isActive, setIsActive] = useState(profile.isActive);
	const [error, setError] = useState<string | null>(null);
	const [ok, setOk] = useState(false);
	const [copied, setCopied] = useState(false);
	const [pending, start] = useTransition();

	const link = `${baseUrl}${slug}`;

	const save = () => {
		setError(null);
		setOk(false);
		start(async () => {
			const r = await saveBookingProfileAction({
				slug,
				timezone,
				minNoticeMinutes: minNotice,
				maxDaysOut: maxDays,
				bufferMinutes: buffer,
				isActive,
			});
			if (!r.ok) {
				setError(
					r.error === 'slug_taken'
						? 'That link name is already taken — try another.'
						: r.error === 'invalid_slug'
							? 'Enter a valid link name (letters and numbers).'
							: 'Save failed.',
				);
				return;
			}
			setSlug(r.slug);
			setOk(true);
		});
	};

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(link);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			/* clipboard unavailable */
		}
	};

	return (
		<section className={card}>
			<header className={cardHead}>
				<h2 className={cardTitle}>Your booking link</h2>
			</header>
			<div className="flex flex-col gap-4 px-4 py-3 text-sm">
				<div className="flex flex-col gap-1.5">
					<span className="font-medium text-zinc-700 dark:text-zinc-300">Public link</span>
					<div className="flex flex-wrap items-center gap-2">
						<span className="rounded bg-zinc-100 px-2 py-1 font-mono text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">{link}</span>
						<button type="button" className={btn} onClick={copy}>
							{copied ? 'Copied!' : 'Copy link'}
						</button>
						<a className={btn} href={link} target="_blank" rel="noreferrer">
							Preview
						</a>
					</div>
				</div>

				<label className="flex flex-col gap-1.5">
					<span className="font-medium text-zinc-700 dark:text-zinc-300">Link name</span>
					<input className={`${input} max-w-xs`} value={slug} onChange={(e) => setSlug(slugify(e.target.value))} placeholder="your-name" />
				</label>

				<label className="flex flex-col gap-1.5">
					<span className="font-medium text-zinc-700 dark:text-zinc-300">Timezone</span>
					<select className={`${input} max-w-xs`} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
						{COMMON_TIMEZONES.map((tz) => (
							<option key={tz} value={tz}>
								{tz}
							</option>
						))}
					</select>
				</label>

				<div className="grid gap-4 sm:grid-cols-3">
					<label className="flex flex-col gap-1.5">
						<span className="font-medium text-zinc-700 dark:text-zinc-300">Minimum notice</span>
						<select className={input} value={minNotice} onChange={(e) => setMinNotice(Number(e.target.value))}>
							{MIN_NOTICE_OPTIONS.map((m) => (
								<option key={m} value={m}>
									{noticeLabel(m)}
								</option>
							))}
						</select>
					</label>
					<label className="flex flex-col gap-1.5">
						<span className="font-medium text-zinc-700 dark:text-zinc-300">Bookable up to</span>
						<select className={input} value={maxDays} onChange={(e) => setMaxDays(Number(e.target.value))}>
							{MAX_DAYS_OUT_OPTIONS.map((d) => (
								<option key={d} value={d}>
									{d} days out
								</option>
							))}
						</select>
					</label>
					<label className="flex flex-col gap-1.5">
						<span className="font-medium text-zinc-700 dark:text-zinc-300">Buffer between</span>
						<select className={input} value={buffer} onChange={(e) => setBuffer(Number(e.target.value))}>
							{BUFFER_OPTIONS.map((b) => (
								<option key={b} value={b}>
									{b === 0 ? 'None' : `${b} min`}
								</option>
							))}
						</select>
					</label>
				</div>

				<label className="flex items-center gap-2">
					<input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
					<span className="text-zinc-700 dark:text-zinc-300">Link is active (people can book)</span>
				</label>

				<div className="flex items-center gap-3">
					<button type="button" className={btnPrimary} onClick={save} disabled={pending}>
						Save
					</button>
					<Notice error={error} pending={pending} ok={ok} />
				</div>
			</div>
		</section>
	);
}

function AvailabilityCard({ rules }: { rules: RuleInput[] }) {
	// Group incoming rules into per-weekday window lists (HH:MM strings).
	const initial = useMemo(() => {
		const byDay: Window[][] = [[], [], [], [], [], [], []];
		for (const r of rules) byDay[r.weekday].push({ start: minutesToHHMM(r.startMinute), end: minutesToHHMM(r.endMinute) });
		return byDay;
	}, [rules]);

	const [days, setDays] = useState<Window[][]>(initial);
	const [error, setError] = useState<string | null>(null);
	const [ok, setOk] = useState(false);
	const [pending, start] = useTransition();

	const setWindow = (d: number, i: number, key: 'start' | 'end', value: string) => {
		setDays((prev) => {
			const next = prev.map((w) => w.slice());
			next[d][i] = { ...next[d][i], [key]: value };
			return next;
		});
	};
	const addWindow = (d: number) =>
		setDays((prev) => {
			const next = prev.map((w) => w.slice());
			next[d].push({ start: '09:00', end: '17:00' });
			return next;
		});
	const removeWindow = (d: number, i: number) =>
		setDays((prev) => {
			const next = prev.map((w) => w.slice());
			next[d].splice(i, 1);
			return next;
		});

	const save = () => {
		setError(null);
		setOk(false);
		const out: RuleInput[] = [];
		for (let d = 0; d < 7; d++) {
			for (const w of days[d]) {
				const s = hhmmToMinutes(w.start);
				const e = hhmmToMinutes(w.end);
				if (s == null || e == null) {
					setError('Enter valid times (HH:MM).');
					return;
				}
				if (e <= s) {
					setError(`On ${WEEKDAY_LABELS[d]}, the end time must be after the start time.`);
					return;
				}
				out.push({ weekday: d, startMinute: s, endMinute: e });
			}
		}
		start(async () => {
			const r = await saveAvailabilityAction({ rules: out });
			if (!r.ok) {
				setError('Save failed.');
				return;
			}
			setOk(true);
		});
	};

	return (
		<section className={card}>
			<header className={cardHead}>
				<h2 className={cardTitle}>Weekly availability</h2>
			</header>
			<div className="flex flex-col gap-3 px-4 py-3 text-sm">
				<p className="text-xs text-zinc-500">
					Set the hours you&apos;re open each day. Add more than one window for split availability (e.g. mornings and
					afternoons). Days with no window aren&apos;t bookable.
				</p>
				{WEEKDAY_LABELS.map((label, d) => (
					<div key={d} className="flex flex-wrap items-start gap-3 border-b border-zinc-100 py-2 last:border-0 dark:border-zinc-900">
						<div className="w-10 pt-1.5 font-medium text-zinc-700 dark:text-zinc-300">{label}</div>
						<div className="flex flex-1 flex-col gap-2">
							{days[d].length === 0 && <span className="pt-1.5 text-xs text-zinc-400">Unavailable</span>}
							{days[d].map((w, i) => (
								<div key={i} className="flex items-center gap-2">
									<input type="time" className={input} value={w.start} onChange={(e) => setWindow(d, i, 'start', e.target.value)} />
									<span className="text-zinc-400">to</span>
									<input type="time" className={input} value={w.end} onChange={(e) => setWindow(d, i, 'end', e.target.value)} />
									<button type="button" className={btn} onClick={() => removeWindow(d, i)} aria-label="Remove window">
										Remove
									</button>
								</div>
							))}
							<div>
								<button type="button" className={btn} onClick={() => addWindow(d)}>
									+ Add hours
								</button>
							</div>
						</div>
					</div>
				))}
				<div className="flex items-center gap-3">
					<button type="button" className={btnPrimary} onClick={save} disabled={pending}>
						Save availability
					</button>
					<Notice error={error} pending={pending} ok={ok} />
				</div>
			</div>
		</section>
	);
}

function EventTypesCard({ baseUrl, slug, eventTypes }: { baseUrl: string; slug: string; eventTypes: EventTypeInput[] }) {
	const [pending, start] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [newName, setNewName] = useState('');
	const [newDuration, setNewDuration] = useState(30);

	const add = () => {
		setError(null);
		if (!newName.trim()) {
			setError('Give the meeting type a name.');
			return;
		}
		start(async () => {
			const r = await createEventTypeAction({ name: newName.trim(), durationMinutes: newDuration });
			if (!r.ok) {
				setError('Could not add meeting type.');
				return;
			}
			setNewName('');
			setNewDuration(30);
		});
	};

	return (
		<section className={card}>
			<header className={cardHead}>
				<h2 className={cardTitle}>Meeting types</h2>
			</header>
			<div className="flex flex-col gap-4 px-4 py-3 text-sm">
				<p className="text-xs text-zinc-500">Each meeting type has its own length and its own shareable link.</p>

				{eventTypes.length === 0 && <p className="text-xs text-zinc-400">No meeting types yet — add one below.</p>}

				{eventTypes.map((et) => (
					<EventTypeRow key={et.id} baseUrl={baseUrl} slug={slug} et={et} />
				))}

				<div className="rounded-md border border-dashed border-zinc-300 p-3 dark:border-zinc-700">
					<div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Add a meeting type</div>
					<div className="flex flex-wrap items-end gap-2">
						<label className="flex flex-col gap-1">
							<span className="text-xs text-zinc-500">Name</span>
							<input className={input} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="30 Minute Meeting" />
						</label>
						<label className="flex flex-col gap-1">
							<span className="text-xs text-zinc-500">Duration</span>
							<select className={input} value={newDuration} onChange={(e) => setNewDuration(Number(e.target.value))}>
								{DURATION_OPTIONS.map((d) => (
									<option key={d} value={d}>
										{d} min
									</option>
								))}
							</select>
						</label>
						<button type="button" className={btnPrimary} onClick={add} disabled={pending}>
							Add
						</button>
					</div>
				</div>
				<Notice error={error} pending={pending} />
			</div>
		</section>
	);
}

function EventTypeRow({ baseUrl, slug, et }: { baseUrl: string; slug: string; et: EventTypeInput }) {
	const [name, setName] = useState(et.name);
	const [duration, setDuration] = useState(et.durationMinutes);
	const [description, setDescription] = useState(et.description ?? '');
	const [location, setLocation] = useState(et.location ?? '');
	const [isActive, setIsActive] = useState(et.isActive);
	const [error, setError] = useState<string | null>(null);
	const [ok, setOk] = useState(false);
	const [copied, setCopied] = useState(false);
	const [pending, start] = useTransition();

	const link = `${baseUrl}${slug}/${et.slug}`;

	const save = () => {
		setError(null);
		setOk(false);
		start(async () => {
			const r = await updateEventTypeAction({
				id: et.id,
				name,
				durationMinutes: duration,
				description: description || null,
				location: location || null,
				isActive,
			});
			if (!r.ok) {
				setError('Save failed.');
				return;
			}
			setOk(true);
		});
	};
	const remove = () => {
		if (!confirm(`Delete "${et.name}"? Existing booked meetings stay on your calendar.`)) return;
		start(async () => {
			await deleteEventTypeAction({ id: et.id });
		});
	};
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(link);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			/* clipboard unavailable */
		}
	};

	return (
		<div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
			<div className="mb-2 flex flex-wrap items-center gap-2">
				<span className="rounded bg-zinc-100 px-2 py-1 font-mono text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">{link}</span>
				<button type="button" className={btn} onClick={copy}>
					{copied ? 'Copied!' : 'Copy link'}
				</button>
			</div>
			<div className="flex flex-wrap items-end gap-2">
				<label className="flex flex-col gap-1">
					<span className="text-xs text-zinc-500">Name</span>
					<input className={input} value={name} onChange={(e) => setName(e.target.value)} />
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs text-zinc-500">Duration</span>
					<select className={input} value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
						{DURATION_OPTIONS.map((d) => (
							<option key={d} value={d}>
								{d} min
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs text-zinc-500">Location (optional)</span>
					<input className={input} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Zoom / phone / address" />
				</label>
			</div>
			<label className="mt-2 flex flex-col gap-1">
				<span className="text-xs text-zinc-500">Description (optional)</span>
				<textarea className={`${input} min-h-[60px]`} value={description} onChange={(e) => setDescription(e.target.value)} />
			</label>
			<div className="mt-2 flex flex-wrap items-center gap-3">
				<label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
					<input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
					Active
				</label>
				<button type="button" className={btnPrimary} onClick={save} disabled={pending}>
					Save
				</button>
				<button type="button" className={btn} onClick={remove} disabled={pending}>
					Delete
				</button>
				<Notice error={error} pending={pending} ok={ok} />
			</div>
		</div>
	);
}

function OverridesCard({ overrides }: { overrides: OverrideInput[] }) {
	const [pending, start] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [date, setDate] = useState('');
	const [mode, setMode] = useState<'block' | 'custom'>('block');
	const [from, setFrom] = useState('09:00');
	const [to, setTo] = useState('17:00');

	const add = () => {
		setError(null);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
			setError('Pick a date.');
			return;
		}
		const payload =
			mode === 'block'
				? { date, isBlocked: true }
				: { date, isBlocked: false, startMinute: hhmmToMinutes(from), endMinute: hhmmToMinutes(to) };
		if (mode === 'custom') {
			const s = hhmmToMinutes(from);
			const e = hhmmToMinutes(to);
			if (s == null || e == null || e <= s) {
				setError('Enter valid custom hours.');
				return;
			}
		}
		start(async () => {
			const r = await saveDateOverrideAction(payload);
			if (!r.ok) {
				setError('Save failed.');
				return;
			}
			setDate('');
		});
	};
	const remove = (id: string) =>
		start(async () => {
			await deleteDateOverrideAction({ id });
		});

	return (
		<section className={card}>
			<header className={cardHead}>
				<h2 className={cardTitle}>Date overrides</h2>
			</header>
			<div className="flex flex-col gap-3 px-4 py-3 text-sm">
				<p className="text-xs text-zinc-500">Block a specific day off, or open special hours that differ from your weekly schedule.</p>

				{overrides.length > 0 && (
					<ul className="flex flex-col gap-1">
						{overrides.map((o) => (
							<li key={o.id} className="flex items-center justify-between gap-2 rounded bg-zinc-50 px-3 py-1.5 dark:bg-zinc-900">
								<span className="text-zinc-700 dark:text-zinc-300">
									{o.date} —{' '}
									{o.isBlocked
										? 'Blocked'
										: `${o.startMinute != null ? minutesToHHMM(o.startMinute) : '?'}–${o.endMinute != null ? minutesToHHMM(o.endMinute) : '?'}`}
								</span>
								<button type="button" className={btn} onClick={() => remove(o.id)} disabled={pending}>
									Remove
								</button>
							</li>
						))}
					</ul>
				)}

				<div className="flex flex-wrap items-end gap-2">
					<label className="flex flex-col gap-1">
						<span className="text-xs text-zinc-500">Date</span>
						<input type="date" className={input} value={date} onChange={(e) => setDate(e.target.value)} />
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-xs text-zinc-500">Type</span>
						<select className={input} value={mode} onChange={(e) => setMode(e.target.value as 'block' | 'custom')}>
							<option value="block">Block (day off)</option>
							<option value="custom">Custom hours</option>
						</select>
					</label>
					{mode === 'custom' && (
						<>
							<label className="flex flex-col gap-1">
								<span className="text-xs text-zinc-500">From</span>
								<input type="time" className={input} value={from} onChange={(e) => setFrom(e.target.value)} />
							</label>
							<label className="flex flex-col gap-1">
								<span className="text-xs text-zinc-500">To</span>
								<input type="time" className={input} value={to} onChange={(e) => setTo(e.target.value)} />
							</label>
						</>
					)}
					<button type="button" className={btnPrimary} onClick={add} disabled={pending}>
						Add override
					</button>
				</div>
				<Notice error={error} pending={pending} />
			</div>
		</section>
	);
}

function noticeLabel(m: number): string {
	if (m === 0) return 'None';
	if (m < 60) return `${m} minutes`;
	if (m < 1440) return `${m / 60} hour${m === 60 ? '' : 's'}`;
	return `${m / 1440} day${m === 1440 ? '' : 's'}`;
}
