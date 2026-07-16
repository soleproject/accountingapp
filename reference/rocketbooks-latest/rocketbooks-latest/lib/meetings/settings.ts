import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { DEFAULT_GRACE_MINUTES } from '@/lib/meetings/constants';

export interface FollowupSettings {
	enabled: boolean;
	graceMinutes: number;
}

/**
 * Read a single org's follow-up settings. No session needed — the cron calls
 * this too. Returns the opt-out defaults if the row is somehow missing.
 */
export async function loadFollowupSettings(organizationId: string): Promise<FollowupSettings> {
	const [row] = await db
		.select({
			enabled: organizations.meetingFollowupsEnabled,
			graceMinutes: organizations.meetingFollowupsGraceMinutes,
		})
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);
	return {
		enabled: row?.enabled ?? false,
		graceMinutes: row?.graceMinutes ?? DEFAULT_GRACE_MINUTES,
	};
}
