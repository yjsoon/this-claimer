# Setup

How to deploy This Claimer's web app (a Cloudflare Worker with R2 storage) and connect its optional integrations.

## Prerequisites

- Cloudflare account (free tier)
- YNAB account with API access
- Node.js 18+

## 1. Configure Environment

```bash
cp .env.example .env
# Edit .env with your values
```

Required values:
- `HOWMUCH_PAT` - Personal access token created by a HowMuch owner/editor (viewer tokens cannot mark claims)
- `HOWMUCH_PLAN_ID` - HowMuch plan ID (may be omitted when it is the same as `YNAB_BUDGET_ID`)
- `YNAB_API_KEY` / `YNAB_BUDGET_ID` - Optional fallback backend credentials
- `GEMINI_API_KEY` - Gemini API key for AI amount tagging
- `R2_WORKER_URL` - Your deployed worker URL (e.g. `https://receipts.yourdomain.com`)
- `R2_PASSWORD` - Same as AUTH_PASSWORD you set in worker secrets

## 2. Configure Worker Secrets

Set the Worker secrets before deploying so the default HowMuch backend is ready
when the new version becomes active:

```bash
cd upload-app

# Set your chosen password for the web app
wrangler secret put AUTH_PASSWORD

# Set HowMuch credentials (the default claims backend)
wrangler secret put HOWMUCH_PAT
wrangler secret put HOWMUCH_PLAN_ID

# Optional YNAB fallback credentials
wrangler secret put YNAB_API_KEY
wrangler secret put YNAB_BUDGET_ID

# Optional but recommended: enable AI amount tagging
wrangler secret put GEMINI_API_KEY
# Optional model override (defaults to gemini-3-flash-preview)
wrangler secret put GEMINI_MODEL
```

## 3. Deploy Upload App

```bash
cd upload-app
npm install

# Create R2 bucket (one-time)
npx wrangler r2 bucket create receipts

# Deploy
npm run deploy
```

## 4. Custom Domain (Optional)

To use a custom domain, replace the existing `routes` entry in `wrangler.toml`:

```toml
routes = [
  { pattern = "receipts.yourdomain.com/*", zone_name = "yourdomain.com" }
]
```

Then add a DNS record in Cloudflare: `AAAA` record, name: `receipts`, content: `100::`, proxied.

## Cloudflare Access

Recommended once the app is live. Cloudflare Access puts a sign-in page in front of
the whole hostname, so nothing (pages, API, receipts) loads until you sign in. The
app password still applies after that. The free Zero Trust plan covers this.

1. In the Cloudflare dashboard, open **Zero Trust**. The first time, pick a team
   name (this gives you `<team>.cloudflareaccess.com`) and the Free plan.
2. **Settings → Authentication → Login methods**: One-time PIN (an emailed code)
   is there by default. Add **Google** if you'd rather sign in with your Google
   account.
3. **Access → Service auth → Service tokens → Create service token**, named e.g.
   `claimer-clients`, duration "Non-expiring" or a year. Copy the Client ID and
   Client Secret now; the secret is shown only once. The `scripts/` CLIs and the
   iOS Shortcut use it.
4. **Access → Applications → Add an application → Self-hosted**:
   - Name: This Claimer. Domain: `receipts.yourdomain.com`, no path, so every
     route is covered (including `/xero/callback` and `/gmail/callback`, which
     arrive from your signed-in browser).
   - Session duration: whatever you're comfortable with, e.g. 1 month.
   - Policy 1, action **Allow**: Include → Emails → your email address.
   - Policy 2, action **Service Auth**: Include → Service Token → `claimer-clients`.
   - Save. From this point the hostname asks you to sign in.
5. Open the application again and copy its **Application Audience (AUD) Tag**.
   Put it and your team domain in `upload-app/wrangler.toml`, then deploy:
   ```toml
   ACCESS_TEAM_DOMAIN = "<team>.cloudflareaccess.com"
   ACCESS_AUD = "<aud tag>"
   ```
   With both set, the Worker itself rejects any request that didn't come through
   Access (`worker/access.ts`), so a route Access doesn't cover can't be used to
   skip the sign-in. `workers_dev = false` in `wrangler.toml` keeps the
   `*.workers.dev` address off for the same reason.
6. Add the service token to the repo-root `.env` as `CF_ACCESS_CLIENT_ID` and
   `CF_ACCESS_CLIENT_SECRET`, and to the iOS Shortcut (below). For ad hoc curl
   calls add `-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H
   "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"`.

The scheduled Gmail scan runs inside the Worker and isn't affected. Wrong
passwords are limited to 10 a minute per IP, after which that IP is locked out
for five minutes even with the right password (`[[ratelimits]]` in `wrangler.toml`)
whether or not Access is on.

To undo: clear `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`, deploy, then delete the Access
application.

## Xero invoices (optional)

To enable the Invoices tab (Xero draft bills), do this once:

1. In the Xero developer portal, add `https://receipts.yourdomain.com/xero/callback` as a
   redirect URI on your existing Xero app.
2. Create the token KV namespace and paste its id into `wrangler.toml`:
   ```bash
   cd upload-app
   npx wrangler kv namespace create XERO_TOKENS
   ```
3. Set the Xero secrets, then redeploy:
   ```bash
   wrangler secret put XERO_CLIENT_ID
   wrangler secret put XERO_CLIENT_SECRET
   npm run deploy
   ```
4. Open the **Invoices** tab and click **Connect Xero** to authorise once.

Details and tax/account rules: `.claude/skills/claim-invoices/SKILL.md`.

## Gmail receipt import (optional)

See the "Gmail Receipt Import" section of [AGENTS.md](../AGENTS.md) for the Google Cloud OAuth setup and the cron schedule.

## iOS Shortcut

Create an Apple Shortcut to upload receipts directly from the Share Sheet:

1. Open **Shortcuts** app → tap **+** to create new shortcut
2. Dismiss the action picker popup
3. Tap **ⓘ** at the bottom middle → enable **Show in Share Sheet** → under "Receive", select **Images**, **PDFs**, and **Files**
4. Tap **Done**, then add the **Get Contents of URL** action:
   - URL: `https://your-domain.com/upload` (your worker URL or custom domain)
   - Show More → Method: **POST**
   - Headers → Add new field:
      - Key: `X-Auth-Token`
      - Value: your password (same as AUTH_PASSWORD secret)
   - If the app is behind [Cloudflare Access](#cloudflare-access), add two more headers:
      - `CF-Access-Client-Id`: the service token's Client ID
      - `CF-Access-Client-Secret`: the service token's Client Secret
   - Request Body: **Form**
   - Add new field → choose **File** type:
      - Key: `file`
      - Value: tap and choose **Shortcut Input**
5. Add **Show Notification** action: `Receipt uploaded`
6. Rename shortcut to "Upload Receipt"

Now share any receipt image/PDF → choose **Upload Receipt** from the share sheet.

