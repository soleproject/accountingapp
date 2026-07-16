'use server';

import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users, organizations } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { DEMO_ORG_ID } from '@/lib/auth/demo';

const ORG_COOKIE = 'rs_org_id';

export interface EnterTourSandboxResult {
  ok: boolean;
  error?: string;
  /** Org id the user was on before we swapped them into the demo. The caller
   *  stashes this so the exit action can restore it. */
  priorOrgId?: string | null;
  /** The demo org id -- same constant, but echoed back so callers don't have
   *  to import it. */
  sandboxOrgId?: string;
}

/**
 * Switch the active org to the shared Demo Co, LLC for the cool tour. No
 * seeding, no per-user clone -- the cool tour uses the shared demo data for
 * the read-only steps (navigate / filter / revenue question) and renders a
 * pre-built fake invoice card for the create / post steps so nothing is
 * written to the demo.
 */
export async function enterTourSandboxAction(): Promise<EnterTourSandboxResult> {
  await requireSession();
  const userId = await getEffectiveUserId();
  try {
    const cookieStore = await cookies();
    const priorOrgId = cookieStore.get(ORG_COOKIE)?.value ?? null;
    cookieStore.set(ORG_COOKIE, DEMO_ORG_ID, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    await db
      .update(users)
      .set({ activeOrganizationId: DEMO_ORG_ID })
      .where(eq(users.id, userId));
    return { ok: true, priorOrgId, sandboxOrgId: DEMO_ORG_ID };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not enter the demo workspace',
    };
  }
}

export interface ExitTourSandboxResult {
  ok: boolean;
  error?: string;
}

/**
 * Restore the user to the org they were on before the cool tour swapped them
 * into the demo. No-op if no prior org was recorded or if it was deleted
 * mid-tour.
 */
export async function exitTourSandboxAction(priorOrgId: string | null): Promise<ExitTourSandboxResult> {
  await requireSession();
  const userId = await getEffectiveUserId();
  if (!priorOrgId) return { ok: true };
  try {
    const [existing] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, priorOrgId))
      .limit(1);
    if (!existing) return { ok: true };

    const cookieStore = await cookies();
    cookieStore.set(ORG_COOKIE, priorOrgId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    await db
      .update(users)
      .set({ activeOrganizationId: priorOrgId })
      .where(eq(users.id, userId));
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not exit the demo workspace',
    };
  }
}
