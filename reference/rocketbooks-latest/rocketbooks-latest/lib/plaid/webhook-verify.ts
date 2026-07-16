import 'server-only';
import { createHash } from 'crypto';
import { plaid } from './client';
import { jwtVerify, importJWK } from 'jose';

export async function verifyPlaidWebhook(rawBody: string, jwt: string): Promise<boolean> {
  if (!jwt) return false;

  try {
    // The JWT structure is `header.payload.signature` (all base64url). The
    // protected header carries `kid`; the payload carries `request_body_sha256`
    // and `iat`. Earlier versions of this function compared the header object
    // against the body hash, which always returned false → every webhook 401'd.
    const protectedHeader = JSON.parse(
      Buffer.from(jwt.split('.')[0], 'base64url').toString(),
    ) as { kid?: string };
    const kid = protectedHeader.kid;
    if (!kid) return false;

    const keyResp = await plaid.webhookVerificationKeyGet({ key_id: kid });
    const key = keyResp.data.key;

    const publicKey = await importJWK(
      {
        kty: key.kty,
        crv: key.crv,
        x: key.x,
        y: key.y,
        alg: key.alg,
      },
      'ES256',
    );

    const { payload } = await jwtVerify(jwt, publicKey, {
      algorithms: ['ES256'],
      maxTokenAge: '5m',
    });

    const claimedHash = (payload as { request_body_sha256?: string }).request_body_sha256;
    if (!claimedHash) return false;
    const expectedHash = createHash('sha256').update(rawBody, 'utf8').digest('hex');
    return claimedHash === expectedHash;
  } catch {
    return false;
  }
}
