'use client';

import { useEffect, useRef } from 'react';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';

/**
 * Invisible watcher: the reconciliation workspace re-renders (server refresh)
 * after each clear/match action, so when the period flips to reconciled we fire
 * a one-time in-flow event to the assistant. Fires only on the transition
 * (not on landing on an already-reconciled period), and the sidecar reacts only
 * if it's open.
 */
export function ReconcileWatcher({ reconciled, accountName }: { reconciled: boolean; accountName: string | null }) {
  const { notifyAssistant } = useAssistant();
  const prevReconciled = useRef(reconciled);
  useEffect(() => {
    if (reconciled && !prevReconciled.current) {
      notifyAssistant(
        `Reconciliation: the ${accountName ?? 'account'} reconciliation just balanced — the difference is $0 and it's now reconciled.`,
      );
    }
    prevReconciled.current = reconciled;
  }, [reconciled, accountName, notifyAssistant]);
  return null;
}
