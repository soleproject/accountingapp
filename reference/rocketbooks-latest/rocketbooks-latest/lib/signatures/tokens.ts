import 'server-only';
import { randomBytes } from 'crypto';
import { appBaseUrl } from '@/lib/booking/links';

/** Unguessable per-recipient signing token (256 bits of entropy, hex). */
export function newSigningToken(): string {
  return randomBytes(32).toString('hex');
}

/** Public signing link for a recipient token. Works in dev (localhost via
 *  NEXT_PUBLIC_APP_URL) and prod (app.rocketbooks.ai). */
export function signingUrl(token: string): string {
  return `${appBaseUrl()}/sign/${encodeURIComponent(token)}`;
}
