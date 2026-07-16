import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, enterpriseOnboardingState } from '@/db/schema/schema';
import { ensureInviteSlug } from './invite-slug';
import { DEMO_ENTERPRISE_ID } from './demo';

/**
 * AI-guided enterprise (accounting-firm) onboarding — a state machine mirrored
 * on the client onboarding pattern, keyed by the enterprise org. Phase 1
 * records every answer onto the enterprise org (referenced in Settings) and
 * actuates the cheap things (private label, logo, invite link); heavier
 * actuation (color theming, custom email domain, AI-name propagation, bulk
 * import, discount billing) is Phase 2.
 */
export const ENTERPRISE_ONBOARDING_PHASES = [
  'private_label', // do you want to private label?
  'branding', // logo, AI name, brand color
  'web_address', // white-label sign-in subdomain
  'client_interaction', // automatic client-facing email toggles
  'review',
  'complete',
] as const;
// NOTE: per-client billing / client-experience / client-invite decisions used to be
// onboarding steps ('billing' / 'handoff' / 'clients') but now live on the client
// import + create-user + add-company pages. The EnterpriseOnboardingPatch fields they
// set (clientBillingMode, clientOnboardingHandoff, welcomeEmailConfig, …) are kept.

export type EnterprisePhase = (typeof ENTERPRISE_ONBOARDING_PHASES)[number];

export const ENTERPRISE_PHASE_LABELS: Record<EnterprisePhase, string> = {
  private_label: 'Private label',
  branding: 'Branding',
  web_address: 'Web address',
  client_interaction: 'Client Interaction',
  review: 'Review',
  complete: 'Done',
};

/** Per-firm toggles for the automatic client-facing emails. Surfaced in the
 *  "Client Interaction" onboarding step. A null column reads as all-enabled. */
export interface ClientInteractionPrefs {
  askNewContacts: boolean; // ask the client about new vendors/customers
  irsDocRequests: boolean; // request IRS-required documentation
  reviewReminders: boolean; // nudge to review/approve flagged transactions
  weeklyDigest: boolean; // weekly activity recap
  monthlyReport: boolean; // month-end summary report
}

export const DEFAULT_CLIENT_INTERACTION_PREFS: ClientInteractionPrefs = {
  askNewContacts: true,
  irsDocRequests: true,
  reviewReminders: true,
  weeklyDigest: true,
  monthlyReport: true,
};

/** Custom client welcome-email copy. Any field absent falls back to the
 *  default copy derived from the new-client-setup (handoff) choice. */
export interface WelcomeEmailConfig {
  subject: string;
  body: string;
  cta: string;
}

export interface EnterpriseOnboardingAnswers {
  name: string | null;
  privateLabelEnabled: boolean;
  logoUrl: string | null;
  logoUrlDark: string | null;
  logoIconUrl: string | null;
  logoIconDarkUrl: string | null;
  poweredByText: string | null;
  aiAssistantName: string | null;
  brandColorHex: string | null;
  themeConfig: Record<string, string> | null;
  sendingFromEmail: string | null;
  clientBillingMode: string | null; // 'client_pays' | 'firm_pays'
  clientPriceMode: string | null; // 'discount_69' | 'standard_referral'
  clientOnboardingHandoff: string | null; // 'meeting' | 'self'
  clientBackendLoginEnabled: boolean | null;
  welcomeEmailConfig: WelcomeEmailConfig | null;
  welcomeEmailConfigSwitching: WelcomeEmailConfig | null;
  clientBookingUrl: string | null;
  clientInteractionPrefs: ClientInteractionPrefs | null;
  subdomain: string | null;
  enterpriseTier: string | null;
  inviteSlug: string | null;
}

export interface EnterpriseOnboardingStatus {
  phase: EnterprisePhase;
  completed: boolean;
  answers: EnterpriseOnboardingAnswers;
}

/** Fields the wizard may write (logo is handled separately via /api/enterprise/logo). */
export interface EnterpriseOnboardingPatch {
  privateLabelEnabled?: boolean;
  poweredByText?: string | null;
  aiAssistantName?: string | null;
  brandColorHex?: string | null;
  sendingFromEmail?: string | null;
  clientBillingMode?: string | null;
  clientPriceMode?: string | null;
  clientOnboardingHandoff?: string | null;
  clientBackendLoginEnabled?: boolean | null;
  welcomeEmailConfig?: WelcomeEmailConfig | null;
  welcomeEmailConfigSwitching?: WelcomeEmailConfig | null;
  clientBookingUrl?: string | null;
  clientInteractionPrefs?: ClientInteractionPrefs | null;
}

