'use client';

import { useActionState, useState } from 'react';
import {
  setTransactionReviewed,
  acceptRuleAndVerify,
  acceptContactCategorization,
  type ReviewedState,
  type AcceptRuleState,
  type PendingRuleSuggestion,
} from '../_actions/approveTransaction';
import type { ContactCategorizeSuggestion } from '@/lib/accounting/rule-promotion';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/**
 * Per-row reviewed toggle with three states (green reviewed / hollow categorized /
 * faint uncategorized). On verify, if the merchant has a pending rule suggestion,
 * a popup offers to create the rule + verify every matching transaction, or to
 * discuss it with the AI.
 */
export function ReviewedToggle({
  transactionId,
  reviewed,
  uncategorized,
}: {
  transactionId: string;
  reviewed: boolean;
  uncategorized: boolean;
}) {
  const [state, formAction, pending] = useActionState<ReviewedState | undefined, FormData>(
    setTransactionReviewed,
    undefined,
  );
  const [acceptState, acceptAction, acceptPending] = useActionState<AcceptRuleState | undefined, FormData>(
    acceptRuleAndVerify,
    undefined,
  );
  const [contactAcceptState, contactAcceptAction, contactAcceptPending] = useActionState<
    AcceptRuleState | undefined,
    FormData
  >(acceptContactCategorization, undefined);
  const [dismissed, setDismissed] = useState(false);

  const isReviewed = state?.ok && typeof state.reviewed === 'boolean' ? state.reviewed : reviewed;
  const suggestion = state?.suggestion;
  const showPrompt = !!suggestion && !dismissed && !acceptState?.ok;
  const contactSuggestion = state?.contactSuggestion;
  const showContactPrompt = !!contactSuggestion && !dismissed && !contactAcceptState?.ok;

  return (
    <>
      {!isReviewed && uncategorized ? (
        <span
          title="Categorize this transaction before marking it reviewed"
          className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-zinc-200 text-zinc-300 dark:border-zinc-800 dark:text-zinc-700"
        >
          <CheckIcon />
        </span>
      ) : (
        <form action={formAction} className="inline-flex">
          <input type="hidden" name="transactionId" value={transactionId} />
          <input type="hidden" name="reviewed" value={isReviewed ? '0' : '1'} />
          <button
            type="submit"
            disabled={pending}
            aria-pressed={isReviewed}
            title={isReviewed ? 'Reviewed — click to unmark' : 'Mark as reviewed'}
            className={`inline-flex h-7 w-7 items-center justify-center rounded-full border transition-colors disabled:opacity-50 ${
              isReviewed
                ? 'border-emerald-500 bg-emerald-500 text-white hover:border-emerald-600 hover:bg-emerald-600'
                : 'border-zinc-300 text-zinc-400 hover:border-emerald-400 hover:text-emerald-500 dark:border-zinc-700 dark:text-zinc-500'
            }`}
          >
            <CheckIcon />
          </button>
        </form>
      )}

      {showPrompt && suggestion && (
        <RulePromptDialog
          suggestion={suggestion}
          onDismiss={() => setDismissed(true)}
          acceptAction={acceptAction}
          acceptState={acceptState}
          acceptPending={acceptPending}
        />
      )}

      {showContactPrompt && contactSuggestion && (
        <ContactPromptDialog
          suggestion={contactSuggestion}
          onDismiss={() => setDismissed(true)}
          acceptAction={contactAcceptAction}
          acceptState={contactAcceptState}
          acceptPending={contactAcceptPending}
        />
      )}
    </>
  );
}

/** The rule-suggestion popup. Separate component so useAssistant only mounts for
 *  the clicked row, not every row in the table. */
