'use server';

import { randomUUID } from 'crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { emailAccounts } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { encryptSecret, isCredsKeyConfigured } from '@/lib/email-accounts/crypto';
import { PROVIDER_PRESETS, type ProviderKey } from '@/lib/email-accounts/providers';
import { testConnection, type TestConnectionResult } from '@/lib/email-accounts/test-connection';
import { logger } from '@/lib/logger';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ConnectInput {
	emailAddress: string;
	password: string;
	provider: Exclude<ProviderKey, 'imap'>;
	/** Inbox root URL for the shell that initiated the save. Where the
	 *  user is redirected after a successful insert/update. Optional for
	 *  testConnectionAction (no redirect happens there). Defaults to
	 *  '/inbox' for safety. */
	returnTo?: string;
}

// Allowed redirect targets — guard against open-redirect via this field.
const ALLOWED_RETURN_TO = new Set(['/inbox', '/organizer/inbox']);

interface ResolvedInput extends ConnectInput {
	emailNormalized: string;
	imapHost: string;
	imapPort: number;
	imapSecure: boolean;
	smtpHost: string;
	smtpPort: number;
	smtpSecure: boolean;
}

/**
 * Normalize and validate the form input, including substituting provider
 * presets for IMAP/SMTP hosts. Phase 0 supports gmail/yahoo/icloud only —
 * 'imap' (generic) will land in Phase 0b once we add the host/port form.
 *
 * App passwords from Google/Yahoo are commonly shown with spaces every 4
 * chars ("abcd efgh ijkl mnop"). Strip whitespace so users can paste
 * exactly what the provider displayed without thinking about it.
 */
function resolve(input: ConnectInput): ResolvedInput {
	const emailNormalized = input.emailAddress.trim().toLowerCase();
	if (!emailNormalized) throw new Error('Email address is required');
	if (!EMAIL_RE.test(emailNormalized)) throw new Error('Email address looks invalid');

	const password = input.password.replace(/\s+/g, '');
	if (!password) throw new Error('App password is required');

	if (input.provider !== 'gmail' && input.provider !== 'yahoo' && input.provider !== 'icloud') {
		throw new Error(`Provider "${input.provider}" is not supported yet`);
	}
	const preset = PROVIDER_PRESETS[input.provider];

	return {
		...input,
		emailNormalized,
		password,
		imapHost: preset.imapHost,
		imapPort: preset.imapPort,
		imapSecure: preset.imapSecure,
		smtpHost: preset.smtpHost,
		smtpPort: preset.smtpPort,
		smtpSecure: preset.smtpSecure,
	};
}

/**
 * Run IMAP+SMTP login probes against the entered credentials. Does NOT
 * persist anything — used by the "Test connection" button and called
 * again as a pre-check inside saveAccountAction.
 */
export async function testConnectionAction(input: ConnectInput): Promise<TestConnectionResult> {
	await requireSession();
	if (!isCredsKeyConfigured()) {
		throw new Error('EMAIL_CREDS_KEY is not configured on the server');
	}
	const r = resolve(input);
	return testConnection({
		emailAddress: r.emailNormalized,
		password: r.password,
		imapHost: r.imapHost,
		imapPort: r.imapPort,
		imapSecure: r.imapSecure,
		smtpHost: r.smtpHost,
		smtpPort: r.smtpPort,
		smtpSecure: r.smtpSecure,
	});
}

/**
 * Tests the connection (so we don't store dead creds), encrypts the app
 * password, inserts the row, redirects back to /inbox.
 *
 * On duplicate (user already connected this address), updates the
 * existing row's credentials and resets connection_status to 'ok'.
 * Common case: user generated a fresh app password to replace one
 * that was revoked, and we want a re-paste to recover gracefully.
 */
export async function saveAccountAction(input: ConnectInput): Promise<void> {
	const user = await requireSession();
	if (!isCredsKeyConfigured()) {
		throw new Error('EMAIL_CREDS_KEY is not configured on the server');
	}
	const r = resolve(input);

	const probe = await testConnection({
		emailAddress: r.emailNormalized,
		password: r.password,
		imapHost: r.imapHost,
		imapPort: r.imapPort,
		imapSecure: r.imapSecure,
		smtpHost: r.smtpHost,
		smtpPort: r.smtpPort,
		smtpSecure: r.smtpSecure,
	});
	if (!probe.allOk) {
		const reasons = [
			!probe.imap.ok ? `IMAP: ${probe.imap.error}` : null,
			!probe.smtp.ok ? `SMTP: ${probe.smtp.error}` : null,
		].filter(Boolean);
		throw new Error(`Connection failed — ${reasons.join('; ')}`);
	}

	const enc = encryptSecret(r.password);
	const nowIso = new Date().toISOString();

	// Look up an existing row for this (user, email) and update in place if
	// found. Phase 0 doesn't expose a delete-then-re-add path, so this is
	// the only way to update credentials when a provider reissues them.
	const [existing] = await db
		.select({ id: emailAccounts.id })
		.from(emailAccounts)
		.where(
			and(
				eq(emailAccounts.userId, user.id),
				sql`lower(${emailAccounts.emailAddress}) = ${r.emailNormalized}`,
			),
		)
		.limit(1);

	if (existing) {
		await db
			.update(emailAccounts)
			.set({
				encryptedPassword: enc.ciphertext,
				encryptionIv: enc.iv,
				encryptionAuthTag: enc.authTag,
				provider: r.provider,
				imapHost: r.imapHost,
				imapPort: r.imapPort,
				imapSecure: r.imapSecure,
				smtpHost: r.smtpHost,
				smtpPort: r.smtpPort,
				smtpSecure: r.smtpSecure,
				connectionStatus: 'ok',
				lastError: null,
				isActive: true,
				updatedAt: nowIso,
			})
			.where(eq(emailAccounts.id, existing.id));
		logger.info({ userId: user.id, emailAddress: r.emailNormalized }, 'email account credentials refreshed');
	} else {
		await db.insert(emailAccounts).values({
			id: randomUUID(),
			userId: user.id,
			emailAddress: r.emailNormalized,
			encryptedPassword: enc.ciphertext,
			encryptionIv: enc.iv,
			encryptionAuthTag: enc.authTag,
			provider: r.provider,
			imapHost: r.imapHost,
			imapPort: r.imapPort,
			imapSecure: r.imapSecure,
			smtpHost: r.smtpHost,
			smtpPort: r.smtpPort,
			smtpSecure: r.smtpSecure,
			connectionStatus: 'ok',
		});
		logger.info({ userId: user.id, emailAddress: r.emailNormalized }, 'email account connected');
	}

	// Both shells render the same data, so revalidate both regardless of
	// which one triggered the save.
	revalidatePath('/inbox');
	revalidatePath('/organizer/inbox');
	const target = input.returnTo && ALLOWED_RETURN_TO.has(input.returnTo) ? input.returnTo : '/inbox';
	redirect(target);
}