function nextPhase(current: EnterprisePhase): EnterprisePhase {
  const i = ENTERPRISE_ONBOARDING_PHASES.indexOf(current);
  return ENTERPRISE_ONBOARDING_PHASES[Math.min(i + 1, ENTERPRISE_ONBOARDING_PHASES.length - 1)];
}

async function loadAnswers(enterpriseId: string): Promise<EnterpriseOnboardingAnswers> {
  const [org] = await db
    .select({
      name: organizations.name,
      privateLabelEnabled: organizations.privateLabelEnabled,
      logoUrl: organizations.logoUrl,
      logoUrlDark: organizations.logoUrlDark,
      logoIconUrl: organizations.logoIconUrl,
      logoIconDarkUrl: organizations.logoIconDarkUrl,
      poweredByText: organizations.poweredByText,
      aiAssistantName: organizations.aiAssistantName,
      brandColorHex: organizations.brandColorHex,
      themeConfig: organizations.themeConfig,
      sendingFromEmail: organizations.sendingFromEmail,
      clientBillingMode: organizations.clientBillingMode,
      clientPriceMode: organizations.clientPriceMode,
      clientOnboardingHandoff: organizations.clientOnboardingHandoff,
      clientBackendLoginEnabled: organizations.clientBackendLoginEnabled,
      welcomeEmailConfig: organizations.welcomeEmailConfig,
      welcomeEmailConfigSwitching: organizations.welcomeEmailConfigSwitching,
      clientBookingUrl: organizations.clientBookingUrl,
      clientInteractionPrefs: organizations.clientInteractionPrefs,
      subdomain: organizations.subdomain,
      enterpriseTier: organizations.enterpriseTier,
      inviteSlug: organizations.inviteSlug,
    })
    .from(organizations)
    .where(eq(organizations.id, enterpriseId))
    .limit(1);

  return {
    name: org?.name ?? null,
    privateLabelEnabled: org?.privateLabelEnabled ?? false,
    logoUrl: org?.logoUrl ?? null,
    logoUrlDark: org?.logoUrlDark ?? null,
    logoIconUrl: org?.logoIconUrl ?? null,
    logoIconDarkUrl: org?.logoIconDarkUrl ?? null,
    poweredByText: org?.poweredByText ?? null,
    aiAssistantName: org?.aiAssistantName ?? null,
    brandColorHex: org?.brandColorHex ?? null,
    themeConfig: (org?.themeConfig as Record<string, string> | null) ?? null,
    sendingFromEmail: org?.sendingFromEmail ?? null,
    clientBillingMode: org?.clientBillingMode ?? null,
    clientPriceMode: org?.clientPriceMode ?? null,
    clientOnboardingHandoff: org?.clientOnboardingHandoff ?? null,
    clientBackendLoginEnabled: org?.clientBackendLoginEnabled ?? null,
    welcomeEmailConfig: (org?.welcomeEmailConfig as WelcomeEmailConfig | null) ?? null,
    welcomeEmailConfigSwitching: (org?.welcomeEmailConfigSwitching as WelcomeEmailConfig | null) ?? null,
    clientBookingUrl: org?.clientBookingUrl ?? null,
    clientInteractionPrefs: (org?.clientInteractionPrefs as ClientInteractionPrefs | null) ?? null,
    subdomain: org?.subdomain ?? null,
    enterpriseTier: org?.enterpriseTier ?? null,
    inviteSlug: org?.inviteSlug ?? null,
  };
}

export async function getEnterpriseOnboardingStatus(enterpriseId: string): Promise<EnterpriseOnboardingStatus> {
  // The virtual demo enterprise has no real org row — treat it as complete so
  // it never prompts.
  if (enterpriseId === DEMO_ENTERPRISE_ID) {
    return {
      phase: 'complete',
      completed: true,
      answers: {
        name: 'Demo Enterprise',
        privateLabelEnabled: true,
        logoUrl: null,
        logoUrlDark: null,
        logoIconUrl: null,
        logoIconDarkUrl: null,
        poweredByText: null,
        aiAssistantName: 'Scotty',
        brandColorHex: '#7c3aed',
        themeConfig: null,
        sendingFromEmail: null,
        clientBillingMode: 'firm_pays',
        clientPriceMode: 'discount_69',
        clientOnboardingHandoff: 'self',
        clientBackendLoginEnabled: true,
        welcomeEmailConfig: null,
        welcomeEmailConfigSwitching: null,
        clientBookingUrl: null,
        clientInteractionPrefs: null,
        subdomain: null,
        enterpriseTier: 'pl_995',
        inviteSlug: null,
      },
    };
  }

  const [st] = await db
    .select({ phase: enterpriseOnboardingState.phase, completed: enterpriseOnboardingState.completed })
    .from(enterpriseOnboardingState)
    .where(eq(enterpriseOnboardingState.enterpriseId, enterpriseId))
    .limit(1);

  const answers = await loadAnswers(enterpriseId);
  const phase = ((st?.phase as EnterprisePhase) ?? 'private_label') as EnterprisePhase;
  return { phase, completed: st?.completed ?? false, answers };
}

