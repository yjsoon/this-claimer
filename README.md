# This Claimer

Expense claim management system with HowMuch/YNAB integration and Cloudflare R2 storage. (Formerly "Claim Manager" and `ynab-claimer`.)

## Features

- **Receipt Upload**: Drag-and-drop web interface for uploading receipts
- **Receipt-Claim Linking**: Pre-link receipts to financial transactions in the web UI for faster processing, including claim-first multi-select linking
- **AI Amount + Date Tagging**: Gemini auto-tags receipt totals and receipt dates for pending receipts
- **AI Vendor + Purpose Label**: Gemini adds best-effort vendor and short purpose labels for faster scanning
- **USD Matching Assist**: For USD receipts, the app shows approximate SGD values at day rate and day rate + 3.25%
- **Smart Match Highlighting**: During linking, the UI highlights exact and near matches by amount and date
- **Switchable Financial Backend**: View pending claims from HowMuch by default, with YNAB available from the Backend selector
- **Volopay Automation**: Playwright script auto-fills Volopay claim forms
- **Xero Claim Bills**: The Invoices tab generates monthly DRAFT bills (GST / non-GST / transport) from ready-to-claim items, attaches the receipts, and marks linked claims CLAIMED in the selected backend
- **Password Protection**: Simple auth gate for the web app and API
- **iOS Shortcut**: Upload receipts directly from the Share Sheet
- **Claude Code Skill**: Interactive claim processing via `/claims` command

## Components

### 1. Receipt Upload App (`upload-app/`)

Web app for uploading receipts and viewing pending HowMuch or YNAB claims.

**Stack**: Cloudflare Workers + R2

**Endpoints**:
- `POST /upload` - Upload receipt file
- `GET /list` - List pending receipts (includes link metadata)
- `GET /ynab/todos?backend=howmuch|ynab` - Fetch pending claims (HowMuch is the default)
- `GET /receipt/:key` - Download receipt
- `DELETE /receipt/:key` - Delete receipt
- `PATCH /receipt/:key/link` - Link receipt to a transaction
- `PATCH /receipt/:key/receipt-date` - Set/clear manual receipt date override (`YYYY-MM-DD`)
- `POST /receipt/:key/tag-amount` - Run Gemini amount tagging for one receipt
- `POST /amount-tags/pending?limit=3` - Tag a batch of pending receipts
- `GET /agent/unclaimed-expenditures?backend=howmuch|ynab` - Agent report of TODO claims without linked receipts (HowMuch is the default)
- `POST /xero/connect` · `GET /xero/callback` · `GET /xero/status` · `POST /xero/disconnect` · `GET /xero/meta` · `POST /xero/invoices/push` - Xero integration for the Invoices tab (see below)

`GET /agent/unclaimed-expenditures` accepts an optional `since_date=YYYY-MM-DD` query param and returns:
- `summary` - counts for TODO claims, missing receipt claims, linked claims, and unlinked receipts
- `missingReceiptClaims` - TODO expenditures with no linked uploaded receipt, including Gmail search hints
- `linkedClaims` - TODO claims that already have linked receipt metadata
- `unlinkedReceipts` - uploaded receipts that are not linked to any claim

All endpoints require `X-Auth-Token` header.

### 2. Volopay Automation (`scripts/`)

Playwright script to auto-fill Volopay expense claim forms.

```bash
cd scripts
npm install
npm run submit -- claim.json
```

The script fills all form fields and pauses for review before submit. If a dropdown option isn't found, it shows an alert and pauses for manual selection.

### 3. Claude Code Skill (`/claims`)

Interactive claim processing workflow run via Claude Code.

### 4. Xero Invoices (Invoices tab)

