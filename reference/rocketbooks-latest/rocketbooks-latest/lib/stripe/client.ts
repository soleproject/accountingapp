import Stripe from 'stripe';

// Memoize across hot reloads in dev so we don't open a new HTTPS agent
// per request. The Stripe constructor is cheap but we may as well.
declare global {
  var __stripe: Stripe | undefined;
}

export function stripe(): Stripe {
  if (global.__stripe) return global.__stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is required');
  if (key.startsWith('sk_live_') && process.env.NODE_ENV !== 'production') {
    // Guard rail — using a live key outside production is almost always a
    // mis-configured env. Throw loudly rather than charging a real card.
    throw new Error('Refusing to use sk_live_ outside production');
  }
  const client = new Stripe(key, { typescript: true });
  if (process.env.NODE_ENV !== 'production') global.__stripe = client;
  return client;
}
