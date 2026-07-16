import Image from 'next/image';
import type { HostBrand } from '@/lib/auth/hostBranding';

/**
 * Brand mark for the unauthenticated gate. Private-label firm logo (light/dark)
 * when set; otherwise the platform logo image; otherwise a text wordmark.
 */
export function AuthBrandLogo({ brand }: { brand: HostBrand }) {
  if (brand.privateLabelEnabled && brand.logoUrl) {
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={brand.logoUrl}
          alt={brand.name}
          className={`h-24 w-auto max-w-[20rem] object-contain ${brand.logoUrlDark ? 'dark:hidden' : ''}`}
        />
        {brand.logoUrlDark && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={brand.logoUrlDark} alt={brand.name} className="hidden h-24 w-auto max-w-[20rem] object-contain dark:block" />
        )}
      </>
    );
  }
  if (brand.platformLogo) {
    return <Image src={brand.platformLogo} alt={brand.name} width={400} height={160} priority className="h-auto w-80" />;
  }
  return <span className="text-3xl font-semibold tracking-tight">{brand.name}</span>;
}
