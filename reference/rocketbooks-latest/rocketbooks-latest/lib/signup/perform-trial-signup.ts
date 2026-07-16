import 'server-only';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  users,
  organizations,
  enterpriseClients,
  adminAuditLog,
  onboardingState,
} from '@/db/schema/schema';
import { createServiceClient } from '@/lib/supabase/service';
import { seedDefaultCoa } from '@/lib/accounting/seed-default-coa';
import { recordInitialClientRevenueShare } from '@/lib/enterprise/revenue-share';
import { applyFirmClientInteractionPrefs } from '@/lib/enterprise/client-interaction-prefs';
import { recordInitialUserReferralRevenueShare } from '@/lib/referral/user-revenue-share';
import { type AccountingTierKey } from '@/lib/accounting/tiers';
import { assignTierPermissionSet } from '@/lib/accounting/assign-tier';

export type OrgEntityType =
  | 'llc'
  | 'c_corp'
  | 's_corp'
  | 'partnership'
  | 'sole_prop'
  | 'beneficial_trust'
  | 'business_trust'
  | 'nonprofit'
  | 'other';

export interface PerformTrialSignupInput {
  fullName: string;
  email: string;
  password: string;
  companyName: string;
  enterpriseId: string;
  // Optional regular-user referrer (the person whose ?ref=<user slug> link was
  // used). Re-resolved server-side by the caller — never trusted from the
  // client. Records organizations.referred_by_user_id + a user-referral
  // earnings row; additive to the enterprise client attachment.
  referrerUserId?: string | null;
  // Optional intake fields collected by the marketing site form. None of
  // these are required to provision a usable account; they're persisted
  // when present so sales/onboarding can see them later.
  phone?: string | null;
  businessType?: OrgEntityType | null;
  businessDescription?: string | null;
  // Source label written to the audit log so we can tell self-serve
  // /signup signups apart from rocketbooks.ai marketing-form signups.
  source?: 'app_signup' | 'marketing_form';
  // Self-serve plan chosen on the marketing pricing page (/signup?plan=…).
  // Stamps the org's accounting tier + assigns the matching permission set so
  // the trial starts on that plan; price is charged at conversion. NULL/absent
  // = no plan picked yet (the user can choose later on /billing).
  accountingTier?: AccountingTierKey | null;
}

export type PerformTrialSignupResult =
  | { ok: true; userId: string; orgId: string }
  | { ok: false; error: string; status: number };

const ENTITY_TYPES: readonly OrgEntityType[] = [
  'llc',
  'c_corp',
  's_corp',
  'partnership',
  'sole_prop',
  'beneficial_trust',
  'business_trust',
  'nonprofit',
  'other',
];

export function coerceEntityType(raw: unknown): OrgEntityType | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if ((ENTITY_TYPES as readonly string[]).includes(v)) return v as OrgEntityType;
  if (v === 'llc' || v === 'limited_liability_company') return 'llc';
  if (v === 'c_corporation' || v === 'ccorp') return 'c_corp';
  if (v === 's_corporation' || v === 'scorp') return 's_corp';
  if (v === 'sole_proprietor' || v === 'sole_proprietorship') return 'sole_prop';
  return null;
}

