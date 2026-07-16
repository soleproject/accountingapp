'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';

/**
 * Per-user AI thread context window. See migration 0065 for the value
 * constraints (0 = full, 3 / 5 / 10 are the bounded options).
 *
 * NULL means "use the default" which the AI draft library treats as 5.
 */
const ALLOWED = new Set([0, 3, 5, 10]);

export interface SetAiContextWindowInput {
	value: number;
}

export interface SetAiContextWindowResult {
	ok: boolean;
	error?: string;
}

export async function setAiContextWindowAction(
	input: SetAiContextWindowInput,
): Promise<SetAiContextWindowResult> {
	const user = await requireSession();
	if (!ALLOWED.has(input.value)) {
		return { ok: false, error: 'Invalid context window — must be 3, 5, 10, or 0 (full thread)' };
	}
	await db
		.update(users)
		.set({ aiThreadContextWindow: input.value })
		.where(eq(users.id, user.id));
	revalidatePath('/settings');
	revalidatePath('/organizer/settings');
	return { ok: true };
}
