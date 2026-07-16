import 'server-only';
import { createHmac } from 'node:crypto';

/**
 * Signed, login-free unsubscribe tokens for the weekly digest. The token is
 * `<userId>.<hmac>`; the unsubscribe route verifies the HMAC before clearing
 * the user's opt-in, so nobody can unsubscribe an arbitrary user. Reuses the
 * existing INBOUND_TOKEN_SECRET (namespaced with a 'digest:' prefix so it can't
 * collide with inbound reply tokens). userIds are UUIDs (no dots), so the
 * lastIndexOf('.') split is unambiguous.
 */
function secret(): string {
  return process.env.INBOUND_TOKEN_SECRET ?? '';
}

function hmac(userId: string): string {
  return createHmac('sha256', secret()).update(`digest:${userId}`).digest('hex').slice(0, 16);
}

export function signDigestUnsubToken(userId: string): string {
  return `${userId}.${hmac(userId)}`;
}

export function verifyDigestUnsubToken(token: string): string | null {
  if (!secret() || !token) return null;
  const i = token.lastIndexOf('.');
  if (i <= 0) return null;
  const id = token.slice(0, i);
  const sig = token.slice(i + 1);
  return sig === hmac(id) ? id : null;
}
