/**
 * Known-provider IMAP/SMTP presets and email-domain detection helpers.
 * Intentionally pure data + functions — safe to import from client
 * components (the connect form needs PROVIDER_PRESETS for its
 * walkthrough strings and detectProviderByEmail to auto-snap the
 * provider radio). Anything that actually touches credentials or
 * opens connections lives in crypto.ts / test-connection.ts, which
 * keep their `import 'server-only'` guards.
 *
 * Persisted onto the email_accounts row at create time so subsequent
 * connections don't depend on this table — if a provider changes
 * ports, only NEW accounts pick up the change, existing rows keep
 * working.
 *
 * Provider rules of thumb:
 *   - imap_port 993 / secure=true  → IMAPS (implicit TLS)
 *   - smtp_port 465 / secure=true  → SMTPS (implicit TLS)
 *   - smtp_port 587 / secure=false → STARTTLS upgrade
 *
 * imapflow accepts secure=true for implicit-TLS ports and handles the
 * upgrade negotiation when secure=false. nodemailer behaves the same.
 */

export type ProviderKey = 'gmail' | 'yahoo' | 'icloud' | 'imap';

export interface ProviderPreset {
	key: ProviderKey;
	label: string;
	imapHost: string;
	imapPort: number;
	imapSecure: boolean;
	smtpHost: string;
	smtpPort: number;
	smtpSecure: boolean;
	/** Where the user generates an app password — surfaced in the UI walkthrough. */
	appPasswordUrl: string;
	/** Short, copy-tested instructions shown above the form. */
	walkthrough: string[];
}

export const PROVIDER_PRESETS: Record<Exclude<ProviderKey, 'imap'>, ProviderPreset> = {
	gmail: {
		key: 'gmail',
		label: 'Gmail',
		imapHost: 'imap.gmail.com',
		imapPort: 993,
		imapSecure: true,
		smtpHost: 'smtp.gmail.com',
		smtpPort: 465,
		smtpSecure: true,
		appPasswordUrl: 'https://myaccount.google.com/apppasswords',
		walkthrough: [
			'Enable 2-Step Verification at myaccount.google.com/security if you have not already.',
			'Open myaccount.google.com/apppasswords and sign in.',
			'Select "Mail" and name it "RocketSuite", then click Generate.',
			'Copy the 16-character app password (spaces are optional — paste either way).',
		],
	},
	yahoo: {
		key: 'yahoo',
		label: 'Yahoo',
		imapHost: 'imap.mail.yahoo.com',
		imapPort: 993,
		imapSecure: true,
		smtpHost: 'smtp.mail.yahoo.com',
		smtpPort: 465,
		smtpSecure: true,
		appPasswordUrl: 'https://login.yahoo.com/account/security',
		walkthrough: [
			'Open login.yahoo.com/account/security and sign in.',
			'Turn on 2-Step Verification if not already enabled.',
			'Click "Generate app password" → name it "RocketSuite" → Generate.',
			'Copy the 16-character password and paste it below.',
		],
	},
	icloud: {
		key: 'icloud',
		label: 'iCloud',
		imapHost: 'imap.mail.me.com',
		imapPort: 993,
		imapSecure: true,
		smtpHost: 'smtp.mail.me.com',
		smtpPort: 587,
		smtpSecure: false, // STARTTLS
		appPasswordUrl: 'https://account.apple.com/account/manage',
		walkthrough: [
			'Open account.apple.com → Sign In and Security → App-Specific Passwords.',
			'Click "+" to generate a new password, label it "RocketSuite".',
			'Copy the password (format like "abcd-efgh-ijkl-mnop") and paste it below.',
			'iCloud requires that your full @icloud.com address (not just the alias) be used as the username.',
		],
	},
};

/** Provider keys other than the generic IMAP escape hatch. */
export const KNOWN_PROVIDERS: Array<Exclude<ProviderKey, 'imap'>> = ['gmail', 'yahoo', 'icloud'];

/**
 * Auto-detect provider from the email's domain. Falls back to null for
 * anything we don't recognize (Outlook personal, custom domains, etc.) —
 * the UI offers Generic IMAP for those.
 *
 * Note: Outlook.com / Hotmail are deliberately NOT here. Microsoft
 * disabled basic-auth IMAP (including app passwords) for personal
 * accounts in Sep 2024; only OAuth works. We surface this in the UI
 * so users don't waste time generating an app password that won't
 * authenticate.
 */
export function detectProviderByEmail(email: string): Exclude<ProviderKey, 'imap'> | null {
	const at = email.lastIndexOf('@');
	if (at < 0) return null;
	const domain = email.slice(at + 1).toLowerCase().trim();
	if (domain === 'gmail.com' || domain === 'googlemail.com') return 'gmail';
	if (
		domain === 'yahoo.com' ||
		domain === 'ymail.com' ||
		domain === 'rocketmail.com' ||
		domain.endsWith('.yahoo.com')
	)
		return 'yahoo';
	if (domain === 'icloud.com' || domain === 'me.com' || domain === 'mac.com') return 'icloud';
	return null;
}

export function isMicrosoftPersonalDomain(email: string): boolean {
	const at = email.lastIndexOf('@');
	if (at < 0) return false;
	const domain = email.slice(at + 1).toLowerCase().trim();
	return (
		domain === 'outlook.com' ||
		domain === 'hotmail.com' ||
		domain === 'live.com' ||
		domain === 'msn.com'
	);
}
