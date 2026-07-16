import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

// AES-256-GCM encryption for GoHighLevel OAuth tokens at rest.
//
// Deliberately separate from lib/plaid/encryption.ts: its own key
// (GHL_ENCRYPTION_KEY) and salt so a GHL key rotation never touches Plaid
// and vice-versa. Same payload format ("iv:tag:enc", base64 parts) so the
// shape is familiar, but the modules share no state.
//
// GHL_ENCRYPTION_KEY: any sufficiently long random secret (>= 32 bytes of
// entropy recommended). scrypt stretches it to a 32-byte AES key.

const ALGO = 'aes-256-gcm';

function getKey(): Buffer {
  const secret = process.env.GHL_ENCRYPTION_KEY;
  if (!secret) throw new Error('GHL_ENCRYPTION_KEY is required');
  return scryptSync(secret, 'rocketsuite-ghl', 32);
}

export function encryptGhlToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptGhlToken(payload: string): string {
  const [ivB64, tagB64, encB64] = payload.split(':');
  if (!ivB64 || !tagB64 || !encB64) throw new Error('Malformed encrypted GHL payload');
  const decipher = createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(encB64, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}
