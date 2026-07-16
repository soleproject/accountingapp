/**
 * White-label subdomain helpers — pure (no server-only) so client editors and
 * server actions/layouts can share them. A subdomain is one DNS label under the
 * platform-owned wildcard root (default accountingapp.ai), e.g. 'acme' →
 * acme.accountingapp.ai.
 */

export const PRIVATE_LABEL_ROOT = (process.env.NEXT_PUBLIC_PRIVATE_LABEL_ROOT ?? 'accountingapp.ai')
  .toLowerCase()
  .trim();

// The main (non-white-label) host. Resolves to the RocketBooks brand.
export const PRIMARY_HOST = 'app.rocketbooks.ai';

/**
 * Labels that must never be claimed by a firm — infrastructure hostnames and
 * brand/vendor names. Deliberately lean: generic business words (demo, billing,
 * support, dashboard, login, …) are fine as firm subdomains, since app routes
 * are paths, not hosts.
 */
const RESERVED = new Set([
  'app', 'www', 'api', 'admin', 'mail', 'smtp', 'imap', 'pop', 'ftp', 'ns1', 'ns2', 'mx',
  'cdn', 'static', 'assets', 'webhook', 'webhooks', 'cron',
  'rocketbooks', 'rocketsuite', 'accountingapp', 'vercel', 'supabase',
]);

// 3–40 chars, lowercase alphanumeric + hyphen, no leading/trailing hyphen.
const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export function normalizeSubdomain(input: string): string {
  return input.trim().toLowerCase();
}

export type SubdomainCheck = { ok: true; value: string } | { ok: false; error: string };

export function validateSubdomain(input: string): SubdomainCheck {
  const v = normalizeSubdomain(input);
  if (!v) return { ok: false, error: 'Enter a subdomain.' };
  if (v.length < 3 || v.length > 40) return { ok: false, error: 'Use 3–40 characters.' };
  if (!SUBDOMAIN_RE.test(v)) {
    return { ok: false, error: 'Use lowercase letters, numbers, and hyphens — not at the start or end.' };
  }
  if (v.includes('--')) return { ok: false, error: 'No double hyphens.' };
  if (RESERVED.has(v)) return { ok: false, error: 'That subdomain is reserved — pick another.' };
  return { ok: true, value: v };
}

/** Full host for a subdomain label, e.g. 'acme' → 'acme.accountingapp.ai'. */
export function subdomainToHost(sub: string): string {
  return `${sub}.${PRIVATE_LABEL_ROOT}`;
}

/**
 * If `host` is a `<label>.<root>` under the private-label root, return the label
 * (else null). Bare root (accountingapp.ai) and the primary host return null.
 */
export function subdomainFromHost(host: string): string | null {
  const h = host.split(':')[0]?.toLowerCase().trim() ?? '';
  const suffix = `.${PRIVATE_LABEL_ROOT}`;
  if (!h.endsWith(suffix)) return null;
  const label = h.slice(0, -suffix.length);
  if (!label || label.includes('.')) return null; // bare root, or deeper nesting
  return RESERVED.has(label) ? null : label;
}
