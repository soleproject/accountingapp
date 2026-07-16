import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config({ path: '.env.local' });

const email = process.argv[2];
const password = process.argv[3];

if (!email || !password) {
  console.error('Usage: tsx scripts/verify-login.ts <email> <password>');
  process.exit(1);
}

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.error('FAIL:', error.message);
    process.exit(2);
  }
  console.log('OK login');
  console.log('  user_id:', data.user?.id);
  console.log('  email:  ', data.user?.email);
  console.log('  has_session:', !!data.session?.access_token);
  console.log('  access_token_prefix:', data.session?.access_token?.slice(0, 20) + '...');
}

main();
