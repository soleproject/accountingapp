'use server';

import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { requireSession } from '@/lib/auth/session';
import { chatCompletion } from '@/lib/ai/openai';
import {
  saveEnterpriseOnboardingStep,
  resetEnterpriseOnboarding,
  type EnterpriseOnboardingPatch,
  type EnterpriseOnboardingStatus,
  type EnterprisePhase,
  ENTERPRISE_PHASE_LABELS,
} from '@/lib/enterprise/onboarding';

export async function saveEnterpriseOnboardingStepAction(input: {
  patch?: EnterpriseOnboardingPatch;
  to?: EnterprisePhase | 'next' | 'stay';
}): Promise<EnterpriseOnboardingStatus> {
  const current = await getCurrentEnterprise();
  if (!current) throw new Error('No active enterprise.');
  return saveEnterpriseOnboardingStep(current.id, input);
}

export async function resetEnterpriseOnboardingAction(): Promise<void> {
  const current = await getCurrentEnterprise();
  if (!current) throw new Error('No active enterprise.');
  await resetEnterpriseOnboarding(current.id);
}

const ASSISTANT_SYSTEM = [
  'You are the RocketBooks setup assistant, helping an accounting firm configure its white-label enterprise account during onboarding.',
  'Answer the firm owner concisely (2-4 sentences), concretely, and recommend a sensible default. Plain, friendly, professional.',
  'Key facts you can use:',
  '- Private label is $95/month. It lets the firm charge clients their own prices, name the AI, and customize branding/colors. Without it, the firm uses RocketBooks per-service pricing.',
  '- Client prices are tiered: Starter $39/month, Plus $79/month, Pro $149/month. When a client pays the standard rate, the firm earns the tier referral share ($7 / $15 / $25 per client per month for Starter / Plus / Pro).',
  '- Pricing choice: give clients the discounted rate (Starter $29 / Plus $65 / Pro $119 per month), OR charge the standard rate ($39 / $79 / $149) and take the referral fee. The discount passes the savings to the client, so there is no referral share on discounted clients.',
  '- Who pays: clients can pay directly, or the firm can pay for clients and charge more for its own service.',
  '- Client handoff: the AI can book a setup meeting with the firm, or let the client self-serve onboarding.',
  'Do not invent features that were not described. If unsure, suggest the common best practice.',
].join('\n');

export async function askOnboardingAssistantAction(input: {
  phase: string;
  question: string;
}): Promise<{ ok: boolean; answer?: string; error?: string }> {
  const session = await requireSession();
  const current = await getCurrentEnterprise();
  if (!current) return { ok: false, error: 'No active enterprise.' };
  const phaseLabel = ENTERPRISE_PHASE_LABELS[input.phase as EnterprisePhase] ?? input.phase;
  try {
    const res = await chatCompletion(
      { userId: session.id, orgId: current.id, actor: 'enterprise', feature: 'enterprise_onboarding_assistant' },
      {
        model: 'gpt-4o-mini',
        temperature: 0.4,
        max_tokens: 250,
        messages: [
          { role: 'system', content: ASSISTANT_SYSTEM },
          {
            role: 'user',
            content: `Firm: ${current.name}. Onboarding step: "${phaseLabel}". Question: ${input.question}`,
          },
        ],
      },
    );
    const answer = res.choices[0]?.message?.content?.trim();
    return answer ? { ok: true, answer } : { ok: false, error: 'No answer returned.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Assistant failed.' };
  }
}
