# Private-Label Setup Guide

You now have Rocket-Suite-style private-label sign-in URLs. Here's how to
finish provisioning so `acme.accountingapp.ai` really loads in a browser.

## Prerequisites
- You own `accountingapp.ai` (registered at GoDaddy)
- DNS for `accountingapp.ai` is managed at GoDaddy (or moved to GoDaddy)
- Railway paid plan (wildcard custom domains require a paid plan)

---

## Step 1 — Add the wildcard custom domain in Railway

1. Railway → **`lucid-possibility`** (frontend service) → **Settings → Networking**.
2. Click **+ Custom Domain**.
3. Enter: `*.accountingapp.ai`
4. Railway shows you two records:
   - A **CNAME** target (e.g. `jebza2x6.up.railway.app`) — same as your `app.` frontend
   - A **TXT** `_railway-verify.*` verification token (some accounts also need `_acme-challenge` for DNS-01)
5. **Copy both.**

Also add the bare root domain if you want `accountingapp.ai` (no subdomain) to show the neutral gate:
1. Same panel → **+ Custom Domain** → enter `accountingapp.ai` → copy the CNAME.

---

## Step 2 — Add DNS records in GoDaddy

Log in to GoDaddy → `accountingapp.ai` → **Manage DNS**.

### Wildcard record (matches every subdomain)
- **Type**: `CNAME`
- **Name**: `*`
- **Value**: the CNAME target from Step 1 (frontend Railway target)
- **TTL**: 1 hour

### Railway verification TXT
- **Type**: `TXT`
- **Name**: `_railway-verify` (or the exact name Railway showed you, e.g. `_railway-verify.*`)
- **Value**: the verification token from Step 1
- **TTL**: 1 hour

### Bare root (optional, if you added it in Railway)
- **Type**: `A` (root domains can't use CNAME on GoDaddy standard DNS — use A + Railway IP OR use ALIAS/ANAME if supported)
- **Name**: `@`
- **Value**: Railway will show the IP or ALIAS target
- **TTL**: 1 hour

### For wildcard SSL — DNS-01 challenge
Railway will show you a special `_acme-challenge` TXT record. Add it:
- **Type**: `TXT`
- **Name**: `_acme-challenge`
- **Value**: whatever Railway shows
- **TTL**: 1 hour

⚠️ Wildcard SSL certs require the DNS-01 challenge (regular subdomains use HTTP-01, but `*` can't use HTTP-01). Railway handles the challenge automatically once the TXT record is in place.

---

## Step 3 — Add env vars in Railway (backend + frontend)

### Backend (`accountingapp` service)
Add these variables:
```
PRIVATE_LABEL_ROOT=accountingapp.ai
PRIMARY_HOST=app.smartbookssoftware.ai
```
Save → backend auto-restarts.

### Backend CORS_ORIGINS
Update to include the platform + private-label root:
```
CORS_ORIGINS=https://app.smartbookssoftware.ai,https://accountingapp.ai
CORS_ORIGIN_REGEX=^https://[a-z0-9-]+\.accountingapp\.ai$
```

I've already wired `server.py` to read `CORS_ORIGIN_REGEX` from env. That regex matches any single-label subdomain of `accountingapp.ai`, so all firm sign-in URLs will pass CORS without you having to list them individually.

### Frontend (`lucid-possibility` service)
No frontend env change needed — the frontend calls `/api/branding/by-host` at runtime with `window.location.hostname` and the backend does all the mapping.

---

## Step 4 — Verify in Railway

Wait 5-20 min for:
- DNS propagation (`*.accountingapp.ai` resolves)
- Railway wildcard SSL provisioning

Both statuses should turn ✅ green in the Networking panel.

---

## Step 5 — Test end-to-end

1. Sign in as `pro@axiom.ai` at `app.smartbookssoftware.ai`.
2. Enterprise Settings → Sign-in address → enter `acme` → Save (see live "Available" indicator).
3. Open `https://acme.accountingapp.ai` in incognito.
4. You should see:
   - Firm's own logo + firm name (no SmartBooks branding)
   - Sign-in form functional
   - Login as `client@axiom.ai` → dashboard

## Step 6 — Test the neutral fallback

1. Open `https://xyz-unclaimed-firm.accountingapp.ai` (any label not registered)
2. Should show: form only, no SmartBooks marketing, no firm logo — the "neutral" mode

---

## Optional: fine-tune

- **Reserved labels**: edit `backend/subdomain_util.py` → `RESERVED` set
- **Subdomain format rules**: edit `_SUBDOMAIN_RE` in same file
- **Change default private-label root** in a future rebrand: just change `PRIVATE_LABEL_ROOT` env var — no code deploy
