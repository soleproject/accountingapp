import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const chatBox = readFileSync('app/(app)/ai-chat/_components/ChatBox.tsx', 'utf8');
const sidecar = readFileSync('components/ai-assistant/AIAssistantSidecar.tsx', 'utf8');
const chatRoute = readFileSync('app/api/ai/chat/route.ts', 'utf8');
const assistantRoute = readFileSync('app/api/ai/assistant/chat/route.ts', 'utf8');
const topBar = readFileSync('components/layout/TopBar.tsx', 'utf8');

assert.match(topBar, /LanguageToggle/, 'the app top bar must expose the English/Spanish toggle');
assert.match(chatBox, /language:\s*normalizeLanguage\(/, 'full AI chat must send the selected app language');
assert.match(sidecar, /const language = normalizeLanguage\(/, 'sidecar AI chat must read the selected app language');
assert.match(sidecar, /\? \{ messages: history, language \}/, 'sidecar onboarding chat must send the selected app language');
assert.match(sidecar, /messages: history,\s*language,/, 'sidecar page chat must send the selected app language');
assert.match(chatRoute, /language:\s*z\.enum\(APP_LANGUAGES\)/, 'full chat API must validate the requested language');
assert.match(assistantRoute, /language:\s*z\.enum\(APP_LANGUAGES\)/, 'sidecar API must validate the requested language');
assert.match(chatRoute, /buildLanguageInstruction\(language\)/, 'full chat prompt must follow the selected language');
assert.match(assistantRoute, /buildLanguageInstruction\(language\)/, 'sidecar prompt must follow the selected language');

console.log('ai-chat-language-sync: selected app language reaches both text AI prompts');