export async function performTrialSignup(
  input: PerformTrialSignupInput,
): Promise<PerformTrialSignupResult> {
  const email = input.email.trim().toLowerCase();
  const fullName = input.fullName.trim();
  const companyName = input.companyName.trim();
  const password = input.password;
  const enterpriseId = input.enterpriseId;
  const phone = input.phone?.trim() || null;
  const businessType = input.businessType ?? null;
  const businessDescription = input.businessDescription?.trim() || null;
  const source = input.source ?? 'app_signup';
  const referrerUserId = input.referrerUserId ?? null;
  // Default self-serve signups (no ?plan= chosen) to the "Most Popular" Plus tier
  // ($79) — never the retired legacy $89 base seat. Stamps the org tier + assigns
  // the Plus permission set below, and the trial checkout bills the Plus price.
  const accountingTier: AccountingTierKey = input.accountingTier ?? 'plus';

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing) {
    return { ok: false, status: 409, error: `A user with email ${email} already exists` };
  }

  const service = createServiceClient();
  const { data, error: authErr } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (authErr || !data.user) {
    return {
      ok: false,
      status: 400,
      error: `Signup failed: ${authErr?.message ?? 'unknown auth error'}`,
    };
  }
  const authUserId = data.user.id;
  const orgId = randomUUID();

  try {
    await db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: authUserId,
        email,
        fullName,
        passwordHash: 'supabase',
        isActive: true,
        role: 'paying_user',
        ...(phone ? { phone } : {}),
      });

      await tx.insert(organizations).values({
        id: orgId,
        name: companyName,
        ownerUserId: authUserId,
        planType: 'pro',
        // Per-user referral attribution. Self-referral is impossible at signup
        // (referrer is an existing user) but guard anyway.
        ...(referrerUserId && referrerUserId !== authUserId
          ? { referredByUserId: referrerUserId }
          : {}),
        ...(accountingTier ? { accountingTier } : {}),
        ...(businessType ? { entityType: businessType } : {}),
        ...(phone ? { phone } : {}),
        ...(businessDescription ? { businessDescription } : {}),
      });

      await tx.insert(enterpriseClients).values({
        id: randomUUID(),
        enterpriseId,
        clientUserId: authUserId,
        status: 'active',
        acquisitionSource: 'invite_link',
      });

      // NOTE: no local trial row is created here anymore. The 7-day trial is now a
      // REAL Stripe subscription (trial_period_days:7) — the caller routes the new
      // user through createTrialSignupCheckoutSession right after this to collect a
      // card and start the trial; the webhook then writes the 'trialing' sub.

      await tx
        .update(users)
        .set({ organizationId: orgId, activeOrganizationId: orgId })
        .where(eq(users.id, authUserId));

      // Seed the firm's Client Interaction defaults onto the new client org + owner.
      await applyFirmClientInteractionPrefs(tx, { enterpriseId, clientOrgId: orgId, ownerUserId: authUserId });

      // Seed an onboarding_state row so the /ai-chat "finish setting up
      // your business" action card surfaces from minute one. The card
      // generator at lib/server/action-cards.ts requires `(onboarding &&
      // !onboarding.completed)`, so a fresh org with no row at all is
      // indistinguishable from one that finished onboarding — it never
      // shows the card. business_info is the canonical first phase
      // (lib/accounting/onboarding.ts).
      await tx.insert(onboardingState).values({
        orgId,
        phase: 'business_info',
        step: 'business_info',
        context: {},
        completed: false,
      });

      await tx.insert(adminAuditLog).values({
        id: randomUUID(),
        adminUserId: authUserId,
        action: 'trial.signup',
        targetType: 'user',
        targetId: authUserId,
        auditMetadata: {
          email,
          enterpriseId,
          orgId,
          source,
          ...(phone ? { phone } : {}),
          ...(businessType ? { businessType } : {}),
          ...(businessDescription ? { businessDescription } : {}),
        },
      });
    });
  } catch (err) {
    try {
      await service.auth.admin.deleteUser(authUserId);
    } catch (deleteErr) {
      console.error('Failed to roll back Supabase auth user', authUserId, deleteErr);
    }
    const message = err instanceof Error ? err.message : 'Signup failed';
    return { ok: false, status: 500, error: message };
  }

  try {
    await seedDefaultCoa({ organizationId: orgId });
  } catch (seedErr) {
    console.error('Failed to seed default CoA on trial org', orgId, seedErr);
  }

  // Assign the chosen plan's permission set to the new owner (the org row was
  // already stamped with accountingTier in the tx above). Best-effort: the
  // account is usable without it, and /billing re-applies on plan selection.
  if (accountingTier) {
    try {
      await assignTierPermissionSet(authUserId, accountingTier);
    } catch (tierErr) {
      console.error('Failed to assign tier permission set on signup', orgId, tierErr);
    }
  }

  try {
    await recordInitialClientRevenueShare({
      enterpriseId,
      clientOrganizationId: orgId,
    });
  } catch (rsErr) {
    console.error('Failed to record initial revenue share on signup', orgId, rsErr);
  }

  if (referrerUserId && referrerUserId !== authUserId) {
    try {
      await recordInitialUserReferralRevenueShare({
        referrerUserId,
        referredOrganizationId: orgId,
      });
    } catch (rsErr) {
      console.error('Failed to record initial user-referral revenue share on signup', orgId, rsErr);
    }
  }

  return { ok: true, userId: authUserId, orgId };
}
