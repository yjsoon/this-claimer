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

To use a custom domain, add to `wrangler.toml`:

```toml
routes = [
  { pattern = "receipts.yourdomain.com/*", zone_name = "yourdomain.com" }
]
```

Then add a DNS record in Cloudflare: `AAAA` record, name: `receipts`, content: `100::`, proxied.

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
   - Request Body: **Form**
   - Add new field → choose **File** type:
      - Key: `file`
      - Value: tap and choose **Shortcut Input**
5. Add **Show Notification** action: `Receipt uploaded`
6. Rename shortcut to "Upload Receipt"

Now share any receipt image/PDF → choose **Upload Receipt** from the share sheet.

