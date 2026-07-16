'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';

/**
 * Registers the Taxes product's context for the global AI sidecar. Mounted once in the
 * taxes layout so the tax toolset is the assistant's surface on every /taxes page —
 * pageId 'taxes' maps to the tax intake/onboarding tools in the page-tool registry.
 *
 * This is what makes the SAME sidecar (everywhere in the app) become the tax assistant
 * here, instead of a separate chat. Tax tools are exposed ONLY while a taxes page is
 * mounted; they were removed from the general accounting chat.
 */
export function TaxAssistantRegistrar() {
  const { setPageContext } = useAssistant();
  const pathname = usePathname() ?? '/taxes';

  useEffect(() => {
    setPageContext({
      pageId: 'taxes',
      pageTitle: 'Taxes',
      route: pathname,
      data: {
        note:
          "The user is in the Taxes product. Help them prepare a tax return by LEADING a guided flow — don't wait to be told each step. " +
          "A return carries an intake PHASE: classify → documents → interview → review → run → complete. Work the current phase; advance only when it's genuinely done.",
        guidance: [
          "ORIENT: for an in-progress return, call get_tax_intake_status(returnId) first — it returns the phase, one-line guidance, and signals.",
          "classify: FIRST ask 'Do you have a copy of last year's return?'. If YES → have them upload it and call import_prior_return: it carries forward their identity and pre-lists the forms they filed (shown in the UI), so you skip most of the interview. If NO → ask personal vs business + tax year (+ entity type for business). Either way call classify_tax_return → returnId (reuse it), then advance.",
          "documents: ask them to upload this year's W-2s/1099s/K-1s. Uploads auto-extract (extract_tax_document); read back what was read, note anything flagged. Advance when no more docs.",
          "interview: collect what docs don't cover (filing status, dependents, state, itemize vs standard). list_tax_facts for refs; record_tax_facts to save.",
          "review: walk them through facts — especially unconfirmed AI-extracted ones — to confirm/correct, then advance.",
          "run: run_tax_return(returnId) fills the forms as drafts and recurses; on needs_input ask for exactly the missing refs, record, run again. Advance when filled.",
          "complete: the drafts are ready for preparer review.",
          "CLASSIFY each user message: forward signal → act/advance; a question or hesitation → ANSWER and STAY on the phase (do not advance); off-topic → answer briefly, steer back. Default to staying.",
          "Honesty: completed forms are DRAFTS for preparer review, never filed; extracted values are unconfirmed until the user confirms; never invent a number; we do NOT e-file.",
        ],
      },
      // Expose ONLY the tax tools as this page's surface (plus the always-on global
      // read/navigate tools the sidecar carries). No allow-list filter = all tax tools.
      toolNames: undefined,
    });
    return () => setPageContext(null);
  }, [setPageContext, pathname]);

  return null;
}
