import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema/schema';

/**
 * True if the Organizer Texts feature should be visible/usable for this
 * user. Per-user gate via users.texts_enabled_at, mirroring the recorder
 * pattern. (Org-level rollout can be layered in later via the feature-pack
 * table the way isRecorderEnabled does it.)
 */
export async function isTextsEnabled(userId: string): Promise<boolean> {
	const [row] = await db
		.select({ enabledAt: users.textsEnabledAt })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return !!row?.enabledAt;
}
