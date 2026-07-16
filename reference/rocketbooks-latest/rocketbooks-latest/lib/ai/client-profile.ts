import 'server-only';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';

export type CommunicationStyle = 'brief' | 'standard' | 'detailed';

export interface ClientLearning {
  id: string;
  note: string;
  /** ISO timestamp the learning was saved. */
  at: string;
}

/**
 * Per-org "how this client likes to work" memory. Stored as a JSON blob on
 * organizations.ai_client_profile. Structured prefs are user-editable in
 * Settings; `learnings` are accumulated by the assistant via the
 * remember_about_client tool. Vendor→category habits intentionally live in the
 * categorization tables, not here.
 */
export interface AiClientProfile {
  communicationStyle?: CommunicationStyle;
  /** Don't pester the user about transactions below this dollar amount. */
  skipBelowAmount?: number | null;
  /** Free-form standing instructions the user typed in Settings. */
  standingInstructions?: string;
  /** Durable facts/preferences the assistant has learned, newest last. */
  learnings?: ClientLearning[];
}

const EMPTY: AiClientProfile = {};
const MAX_LEARNINGS = 50;

export async function getClientProfile(orgId: string): Promise<AiClientProfile> {
  try {
    const [row] = await db
      .select({ profile: organizations.aiClientProfile })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    return (row?.profile as AiClientProfile | null) ?? EMPTY;
  } catch {
    return EMPTY;
  }
}

const STYLE_LABEL: Record<CommunicationStyle, string> = {
  brief: 'Keep replies brief and to the point.',
  standard: 'Use a normal level of detail.',
  detailed: 'They appreciate thorough, detailed explanations.',
};

/**
 * A prompt block describing how this client likes to work + what the assistant
 * has learned. Returns '' when there's nothing to say (so the caller can omit
 * the section entirely).
 */
export function renderProfileForPrompt(profile: AiClientProfile): string {
  const lines: string[] = [];
  if (profile.communicationStyle) lines.push(`- ${STYLE_LABEL[profile.communicationStyle]}`);
  if (typeof profile.skipBelowAmount === 'number' && profile.skipBelowAmount > 0) {
    lines.push(`- Don't ask about or flag transactions under $${profile.skipBelowAmount}; handle them quietly.`);
  }
  if (profile.standingInstructions && profile.standingInstructions.trim()) {
    lines.push(`- Standing instructions: ${profile.standingInstructions.trim()}`);
  }
  for (const l of profile.learnings ?? []) lines.push(`- ${l.note}`);
  if (lines.length === 0) return '';
  return `WHAT YOU'VE LEARNED ABOUT HOW THIS CLIENT LIKES TO WORK (honor these — never re-ask something you've already been told):\n${lines.join('\n')}`;
}

/** Append a durable learning. Read-modify-write; caps memory at MAX_LEARNINGS. */
export async function appendLearning(orgId: string, note: string): Promise<ClientLearning | null> {
  const trimmed = note.trim();
  if (!trimmed) return null;
  const current = await getClientProfile(orgId);
  const learning: ClientLearning = { id: randomUUID(), note: trimmed, at: new Date().toISOString() };
  const learnings = [...(current.learnings ?? []), learning].slice(-MAX_LEARNINGS);
  await db
    .update(organizations)
    .set({ aiClientProfile: { ...current, learnings } })
    .where(eq(organizations.id, orgId));
  return learning;
}

/** Save the user-editable preference fields (merges over existing profile). */
export async function saveProfilePrefs(
  orgId: string,
  prefs: Pick<AiClientProfile, 'communicationStyle' | 'skipBelowAmount' | 'standingInstructions'>,
): Promise<void> {
  const current = await getClientProfile(orgId);
  await db
    .update(organizations)
    .set({ aiClientProfile: { ...current, ...prefs } })
    .where(eq(organizations.id, orgId));
}

/** Remove a single learning by id. */
export async function removeLearning(orgId: string, learningId: string): Promise<void> {
  const current = await getClientProfile(orgId);
  const learnings = (current.learnings ?? []).filter((l) => l.id !== learningId);
  await db
    .update(organizations)
    .set({ aiClientProfile: { ...current, learnings } })
    .where(eq(organizations.id, orgId));
}
