/**
 * Mints a Supabase session for an admin email using the service-role key,
 * sets it as the rocketsuite cookie pair (sb-<ref>-auth-token.0/.1) and
 * writes a Netscape cookies.txt file ready for `curl -b`.
 *
 * Usage: tsx scripts/admin-session.ts <email> [outFile]
 */
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'node:fs';

config({ path: '.env.local' });

const email = process.argv[2] ?? 'michael@bigsaas.ai';
const outFile = process.argv[3] ?? 'admin-cookies.txt';

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!url || !serviceKey) throw new Error('Missing Supabase env');

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // 1) generate magiclink (we only need email_otp + verifier from the link)
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (linkErr) throw linkErr;
  const otp = linkData.properties?.email_otp;
  if (!otp) throw new Error('No OTP returned');

  // 2) verify with anon client to get a real session
  const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false },
  });
  const { data: vData, error: vErr } = await anon.auth.verifyOtp({
    email,
    token: otp,
    type: 'magiclink',
  });
  if (vErr) throw vErr;
  if (!vData.session) throw new Error('No session');

  const session = vData.session;
  const projectRef = url.match(/https:\/\/([^.]+)\./)![1];
  const cookieName = `sb-${projectRef}-auth-token`;

  // Supabase ssr stores session as base64-<json>, optionally chunked .0/.1
  const sessionPayload = {
    access_token: session.access_token,
    token_type: 'bearer',
    expires_in: session.expires_in,
    expires_at: session.expires_at,
    refresh_token: session.refresh_token,
    user: vData.user,
  };
  const encoded = 'base64-' + Buffer.from(JSON.stringify(sessionPayload)).toString('base64');

  // chunk into ~3180 byte pieces (cookie limit)
  const CHUNK = 3180;
  const chunks: string[] = [];
  for (let i = 0; i < encoded.length; i += CHUNK) chunks.push(encoded.slice(i, i + CHUNK));

  // Netscape cookies.txt format: domain \t flag \t path \t secure \t expiry \t name \t value
  const expiry = Math.floor(Date.now() / 1000) + 60 * 60;
  const lines = ['# Netscape HTTP Cookie File'];
  chunks.forEach((c, i) => {
    lines.push(`localhost\tFALSE\t/\tFALSE\t${expiry}\t${cookieName}.${i}\t${c}`);
  });
  writeFileSync(outFile, lines.join('\n') + '\n');

  console.log('OK');
  console.log('  user_id:', vData.user?.id);
  console.log('  email:  ', vData.user?.email);
  console.log('  cookie_name:', cookieName);
  console.log('  chunks:', chunks.length);
  console.log('  out:', outFile);
}

main().catch((e) => {
  console.error('FAIL:', e.message ?? e);
  process.exit(1);
});
