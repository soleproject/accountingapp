import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgContext } from '@/lib/auth/org';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import { AssistantProvider } from '@/components/ai-assistant/AssistantContext';
import { LazyAIAssistantSidecar } from '@/components/ai-assistant/LazyAIAssistantSidecar';

const TRUST_ENTITY_TYPES = new Set(['beneficial_trust', 'business_trust']);

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [user, orgContext] = await Promise.all([
    requireSession(),
    getCurrentOrgContext(),
  ]);
  const currentOrg = { id: orgContext.id, name: 'Workspace', entityType: orgContext.entityType };
  const orgs = [{ ...currentOrg, role: 'primary' as const }];

  // Trust nav (Trust Review / Beneficiaries / Documents) is gated on the org's
  // ENTITY TYPE — it shows only when the entity itself is a trust. This is
  // deliberately NOT tied to the accounting feature pack: an LLC that happens to
  // have the beneficial_trust pack toggled on must NOT show trust nav. The indexed
  // entity lookup chains from org resolution while overlapping the remaining
  // app-shell work, so it does not add a second sequential layout waterfall.
  const isTrustOrg = !!orgContext.entityType && TRUST_ENTITY_TYPES.has(orgContext.entityType);

  const hiddenNavPaths = [
    // Hide "AI Assistant" from the accounting left nav — the /ai-chat page,
    // AssistantProvider, AI button, and floating sidecar all stay live.
    '/ai-chat',
    // Trust nav is hidden unless this org's entity type is a trust.
    ...(isTrustOrg ? [] : ['/trust-review', '/trust-beneficiaries', '/trust-documents']),
    // Share is shown in the demo workspace too — the /share page handles the
    // demo org with a "create your workspace" prompt instead of a dead end.
  ];

  return (
    <AssistantProvider>
      <div>
        <div className="flex min-h-screen bg-zinc-50 dark:bg-zinc-950">
        <Sidebar hiddenNavPaths={hiddenNavPaths} />
        <div className="flex flex-1 flex-col">
          <TopBar
          email={user.email ?? ''}
          orgs={orgs}
          currentOrg={currentOrg}
        />
          <main className="flex-1 overflow-auto p-6">
            {children}
          </main>
        </div>
        </div>
        <LazyAIAssistantSidecar orgId={currentOrg.id} />
      </div>
    </AssistantProvider>
  );
}
