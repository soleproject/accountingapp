import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { onboardingState, organizations, users } from '@/db/schema/schema';
import { getActionCards, type ActionCard } from '@/lib/server/action-cards';
import { entityFraming, firstNameOf } from './persona';
import { getClientProfile, renderProfileForPrompt, type AiClientProfile } from './client-profile';

export interface ClientContext {
  orgName: string;
  entityType: string | null;
  /** Already sorted blocking-first, then by priority (see getActionCards). */
  cards: ActionCard[];
  /** True only when the org has finished onboarding. Drives whether we surface
   *  a books-grounded opener (complete) vs. let the onboarding flow lead. */
  onboardingComplete: boolean;
  /** The onboarding phase the org is currently on while onboarding is NOT yet
   *  complete (business_info → quickbooks → plaid → bank_statements → receipts →
   *  review). Null once complete. Injected into the prompt so the assistant
   *  proactively coaches the right step on every turn. */
  onboardingPhase: string | null;
  /** Durable "how this client likes to work" memory (prefs + learnings). */
  profile: AiClientProfile;
  /** False when a latency-sensitive caller intentionally skipped attention-card
   * derivation. Prevents the prompt from claiming the books are clear. */
  attentionLoaded?: boolean;
}

export interface SuggestionChip {
  label: string;
  prompt: string;
}

/**
 * Assemble a cheap, live "what's true for this client" snapshot for grounding
 * the AI. Reuses getActionCards() (one aggregated round-trip) rather than
 * recomputing the underlying signals; adds only a light org read + onboarding
 * flag. Safe to call per-conversation/per-turn.
 */
export async function buildClientContext(orgId: string): Promise<ClientContext> {
  // Keep these reads sequential. This function runs inside the chat request and
  // getActionCards performs its own DB work; fanning everything out here can
  // exhaust Hyperdrive's Supavisor session pool and fail the turn before AI is
  // called.
  const orgRow = await db
    .select({ name: organizations.name, entityType: organizations.entityType })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const onboardingRow = await db
    .select({ completed: onboardingState.completed, phase: onboardingState.phase })
    .from(onboardingState)
    .where(eq(onboardingState.orgId, orgId))
    .limit(1);
  const cards = await getActionCards(orgId);
  const profile = await getClientProfile(orgId);

  return {
    orgName: orgRow[0]?.name ?? 'your business',
    entityType: orgRow[0]?.entityType ?? null,
    cards,
    onboardingComplete: onboardingRow[0]?.completed === true,
    onboardingPhase: onboardingRow[0]?.completed === true ? null : (onboardingRow[0]?.phase ?? null),
    profile,
  };
}

/**
 * Lightweight per-turn grounding for /api/ai/chat. Action cards are available
 * through an explicit assistant tool and must not consume a burst of DB sessions
 * before every model request.
 */
export async function buildChatClientContext(orgId: string): Promise<ClientContext> {
  const orgRow = await db
    .select({ name: organizations.name, entityType: organizations.entityType })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const onboardingRow = await db
    .select({ completed: onboardingState.completed, phase: onboardingState.phase })
    .from(onboardingState)
    .where(eq(onboardingState.orgId, orgId))
    .limit(1);
  const profile = await getClientProfile(orgId);

  return {
    orgName: orgRow[0]?.name ?? 'your business',
    entityType: orgRow[0]?.entityType ?? null,
    cards: [],
    onboardingComplete: onboardingRow[0]?.completed === true,
    onboardingPhase: onboardingRow[0]?.completed === true ? null : (onboardingRow[0]?.phase ?? null),
    profile,
    attentionLoaded: false,
  };
}

/**
 * Whether there's enough real bookkeeping activity to lead a grounded opener.
 * True when onboarding is complete (even with clean books → "all caught up"),
 * OR when there's at least one substantive concern. Onboarding-setup and the
 * always-present quarterly-tax reminder don't count as "real books", so a
 * genuinely fresh/empty org gets no opener — but an org loaded with data whose
 * onboarding was never formally completed still does.
 */
