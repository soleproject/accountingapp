import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema/schema';
import { getOrgFeature } from '@/lib/accounting/get-org-feature';

/**
 * True if the recorder feature should be visible/usable for this user
 * in this org. We check two switches and OR them:
 *
 *   1. user-level — `users.recorder_enabled_at` is set. Flip this on
 *      once and the recorder follows the user across every workspace
 *      they switch into.
 *   2. org-level — the org has the 'recorder' feature pack enabled.
 *      Lets us roll the feature out to whole workspaces later without
 *      touching individual users.
 */
export async function isRecorderEnabled(userId: string, orgId: string): Promise<boolean> {
	const [row] = await db
		.select({ enabledAt: users.recorderEnabledAt })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (row?.enabledAt) return true;
	return getOrgFeature(orgId, 'recorder');
}
