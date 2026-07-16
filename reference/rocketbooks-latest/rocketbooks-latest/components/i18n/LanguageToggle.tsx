'use client';

import { APP_LANGUAGES, LANGUAGE_LABELS, type AppLanguage } from '@/lib/i18n/languages';
import { useTranslation } from './LanguageProvider';

export function LanguageToggle() {
  const { language, setLanguage, t } = useTranslation();

  return (
    <div
      aria-label={t('language.toggleLabel')}
      className="inline-flex rounded-full border border-zinc-300 bg-zinc-50 p-0.5 text-xs font-medium dark:border-zinc-700 dark:bg-zinc-900"
    >
      {APP_LANGUAGES.map((option: AppLanguage) => {
        const active = option === language;
        return (
          <button
            key={option}
            type="button"
            onClick={() => setLanguage(option)}
            aria-pressed={active}
            className={`rounded-full px-2.5 py-1 transition-colors ${
              active
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-zinc-600 hover:bg-white hover:text-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-50'
            }`}
          >
            {LANGUAGE_LABELS[option]}
          </button>
        );
      })}
    </div>
  );
}
