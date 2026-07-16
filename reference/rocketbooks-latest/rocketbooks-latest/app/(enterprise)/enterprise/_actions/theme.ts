'use server';

import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { DEMO_ENTERPRISE_ID } from '@/lib/enterprise/demo';
import { sanitizeThemeConfig, type ThemeConfig } from '@/lib/enterprise/theme';

export async function saveThemeConfigAction(config: ThemeConfig): Promise<{ ok: boolean; error?: string }> {
  const current = await getCurrentEnterprise();
  if (!current || current.id === DEMO_ENTERPRISE_ID) return { ok: false, error: 'Not available.' };
  const clean = sanitizeThemeConfig(config);
  if (Object.keys(clean).length === 0) {
    // Empty config (e.g. the RocketBooks preset) = full revert: also drop the
    // onboarding brand color so accents/menu/icons return to the originals.
    await db
      .update(organizations)
      .set({ themeConfig: null, brandColorHex: null })
      .where(eq(organizations.id, current.id));
    return { ok: true };
  }
  await db.update(organizations).set({ themeConfig: clean }).where(eq(organizations.id, current.id));
  return { ok: true };
}

export async function resetThemeConfigAction(): Promise<{ ok: boolean }> {
  const current = await getCurrentEnterprise();
  if (!current || current.id === DEMO_ENTERPRISE_ID) return { ok: false };
  // Full revert to RocketBooks: clear both the theme tokens AND the brand color
  // so every accent, menu, and icon color returns to the original.
  await db
    .update(organizations)
    .set({ themeConfig: null, brandColorHex: null })
    .where(eq(organizations.id, current.id));
  return { ok: true };
}
