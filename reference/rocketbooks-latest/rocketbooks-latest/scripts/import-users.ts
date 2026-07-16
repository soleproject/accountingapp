import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';

config({ path: '.env.local' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DB_URL = process.env.POSTGRES_URL_NON_POOLING;

if (!SUPABASE_URL) throw new Error('NEXT_PUBLIC_SUPABASE_URL is required');
if (!SERVICE_ROLE) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING is required');

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const sql = postgres(DB_URL, { prepare: false, max: 1 });

interface SourceUser {
  id: string;
  email: string;
  password_hash: string | null;
  full_name: string | null;
  is_active: boolean | null;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitFlag = args.find((a) => a.startsWith('--limit='));
  const limit = limitFlag ? parseInt(limitFlag.split('=')[1], 10) : null;

  console.log(`[import-users] dry_run=${dryRun} limit=${limit ?? 'none'}`);

  const rows = await sql<SourceUser[]>`
    SELECT id::text AS id, email, password_hash, full_name, is_active
    FROM public.users
    WHERE password_hash IS NOT NULL
      AND email IS NOT NULL
    ORDER BY created_at NULLS LAST
    ${limit ? sql`LIMIT ${limit}` : sql``}
  `;

  console.log(`[import-users] found ${rows.length} users in public.users`);

  const stats = { ok: 0, skipped: 0, alreadyExists: 0, badHash: 0, errors: 0 };
  const errors: { email: string; reason: string }[] = [];

  for (const u of rows) {
    if (!u.password_hash || !u.password_hash.startsWith('$argon2')) {
      stats.badHash++;
      errors.push({ email: u.email, reason: `non-argon2 hash: ${u.password_hash?.slice(0, 8) ?? 'null'}` });
      continue;
    }

    if (dryRun) {
      console.log(`DRY ${u.email} (id=${u.id})`);
      stats.ok++;
      continue;
    }

    const { error } = await admin.auth.admin.createUser({
      id: u.id,
      email: u.email,
      password_hash: u.password_hash,
      email_confirm: true,
      user_metadata: { full_name: u.full_name ?? '', migrated_from: 'public.users' },
    });

    if (error) {
      const msg = error.message ?? String(error);
      if (/already (registered|exists)/i.test(msg) || /duplicate key/i.test(msg)) {
        stats.alreadyExists++;
        console.log(`EXISTS ${u.email}`);
      } else {
        stats.errors++;
        errors.push({ email: u.email, reason: msg });
        console.error(`FAIL  ${u.email}: ${msg}`);
      }
    } else {
      stats.ok++;
      console.log(`OK    ${u.email}`);
    }
  }

  console.log('\n=== summary ===');
  console.log(stats);
  if (errors.length) {
    console.log('\n=== errors ===');
    for (const e of errors) console.log(`  ${e.email}: ${e.reason}`);
  }

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