function writeState(enterpriseId: string, phase: EnterprisePhase, completed: boolean) {
  const now = new Date().toISOString();
  return db
    .insert(enterpriseOnboardingState)
    .values({ enterpriseId, phase, completed, context: {}, updatedAt: now })
    .onConflictDoUpdate({
      target: enterpriseOnboardingState.enterpriseId,
      set: { phase, completed, updatedAt: now },
    });
}

/**
 * Save the answers for the current step (whitelisted patch) and move the state
 * machine. `to` = 'next' advances one phase, 'stay' just saves, or a named phase.
 * Folds in the cheap actuations: private label flag is written directly; an
 * invite slug is ensured when reaching the clients/review phases.
 */
export async function saveEnterpriseOnboardingStep(
  enterpriseId: string,
  input: { patch?: EnterpriseOnboardingPatch; to?: EnterprisePhase | 'next' | 'stay' },
): Promise<EnterpriseOnboardingStatus> {
  if (enterpriseId === DEMO_ENTERPRISE_ID) return getEnterpriseOnboardingStatus(enterpriseId);

  const patch = input.patch ?? {};
  // Whitelist — only known onboarding answer columns.
  const set: Record<string, unknown> = {};
  if (patch.privateLabelEnabled !== undefined) set.privateLabelEnabled = patch.privateLabelEnabled;
  if (patch.poweredByText !== undefined) set.poweredByText = patch.poweredByText;
  if (patch.aiAssistantName !== undefined) set.aiAssistantName = patch.aiAssistantName;
  if (patch.brandColorHex !== undefined) set.brandColorHex = patch.brandColorHex;
  if (patch.sendingFromEmail !== undefined) set.sendingFromEmail = patch.sendingFromEmail;
  if (patch.clientBillingMode !== undefined) set.clientBillingMode = patch.clientBillingMode;
  if (patch.clientPriceMode !== undefined) set.clientPriceMode = patch.clientPriceMode;
  if (patch.clientOnboardingHandoff !== undefined) set.clientOnboardingHandoff = patch.clientOnboardingHandoff;
  if (patch.clientBackendLoginEnabled !== undefined) set.clientBackendLoginEnabled = patch.clientBackendLoginEnabled;
  if (patch.welcomeEmailConfig !== undefined) set.welcomeEmailConfig = patch.welcomeEmailConfig;
  if (patch.welcomeEmailConfigSwitching !== undefined) set.welcomeEmailConfigSwitching = patch.welcomeEmailConfigSwitching;
  if (patch.clientBookingUrl !== undefined) set.clientBookingUrl = patch.clientBookingUrl;
  if (patch.clientInteractionPrefs !== undefined) set.clientInteractionPrefs = patch.clientInteractionPrefs;
  if (Object.keys(set).length > 0) {
    await db.update(organizations).set(set).where(eq(organizations.id, enterpriseId));
  }

  const current = await getEnterpriseOnboardingStatus(enterpriseId);
  let target: EnterprisePhase = current.phase;
  if (input.to === 'next') target = nextPhase(current.phase);
  else if (input.to && input.to !== 'stay') target = input.to;

  // Cheap actuation: make sure the firm has a shareable invite link by the time
  // they reach review (the invite link + client-add flows read it).
  if (target === 'review') {
    await ensureInviteSlug(enterpriseId);
  }

  await writeState(enterpriseId, target, target === 'complete');
  return getEnterpriseOnboardingStatus(enterpriseId);
}

export async function resetEnterpriseOnboarding(enterpriseId: string): Promise<void> {
  if (enterpriseId === DEMO_ENTERPRISE_ID) return;
  await writeState(enterpriseId, 'private_label', false);
}
