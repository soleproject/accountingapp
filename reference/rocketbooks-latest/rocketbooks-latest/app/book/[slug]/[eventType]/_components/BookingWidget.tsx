'use client';

import { useEffect, useMemo, useState } from 'react';

type Slot = { startUtc: string; endUtc: string };

const card = 'rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950';
const input = 'w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950';
const btnPrimary = 'inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50';

const localTz = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';

function localDateKey(iso: string): string {
	const d = new Date(iso);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}
function localDayLabel(key: string): string {
	const [y, m, d] = key.split('-').map(Number);
	return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}
function localTimeLabel(iso: string): string {
	return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function BookingWidget(props: {
	slug: string;
	eventSlug: string;
	durationMinutes: number;
	hostTimezone: string;
	maxDaysOut: number;
}) {
	const [slots, setSlots] = useState<Slot[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);

	// Explicit day pin; null falls through to the first available day (see activeDay).
	const [pinnedDay, setPinnedDay] = useState<string | null>(null);
	const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);

	const [name, setName] = useState('');
	const [email, setEmail] = useState('');
	const [phone, setPhone] = useState('');
	const [notes, setNotes] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [confirmed, setConfirmed] = useState<{ startUtc: string; cancelUrl: string } | null>(null);

	useEffect(() => {
		let cancelled = false;
		const from = new Date().toISOString();
		const to = new Date(Date.now() + props.maxDaysOut * 86400000).toISOString();
		const qs = new URLSearchParams({ event: props.eventSlug, from, to });
		// `loading` initializes to true; the slug/event/window deps are stable for
		// this component's lifetime, so no synchronous reset is needed here.
		fetch(`/api/public/booking/${encodeURIComponent(props.slug)}/slots?${qs.toString()}`)
			.then(async (r) => {
				if (!r.ok) throw new Error(`status ${r.status}`);
				return r.json();
			})
			.then((data: { slots: Slot[] }) => {
				if (cancelled) return;
				setSlots(data.slots ?? []);
				setLoading(false);
			})
			.catch(() => {
				if (cancelled) return;
				setLoadError('Could not load available times. Please try again.');
				setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [props.slug, props.eventSlug, props.maxDaysOut]);

	const byDay = useMemo(() => {
		const map = new Map<string, Slot[]>();
		for (const s of slots) {
			const key = localDateKey(s.startUtc);
			const list = map.get(key) ?? [];
			list.push(s);
			map.set(key, list);
		}
		return map;
	}, [slots]);

	const days = useMemo(() => Array.from(byDay.keys()).sort(), [byDay]);

	// Default to the first available day without an effect: a null pin falls
	// through to days[0]. Clicking a day sets an explicit pin.
	const activeDay = pinnedDay ?? days[0] ?? null;
	const daySlots = activeDay ? byDay.get(activeDay) ?? [] : [];

	const submit = async () => {
		if (!selectedSlot) return;
		setSubmitError(null);
		if (!name.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
			setSubmitError('Please enter your name and a valid email.');
			return;
		}
		setSubmitting(true);
		try {
			const r = await fetch(`/api/public/booking/${encodeURIComponent(props.slug)}/book`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					event: props.eventSlug,
					slotStartUtc: selectedSlot.startUtc,
					name: name.trim(),
					email: email.trim(),
					phone: phone.trim() || null,
					notes: notes.trim() || null,
				}),
			});
			const data = await r.json().catch(() => ({}));
			if (!r.ok) {
				if (r.status === 409) {
					setSubmitError('Sorry, that time was just taken. Please pick another.');
					setSlots((prev) => prev.filter((s) => s.startUtc !== selectedSlot.startUtc));
					setSelectedSlot(null);
				} else {
					setSubmitError('Something went wrong booking that time. Please try again.');
				}
				setSubmitting(false);
				return;
			}
			setConfirmed({ startUtc: data.startUtc, cancelUrl: data.cancelUrl });
		} catch {
			setSubmitError('Network error. Please try again.');
		}
		setSubmitting(false);
	};

	if (confirmed) {
		return (
			<div className={card}>
				<h2 className="text-lg font-semibold text-green-700 dark:text-green-400">You&apos;re booked!</h2>
				<p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
					{localDayLabel(localDateKey(confirmed.startUtc))} at {localTimeLabel(confirmed.startUtc)} ({localTz})
				</p>
				<p className="mt-2 text-sm text-zinc-500">A confirmation has been sent to {email}.</p>
				{confirmed.cancelUrl && (
					<p className="mt-4 text-xs text-zinc-400">
						Need to cancel?{' '}
						<a className="underline" href={confirmed.cancelUrl}>
							Cancel this meeting
						</a>
					</p>
				)}
			</div>
		);
	}

	return (
		<div className="grid gap-4 md:grid-cols-2">
			<div className={card}>
				<div className="mb-3 flex items-center justify-between">
					<h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">Select a time</h2>
					<span className="text-xs text-zinc-400">{localTz}</span>
				</div>

				{loading && <p className="text-sm text-zinc-500">Loading available times…</p>}
				{loadError && <p className="text-sm text-red-600">{loadError}</p>}
				{!loading && !loadError && days.length === 0 && <p className="text-sm text-zinc-500">No times are currently available.</p>}

				{days.length > 0 && (
					<div className="flex flex-col gap-3">
						<div className="flex flex-wrap gap-1.5">
							{days.map((d) => (
								<button
									key={d}
									type="button"
									onClick={() => {
										setPinnedDay(d);
										setSelectedSlot(null);
									}}
									className={`rounded-md border px-2.5 py-1 text-xs ${
										activeDay === d
											? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
											: 'border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900'
									}`}
								>
									{localDayLabel(d)}
								</button>
							))}
						</div>

						<div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
							{daySlots.map((s) => (
								<button
									key={s.startUtc}
									type="button"
									onClick={() => setSelectedSlot(s)}
									className={`rounded-md border px-2 py-1.5 text-sm ${
										selectedSlot?.startUtc === s.startUtc
											? 'border-blue-500 bg-blue-600 text-white'
											: 'border-zinc-200 text-zinc-700 hover:border-blue-400 dark:border-zinc-800 dark:text-zinc-300'
									}`}
								>
									{localTimeLabel(s.startUtc)}
								</button>
							))}
						</div>
					</div>
				)}
			</div>

			<div className={card}>
				<h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-500">Your details</h2>
				{selectedSlot ? (
					<p className="mb-3 rounded bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
						{localDayLabel(localDateKey(selectedSlot.startUtc))} at {localTimeLabel(selectedSlot.startUtc)}
					</p>
				) : (
					<p className="mb-3 text-sm text-zinc-400">Pick a time to continue.</p>
				)}

				<div className="flex flex-col gap-3">
					<label className="flex flex-col gap-1">
						<span className="text-xs text-zinc-500">Name</span>
						<input className={input} value={name} onChange={(e) => setName(e.target.value)} disabled={!selectedSlot} />
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-xs text-zinc-500">Email</span>
						<input type="email" className={input} value={email} onChange={(e) => setEmail(e.target.value)} disabled={!selectedSlot} />
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-xs text-zinc-500">Phone (optional)</span>
						<input type="tel" className={input} value={phone} onChange={(e) => setPhone(e.target.value)} disabled={!selectedSlot} />
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-xs text-zinc-500">Anything to share? (optional)</span>
						<textarea className={`${input} min-h-[70px]`} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!selectedSlot} />
					</label>

					{submitError && <p className="text-sm text-red-600">{submitError}</p>}

					<button type="button" className={btnPrimary} onClick={submit} disabled={!selectedSlot || submitting}>
						{submitting ? 'Booking…' : 'Confirm booking'}
					</button>
				</div>
			</div>
		</div>
	);
}
