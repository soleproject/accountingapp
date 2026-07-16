import 'server-only';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Intuit signs every webhook delivery with HMAC-SHA256(rawBody, verifierToken),
 * base64-encoded, in the `intuit-signature` header. We MUST verify against the
 * raw bytes — re-serializing the parsed JSON will not match because Intuit's
 * key order, whitespace, and number formatting won't survive a round trip.
 *
 * Returns true on match. Uses constant-time comparison so a timing attack
 * can't probe for the verifier token byte-by-byte.
 */
export function verifyIntuitSignature(rawBody: string, signatureHeader: string | null, verifierToken: string): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac('sha256', verifierToken).update(rawBody, 'utf8').digest();
  let given: Buffer;
  try {
    given = Buffer.from(signatureHeader, 'base64');
  } catch {
    return false;
  }
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

export interface IntuitEntityEvent {
  name: string;            // 'Invoice' | 'Bill' | 'Customer' | ...
  id: string;
  operation: 'Create' | 'Update' | 'Delete' | 'Merge' | 'Void' | 'Emailed';
  lastUpdated: string;     // ISO timestamp
  deletedId?: string;      // Merge: surviving id is `id`, retired id is `deletedId`
}

export interface IntuitEventNotification {
  realmId: string;
  dataChangeEvent: { entities: IntuitEntityEvent[] };
}

export interface IntuitWebhookPayload {
  eventNotifications: IntuitEventNotification[];
}
