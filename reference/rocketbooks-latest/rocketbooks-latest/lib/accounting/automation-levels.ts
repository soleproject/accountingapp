/**
 * AI categorization automation levels — the per-org control for how aggressively
 * the categorizer posts on its own. PURE module (no db, no server-only) so both
 * the settings UI (client component) and server code can import it.
 *
 * A level maps to two stored org fields:
 *   - aiAutoPostEnabled: whether confident categorizations auto-confirm
 *     (reviewed=true) or always wait in the review queue (reviewed=false).
 *   - aiAutoPostThreshold: the confidence cutoff at/above which a categorization
 *     is considered "confident" enough to auto-post.
 */

export type AutomationLevel = 'review_all' | 'conservative' | 'balanced' | 'aggressive';

/** Fallback when an org has no stored threshold (matches the historical env default). */
export const DEFAULT_AUTO_POST_THRESHOLD = 0.85;

export interface AutomationLevelDef {
  value: AutomationLevel;
  label: string;
  description: string;
  enabled: boolean;
  threshold: number;
}

export const AUTOMATION_LEVELS: AutomationLevelDef[] = [
  {
    value: 'review_all',
    label: 'Review everything before posting',
    description:
      'The AI categorizes every transaction but never confirms on its own — each one waits in the review queue for one-click approval. Safest; best for new clients.',
    enabled: false,
    threshold: DEFAULT_AUTO_POST_THRESHOLD,
  },
  {
    value: 'conservative',
    label: 'Conservative — auto-post at 95%+ confidence',
    description: 'Only the most certain categorizations post automatically; everything else queues for review.',
    enabled: true,
    threshold: 0.95,
  },
  {
    value: 'balanced',
    label: 'Balanced — auto-post at 85%+ confidence (default)',
    description: 'High-confidence categorizations post automatically; the rest wait for review.',
    enabled: true,
    threshold: 0.85,
  },
  {
    value: 'aggressive',
    label: 'Aggressive — auto-post at 75%+ confidence',
    description: 'Most categorizations post automatically. Fastest, but review the books more closely.',
    enabled: true,
    threshold: 0.75,
  },
];

export function levelToSettings(level: AutomationLevel): { enabled: boolean; threshold: number } {
  const def = AUTOMATION_LEVELS.find((l) => l.value === level) ?? AUTOMATION_LEVELS[2];
  return { enabled: def.enabled, threshold: def.threshold };
}

/** Derive the closest level from stored settings (for pre-selecting the UI). */
export function settingsToLevel(enabled: boolean, threshold: number): AutomationLevel {
  if (!enabled) return 'review_all';
  if (threshold >= 0.95) return 'conservative';
  if (threshold >= 0.85) return 'balanced';
  return 'aggressive';
}
