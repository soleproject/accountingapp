'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';

/**
 * Persist the user's email signature — the block appended to the bottom of
 * every email reply they send from the Inbox. Empty / whitespace-only input
 * clears it (stored as NULL) so no signature is appended. Per-user because
 * replies go out from each person's own connected email account.
 */

const MAX_CHARS = 1000;

export interface SetEmailSignatureInput {
	value: string;
}

export interface SetEmailSignatureResult {
	ok: boolean;
	error?: string;
}

export async function setEmailSignatureAction(
	input: SetEmailSignatureInput,
): Promise<SetEmailSignatureResult> {
	const user = await requireSession();
	const trimmed = input.value.trim();
	if (trimmed.length > MAX_CHARS) {
		return { ok: false, error: `Signature is too long (${trimmed.length} / ${MAX_CHARS} chars)` };
	}
	await db
		.update(users)
		.set({ emailSignature: trimmed.length === 0 ? null : trimmed })
		.where(eq(users.id, user.id));
	revalidatePath('/settings');
	revalidatePath('/organizer/settings');
	return { ok: true };
}