A full-width **Invoices** tab in the web app assembles ready-to-claim items into
monthly DRAFT bills in Xero, replacing Volopay. Items split into GST / non-GST /
transport (line items grouped by account, sorted by date); each line's account,
GST flag and remark are editable. **Push to Xero (draft)** creates the bill (payee
"Soon Yin Jie", tax-inclusive), attaches the receipts (merging into combined PDFs
when over Xero's 3 MB / 10-attachment caps), then presents a separate **Mark
checked as claimed** action. That action tags the receipts and flips linked
`TODO:` memos to `CLAIMED:` in their originating backend; creating the draft
alone does not change claim memos.

The worker talks to Xero over raw `fetch` (OAuth 2.0; rotating refresh token in the
`XERO_TOKENS` KV namespace). Setup and usage: `.claude/skills/claim-invoices/SKILL.md`.

## Setup

### Prerequisites

- Cloudflare account (free tier)
- YNAB account with API access
- Node.js 18+

### 1. Configure Environment

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

### 2. Configure Worker Secrets

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

### 3. Deploy Upload App

```bash
cd upload-app
npm install

# Create R2 bucket (one-time)
npx wrangler r2 bucket create receipts

# Deploy
npm run deploy
```

### 4. Custom Domain (Optional)

To use a custom domain, add to `wrangler.toml`:

```toml
routes = [
  { pattern = "receipts.yourdomain.com/*", zone_name = "yourdomain.com" }
]
```

Then add a DNS record in Cloudflare: `AAAA` record, name: `receipts`, content: `100::`, proxied.

### 5. Use

1. **Visit the web app**: Enter your password to authenticate
2. **Upload receipts**: Drag and drop or tap to upload
3. **View pending claims**: HowMuch transactions with `TODO:` memos appear automatically; use the Backend selector to switch to YNAB
4. **Process claims**: Run `/claims` in Claude Code to match receipts to transactions

Receipts can also be marked ready without a visible TODO claim. Click the receipt link button, then choose **Mark ready** without selecting a claim. These receipts move under **Ready to Claim** alongside ordinary linked claim-receipt pairs.

### 6. Xero Invoices (Optional)

To enable the Invoices tab (Xero draft bills), do this once:

1. In the Xero developer portal, add `https://receipts.soon.sg/xero/callback` as a
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

### Auto-Link Clear Matches

For obvious one-to-one matches, run the local helper from `scripts/`:

```bash
npm run link:matches
```

This is a dry run by default. It only proposes matches where one unlinked receipt maps to one unlinked YNAB TODO claim by receipt date and amount. To write the links:

```bash
npm run link:matches -- --apply
```

Optional flags:

- `--since-date YYYY-MM-DD` - fetch TODO claims from a specific date
- `--near-days N` - allow receipt dates within N days; default is exact date only
- `--allow-upload-date` - use upload date when no manual or AI receipt date exists

## Workflow

```
Mobile/Desktop                    YNAB
     │                              │
     │ Upload receipts              │ Mark with TODO:
     ▼                              ▼
┌─────────┐                   ┌──────────┐
│   R2    │◄──── /claims ────►│  YNAB    │
│ Storage │     (Claude)      │   API    │
└─────────┘                   └──────────┘
     │                              │
     │ Delete when done             │ Update to CLAIMED:
     ▼                              ▼
  Cleaned up                   Marked complete
```

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

## Agent access and WebMCP

The frontend progressively enhances compatible browsers with three read-only
WebMCP tools: `list_receipts`, `list_pending_claims`, and `get_xero_status`.
They use the signed-in browser session and existing authenticated GET endpoints;
they do not expose credentials, start vision tagging, or submit financial actions.
The public [`llms.txt`](upload-app/src/llms.txt) guide documents pagination,
backend ownership, amount units, GST evidence, and the human-review workflow.
Ordinary browser automation remains available without WebMCP.

WebMCP is experimental, not a remote MCP server. The implementation detects both
`document.modelContext` (current API) and `navigator.modelContext` (older builds).
See [Chrome's setup instructions](https://developer.chrome.com/docs/ai/webmcp)
for compatible browser versions, the local development flag, and origin-trial
enrollment. No origin-trial token is bundled; enabling it on a production origin
is a separate deployment/configuration step. Tools are not exposed cross-origin.

Run `npm run smoke:frontend` in `upload-app/` to test both registration interfaces,
tool execution with mocked authenticated APIs, failure handling, read-only
requests, accessible control labels, and the existing non-WebMCP workflows.
The harness verifies the app contract, not a particular browser agent's integration.

With a WebMCP-capable `agent-browser`, open the app and let the user sign in,
then use `agent-browser webmcp list` to discover tools and, for example,
`agent-browser webmcp invoke list_receipts --params '{"limit":20}'` to read a page.
Native discovery, logged-out rejection and a mocked receipt read were also
verified with Chrome 153 using experimental web-platform features.
