import { requireSession } from '@/lib/auth/session';
import { AiChatWorkspace } from './_components/AiChatWorkspace';
import type { OutlookData } from '@/lib/server/outlook';

interface PageProps {
  searchParams: Promise<{ onboarding?: string; categorize?: string }>;
}

function emptyOutlook(): OutlookData {
  const windowDays = 60;
  const zeros = Array(windowDays).fill(0);
  return {
    windowDays,
    generatedAt: new Date().toISOString(),
    income: {
      actual: 0,
      projected: 0,
      projectedBreakdown: { scheduled: 0, extrapolated: null },
      trailing: zeros,
      projectedDaily: [],
      notEnoughHistory: true,
    },
    expenses: {
      actual: 0,
      projected: 0,
      projectedBreakdown: { scheduled: 0, extrapolated: null },
      trailing: zeros,
      projectedDaily: [],
      notEnoughHistory: true,
    },
    invoices: { actual: 0, projected: 0 },
    bills: { actual: 0, projected: 0 },
  };
}

export default async function AiChatPage({ searchParams }: PageProps) {
  // Keep the document render intentionally thin for Cloudflare/OpenNext.
  // Heavy cards/outlook/admin/categorization reads lazy-load in client APIs so
  // /ai-chat can paint without competing for Supavisor session-pool slots.
  await requireSession();
  const { onboarding, categorize } = await searchParams;
  const resumeOnboarding = onboarding === 'start';
  const categorizeMode = !!categorize;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 lg:translate-x-[calc(-1*min(var(--rs-sidebar-w)/2,max(0px,(100vw_-_var(--rs-sidebar-w)_-_1328px)/2)))] lg:transition-transform lg:duration-150">
      <header>
        <h1 className="text-2xl font-semibold">AI Assistant</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Ask anything about your books, categorization, or GAAP rules.
        </p>
      </header>
      <AiChatWorkspace
        resumeOnboarding={resumeOnboarding}
        canRealtime={false}
        firstName=""
        initialCards={[]}
        initialOutlook={emptyOutlook()}
        categorizeMode={categorizeMode}
        categorizationSessionIdParam={categorize ?? null}
        initialCategorizationSession={null}
        categorizationAccountOptions={[]}
      />
    </div>
  );
}
