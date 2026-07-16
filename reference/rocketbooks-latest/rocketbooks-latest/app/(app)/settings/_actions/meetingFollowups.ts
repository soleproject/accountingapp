'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { GRACE_OPTIONS } from '@/lib/meetings/constants';

export interface SetMeetingFollowupsInput {
	enabled?: boolean;
	graceMinutes?: number;
}

export interface SetMeetingFollowupsResult {
	ok: boolean;
	error?: string;
}

/**
 * Org-level meeting follow-up settings (migration 0076). The cron reads these
 * via loadFollowupSettings, so a change applies on the next tick.
 */
export async function setMeetingFollowupsAction(
	input: SetMeetingFollowupsInput,
): Promise<SetMeetingFollowupsResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const patch: { meetingFollowupsEnabled?: boolean; meetingFollowupsGraceMinutes?: number } = {};
	if (typeof input.enabled === 'boolean') patch.meetingFollowupsEnabled = input.enabled;
	if (typeof input.graceMinutes === 'number') {
		if (!(GRACE_OPTIONS as readonly number[]).includes(input.graceMinutes)) {
			return { ok: false, error: 'Invalid grace period.' };
		}
		patch.meetingFollowupsGraceMinutes = input.graceMinutes;
	}
	if (Object.keys(patch).length === 0) return { ok: true };

	await db.update(organizations).set(patch).where(eq(organizations.id, orgId));
	revalidatePath('/settings');
	revalidatePath('/organizer/settings');
	return { ok: true };
}
