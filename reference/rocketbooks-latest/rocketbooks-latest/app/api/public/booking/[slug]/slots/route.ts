import { NextResponse } from 'next/server';
import { getProfileBySlug, getEventType, getOpenSlots } from '@/lib/booking/availability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public, unauthenticated. Returns open slots (UTC) for a booking link's event
 * type within a window. The page renders them in the visitor's local timezone.
 *
 * GET /api/public/booking/:slug/slots?event=<eventSlug>&from=<ISO>&to=<ISO>
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
	const { slug } = await ctx.params;
	const url = new URL(req.url);
	const eventSlug = url.searchParams.get('event') ?? '';
	const fromRaw = url.searchParams.get('from');
	const toRaw = url.searchParams.get('to');

	const profile = await getProfileBySlug(slug);
	if (!profile) return NextResponse.json({ error: 'not_found' }, { status: 404 });

	const eventType = await getEventType(profile.id, eventSlug);
	if (!eventType) return NextResponse.json({ error: 'event_not_found' }, { status: 404 });

	const now = new Date();
	const from = fromRaw ? new Date(fromRaw) : now;
	const defaultTo = new Date(now.getTime() + profile.maxDaysOut * 86400000);
	const to = toRaw ? new Date(toRaw) : defaultTo;
	if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
		return NextResponse.json({ error: 'bad_range' }, { status: 400 });
	}

	const slots = await getOpenSlots({ profile, eventType, fromUtc: from, toUtc: to, now });

	return NextResponse.json({
		timezone: profile.timezone,
		durationMinutes: eventType.durationMinutes,
		eventName: eventType.name,
		slots,
	});
}
