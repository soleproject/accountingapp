'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';

/**
 * Persist the user's AI voice-doc preferences. Empty / whitespace-only
 * input clears the doc (stored as NULL) so the draft job skips the
 * voice wrapper entirely instead of injecting an empty block.
 *
 * Soft cap 2000 chars — long enough for meaningful style guidance
 * without bloating every draft prompt. Raise in code if user feedback
 * says it's tight.
 */

const MAX_CHARS = 2000;

export interface SetAiVoiceDocInput {
	value: string;
}

export interface SetAiVoiceDocResult {
	ok: boolean;
	error?: string;
}

export async function setAiVoiceDocAction(
	input: SetAiVoiceDocInput,
): Promise<SetAiVoiceDocResult> {
	const user = await requireSession();
	const trimmed = input.value.trim();
	if (trimmed.length > MAX_CHARS) {
		return { ok: false, error: `Voice doc is too long (${trimmed.length} / ${MAX_CHARS} chars)` };
	}
	await db
		.update(users)
		.set({ aiVoiceDoc: trimmed.length === 0 ? null : trimmed })
		.where(eq(users.id, user.id));
	revalidatePath('/settings');
	revalidatePath('/organizer/settings');
	return { ok: true };
}
