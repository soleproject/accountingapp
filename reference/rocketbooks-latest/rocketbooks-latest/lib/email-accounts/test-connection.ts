import 'server-only';

/**
 * IMAP/SMTP credential checks require Node socket libraries that push the
 * Cloudflare Worker over the upload limit. Keep the action callable, but return
 * an explicit unavailable result until this path is moved to a Node/background
 * lane.
 */

export interface TestConnectionInput {
	emailAddress: string;
	password: string;
	imapHost: string;
	imapPort: number;
	imapSecure: boolean;
	smtpHost: string;
	smtpPort: number;
	smtpSecure: boolean;
}

export interface ConnectionCheckResult {
	ok: boolean;
	error?: string;
}

export interface TestConnectionResult {
	imap: ConnectionCheckResult;
	smtp: ConnectionCheckResult;
	/** Convenience flag — true only when both halves succeeded. */
	allOk: boolean;
}

const UNAVAILABLE = 'Email account connection testing is temporarily unavailable on the Cloudflare Worker runtime.';

export async function testConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
	if (!input.emailAddress || !input.password) {
		throw new Error('testConnection: emailAddress and password are required');
	}
	return {
		imap: { ok: false, error: UNAVAILABLE },
		smtp: { ok: false, error: UNAVAILABLE },
		allOk: false,
	};
}
