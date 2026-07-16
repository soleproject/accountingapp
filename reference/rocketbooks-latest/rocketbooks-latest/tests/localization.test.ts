import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const requiredFiles = [
  'lib/i18n/languages.ts',
  'lib/i18n/dictionaries/en.ts',
  'lib/i18n/dictionaries/es.ts',
  'lib/i18n/dictionaries/index.ts',
  'components/i18n/LanguageProvider.tsx',
  'components/i18n/LanguageToggle.tsx',
];

for (const file of requiredFiles) {
  assert.ok(existsSync(file), `${file} should exist for first-party localization`);
}

const allLocalization = requiredFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
const rootLayout = readFileSync('app/layout.tsx', 'utf8');
const topBar = readFileSync('components/layout/TopBar.tsx', 'utf8');

assert.doesNotMatch(
  allLocalization + rootLayout + topBar,
  /translate\.google|googtrans|google_translate_element|translate_a\/element/i,
  'Rocket Suite localization must not use Google Translate/runtime translation widgets',
);

assert.match(allLocalization, /LANGUAGE_STORAGE_KEY = 'rs_language'/, 'language choice should persist in rs_language');
assert.match(allLocalization, /export type AppLanguage = 'en' \| 'es'/, 'only English and Spanish should be supported initially');
assert.match(allLocalization, /satisfies Record<AppLanguage, Record<TranslationKey, string>>/, 'dictionaries should be type-checked across languages');
assert.match(rootLayout, /<LanguageProvider>\s*\{children\}\s*<\/LanguageProvider>/, 'root layout should mount lightweight LanguageProvider around children');
assert.match(topBar, /<LanguageToggle \/>/, 'top bar should include English/Español toggle');

for (const key of [
  'nav.dashboard',
  'nav.transactions',
  'nav.bills',
  'nav.invoices',
  'nav.reports',
  'nav.contacts',
  'dashboard.recovery.title',
  'dashboard.recovery.transactions.description',
  'topbar.signOut',
]) {
  assert.match(allLocalization, new RegExp(`['\"]${key}['\"]`), `${key} should be present in dictionaries`);
}

console.log('localization: first-party English/Spanish shell verified');
