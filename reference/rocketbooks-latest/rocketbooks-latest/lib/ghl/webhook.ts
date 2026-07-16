import 'server-only';
import { createVerify, verify as edVerify } from 'crypto';

// Verify GoHighLevel webhook authenticity using GHL's PUBLISHED public keys
// (these are GHL's keys, not a per-app secret — safe to hardcode).
//
// Modern: X-GHL-Signature, Ed25519 over the raw UTF-8 body, base64.
// Legacy: X-WH-Signature, RSA-SHA256 over the raw body, base64. GHL deprecates
//         the legacy header on 2026-07-01, so Ed25519 is primary; we still
//         accept the legacy header during the transition.
// Source: marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide

const GHL_ED25519_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`;

const GHL_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAokvo/r9tVgcfZ5DysOSC
Frm602qYV0MaAiNnX9O8KxMbiyRKWeL9JpCpVpt4XHIcBOK4u3cLSqJGOLaPuXw6
dO0t6Q/ZVdAV5Phz+ZtzPL16iCGeK9po6D6JHBpbi989mmzMryUnQJezlYJ3DVfB
csedpinheNnyYeFXolrJvcsjDtfAeRx5ByHQmTnSdFUzuAnC9/GepgLT9SM4nCpv
uxmZMxrJt5Rw+VUaQ9B8JSvbMPpez4peKaJPZHBbU3OdeCVx5klVXXZQGNHOs8gF
3kvoV5rTnXV0IknLBXlcKKAQLZcY/Q9rG6Ifi9c+5vqlvHPCUJFT5XUGG5RKgOKU
J062fRtN+rLYZUV+BjafxQauvC8wSWeYja63VSUruvmNj8xkx2zE/Juc+yjLjTXp
IocmaiFeAO6fUtNjDeFVkhf5LNb59vECyrHD2SQIrhgXpO4Q3dVNA5rw576PwTzN
h/AMfHKIjE4xQA1SZuYJmNnmVZLIZBlQAF9Ntd03rfadZ+yDiOXCCs9FkHibELhC
HULgCsnuDJHcrGNd5/Ddm5hxGQ0ASitgHeMZ0kcIOwKDOzOU53lDza6/Y09T7sYJ
PQe7z0cvj7aE4B+Ax1ZoZGPzpJlZtGXCsu9aTEGEnKzmsFqwcSsnw3JB31IGKAyk
T1hhTiaCeIY/OwwwNUY2yvcCAwEAAQ==
-----END PUBLIC KEY-----`;

/**
 * Returns true iff the raw body is authentically signed by GHL. Tries the
 * modern Ed25519 header first, falls back to the legacy RSA header. Any
 * malformed input or missing signature → false (reject).
 */
export function verifyGhlWebhook(rawBody: string, headers: Headers): boolean {
  const payload = Buffer.from(rawBody, 'utf8');

  const ghlSig = headers.get('x-ghl-signature');
  if (ghlSig && ghlSig !== 'N/A') {
    try {
      // Ed25519: algorithm must be null.
      if (edVerify(null, payload, GHL_ED25519_PUBLIC_KEY, Buffer.from(ghlSig, 'base64'))) {
        return true;
      }
    } catch {
      /* fall through to legacy */
    }
  }

  const whSig = headers.get('x-wh-signature');
  if (whSig && whSig !== 'N/A') {
    try {
      return createVerify('RSA-SHA256').update(payload).verify(GHL_RSA_PUBLIC_KEY, whSig, 'base64');
    } catch {
      return false;
    }
  }

  return false;
}
