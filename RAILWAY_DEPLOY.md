# Railway Deployment Guide

Full-stack deployment (React + FastAPI + MongoDB) for **soleproject/accountingapp**.

Follow the steps in order. Total time: ~30 minutes.

---

## Step 1 — Create the Railway project

1. Go to <https://railway.com/new>.
2. Click **GitHub Repository**.
3. Authorize Railway to access `soleproject/accountingapp` (grant repo access if prompted).
4. Select `soleproject/accountingapp`.
5. Railway will create an empty project. **Do not deploy yet** — we need to add services one at a time.

---

## Step 2 — Add the MongoDB service

1. In your Railway project, click **+ New** → **Database** → **Add MongoDB**.
2. Wait ~30 seconds for it to provision.
3. Click the new MongoDB service → **Variables** tab → **copy** the value of `MONGO_URL` (looks like `mongodb://mongo:password@mongodb.railway.internal:27017`).
4. Keep this value — you'll paste it into the backend service in Step 3.

---

## Step 3 — Add the backend service

1. Click **+ New** → **GitHub Repo** → select `soleproject/accountingapp`.
2. In the new service's **Settings** tab:
   - **Root Directory**: `backend`
   - **Build**: leave as Nixpacks (auto-detected)
   - **Start Command**: leave blank — `railway.json` provides it.
3. Go to the **Variables** tab and paste in **all** of these (adjust the values marked ⚠️):

   ```
   MONGO_URL=<paste from Step 2>
   DB_NAME=axiom_prod
   CORS_ORIGINS=*
   JWT_SECRET=<generate a NEW random 32+ char string — do NOT reuse the dev one>

   # LLM provider (start with GPT-4o-mini, swap later by changing LLM_MODEL)
   LLM_PROVIDER=openai
   LLM_MODEL=gpt-4o-mini
   LLM_MODEL_FAST=gpt-4o-mini
   OPENAI_API_KEY=<your key>

   # Plaid — production keys (from current .env)
   PLAID_CLIENT_ID=<from Emergent .env>
   PLAID_SECRET=<from Emergent .env>
   PLAID_ENV=production
   PLAID_SECRET_SANDBOX=<from Emergent .env>

   # Veryfi — OCR (from current .env)
   VERYFI_CLIENT_ID=<from Emergent .env>
   VERYFI_CLIENT_SECRET=<from Emergent .env>
   VERYFI_USERNAME=<from Emergent .env>
   VERYFI_API_KEY=<from Emergent .env>

   # Email
   RESEND_API_KEY=<from Emergent .env>
   RESEND_FROM=Axiom Ledger <no-reply@accountingapp.ai>

   # Public URL — SET THIS AFTER your backend gets its Railway URL (Step 4).
   PUBLIC_BACKEND_URL=https://<will-fill-in-step-4>.up.railway.app
   ```

4. Click **Deploy**.
5. Wait ~2-3 minutes. Watch the **Deployments** tab for a green ✔.

⚠️ **Redis / Caching**: Your dev `.env` has `REDIS_URL`, but the app uses in-memory fallback when Redis isn't set. Skip Redis on Railway for the first launch — add later if you want persistent caching.

---

## Step 4 — Generate a public URL for the backend

1. Click the backend service → **Settings** → **Networking** → **Generate Domain**.
2. Copy the resulting URL, e.g. `accountingapp-backend-production.up.railway.app`.
3. Go back to the **Variables** tab of the backend and update:
   ```
   PUBLIC_BACKEND_URL=https://accountingapp-backend-production.up.railway.app
   ```
4. Railway will auto-redeploy.

---

## Step 5 — Add the frontend service

1. Click **+ New** → **GitHub Repo** → `soleproject/accountingapp` again.
2. Rename it "frontend".
3. In **Settings**:
   - **Root Directory**: `frontend`
   - **Build & Start**: auto-detected via `railway.json` / `nixpacks.toml`.
4. In **Variables**:
   ```
   REACT_APP_BACKEND_URL=https://accountingapp-backend-production.up.railway.app
   NODE_VERSION=20
   CI=false
   ```
   ⚠️ Replace with the **actual backend URL from Step 4**. This must be set **before** the frontend build runs because Create-React-App inlines it at build time.
5. Click **Deploy**.
6. When it succeeds, generate a public domain: **Settings → Networking → Generate Domain**.

---

## Step 6 — Seed the database

Your Railway MongoDB is empty. Two options:

### Option A — Fresh DB (recommended for prod)
Sign up as a new user via the app — the first user becomes an admin. Skip if you're OK starting from zero.

### Option B — Copy data from Emergent MongoDB
Use `mongodump` from the Emergent pod and `mongorestore` into Railway:
```bash
# In Emergent shell:
mongodump --uri "$MONGO_URL" --db test_database --out /tmp/dump

# Locally, install mongo tools, then:
mongorestore --uri "<Railway MONGO_URL>" --nsFrom "test_database.*" --nsTo "axiom_prod.*" /tmp/dump
```

---

## Step 7 — Point your custom domain at Railway

1. In the **frontend** service → **Settings → Networking → Custom Domain**.
2. Enter your domain (e.g. `app.yourbrand.com`).
3. Railway shows you a CNAME target — add it to your DNS registrar.
4. Auto-SSL provisions in ~2-5 minutes.

---

## Step 8 — Verify

- Open the frontend Railway URL.
- Sign in with a test account.
- Confirm: chat responses stream, transactions categorize, Plaid Link opens, Resend emails send.

---

## Rollback / Debug

- **Backend fails to boot**: check **Deployments → Logs**. Common causes: missing env var (compare to Step 3 list), Mongo URL typo.
- **AI returns errors**: verify `OPENAI_API_KEY` and confirm your OpenAI account has credit.
- **CORS errors**: set `CORS_ORIGINS=https://your-frontend.up.railway.app` (comma-separated for multiple).
- **Frontend calls localhost**: `REACT_APP_BACKEND_URL` wasn't set BEFORE the build. Edit the var, then Railway → **Deployments → Redeploy**.

---

## Post-launch cleanup

Once Railway is stable, you can turn off the Emergent deployment:
1. Emergent project → **Publishing → Turn off** (keeps preview running for dev).
2. Update your domain DNS to point at Railway only.
