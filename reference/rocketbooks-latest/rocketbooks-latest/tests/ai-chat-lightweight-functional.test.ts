import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync('app/(app)/ai-chat/page.tsx', 'utf8');
const workspace = readFileSync('app/(app)/ai-chat/_components/AiChatWorkspace.tsx', 'utf8');
const taskCards = readFileSync('app/(app)/ai-chat/_components/TaskCardsPanel.tsx', 'utf8');
const categorizationWorkspace = readFileSync('app/(app)/ai-chat/_components/CategorizationWorkspace.tsx', 'utf8');
const files = {
  bootstrap: readFileSync('app/api/ai-chat/bootstrap/route.ts', 'utf8'),
  categorizationAccounts: readFileSync('app/api/categorization/accounts/route.ts', 'utf8'),
};

assert.match(page, /AiChatWorkspace/, 'AI chat page must keep the rich workspace mounted, not replace it with a dead shell');
assert.doesNotMatch(page, /from '@\/db\/client'|from '\.\/_components\/AiChatWorkspace'\s*;[\s\S]*getActionCards|fetchInitialCards|fetchInitialOutlook|getOutlook\(|isSuperAdmin\(|getFirstName\(/, 'AI chat document render must not do DB-backed cards/outlook/admin/name work before first paint');
assert.match(page, /initialCards=\{\[\]\}/, 'AI chat page should seed task cards empty and let the client revalidate');
assert.match(page, /initialCategorizationSession=\{null\}/, 'AI chat page should not load categorization session during document render');
assert.match(page, /categorizationAccountOptions=\{\[\]\}/, 'AI chat page should not load chart-of-account options during document render');

assert.match(workspace, /fetch\('\/api\/ai-chat\/bootstrap'/, 'workspace should lazy-load lightweight user capability metadata after first paint');
assert.match(workspace, /setCanRealtime\(data\.canRealtime === true\)/, 'workspace should restore realtime UI after lazy capability load for eligible users');
assert.match(workspace, /fetch\('\/api\/ai\/opener\?light=1'/, 'workspace opener should use lightweight opener on first paint to avoid DB pool pressure');

assert.match(taskCards, /initialCards\.length > 0[\s\S]*void fetchCards\(\);[\s\S]*startPolling\(\)/, 'task cards may poll only when server-provided cards already exist');
assert.match(taskCards, /Load suggestions/, 'empty task-card rail should expose a manual lazy-load control instead of auto-querying on first paint');

assert.match(categorizationWorkspace, /fetch\('\/api\/categorization\/accounts'/, 'categorization workspace should lazy-load account options client-side');
assert.match(categorizationWorkspace, /useState<AccountOption\[\]>\(accountOptions\)/, 'categorization workspace should keep account options in client state');

assert.match(files.bootstrap, /requireSession\(\)/, 'bootstrap endpoint must require auth');
assert.match(files.bootstrap, /isSuperAdmin\(\)/, 'bootstrap endpoint should compute realtime capability after first paint');
assert.match(files.categorizationAccounts, /requireSession\(\)/, 'categorization account-options endpoint must require auth');
assert.match(files.categorizationAccounts, /chartOfAccounts/, 'categorization account-options endpoint should provide chart-of-account options');

console.log('ai-chat-lightweight-functional: document render is lightweight while rich AI chat features lazy-load');
