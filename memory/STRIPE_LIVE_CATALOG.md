# Stripe LIVE Product Catalog

The preview environment runs on a claimable Stripe **sandbox** (test-mode)
so we don't touch the user's real account while iterating. When deploying
to Railway (or any production environment), swap the test values for the
LIVE values below in the platform's env-var settings.

## LIVE Account
- Account: `acct_1SNoxrECKMX6pzcA`
- Publishable key: `pk_live_51SNoxrECKMX6pzcAhVWqlB0SeGStgkQRGoZOAQ9VEwJwUBT0baBQDddXLN5FgWIqkh4Y1wfFCCwMa9Hdb3mNnR3P00ppXkdXcD`
- Secret key: **user must paste `sk_live_…` from Stripe Dashboard → Developers → API keys**
- Webhook secret: **user must copy from Stripe Dashboard → Developers → Webhooks after registering the endpoint**

## LIVE Products & Prices (uploaded Feb 2026)

| Plan             | Cadence  | Product ID              | Live Price ID            | Amount     |
|------------------|----------|-------------------------|--------------------------|------------|
| Core             | Monthly  | `prod_VJe6sFCRLRnlIP`   | `price_1TwKhcECKMX6pzcAi1l2WAWw` | $38 / mo   |
| Core             | Annual   | `prod_VJg0sP4cWmVOfl`   | *needs default-price lookup*     | $380 / yr  |
| AI Assistant     | Monthly  | `prod_VJfwZndzRRDO0w`   | *needs default-price lookup*     | $79 / mo   |
| AI Assistant     | Annual   | `prod_VJg3qHwYHvdTuz`   | *needs default-price lookup*     | $790 / yr  |
| AI Bookkeeper    | Monthly  | `prod_VJg5SiqGWHQac7`   | *needs default-price lookup*     | $99 / mo   |
| AI Bookkeeper    | Annual   | `prod_VJg7peUUSLI2wf`   | *needs default-price lookup*     | $990 / yr  |
| Advanced         | Monthly  | *pending — user upload* | *pending*                | $149 / mo  |
| Advanced         | Annual   | *pending — user upload* | *pending*                | $1490 / yr |

The "needs default-price lookup" cells only have the Product ID — the exact
Price ID (starts with `price_…`) is the *default price* attached to each
product. To get it: `stripe products retrieve prod_XXX` → read
`.default_price`, or open the product in the Dashboard and copy the ID from
the Pricing table.

## Env vars to set on Railway for LIVE

```
STRIPE_SECRET_KEY=sk_live_… (paste from Stripe Dashboard)
STRIPE_WEBHOOK_SECRET=whsec_… (paste after registering webhook)
STRIPE_PUBLISHABLE_KEY=pk_live_51SNoxrECKMX6pzcAhVWqlB0SeGStgkQRGoZOAQ9VEwJwUBT0baBQDddXLN5FgWIqkh4Y1wfFCCwMa9Hdb3mNnR3P00ppXkdXcD
STRIPE_MODE=live

STRIPE_PRICE_SIMPLE_START_MONTHLY=price_1TwKhcECKMX6pzcAi1l2WAWw    # $38
STRIPE_PRICE_SIMPLE_START_ANNUAL=price_… (from prod_VJg0sP4cWmVOfl)  # $380
STRIPE_PRICE_ASSISTANT_MONTHLY=price_…    (from prod_VJfwZndzRRDO0w)  # $79
STRIPE_PRICE_ASSISTANT_ANNUAL=price_…     (from prod_VJg3qHwYHvdTuz)  # $790
STRIPE_PRICE_BOOKKEEPER_MONTHLY=price_…   (from prod_VJg5SiqGWHQac7)  # $99
STRIPE_PRICE_BOOKKEEPER_ANNUAL=price_…    (from prod_VJg7peUUSLI2wf)  # $990
STRIPE_PRICE_ADVANCED_MONTHLY=price_…     (pending)                   # $149
STRIPE_PRICE_ADVANCED_ANNUAL=price_…      (pending)                   # $1490
```

## Webhook endpoint (register on Stripe Dashboard)

- Endpoint URL: `https://app.smartbookssoftware.ai/api/stripe/webhook`
- Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`,
  `customer.subscription.updated`, `customer.subscription.deleted`,
  `invoice.paid`, `invoice.payment_failed`, `charge.refunded`
