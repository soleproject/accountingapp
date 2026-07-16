import { NextResponse } from 'next/server';
import { getProfileBySlug, getEventType } from '@/lib/booking/availability';
import { createBooking } from '@/lib/booking/createBooking';
import { cancelUrl } from '@/lib/booking/links';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Public, unauthenticated. Confirms a booking for a link's event type.
 * Body: { event, slotStartUtc, name, email, phone?, notes? }
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
	const { slug } = await ctx.params;

	let body: Record<string, unknown>;
	try {
		body = (await req.json()) as Record<string, unknown>;
	} catch {
		return NextResponse.json({ error: 'invalid' }, { status: 400 });
	}

	const eventSlug = String(body.event ?? '');
	const slotStartUtc = String(body.slotStartUtc ?? '');
	const name = String(body.name ?? '').trim();
	const email = String(body.email ?? '').trim();
	const phone = body.phone != null ? String(body.phone) : null;
	const notes = body.notes != null ? String(body.notes) : null;

	if (!name || !EMAIL_RE.test(email) || !slotStartUtc) {
		return NextResponse.json({ error: 'invalid' }, { status: 400 });
	}

	const profile = await getProfileBySlug(slug);
	if (!profile) return NextResponse.json({ error: 'not_found' }, { status: 404 });
	const eventType = await getEventType(profile.id, eventSlug);
	if (!eventType) return NextResponse.json({ error: 'event_not_found' }, { status: 404 });

	const result = await createBooking({
		profile,
		eventType,
		slotStartUtc,
		bookerName: name,
		bookerEmail: email,
		bookerPhone: phone,
		notes,
	});

	if (!result.ok) {
		const status = result.error === 'slot_taken' ? 409 : result.error === 'invalid' ? 400 : 500;
		return NextResponse.json({ error: result.error }, { status });
	}

	return NextResponse.json({
		ok: true,
		startUtc: result.startUtc,
		endUtc: result.endUtc,
		cancelUrl: cancelUrl(result.cancelToken),
	});
}
