'use client';

import { useEffect } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';

interface Props {
  /** Snapshot of the current filter state, computed server-side and passed in. */
  state: {
    page: number;
    filter: string;
    q: string | null;
    accountId: string | null;
    categoryId: string | null;
    contactId: string | null;
    start: string | null;
    end: string | null;
    sort: string;
    dir: string;
    totalMatching: number;
    uncategorizedCount: number;
    /** Per-flow review counts for the "Start guided review" picker. */
    reviewCounts?: { deposits: number; aiCategorized: number; uncategorized: number };
    /** IDs of every transaction rendered in the table on this page — capped at
     *  the page size. The AI uses these when the user says "these" / "all of
     *  these" / "the filtered ones" without naming specific rows. */
    visibleTransactionIds: string[];
    /** Guided triage mode: the spotlight-active group the user is being asked
     *  about. The AI calls categorize_transaction_ids with these ids when the
     *  user confirms a category. Null when not in guide mode. */
    guide?: {
      /** 'deposits' = deposit review; 'verify' = confirm AI categorizations. */
      kind?: 'triage' | 'deposits' | 'verify';
      contactName: string;
      count: number;
      totalAmount: number;
      sampleDescription: string | null;
      /** The category the verify-group was AI-categorized as (verify mode). */
      categoryName?: string | null;
      transactionIds: string[];
      remainingGroups: number;
    } | null;
  };
}

/**
 * Client-side glue: tells the AIAssistantSidecar what page we're on, what
 * tools it can use, what the user's current view looks like — and registers
 * the URL-mutating client actions the AI invokes via tool results.
 */
export function AssistantPageRegistration({ state }: Props) {
  const { setPageContext, registerClientAction } = useAssistant();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    setPageContext({
      pageId: 'transactions',
      pageTitle: 'Transactions',
      route: pathname,
      data: {
        currentFilters: {
          status: state.filter,
          search: state.q,
          accountId: state.accountId,
          categoryId: state.categoryId,
          contactId: state.contactId,
          dateRange: state.start || state.end ? { start: state.start, end: state.end } : null,
        },
        sort: { column: state.sort, direction: state.dir },
        totalMatching: state.totalMatching,
        uncategorizedCount: state.uncategorizedCount,
        reviewCounts: state.reviewCounts ?? null,
        page: state.page,
        // Real transaction UUIDs visible in the table right now. When the user
        // says "these" / "all of them" / "the filtered ones", the AI must
        // pass THESE ids to categorize_transaction_ids — not hallucinate them.
        visibleTransactionIds: state.visibleTransactionIds,
        // When the user lands here with ?guide=1 the GuidedTriage overlay
        // spotlights one contact group at a time. AI must categorize ALL of
        // guide.transactionIds in a single categorize_transaction_ids call.
        guide: state.guide ?? null,
      },
      // Allow every transactions tool. The page-tool registry already scopes
      // these to this pageId on the server.
      toolNames: [
        'apply_transactions_filters',
        'find_transactions_for_categorization',
        'categorize_transaction_ids',
        'categorize_filtered_transactions',
        'create_categorization_rule',
        'verify_transaction_ids',
        'start_guided_review',
        'set_contact_for_transactions',
        'open_transaction',
        'find_transfer_counterpart',
        'find_matching_invoice',
        'restore_view',
      ],
    });
    return () => setPageContext(null);
  }, [setPageContext, pathname, state]);

  // apply_transactions_filters → update URL search params and let RSC re-render.
  useEffect(() => {
    const off = registerClientAction('apply_transactions_filters', (args) => {
      const next = args.clear === true ? new URLSearchParams() : new URLSearchParams(searchParams.toString());

      const setOrDelete = (key: string, value: unknown) => {
        if (value === undefined) return; // not specified — leave alone
        if (value === null || value === '') {
          next.delete(key);
        } else {
          next.set(key, String(value));
        }
      };
      setOrDelete('contactId', args.contactId);
      setOrDelete('categoryId', args.categoryId);
      setOrDelete('accountId', args.accountId);
      setOrDelete('start', args.start);
      setOrDelete('end', args.end);
      setOrDelete('q', args.q);
      setOrDelete('sort', args.sort);
      setOrDelete('dir', args.dir);

      if (args.filter !== undefined) {
        if (args.filter === 'all' || args.filter === '' || args.filter === null) {
          next.delete('filter');
        } else {
          next.set('filter', String(args.filter));
        }
      }

      // Filter changes always reset pagination.
      next.delete('page');
      const qs = next.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
    return () => off();
  }, [registerClientAction, router, pathname, searchParams]);

  return null;
}
