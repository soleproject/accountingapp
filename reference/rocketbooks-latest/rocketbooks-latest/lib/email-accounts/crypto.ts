import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * AES-256-GCM encryption for stored email app passwords.
 *
 * Why GCM: authenticated encryption — if the ciphertext or IV is
 * tampered with in the DB, decryption throws instead of silently
 * returning garbage. Catches DB corruption and rules out attacks
 * that swap ciphertext between rows.
 *
 * Key material lives in EMAIL_CREDS_KEY (32 random bytes, base64).
 * NEVER store this in the DB and never log it. To rotate, decrypt
 * every row with the old key, re-encrypt with the new key, write
 * back — one-shot migration. There's no fallback to a previous key
 * here; that's a future feature when we have rows in production.
 *
 * Per-row IV (12 bytes, the GCM standard) means identical plaintext
 * passwords don't share ciphertext, and replaying a row's ciphertext
 * into a different row would fail auth-tag verification.
 *
 * Storage encoding: base64 for ciphertext, IV, and auth tag so the
 * DB columns can be plain `text` (no bytea handling in app code).
 */

const KEY_ENV = 'EMAIL_CREDS_KEY';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
	if (cachedKey) return cachedKey;
	const raw = process.env[KEY_ENV];
	if (!raw) {
		throw new Error(
			`${KEY_ENV} is not set. Generate a 32-byte key with: ` +
				`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
		);
	}
	const key = Buffer.from(raw, 'base64');
	if (key.length !== KEY_BYTES) {
		throw new Error(
			`${KEY_ENV} must decode to exactly ${KEY_BYTES} bytes (got ${key.length}). ` +
				`Use base64 of 32 random bytes.`,
		);
	}
	cachedKey = key;
	return key;
}

export interface EncryptedSecret {
	/** base64 of the AES-GCM ciphertext */
	ciphertext: string;
	/** base64 of the 12-byte IV used for this row */
	iv: string;
	/** base64 of the 16-byte GCM authentication tag */
	authTag: string;
}

export function encryptSecret(plaintext: string): EncryptedSecret {
	if (typeof plaintext !== 'string' || plaintext.length === 0) {
		throw new Error('encryptSecret: plaintext must be a non-empty string');
	}
	const key = getKey();
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGO, key, iv);
	const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const authTag = cipher.getAuthTag();
	return {
		ciphertext: enc.toString('base64'),
		iv: iv.toString('base64'),
		authTag: authTag.toString('base64'),
	};
}

/**
 * Decrypts a previously-stored secret. Throws if any of the three
 * inputs has been altered (GCM auth-tag check) or if the key has
 * changed since encryption. Callers should be careful not to log
 * the return value.
 */
export function decryptSecret(input: EncryptedSecret): string {
	const key = getKey();
	const iv = Buffer.from(input.iv, 'base64');
	const authTag = Buffer.from(input.authTag, 'base64');
	const ciphertext = Buffer.from(input.ciphertext, 'base64');
	if (iv.length !== IV_BYTES) throw new Error('decryptSecret: bad IV length');
	if (authTag.length !== 16) throw new Error('decryptSecret: bad auth tag length');
	const decipher = createDecipheriv(ALGO, key, iv);
	decipher.setAuthTag(authTag);
	const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	return dec.toString('utf8');
}

/**
 * True when EMAIL_CREDS_KEY is present and well-formed. UI uses this
 * to surface a setup warning instead of letting the operator try to
 * connect an account and hit a 500 mid-flow.
 */
export function isCredsKeyConfigured(): boolean {
	try {
		getKey();
		return true;
	} catch {
		return false;
	}
}
