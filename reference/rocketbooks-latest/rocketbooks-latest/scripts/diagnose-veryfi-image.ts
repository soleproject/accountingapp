import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
config({ path: '.env.local' });
async function main() {
  const { db } = await import('../db/client');
  const { receipts } = await import('../db/schema/schema');
  const [r] = await db
    .select({ raw: receipts.veryfiRawJson })
    .from(receipts)
    .where(eq(receipts.id, '6d972280-cd45-4f92-97e8-7a26e6fb3dd7'))
    .limit(1);
  if (!r?.raw) { console.log('no raw'); process.exit(0); }
  const p = JSON.parse(r.raw);
  console.log('image/url-like keys:');
  for (const k of Object.keys(p).filter((k) => /img|image|url|file|pdf|thumb/i.test(k))) {
    console.log(`  ${k} =`, JSON.stringify(p[k]).slice(0, 200));
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
