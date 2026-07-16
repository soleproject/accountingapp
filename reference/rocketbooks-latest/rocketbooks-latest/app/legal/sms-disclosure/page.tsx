import Link from 'next/link';

export const metadata = {
  title: 'SMS Notifications Terms · RocketBooks',
  description: 'RocketBooks SMS notification disclosures, opt-in terms, opt-out instructions, and support contact information.',
};

const LINK = 'underline hover:text-zinc-700 dark:hover:text-zinc-200';

export default function SmsDisclosurePage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-12 text-zinc-800 dark:text-zinc-200">
      <header className="border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">RocketBooks · Legal</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">SMS Notifications Terms</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">Last updated: June 9, 2026</p>
      </header>

      <Section title="Overview">
        <p>
          RocketBooks may send SMS text messages for account, security, appointment,
          payment, bookkeeping, and service-related notifications when you provide a
          mobile number and consent to receive messages. SMS participation is optional
          and is not required to use RocketBooks.
        </p>
      </Section>

      <Section title="Consent to receive messages">
        <p>
          By entering your mobile number, enabling SMS notifications, replying to a
          RocketBooks message, or otherwise opting in, you authorize RocketBooks and
          its service providers to send text messages to the mobile number you provide.
          Message types may include authentication or security alerts, reminders,
          status updates, billing notices, product notifications, and support-related
          communications.
        </p>
      </Section>

      <Section title="Message frequency and charges">
        <p>
          Message frequency varies based on your account activity, enabled features,
          and notification preferences. Message and data rates may apply. Your mobile
          carrier is not liable for delayed or undelivered messages.
        </p>
      </Section>

      <Section title="Opt out">
        <p>
          You can opt out of SMS messages at any time by replying <strong>STOP</strong>
          to any RocketBooks text message. After you opt out, we may send one final
          confirmation message and then stop sending SMS messages to that number unless
          you opt in again.
        </p>
      </Section>

      <Section title="Help and support">
        <p>
          For help, reply <strong>HELP</strong> to a RocketBooks text message or contact{' '}
          <a href="mailto:support@rocketsuite.ai" className={LINK}>support@rocketsuite.ai</a>.
        </p>
      </Section>

      <Section title="Privacy">
        <p>
          We handle personal information, including mobile numbers and SMS-related
          records, according to our{' '}
          <Link href="/legal/privacy" className={LINK}>Privacy Policy</Link>. We do not
          sell your mobile number or SMS opt-in information.
        </p>
      </Section>

      <Section title="Related terms">
        <p>
          These SMS terms supplement the RocketBooks{' '}
          <Link href="/legal/terms" className={LINK}>Terms of Service</Link>. If these
          SMS terms conflict with the Terms of Service for SMS-specific matters, these
          SMS terms control for that SMS-specific issue.
        </p>
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
      <div className="space-y-3 text-sm leading-6 text-zinc-700 dark:text-zinc-300">{children}</div>
    </section>
  );
}
