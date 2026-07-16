// Route-segment config (`dynamic`) must be declared statically here — Next.js
// can't statically parse it through a re-export, so only the component is
// re-used from the (app) settings page.
export { default } from '@/app/(app)/settings/booking/page';

export const dynamic = 'force-dynamic';
