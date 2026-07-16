import { LoginForm } from './_components/LoginForm';
import { LegalFooter } from '@/components/legal/LegalFooter';
import { AuthBrandLogo } from '@/components/auth/AuthBrandLogo';
import { resolveHostBrand } from '@/lib/auth/hostBranding';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function LoginPage({ searchParams }: PageProps) {
  const { next } = await searchParams;
  const brand = await resolveHostBrand();

  return (
    <>
      <header className="flex flex-col items-center gap-2 text-center">
        <AuthBrandLogo brand={brand} />
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Sign in to your account</p>
      </header>
      <LoginForm next={next} />
      <LegalFooter />
    </>
  );
}