function RulePromptDialog({
  suggestion,
  onDismiss,
  acceptAction,
  acceptState,
  acceptPending,
}: {
  suggestion: PendingRuleSuggestion;
  onDismiss: () => void;
  acceptAction: (formData: FormData) => void;
  acceptState: AcceptRuleState | undefined;
  acceptPending: boolean;
}) {
  const { requestSidecarOpen, seedPrompt, setPinnedRule } = useAssistant();

  const discuss = () => {
    // Close the popup, open the sidecar, seed a HIDDEN context turn so the AI
    // greets in its own words + knows to take the user back to this view when
    // done, and pin the rule card to the bottom of the sidecar.
    const returnTo =
      typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/transactions';
    requestSidecarOpen('side');
    seedPrompt(
      `I clicked "Discuss with AI" from a categorization-rule suggestion for the merchant "${suggestion.pattern}" — ` +
        `I've categorized it as "${suggestion.categoryName}" ${suggestion.count} times and the app suggested turning it into a rule. ` +
        `I want to talk through this merchant, its rule, or its transactions — ANSWER my questions and discuss first; do NOT create a rule or change any categorizations unless I EXPLICITLY tell you to. Greet me briefly and naturally and ask how you can help — keep it short and don't just repeat these details back to me. ` +
        `IMPORTANT: once we're done here — whether or not you ended up creating a rule or making changes — call restore_view with url "${returnTo}" to take me back to the exact view I was on.`,
      { hidden: true },
    );
    setPinnedRule({
      pattern: suggestion.pattern,
      categoryAccountId: suggestion.categoryAccountId,
      categoryName: suggestion.categoryName,
      count: suggestion.count,
      transactionType: suggestion.transactionType,
      returnTo,
    });
    onDismiss();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-5 text-left shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
        <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          Create a rule for &ldquo;{suggestion.pattern}&rdquo;?
        </h3>
        <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-400">
          You&rsquo;ve categorized &ldquo;{suggestion.pattern}&rdquo; as{' '}
          <strong className="text-zinc-800 dark:text-zinc-200">{suggestion.categoryName}</strong> {suggestion.count}×.
          Create a rule so future ones auto-categorize, and mark all matching transactions reviewed.
        </p>
        {acceptState?.error && <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{acceptState.error}</p>}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Not now
          </button>
          <button
            type="button"
            onClick={discuss}
            className="rounded-md border border-blue-300 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50 dark:border-blue-700 dark:text-blue-300 dark:hover:bg-blue-950/40"
          >
            Discuss with AI
          </button>
          <form action={acceptAction}>
            <input type="hidden" name="pattern" value={suggestion.pattern} />
            <input type="hidden" name="categoryAccountId" value={suggestion.categoryAccountId} />
            <input type="hidden" name="transactionType" value={suggestion.transactionType ?? ''} />
            <button
              type="submit"
              disabled={acceptPending}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {acceptPending ? 'Working…' : 'Create rule & verify all'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

/** Shown on verify when there's no rule but other same-contact transactions could
 *  be aligned to this category. Categorizes (posting JEs) + verifies them. */
function ContactPromptDialog({
  suggestion,
  onDismiss,
  acceptAction,
  acceptState,
  acceptPending,
}: {
  suggestion: ContactCategorizeSuggestion;
  onDismiss: () => void;
  acceptAction: (formData: FormData) => void;
  acceptState: AcceptRuleState | undefined;
  acceptPending: boolean;
}) {
  const many = suggestion.count !== 1;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-5 text-left shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
        <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          Categorize other {suggestion.contactName} transactions?
        </h3>
        <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-400">
          {suggestion.count} other {suggestion.contactName} transaction{many ? 's' : ''} {many ? 'aren’t' : 'isn’t'} categorized as{' '}
          <strong className="text-zinc-800 dark:text-zinc-200">{suggestion.categoryName}</strong>. Categorize {many ? 'them all' : 'it'} that way and mark reviewed?
        </p>
        {acceptState?.error && <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{acceptState.error}</p>}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Not now
          </button>
          <form action={acceptAction}>
            <input type="hidden" name="contactId" value={suggestion.contactId} />
            <input type="hidden" name="categoryAccountId" value={suggestion.categoryAccountId} />
            <input type="hidden" name="transactionType" value={suggestion.transactionType ?? ''} />
            <button
              type="submit"
              disabled={acceptPending}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {acceptPending ? 'Working…' : 'Categorize all & verify'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
