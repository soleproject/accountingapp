import type { AppLanguage } from '../languages';
import { en, type TranslationKey } from './en';
import { es } from './es';

export type { TranslationKey } from './en';

export const dictionaries = {
  en,
  es,
} satisfies Record<AppLanguage, Record<TranslationKey, string>>;

export function translate(language: AppLanguage, key: TranslationKey): string {
  return dictionaries[language][key] ?? dictionaries.en[key];
}