export function hasSubstantiveBooks(ctx: ClientContext): boolean {
  if (ctx.onboardingComplete) return true;
  return ctx.cards.some((c) => c.id !== 'onboarding' && !c.id.startsWith('quarterly-tax'));
}

/** First name for a user id (from the users table). '' when unknown. */
export async function getFirstName(userId: string): Promise<string> {
  try {
    const [row] = await db
      .select({ fullName: users.fullName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return firstNameOf(row?.fullName);
  } catch {
    return '';
  }
}

/**
 * Render the snapshot into a compact prompt block the model can lead from.
 * Top concerns only (blocking first), with the real titles/bodies the
 * action-cards engine already computed — so the AI cites accurate numbers.
 */
export function renderContextBlock(ctx: ClientContext, firstName: string): string {
  const lines: string[] = ['CLIENT CONTEXT (live — lead from this, do not invent anything beyond it):'];

  lines.push(
    firstName
      ? `- You're speaking with ${firstName}, who runs ${ctx.orgName}.`
      : `- This is the owner of ${ctx.orgName}.`,
  );

  const ef = entityFraming(ctx.entityType);
  if (ef) {
    lines.push(`- Business type: ${ef.label}.${ef.guidance ? ` ${ef.guidance}` : ''}`);
  }

  // Onboarding-in-progress: tell the model exactly which step they're on and to
  // actively drive it. The per-phase coaching playbook lives in the system
  // prompt — this just points the model at the current step so it leads from
  // turn one instead of waiting to be asked.
  if (ctx.onboardingPhase) {
    lines.push(
      `- ONBOARDING IN PROGRESS — they are currently on the "${ctx.onboardingPhase}" step. Proactively guide them through THIS step right now per the Onboarding flow instructions: coach this step, ask only what this step needs, call the onboarding tools (set_business_info / advance_onboarding), and move them to the next step when it's done. Don't wait to be asked, and don't re-do steps already completed.`,
    );
  }

  // Onboarding card (if present) is setup, not a "concern". Latency-sensitive
  // chat turns intentionally omit cards, so do not claim the books are clear in
  // that case; the model can call list_attention_items when the user asks.
  if (ctx.attentionLoaded !== false) {
    const concerns = ctx.cards.slice(0, 5);
    if (concerns.length === 0) {
      lines.push('- Their books are in good shape right now — nothing needs attention.');
    } else {
      lines.push('- What needs attention right now (most important first):');
      concerns.forEach((c, i) => {
        lines.push(`  ${i + 1}. ${c.title}${c.body ? ` — ${c.body}` : ''}`);
      });
    }
  }

  const profileBlock = renderProfileForPrompt(ctx.profile);
  if (profileBlock) lines.push('', profileBlock);

  return lines.join('\n');
}

/** A chat prompt for a card whether or not it carries an ask-ai prompt. */
function chipPromptFor(card: ActionCard): string {
  if (card.action.kind === 'ask-ai') return card.action.prompt;
  return `Walk me through: ${card.title}.`;
}

/**
 * Dynamic suggestion chips derived from the client's actual situation. When
 * there are concerns, lead with a "focus" chip + the top few cards; when the
 * books are clean, offer a few sensible health-check defaults. Capped at 4.
 */
export function deriveChips(ctx: ClientContext): SuggestionChip[] {
  // Onboarding is handled by its own flow, not a chip.
  const cards = ctx.cards.filter((c) => c.id !== 'onboarding');

  if (cards.length === 0) {
    return [
      { label: 'How are my books looking?', prompt: 'Give me a quick health check on my books.' },
      { label: 'Recent transactions', prompt: 'Show me my recent transactions.' },
      { label: 'Profit & loss this month', prompt: "What's my profit and loss this month?" },
    ];
  }

  const chips: SuggestionChip[] = [
    { label: 'What should I focus on first?', prompt: 'What should I focus on first today?' },
  ];
  for (const c of cards.slice(0, 3)) {
    chips.push({ label: c.title, prompt: chipPromptFor(c) });
  }
  return chips.slice(0, 4);
}
