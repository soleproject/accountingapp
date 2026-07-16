import Link from 'next/link';

interface LegalFooterProps {
  /**
   * Verb that describes the action the visitor is about to take, used in the
   * "By {verb} you agree…" preamble. Defaults to "continuing" so the same
   * footer reads naturally under both signup and login forms.
   */
  agreementVerb?: string;
}

/**
 * Small legal-link footer rendered under unauthenticated forms.
 *
 * Exists primarily so the Terms and Privacy URLs Intuit reviews for
 * QBO production approval have a discoverable in-product entry point —
 * Intuit's reviewer browses the live site and expects links to be reachable
 * without first creating an account.
 */
export function LegalFooter({ agreementVerb = 'continuing' }: LegalFooterProps) {
  return (
    <p className="text-center text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
      By {agreementVerb} you agree to our{' '}
      <Link href="/legal/terms" prefetch={false} className={LINK}>Terms</Link>
      {' · '}
      <Link href="/legal/privacy" prefetch={false} className={LINK}>Privacy</Link>
      {' · '}
      <Link href="/legal/sms-disclosure" prefetch={false} className={LINK}>SMS terms</Link>
    </p>
  );
}

const LINK = 'underline hover:text-zinc-700 dark:hover:text-zinc-200';
