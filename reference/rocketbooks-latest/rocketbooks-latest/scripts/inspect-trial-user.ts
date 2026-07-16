import { config } from 'dotenv';
config({ path: '.env.local' });
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  users,
  organizations,
  enterpriseClients,
  enterpriseStaff,
  organizationSubscriptions,
  billingProducts,
} from '@/db/schema/schema';

const EMAIL = (process.argv[2] ?? 'michael.giorgi@ymail.com').toLowerCase();

async function main() {
  const banner = (s: string) => console.log(`\n=== ${s} ===`);

  banner(`Inspecting trial user: ${EMAIL}`);

  const [user] = await db.select().from(users).where(eq(users.email, EMAIL)).limit(1);
  if (!user) {
    console.log('No users row for this email. The signup never completed.');
    process.exit(0);
  }

  console.log({
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    isActive: user.isActive,
    organizationId: user.organizationId,
    activeOrganizationId: user.activeOrganizationId,
  });

  banner('Enterprise-client links (enterprise_clients)');
  const ecRows = await db
    .select({
      id: enterpriseClients.id,
      enterpriseId: enterpriseClients.enterpriseId,
      status: enterpriseClients.status,
      createdAt: enterpriseClients.createdAt,
      enterpriseName: organizations.name,
      enterpriseDomain: organizations.domain,
    })
    .from(enterpriseClients)
    .leftJoin(organizations, eq(organizations.id, enterpriseClients.enterpriseId))
    .where(eq(enterpriseClients.clientUserId, user.id));
  console.log(ecRows);

  banner('Enterprise-staff links (enterprise_staff)');
  const esRows = await db
    .select({
      id: enterpriseStaff.id,
      enterpriseId: enterpriseStaff.enterpriseId,
      role: enterpriseStaff.role,
      enterpriseName: organizations.name,
    })
    .from(enterpriseStaff)
    .leftJoin(organizations, eq(organizations.id, enterpriseStaff.enterpriseId))
    .where(eq(enterpriseStaff.staffUserId, user.id));
  console.log(esRows);

  banner('Organizations owned by this user');
  const orgs = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      planType: organizations.planType,
      entityType: organizations.entityType,
      createdAt: organizations.createdAt,
      ownerUserId: organizations.ownerUserId,
    })
    .from(organizations)
    .where(eq(organizations.ownerUserId, user.id));
  console.log(orgs);

  banner('Organization subscriptions on each owned org');
  for (const o of orgs) {
    const subs = await db
      .select({
        id: organizationSubscriptions.id,
        organizationId: organizationSubscriptions.organizationId,
        billingProductId: organizationSubscriptions.billingProductId,
        stripeSubscriptionId: organizationSubscriptions.stripeSubscriptionId,
        status: organizationSubscriptions.status,
        currentPeriodStart: organizationSubscriptions.currentPeriodStart,
        currentPeriodEnd: organizationSubscriptions.currentPeriodEnd,
        productName: billingProducts.name,
        productFeatureKey: billingProducts.featureKey,
      })
      .from(organizationSubscriptions)
      .leftJoin(billingProducts, eq(billingProducts.id, organizationSubscriptions.billingProductId))
      .where(eq(organizationSubscriptions.organizationId, o.id));
    console.log(`Org ${o.name} (${o.id}):`, subs);
  }

  banner('Expectation check (mirror of enterprise-creates-demo-client flow)');
  const checks: { name: string; pass: boolean; note?: string }[] = [];

  checks.push({
    name: "user.role is 'paying_user' or 'enterprise_owner_demo'",
    pass: user.role === 'paying_user' || user.role === 'enterprise_owner_demo',
    note: `actual: ${user.role}`,
  });
  checks.push({ name: 'user.isActive=true', pass: !!user.isActive });
  checks.push({ name: 'attached to >=1 enterprise via enterprise_clients', pass: ecRows.length >= 1 });
  checks.push({ name: 'owns >=1 organization', pass: orgs.length >= 1 });
  const proOrg = orgs.find((o) => o.planType === 'pro');
  checks.push({ name: "primary org has planType='pro'", pass: !!proOrg, note: proOrg ? `org: ${proOrg.name}` : 'no pro org found' });

  let trialSub:
    | { status: string | null; currentPeriodEnd: string | null; productFeatureKey: string | null }
    | undefined;
  for (const o of orgs) {
    const [s] = await db
      .select({
        status: organizationSubscriptions.status,
        currentPeriodEnd: organizationSubscriptions.currentPeriodEnd,
        productFeatureKey: billingProducts.featureKey,
      })
      .from(organizationSubscriptions)
      .leftJoin(billingProducts, eq(billingProducts.id, organizationSubscriptions.billingProductId))
      .where(eq(organizationSubscriptions.organizationId, o.id))
      .limit(1);
    if (s) {
      trialSub = s;
      break;
    }
  }
  checks.push({ name: 'has an organization_subscriptions row', pass: !!trialSub });
  checks.push({
    name: "subscription is on demo_full product",
    pass: trialSub?.productFeatureKey === 'demo_full',
    note: trialSub ? `actual: ${trialSub.productFeatureKey}` : undefined,
  });
  checks.push({
    name: "subscription status is 'trialing'",
    pass: trialSub?.status === 'trialing',
    note: trialSub ? `actual: ${trialSub.status}` : undefined,
  });

  const stillTrialing =
    trialSub?.currentPeriodEnd && new Date(trialSub.currentPeriodEnd).getTime() > Date.now();
  checks.push({
    name: 'trial currentPeriodEnd is in the future',
    pass: !!stillTrialing,
    note: trialSub?.currentPeriodEnd ? `ends: ${trialSub.currentPeriodEnd}` : 'no end set',
  });

  for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.note ? `  (${c.note})` : ''}`);
  }

  banner('Banner-rendering check');
  console.log('DemoTrialBanner mounts in app/(enterprise)/enterprise/layout.tsx.');
  console.log("getDemoTrialState only returns non-null when user.role === 'enterprise_owner_demo'.");
  console.log(`This user's role: ${user.role}`);
  if (user.role !== 'enterprise_owner_demo') {
    console.log("=> Banner will NOT show as the layout is wired today. The user lives at /dashboard, not /enterprise.");
  } else {
    console.log('=> Banner can show on the enterprise area.');
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
