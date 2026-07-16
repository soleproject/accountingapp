'use server';

import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getOrCreateBookingProfile } from '@/lib/booking/profile';
import { appBaseUrl } from '@/lib/booking/links';

/** The exact prop shape the BookingSettings editor consumes (mirrors the
 *  /settings/booking page). */
export interface BookingBundleProps {
  baseUrl: string;
  profile: {
    slug: string;
    timezone: string;
    minNoticeMinutes: number;
    maxDaysOut: number;
    bufferMinutes: number;
    isActive: boolean;
  };
  eventTypes: {
    id: string;
    name: string;
    slug: string;
    durationMinutes: number;
    description: string | null;
    location: string | null;
    isActive: boolean;
  }[];
  rules: { weekday: number; startMinute: number; endMinute: number }[];
  overrides: { id: string; date: string; isBlocked: boolean; startMinute: number | null; endMinute: number | null }[];
}

/**
 * Load (creating if absent) the current user's booking bundle for the embedded
 * editor in the onboarding wizard's booking modal. Operates on the session user
 * (the enterprise owner) — whose calendar the client setup meetings book.
 */
export async function loadMyBookingBundleAction(): Promise<BookingBundleProps> {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  const [profileRow] = await db.select({ fullName: users.fullName }).from(users).where(eq(users.id, user.id)).limit(1);

  const bundle = await getOrCreateBookingProfile({
    userId: user.id,
    organizationId: orgId,
    seed: profileRow?.fullName || user.email || 'meet',
  });

  return {
    baseUrl: `${appBaseUrl()}/book/`,
    profile: {
      slug: bundle.profile.slug,
      timezone: bundle.profile.timezone,
      minNoticeMinutes: bundle.profile.minNoticeMinutes,
      maxDaysOut: bundle.profile.maxDaysOut,
      bufferMinutes: bundle.profile.bufferMinutes,
      isActive: bundle.profile.isActive,
    },
    eventTypes: bundle.eventTypes.map((e) => ({
      id: e.id,
      name: e.name,
      slug: e.slug,
      durationMinutes: e.durationMinutes,
      description: e.description,
      location: e.location,
      isActive: e.isActive,
    })),
    rules: bundle.rules.map((r) => ({ weekday: r.weekday, startMinute: r.startMinute, endMinute: r.endMinute })),
    overrides: bundle.overrides.map((o) => ({
      id: o.id,
      date: String(o.date),
      isBlocked: o.isBlocked,
      startMinute: o.startMinute,
      endMinute: o.endMinute,
    })),
  };
}
