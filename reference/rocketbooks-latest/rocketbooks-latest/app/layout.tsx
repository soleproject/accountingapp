import type { Metadata } from "next";
import { cookies } from "next/headers";
import { LanguageProvider } from '@/components/i18n/LanguageProvider';
import "./globals.css";

export const metadata: Metadata = {
  title: { default: 'RocketSuite', template: '%s · RocketSuite' },
  description: 'Books on autopilot.',
};

// Theme and sidebar width are applied here, server-side from cookies, so
// the SSR'd HTML already reflects the user's preferences and there's no
// pre-paint <script> in the React tree (which trips React 19 / Next 16's
// "script tag while rendering React component" warning). ThemeToggle and
// each sidebar mirror their localStorage writes into cookies of the same
// name. First-visit users in "system" mode see the light default until
// the client picks up `prefers-color-scheme`.
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const themeCookie = cookieStore.get('rs_theme')?.value;
  const sidebarCollapsed = cookieStore.get('rs_sidebar_collapsed')?.value === '1';

  const htmlClass = `h-full antialiased${themeCookie === 'dark' ? ' dark' : ''}`;

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={htmlClass}
      style={{ ['--rs-sidebar-w' as string]: sidebarCollapsed ? '56px' : '224px' }}
    >
      <body className="min-h-full flex flex-col">
        <LanguageProvider>
          {children}
        </LanguageProvider>
      </body>
    </html>
  );
}
