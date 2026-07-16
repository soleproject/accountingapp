import type { Metadata } from 'next';
import { resolveHostBrand, hostBrandThemeVars } from '@/lib/auth/hostBranding';

export const dynamic = 'force-dynamic';

// Title the sign-in tab with the host brand (RocketBooks, a firm, or AccountingApp).
export async function generateMetadata(): Promise<Metadata> {
  const brand = await resolveHostBrand();
  return { title: { absolute: brand.name } };
}

/**
 * Shared shell for the unauthenticated gate (login / signup / reset): a
 * glassmorphic card floating on a soft, brand-tinted aurora background. The
 * brand accent (a firm's color, else RocketBooks blue) drives the glow, and the
 * whole gate sits in the `.rs-themed` token wrapper so accent classes (the
 * sign-in button, links) pick up the firm's palette.
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const brand = await resolveHostBrand();
  const styleVars = hostBrandThemeVars(brand);
  const themed = Object.keys(styleVars).length > 0;
  const glow = brand.brandColorHex ?? '#3b82f6';

  return (
    <div className={themed ? 'rs-themed' : undefined} style={themed ? (styleVars as React.CSSProperties) : undefined}>
      <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-zinc-50 px-4 py-10 dark:bg-zinc-950">
        {/* Aurora glow blobs (brand-tinted) */}
        <div aria-hidden className="pointer-events-none absolute -left-40 -top-40 h-[30rem] w-[30rem] rounded-full opacity-25 blur-[120px] dark:opacity-30" style={{ background: glow }} />
        <div aria-hidden className="pointer-events-none absolute -bottom-44 -right-32 h-[28rem] w-[28rem] rounded-full opacity-20 blur-[120px] dark:opacity-25" style={{ background: glow }} />
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_55%_at_50%_-10%,rgba(255,255,255,0.7),transparent)] dark:bg-[radial-gradient(70%_55%_at_50%_-10%,rgba(255,255,255,0.05),transparent)]" />

        {/* Glass card */}
        <div className="relative w-full max-w-md rounded-3xl border border-white/60 bg-white/70 p-8 shadow-2xl shadow-zinc-900/10 ring-1 ring-zinc-900/5 backdrop-blur-2xl sm:p-10 dark:border-white/10 dark:bg-zinc-900/60 dark:shadow-black/40 dark:ring-white/5">
          <div className="flex flex-col items-stretch gap-6">{children}</div>
        </div>
      </main>
    </div>
  );
}
