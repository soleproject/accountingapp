import Link from 'next/link';

export const metadata = {
  title: 'Terms of Service · RocketBooks',
  description:
    'The terms and conditions governing your use of RocketBooks, including subscription, acceptable use, intellectual property, and liability.',
};

/**
 * Public-facing terms of service / end-user license agreement.
 *
 * Linked from the Intuit Developer Portal as the production app's
 * EULA URL — Intuit's review team loads this page to confirm an
 * end-user agreement exists for the production app. It also serves
 * as the canonical terms for the product more broadly.
 *
 * Sections deliberately cover items Intuit looks for:
 *   - QuickBooks/Intuit trademark disclaimer (not affiliated, not endorsed)
 *   - Acceptable use
 *   - Account termination
 *   - Limitation of liability
 *
 * This draft must be reviewed by counsel before going live.
 */
export default function TermsOfServicePage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-12 text-zinc-800 dark:text-zinc-200">
      <header className="border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">RocketBooks · Legal</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Terms of Service</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">Last updated: May 27, 2026</p>
      </header>

      <Section title="Acceptance of these terms">
        <p>
          These Terms of Service (&ldquo;Terms&rdquo;) govern your access to and use of RocketBooks
          (the &ldquo;Service&rdquo;), provided by RocketBooks (&ldquo;RocketBooks,&rdquo;
          &ldquo;we,&rdquo; &ldquo;us&rdquo;). By creating an account, accessing, or using the
          Service, you agree to these Terms and to our{' '}
          <Link href="/legal/privacy" className={LINK}>Privacy Policy</Link>. If you are accepting
          on behalf of an organization, you represent that you have authority to bind that
          organization.
        </p>
      </Section>

      <Section title="The Service">
        <p>
          RocketBooks provides accounting and bookkeeping software, including features that
          synchronize data with third-party services such as QuickBooks Online, bank-feed
          providers, and email/calendar integrations. Features and pricing may change from time to
          time.
        </p>
      </Section>

      <Section title="Accounts">
        <p>
          You must provide accurate registration information and keep it current. You are
          responsible for safeguarding your credentials and for all activity under your account.
          Notify us at <a href="mailto:support@rocketsuite.ai" className={LINK}>support@rocketsuite.ai</a>{' '}
          if you suspect unauthorized access.
        </p>
      </Section>

      <Section title="Subscription, fees, and renewal">
        <p>
          Paid plans are billed in advance on a recurring basis. By starting a paid plan you
          authorize us (and our payment processor) to charge the payment method on file at the
          then-current rates. Subscriptions renew automatically until cancelled. You can cancel
          from <Link href="/settings" className={LINK}>Settings</Link> at any time; cancellation
          takes effect at the end of the current billing period and we do not provide pro-rated
          refunds for partial periods unless required by law.
        </p>
      </Section>

      <Section title="Acceptable use">
        <p>You agree not to:</p>
        <ul className="ml-5 list-disc space-y-1">
          <li>Use the Service to violate any law or the rights of others</li>
          <li>Upload malware, attempt to gain unauthorized access, or interfere with the Service</li>
          <li>Scrape, reverse engineer, or attempt to extract source code, except as permitted by law</li>
          <li>Resell, sublicense, or provide the Service to third parties without our written consent</li>
          <li>Use the Service to send unsolicited communications or violate any third-party platform&rsquo;s terms (including Intuit&rsquo;s)</li>
        </ul>
      </Section>

      <Section title="Your data">
        <p>
          You retain ownership of the data you enter into RocketBooks and the data we receive from
          third-party services you connect on your behalf (&ldquo;Customer Data&rdquo;). You grant
          us a limited license to host, copy, process, transmit, and display Customer Data solely
          as necessary to operate the Service for you. Our handling of Customer Data is described
          in our <Link href="/legal/privacy" className={LINK}>Privacy Policy</Link>.
        </p>
      </Section>

      <Section title="Third-party integrations">
        <p>
          The Service can connect to third-party services (including QuickBooks Online) at your
          direction. Your use of those services is governed by their own terms and privacy
          policies. We are not responsible for third-party services, and we may suspend an
          integration if the third party changes its terms, deprecates its API, or asks us to.
        </p>
      </Section>

      <Section title="QuickBooks Online trademark notice">
        <p>
          QuickBooks&reg;, QuickBooks Online&reg;, and Intuit&reg; are trademarks of Intuit Inc.,
          registered in the United States and other countries. RocketBooks is an independent
          third-party application; it is <strong>not</strong> affiliated with, endorsed by, or
          sponsored by Intuit Inc. References to QuickBooks Online describe interoperability only.
        </p>
      </Section>

      <Section title="Intellectual property">
        <p>
          RocketBooks and its licensors own all right, title, and interest in the Service,
          including all software, designs, and trademarks. These Terms do not grant you any rights
          in the Service other than the limited right to use it in accordance with these Terms.
        </p>
      </Section>

      <Section title="Feedback">
        <p>
          If you send us suggestions or feedback, you grant us a non-exclusive, perpetual,
          royalty-free license to use it for any purpose without obligation to you.
        </p>
      </Section>

      <Section title="Suspension and termination">
        <p>
          We may suspend or terminate your access to the Service if you breach these Terms, if your
          use creates risk for RocketBooks or other users, or if we are required to do so by law.
          You may terminate your account at any time from{' '}
          <Link href="/settings" className={LINK}>Settings</Link> or by emailing{' '}
          <a href="mailto:support@rocketsuite.ai" className={LINK}>support@rocketsuite.ai</a>. On
          termination, your right to use the Service ends; certain provisions survive (including
          intellectual property, disclaimers, limitation of liability, and dispute resolution).
        </p>
      </Section>

      <Section title="Disclaimers">
        <p>
          The Service is provided &ldquo;as is&rdquo; and &ldquo;as available.&rdquo; To the
          maximum extent permitted by law, RocketBooks disclaims all warranties, express or
          implied, including merchantability, fitness for a particular purpose, and
          non-infringement. RocketBooks is bookkeeping software; it is not a substitute for advice
          from a qualified accountant, attorney, or tax professional, and we do not warrant that
          reports or AI-generated suggestions are accurate or suitable for any particular purpose.
        </p>
      </Section>

      <Section title="Limitation of liability">
        <p>
          To the maximum extent permitted by law, RocketBooks and its affiliates will not be liable
          for any indirect, incidental, special, consequential, or punitive damages, or any loss of
          profits, revenue, data, or goodwill, arising out of or in connection with the Service.
          Our total liability for any claim arising out of or relating to the Service is limited to
          the greater of (a) the amounts you paid to us for the Service in the twelve months
          preceding the claim, or (b) US$100.
        </p>
      </Section>

      <Section title="Indemnity">
        <p>
          You will indemnify and hold harmless RocketBooks and its affiliates from any claim or
          demand, including reasonable attorneys&rsquo; fees, arising out of your use of the
          Service, your Customer Data, or your breach of these Terms.
        </p>
      </Section>

      <Section title="Governing law and disputes">
        <p>
          These Terms are governed by the laws of the State of Delaware, United States, without
          regard to its conflict-of-laws rules. The exclusive venue for any dispute that is not
          required to be arbitrated is the state or federal courts located in Delaware, and you
          consent to personal jurisdiction there.
        </p>
      </Section>

      <Section title="Changes to these terms">
        <p>
          We may update these Terms from time to time. We will update the &ldquo;Last updated&rdquo;
          date above and, for material changes, notify users by email or in-product notice. Your
          continued use of the Service after a change takes effect constitutes acceptance of the
          updated Terms.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          RocketBooks<br />
          <a href="mailto:support@rocketsuite.ai" className={LINK}>support@rocketsuite.ai</a><br />
          <Link href="/" className={LINK}>rocketsuite.ai</Link>
        </p>
      </Section>
    </main>
  );
}

const LINK = 'text-blue-600 underline hover:text-blue-700 dark:text-blue-400';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="space-y-2 text-sm leading-relaxed">{children}</div>
    </section>
  );
}
