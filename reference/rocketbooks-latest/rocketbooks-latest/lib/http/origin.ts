import 'server-only';
import { headers } from 'next/headers';

/**
 * The origin (scheme://host) the current request actually arrived on, honoring
 * Vercel's `x-forwarded-*` headers. Use this — not a hardcoded NEXT_PUBLIC_APP_URL
 * — anywhere a link/redirect must come back to the SAME host the user is on
 * (white-label subdomains, auth emails, OAuth callbacks).
 */
export async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = (h.get('x-forwarded-host') ?? h.get('host') ?? '').split(',')[0]?.trim();
  if (!host) {
    return (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  }
  const proto = (h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')).split(',')[0]?.trim();
  return `${proto}://${host}`;
}
