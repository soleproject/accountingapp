import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * AES-256-GCM encryption for stored OAuth tokens (Google Calendar
 * today, more providers later). Same shape as email-accounts/crypto.ts
 * but keyed off OAUTH_CREDS_KEY so the two domains can be rotated /
 * revoked independently.
 *
 * Key material: 32 random bytes, base64-encoded, in OAUTH_CREDS_KEY.
 * Generate with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Per-row IV (12 bytes, GCM standard) prevents identical tokens from
 * producing identical ciphertext. auth_tag (16 bytes) is the GCM
 * authentication tag — decryption throws if anything in the row
 * (ciphertext, iv, tag) is altered.
 *
 * Storage encoding: base64 for all three components so the DB columns
 * stay plain `text`.
 */

const KEY_ENV = 'OAUTH_CREDS_KEY';
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
	ciphertext: string;
	iv: string;
	authTag: string;
}

export function encryptOauthSecret(plaintext: string): EncryptedSecret {
	if (typeof plaintext !== 'string' || plaintext.length === 0) {
		throw new Error('encryptOauthSecret: plaintext must be a non-empty string');
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

export function decryptOauthSecret(input: EncryptedSecret): string {
	const key = getKey();
	const iv = Buffer.from(input.iv, 'base64');
	const authTag = Buffer.from(input.authTag, 'base64');
	const ciphertext = Buffer.from(input.ciphertext, 'base64');
	if (iv.length !== IV_BYTES) throw new Error('decryptOauthSecret: bad IV length');
	if (authTag.length !== 16) throw new Error('decryptOauthSecret: bad auth tag length');
	const decipher = createDecipheriv(ALGO, key, iv);
	decipher.setAuthTag(authTag);
	const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	return dec.toString('utf8');
}

export function isOauthKeyConfigured(): boolean {
	try {
		getKey();
		return true;
	} catch {
		return false;
	}
}
