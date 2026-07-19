# StockKaki backend — Phase 1 setup (email ex-date alerts)

Architecture: static site (GitHub Pages) + **Supabase** (subscriber DB + signup function) + **Resend** (email) + the daily **GitHub Action** sends the weekly digest. No hosting migration.

Do these once. Steps 1–2 you can do now; I wire the frontend once you send me the two **public** values in step 1.

---

## 1. Supabase — database + function

1. In your StockKaki Supabase project → **SQL Editor** → paste and run `backend/schema.sql`.
2. **Project Settings → API** — copy these and send me the two public ones:
   - **Project URL** (`https://xxxx.supabase.co`) — *public, send me*
   - **anon public key** — *public, send me*
   - **service_role key** — **SECRET**, keep it; goes in GitHub (step 3).
3. Deploy the signup function (needs the Supabase CLI you already use):
   ```
   supabase functions deploy subscribe --no-verify-jwt --project-ref <your-ref>
   supabase secrets set RESEND_API_KEY=re_xxx --project-ref <your-ref>
   ```
   (`backend/functions/subscribe/index.ts` is the function.)

## 2. Resend — email sending

1. In Resend → **Domains → Add** `stockkaki.com`, and add the **SPF/DKIM DNS records** it shows at your domain registrar (same place you added the GitHub Pages A-records). Wait for it to go **Verified** (needed so emails don't land in spam).
2. **API Keys → Create** — copy the key (`re_...`). Used in the Supabase secret above **and** GitHub (step 3).
3. Sender address is `alerts@stockkaki.com` (from a verified domain — no inbox needed to send).

## 3. GitHub — secrets for the weekly digest

Repo → **Settings → Secrets and variables → Actions → New repository secret**, add all three:

| Name | Value |
|---|---|
| `SUPABASE_URL` | your project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | the service_role key (secret) |
| `RESEND_API_KEY` | the Resend key |

The daily Action runs `send-alerts.mjs` after the build; it emails the digest **only on Mondays (SGT)** and no-ops safely if these aren't set yet.

---

## Flow
- Visitor enters email on the site → calls the `subscribe` function → gets a **confirm email** (double opt-in, for deliverability + PDPA).
- They click confirm → `/confirm/?t=…` marks them confirmed.
- Every Monday the Action emails confirmed subscribers the week's upcoming ex-dates, with a working **unsubscribe** link (`/unsubscribe/?t=…`).

## Phase 2 (later)
Accounts (Supabase Auth) + per-user watchlist + personalised, timely per-stock alerts.
