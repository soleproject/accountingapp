import Link from 'next/link';

export const metadata = {
  title: 'Privacy Policy · RocketBooks',
  description:
    'How RocketBooks collects, uses, stores, and shares your information, including data received from QuickBooks Online and other connected services.',
};

/**
 * Public-facing privacy policy.
 *
 * Linked from the Intuit Developer Portal as the production app's
 * privacy policy URL — Intuit's review team loads this page to
 * confirm the disclosures required for QuickBooks Online API
 * production access. It also serves as the canonical privacy
 * disclosure for the product more broadly.
 *
 * Sections deliberately cover items Intuit looks for:
 *   - Data received from QuickBooks Online (categories + purpose)
 *   - Whether QBO data is sold or shared (it isn't)
 *   - How users can request deletion of QBO data
 *   - Retention period
 *   - Contact for privacy requests
 *
 * Do not strip the QuickBooks-specific section without confirming
 * with whoever owns the Intuit production listing — Intuit periodically
 * re-validates linked policies and a missing disclosure can revoke
 * production keys.
 *
 * This draft must be reviewed by counsel before going live.
 */
export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-12 text-zinc-800 dark:text-zinc-200">
      <header className="border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">RocketBooks · Legal</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Privacy Policy</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">Last updated: May 27, 2026</p>
      </header>

      <Section title="Overview">
        <p>
          RocketBooks (&ldquo;RocketBooks,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;) provides
          accounting and bookkeeping software at <Link href="/" className={LINK}>rocketsuite.ai</Link>{' '}
          (the &ldquo;Service&rdquo;). This policy explains what information we collect, how we use
          and protect it, who we share it with, and the choices you have. By using the Service you
          agree to the practices described here.
        </p>
      </Section>

      <Section title="Information we collect">
        <p>We collect the following categories of information:</p>
        <ul className="ml-5 list-disc space-y-1">
          <li><strong>Account information</strong> — name, email address, mobile phone number (if provided), organization name, and authentication credentials.</li>
          <li><strong>Billing information</strong> — payment method details processed by our payment processor; we do not store full card numbers ourselves.</li>
          <li><strong>Accounting data you enter</strong> — chart of accounts, customers, vendors, transactions, invoices, bills, and supporting documents you upload.</li>
          <li><strong>Connected-service data</strong> — data received from third-party services you connect, including QuickBooks Online, bank-feed providers, and email/calendar integrations.</li>
          <li><strong>Usage data</strong> — log data such as IP address, browser, pages viewed, and timestamps, used for security and product improvement.</li>
        </ul>
      </Section>

      <Section title="Data received from QuickBooks Online">
        <p>
          When you connect a QuickBooks Online (&ldquo;QBO&rdquo;) company to RocketBooks, we receive
          and store the following categories of data from Intuit on your behalf:
        </p>
        <ul className="ml-5 list-disc space-y-1">
          <li>Chart of accounts, classes, and items</li>
          <li>Customers, vendors, and employees</li>
          <li>Invoices, bills, payments, deposits, transfers, journal entries, and other transactions</li>
          <li>Attachments and notes associated with the above</li>
          <li>Company metadata (company name, fiscal year, base currency, etc.)</li>
        </ul>
        <p>
          We use this data solely to provide the Service to you and your organization — including
          mirroring, categorization, reporting, reconciliation, and AI-assisted bookkeeping
          features. <strong>We do not sell QBO data, and we do not share it with third parties for
          their own marketing or advertising purposes.</strong>
        </p>
        <p>
          You can disconnect QuickBooks Online from RocketBooks at any time from{' '}
          <Link href="/integrations/qbo" className={LINK}>Integrations &rarr; QuickBooks</Link>, or
          from your Intuit account&rsquo;s &ldquo;My Apps&rdquo; page. Disconnecting stops further
          data synchronization. To request deletion of QBO data previously received, see{' '}
          <em>Data retention and deletion</em> below.
        </p>
      </Section>

      <Section title="How we use information">
        <p>We use the information we collect to:</p>
        <ul className="ml-5 list-disc space-y-1">
          <li>Operate, maintain, and improve the Service</li>
          <li>Mirror and synchronize data between RocketBooks and your connected services</li>
          <li>Generate reports, suggestions, and AI-assisted categorizations</li>
          <li>Authenticate you and protect your account</li>
          <li>Process payments and manage your subscription</li>
          <li>Send transactional and account-related messages (see <Link href="/legal/sms-disclosure" className={LINK}>SMS Notifications Terms</Link> for SMS specifics)</li>
          <li>Comply with legal obligations and enforce our <Link href="/legal/terms" className={LINK}>Terms of Service</Link></li>
        </ul>
      </Section>

      <Section title="Service providers we share data with">
        <p>
          We share information only with vendors that help us operate the Service, each bound by
          contractual confidentiality and data-protection obligations. These currently include:
        </p>
        <ul className="ml-5 list-disc space-y-1">
          <li><strong>Supabase</strong> — database hosting and authentication</li>
          <li><strong>Stripe</strong> — payment processing</li>
          <li><strong>Twilio</strong> — SMS delivery (for users who opt in)</li>
          <li><strong>Resend</strong> — transactional email delivery</li>
          <li><strong>Intuit</strong> — QuickBooks Online API access</li>
          <li><strong>AI providers</strong> — language-model providers used to power assistant and categorization features; data sent for these features is governed by the providers&rsquo; zero-retention or limited-retention enterprise terms where available</li>
        </ul>
        <p>
          We do not sell personal information. We may disclose information when required by law,
          subpoena, or court order, or to protect the rights, property, or safety of RocketBooks,
          our users, or others.
        </p>
      </Section>

      <Section title="Data retention and deletion">
        <p>
          We retain your data for as long as your account is active and for a reasonable period
          afterward to comply with legal, tax, and accounting record-keeping obligations.
        </p>
        <p>
          You can request deletion of your account and associated data — including data received
          from QuickBooks Online — by emailing{' '}
          <a href="mailto:support@rocketsuite.ai" className={LINK}>support@rocketsuite.ai</a> from
          the email address on your account. We will confirm and complete the deletion within
          30 days, except for records we are required to retain by law.
        </p>
      </Section>

      <Section title="Security">
        <p>
          We use industry-standard technical and organizational measures to protect your
          information, including TLS in transit, encryption at rest for credentials and tokens,
          least-privilege access controls, and audit logging. No system is perfectly secure; if you
          believe your account has been compromised, contact us immediately at{' '}
          <a href="mailto:support@rocketsuite.ai" className={LINK}>support@rocketsuite.ai</a>.
        </p>
      </Section>

      <Section title="Your choices">
        <p>You can:</p>
        <ul className="ml-5 list-disc space-y-1">
          <li>Update your account information from <Link href="/settings" className={LINK}>Settings</Link></li>
          <li>Disconnect any third-party integration from <Link href="/integrations/qbo" className={LINK}>Integrations</Link></li>
          <li>Opt out of SMS notifications at any time (see <Link href="/legal/sms-disclosure" className={LINK}>SMS Notifications Terms</Link>)</li>
          <li>Request a copy of your data or its deletion by contacting support</li>
        </ul>
      </Section>

      <Section title="Children">
        <p>
          The Service is not directed to children under 13, and we do not knowingly collect
          information from children under 13. If you believe a child has provided us information,
          contact us so we can delete it.
        </p>
      </Section>

      <Section title="Changes to this policy">
        <p>
          We may update this policy from time to time. We will update the &ldquo;Last updated&rdquo;
          date above and, for material changes, notify users by email or in-product notice.
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
