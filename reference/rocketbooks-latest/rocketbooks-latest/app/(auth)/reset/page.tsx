import { ResetPasswordForm } from './_components/ResetPasswordForm';
import { AuthBrandLogo } from '@/components/auth/AuthBrandLogo';
import { resolveHostBrand } from '@/lib/auth/hostBranding';

export const dynamic = 'force-dynamic';

export default async function ResetPage() {
  const brand = await resolveHostBrand();
  return (
    <>
      <header className="flex flex-col items-center gap-2 text-center">
        <AuthBrandLogo brand={brand} />
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Choose a new password</p>
      </header>
      <ResetPasswordForm />
    </>
  );
}
