export const LANGUAGE_STORAGE_KEY = 'rs_language';

export const APP_LANGUAGES = ['en', 'es'] as const;

export type AppLanguage = 'en' | 'es';

export const DEFAULT_LANGUAGE: AppLanguage = 'en';

export const LANGUAGE_LABELS: Record<AppLanguage, string> = {
  en: 'English',
  es: 'Español',
};

export function isAppLanguage(value: unknown): value is AppLanguage {
  return value === 'en' || value === 'es';
}

export function normalizeLanguage(value: unknown): AppLanguage {
  return isAppLanguage(value) ? value : DEFAULT_LANGUAGE;
}

export function buildLanguageInstruction(language: AppLanguage): string {
  return language === 'es'
    ? 'LANGUAGE: Respond in natural Spanish. Preserve US accounting terminology when needed, but explain it in Spanish. Keep tool names, identifiers, dates, and currency values unchanged.'
    : 'LANGUAGE: Always respond in English.';
}
