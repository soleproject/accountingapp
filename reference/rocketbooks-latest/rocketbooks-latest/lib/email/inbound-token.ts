import 'server-only';
import { createHmac } from 'node:crypto';

/**
 * Signed reply-to tokens. We embed `reply+<token>@<INBOUND_DOMAIN>` as the
 * reply-to on firm outreach emails; the inbound webhook decodes the token back
 * to the originating outreach row. The HMAC suffix stops anyone forging a
 * token for an arbitrary outreach id.
 */
function secret(): string {
  return process.env.INBOUND_TOKEN_SECRET ?? '';
}

export function inboundConfigured(): boolean {
  return !!process.env.INBOUND_REPLY_DOMAIN && !!process.env.INBOUND_TOKEN_SECRET;
}

function hmac(id: string): string {
  return createHmac('sha256', secret()).update(id).digest('hex').slice(0, 12);
}

export function signOutreachToken(outreachId: string): string {
  return `${outreachId}.${hmac(outreachId)}`;
}

export function verifyOutreachToken(token: string): string | null {
  if (!secret()) return null;
  const i = token.lastIndexOf('.');
  if (i <= 0) return null;
  const id = token.slice(0, i);
  const sig = token.slice(i + 1);
  return sig === hmac(id) ? id : null;
}

/** The reply-to address for an outreach email, or null when inbound is off. */
export function outreachReplyToAddress(outreachId: string): string | null {
  const domain = process.env.INBOUND_REPLY_DOMAIN;
  if (!domain || !secret()) return null;
  return `reply+${signOutreachToken(outreachId)}@${domain}`;
}
