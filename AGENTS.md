# Agent Instructions

Guidelines for AI agents working on This Claimer (repo formerly `ynab-claimer`).

## Sensitive Data

**DO NOT commit or expose:**
- Actual Cloudflare Worker URLs (use `https://receipts.yourdomain.com` as placeholder)
- YNAB API keys or budget IDs
- Any values from `.env`

The `.env` file contains secrets. When writing documentation or examples, always use placeholders.

## Project Structure

- `upload-app/` - Cloudflare Worker for receipt uploads
- `docs/` - Human docs (setup, usage, worker API, WebMCP); README.md stays short and links here
- `scripts/` - Local automation scripts for Volopay and Gmail receipt export
- `.claude/skills/claims/SKILL.md` - Claude Code skill for processing claims
- `.claude/skills/ride-gmail-receipts/SKILL.md` - Skill for exporting Grab and Gojek ride receipts from Gmail using `gog`
- `.claude/skills/claim-invoices/SKILL.md` - Skill for generating Xero draft bills from ready-to-claim items (Invoices tab)
- `.agents/skills/ride-gmail-receipts/SKILL.md` - Agent mirror of the ride Gmail receipt export skill
- `.agents/skills/claim-invoices/SKILL.md` - Agent mirror of the claim-invoices skill
- `upload-app/worker/xero.ts` - Xero OAuth + bill creation/attachment for the Invoices tab
- `upload-app/worker/gmail.ts` - Gmail OAuth (multiple accounts) + scheduled receipt import
- `upload-app/worker/access.ts` - Cloudflare Access JWT verification and constant-time password check
- `upload-app/worker/ai.ts` - AI keys/settings stored from the app, Claude receipt reading and Claude-assisted matching
- `.env` - Local config (gitignored)
- `.env.example` - Template with placeholders (safe to commit)

## Configuration

Local config lives in `.env` (gitignored); `.env.example` is the committed template. Required variables:

- `YNAB_API_KEY` — from https://app.ynab.com/settings/developer
- `YNAB_BUDGET_ID` — from the YNAB URL when viewing the budget
- `GEMINI_API_KEY` — for receipt amount tagging
- `GEMINI_MODEL` — optional override (worker default: `gemini-3-flash-preview`)
- `ANTHROPIC_API_KEY` — optional, for Claude receipt reading and Claude-assisted matching (can be set under Settings > AI in the app instead)
- `R2_WORKER_URL` — deployed receipt-upload worker URL
- `R2_PASSWORD` — receipt worker auth token (must match the worker's `AUTH_PASSWORD` secret)
- `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` — Cloudflare Access service token, once the worker is behind Access
- `VOLOPAY_URL` — your company's Volopay subdomain

## Claims Processing

The claims skill at `.claude/skills/claims/SKILL.md` handles matching YNAB transactions with uploaded receipts.

Before doing manual claim/receipt matching, run the auto-link helper from `scripts/`:

```bash
cd scripts
npm run link:matches
```

This is a dry run. Always show the full dry-run output to the user for verification before applying anything, including each clear match itemised one by one. If it reports clear one-to-one matches and the user confirms they should be marked as done, apply them with:

```bash
npm run link:matches -- --apply
```

The helper only writes receipt link metadata through `PATCH /receipt/:key/link`; it does not delete receipts, update YNAB memos, or submit Volopay claims. Default matching is intentionally conservative: exact receipt date plus amount within 1 cent, with ambiguous candidates skipped. Do not apply `--near-days` or `--allow-upload-date` unless the user explicitly asks for looser matching. Always report ambiguous skipped candidates back to the user and ask which receipt, if any, should be linked.

The web UI section formerly called "Already Linked" is "Ready to Claim". It includes normal claim-receipt links and receipts the user has explicitly marked ready even when no matching YNAB TODO claim is visible. Ready-only receipts use synthetic link IDs prefixed with `receipt-ready:`. Treat those as intentional ready markers, not broken YNAB links.

The claims skill auto-invokes when the user mentions claims, expenses, reimbursements, receipts, or YNAB TODOs.

## YNAB Memo Convention

- `TODO: <description>` — pending claim
- `CLAIMED: <description>` — processed claim

## Volopay Claim Submission

Submit a single claim to Volopay with the Playwright automation in `scripts/`:

```bash
cd scripts
npm run submit -- claim.json
```

`volopay-submit.ts` reads the claim JSON from the file argument (or stdin), logs into Volopay (using `VOLOPAY_URL`), fills the Create-claim form, then **pauses for manual review** — you click Continue and close the browser to finish. It never auto-submits.

The claim JSON requires these fields: `merchant`, `amount`, `date`, `memo`, `xeroCategory`, `xeroTaxCode`, `receiptPath`. Use the rules below to fill `xeroTaxCode` and `xeroCategory`.

### Tax Code Rules (CRITICAL)

**Only use `INPUTY24` when the receipt shows an explicit GST line item. Never assume GST.**

| Condition | Tax Code |
| :---- | :---- |
| Receipt shows a GST amount | `INPUTY24:Standard-Rated Purchases` |
| No GST + foreign currency | `OPINPUT:Out Of Scope Purchases` |
| No GST + SGD | `NRINPUT:Purchases from Non-GST Registered Suppliers` |

### Category Mappings

**Volopay**: Software, Equipment & hardware, Entertainment

**Xero**:
- Software → Computer Software (463)
- IMDA VIBE / "for class" → Cost of Sales (320)
- Hardware → Computer Hardware & Accessories (464)

## Invoices (Xero Claim Bills)

An alternative to Volopay: the receipts.soon.sg **Invoices** tab turns ready-to-claim
items into monthly DRAFT bills in Xero (payee "Soon Yin Jie"), split into GST /
non-GST / transport, with receipts attached. After a push, receipts are tagged
`xeroInvoiceId` (so they drop off the tab) and the linked YNAB `TODO:` memos become
`CLAIMED:`.

- Worker: `upload-app/worker/xero.ts` (OAuth 2.0 over raw fetch, refresh-token
  rotation in the `XERO_TOKENS` KV namespace, bill creation + attachments) and the
  `/xero/*` routes in `upload-app/worker/index.ts`.
- UI: `upload-app/src/{index.html,main.js,style.css}` (the Invoices tab + editor).
- Config: `wrangler.toml` (`XERO_TOKENS` KV + `XERO_SCOPES` / `XERO_INPUT_TAXTYPE`
  vars); secrets `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` (same Xero app as the local
  `xero/` project). Local secrets template: `upload-app/.dev.vars.example`.

Account/tax-code rules match the Volopay section above (amounts are tax-inclusive
SGD; `INPUTY24` only when the receipt shows explicit GST). Xero attachment caps
(3 MB/file, 10/bill) are handled by merging receipts into chunked combined PDFs;
HEIC/WEBP can't be embedded and are flagged for manual upload. Full setup and usage:
`.claude/skills/claim-invoices/SKILL.md`. Do not deploy to the live worker without
the user's go-ahead.

Manual invoice overrides are shared through `GET|PATCH /receipt/:key/invoice-edits`
and returned on `/list` as `invoiceEdits`. Use the exact revision from GET for
PATCH; a 409 requires deliberate conflict resolution, not a blind retry. These
overrides are separate from AI `taggedGst*` findings. For YJ's Foodpanda
platform-fee-only GST exception, set the line to `section: "nongst"`,
`gstShown: false`, `taxType: "NRINPUT"`; do not falsify the AI's printed GST
finding. See [agent API usage](docs/api.md#shared-invoice-line-overrides-agents-and-browsers)
and [legacy browser edit migration](docs/usage.md#xero-invoices). Never mutate live
receipt overrides just to verify an implementation.

### Vision Tagging (Amounts + GST Detection)

Receipt vision tagging (amount/date/vendor/purpose extraction and GST
detection) is provider-switched across three providers:

- MiniMax coding-plan VLM (`MINIMAX_API_KEY`, an `sk-cp-` key; covered by the
  coding-plan subscription): image receipts only.
- Claude via the Anthropic API (`ANTHROPIC_API_KEY`, `sk-ant-`): images and
  PDFs, through `@anthropic-ai/sdk` with structured JSON output. Model from
  `CLAUDE_MODEL` (default `claude-opus-5-5`).
- Gemini (`GEMINI_API_KEY`): everything, including HEIC.

`VISION_PROVIDER` in `wrangler.toml` (`minimax` | `anthropic` | `gemini`) picks
which is tried first; every other provider with a key that can read the file
type is a fallback, in the order MiniMax, Claude, Gemini.

### AI settings (keys in the app)

The **AI** section of the Settings dialog (gear in the header; `src/ai.js`,
`worker/ai.ts`) holds the provider keys. Keys pasted there are checked against the provider (Anthropic
and Gemini), stored in KV (`APP_SETTINGS` binding, key `ai_settings`, same
namespace as Xero/Gmail) and never returned to the browser; the UI only sees
whether a key is set and its last four characters. A key saved in the app wins
over the matching Worker secret, and removing it falls back to the secret. The
section also sets the first receipt-reading provider and the Claude model, which
override `VISION_PROVIDER` / `CLAUDE_MODEL`. Routes: `GET|PUT /ai/settings`.

With a Claude key set, **Find matches** runs the exact rules and then sends the
outstanding claims and unlinked receipts the rules didn't clearly pair to
Claude (`POST /ai/match`, capped at 150 claims / 250 receipts). Claude's pairs
show in Match review with a "Claude" chip and its reason. Nothing is linked
until the user accepts a suggestion; Claude's pick replaces an ambiguous rule
suggestion for the same claim but never a clear one. Without a Claude key, or
if the call fails, Find matches shows the exact matches only.

The GST checkbox on each invoice line defaults from the AI verdict stored on
the receipt (`taggedGstShown` / `taggedGstAmount` / `taggedGstSource` metadata;
the checkbox remains the manual override):

- New uploads are tagged automatically alongside amount tagging. Backfill via
  the **Detect GST** button on the Invoices tab, or
  `POST /gst-tags/pending?limit=8` (loop until `remaining` is 0); re-run one
  receipt with `POST /receipt/:key/tag-gst`.
- The verdict is strictly "an explicit GST line is printed on the receipt" —
  never inferred from vendor or total. Note a USD receipt can legitimately show
  SG GST (overseas-vendor-registration suppliers like Fireworks AI).

## Gmail Receipt Import (automatic)

The worker can link one or more Gmail accounts (read-only) and import receipts
into R2 on its own: a cron (`[triggers]` in `wrangler.toml`, every four hours)
plus a **Scan now** button in the Gmail import section of the Settings dialog
(gear icon in the header, `upload-app/src/settings.js`). Setup, linked accounts
and reconnects live there too; the Claims page only shows a quiet "Gmail ·
checked" line on the receipts column and a dismissible notice when an account
needs reconnecting. The gear shows a dot whenever an account needs attention.

- PDF/image attachments on emails matching `DEFAULT_RECEIPT_QUERY` in
  `worker/gmail.ts` (override with the `GMAIL_RECEIPT_QUERY` var). Inline
  images and images under 30 KB are ignored as logos.
- Body-only Grab/Gojek ride receipts are printed to PDF through Cloudflare
  Browser Rendering when the `CF_BROWSER_RENDERING_TOKEN` secret is set
  (same rules as `scripts/export-ride-receipt.ts`; GrabFood excluded).
- Imported receipts carry `source=gmail`, `gmailAccount`, `gmailMessageId`,
  `gmailSubject` metadata and are tagged like manual uploads. Each Gmail
  message is imported at most once (seen ids kept per account in KV).
- Nothing is written to Gmail. First scan looks back
  `GMAIL_INITIAL_LOOKBACK_DAYS` (default 14).
- Setup: Google Cloud project with the Gmail API enabled; OAuth client of type
  Web application with redirect URI `https://receipts.yourdomain.com/gmail/callback`;
  consent screen published to "In production" (in Testing, refresh tokens
  expire after 7 days). The client ID/secret can be pasted into the Gmail
  panel (stored in KV via `PUT /gmail/client`, never returned by the API), or
  set as Worker secrets `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, which win.
- Routes: `POST /gmail/connect`, `GET /gmail/callback`, `GET /gmail/status`,
  `POST /gmail/disconnect`, `POST /gmail/scan`, `PUT|DELETE /gmail/client`.

## Gmail Receipt Export

Use the ride Gmail receipt export skill when the user needs missing Grab or Gojek ride receipts from Gmail. It uses `gog` against `yjsoon@gmail.com`, decodes the receipt HTML, and renders a clean PDF with Playwright:

```bash
cd scripts
npm run export:grab -- --since-last-exported --label-exported --max 20
npm run export:gojek -- --since-last-exported --label-exported --max 20
```

By default, repeat exports should start after the newest provider receipt already labelled `exported`; add `--label-exported` only after a PDF has rendered successfully. GrabFood / Grab Food receipts are ignored unless the user explicitly asks for food claims. Generated PDFs go to `~/Downloads` by default and are named `grab_YYYY-MM-DD_AMOUNT.pdf` or `gojek_YYYY-MM-DD_AMOUNT.pdf`. Do not commit exported receipt PDFs. Use them for the receipt uploader or claim processing flow.

### API Authentication

All receipt worker endpoints require the `X-Auth-Token` header:

```bash
curl -H "X-Auth-Token: $R2_PASSWORD" "https://receipts.yourdomain.com/list"
```

The password is stored in `.env` as `R2_PASSWORD` and must match the worker's `AUTH_PASSWORD` secret.

When the worker sits behind Cloudflare Access (`ACCESS_TEAM_DOMAIN` + `ACCESS_AUD`
in `wrangler.toml`, verified in `worker/access.ts`), non-browser calls also need the
service token headers from `.env`:
`-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"`.
Wrong passwords are rate-limited (10 a minute per IP, then a five-minute 429 lockout for that IP). Setup steps:
`docs/setup.md#cloudflare-access`.

### Gemini Amount Tagging

Receipt amount tagging uses MiniMax coding-plan VLM for image receipts when
`MINIMAX_API_KEY` is set (see "Vision Tagging" below), with Google Gemini
(Worker secret `GEMINI_API_KEY`) as backup and for PDFs/HEIC.

- Default Gemini model: `gemini-3-flash-preview`
- Optional override: Worker secret `GEMINI_MODEL`
- Batch backfill endpoint: `POST /amount-tags/pending?limit=3`
- Manual receipt date override endpoint: `PATCH /receipt/:key/receipt-date`
- Gemini also stores best-effort `taggedVendor` and `taggedPurpose` labels per receipt
- For USD receipts, store SGD approximations:
  - day-rate conversion
  - day-rate conversion plus 3.25%

### Load-time diagnostics

`GET /list` and `GET /ynab/todos` return a `Server-Timing` header (`r2-list`,
`r2-metadata`, `claims-upstream`, in ms). In the browser, Network → pick the
request → Timing shows where a slow page load spent its time; with curl use
`-D -` to print the headers. `r2-metadata` says `inline` when R2 returned
receipt metadata in the listing, or how many `head()` fallbacks were needed.

### Common Pitfalls

1. **Auth header name**: Use `X-Auth-Token`, not `Authorization` or `X-Auth-Password`
2. **Worker URL**: Read from `.env` - don't hardcode; user may have custom domain
3. **YNAB amounts**: In milliunits - divide by 1000 for actual dollars
4. **Transfer duplicates**: Filter for `amount < 0` to avoid counting transfers twice
5. **Gemini model name**: Use `gemini-3-flash-preview` (hyphenated), not dotted/underscored variants

## Cursor Cloud specific instructions

Two npm packages, no root `package.json`: `upload-app/` (Cloudflare Worker + static UI) and `scripts/` (tsx/Playwright CLIs). Run npm commands inside each package. The repo has no `.cursor/environment.json`. Install with `npm ci` in `upload-app/` and in `scripts/`, then `npx playwright install chromium` from `upload-app/` (the browser smokes need it; `scripts/` has its own Playwright for ride-receipt export). `.agents/setup` and `.agents/resume` are Amp orb scripts: they pin Node 20.20.2 and run those installs. Deploy CI uses Node 22 (`.github/workflows/deploy.yml`). Those Amp scripts are not a Cursor Cloud startup hook.

- **Run the app**: `cd upload-app && npm run dev` starts `wrangler dev` on http://localhost:8787. Miniflare emulates R2 (`RECEIPTS`) and KV (`XERO_TOKENS`, `GMAIL_STATE`, `APP_SETTINGS`), so local dev does not need a Cloudflare login. Custom-domain `routes` in `wrangler.toml` are ignored locally; the server binds to localhost. Run the dev server in tmux. Leave `npm run deploy` and `wrangler deploy` for an explicit user request.
- **Local auth**: `wrangler dev` reads gitignored `upload-app/.dev.vars`. Copy `upload-app/.dev.vars.example` and set `AUTH_PASSWORD` to a throwaway value. Send that value as `X-Auth-Token`, or through the web password gate. Keep `.dev.vars` and the repo-root `.env` uncommitted. In docs and examples use placeholders (`https://receipts.yourdomain.com`); do not commit API keys, budget or plan IDs, or a real worker URL.
- **Claims backend**: HowMuch is the default in the web app and on `GET /ynab/todos` when `backend` is omitted. It needs `HOWMUCH_PAT` and a plan id (`HOWMUCH_PLAN_ID`, or `YNAB_BUDGET_ID` when that value is the plan id). Without that config, Outstanding Claims shows `Error: HowMuch backend is not configured (HOWMUCH_PAT and a plan ID are required).` and Ready to Claim shows `Claims unavailable`. Choosing YNAB in the Backend selector without `YNAB_API_KEY` and `YNAB_BUDGET_ID` shows `Error: YNAB backend is not configured.` A failed upstream call shows `Error: HowMuch API error` or `Error: YNAB API error`. Receipt upload, list, and link work with only `AUTH_PASSWORD`. Xero, Gmail import, and vision tagging need their own secrets in `.dev.vars`, or AI keys saved under Settings > AI.
- **Checks** (from `upload-app/`; the same commands `.github/workflows/deploy.yml` runs before a deploy): `npx tsc --noEmit`, `npm run smoke:frontend`, `npm run smoke:worker-claims`, `npm run test:access`, `npm run test:ai`, and `npm run smoke:ai-frontend`. `smoke:frontend` and `smoke:ai-frontend` are Playwright tests against a mocked API. `smoke:worker-claims` starts a local wrangler against a fake HowMuch and passes its own test vars. `test:ai` bundles `worker/ai.ts` with esbuild against an in-memory KV and a fake Anthropic API. There is no ESLint, Biome, or Prettier config; these checks are plain Node scripts. `npm run test:gmail` is a Gmail contract test in the same style and is not part of that workflow.
- **`scripts/` CLIs** (`npm run link:matches`, `submit`, `export:grab`, `export:gojek`) read the gitignored repo-root `.env` and call a reachable worker plus external services, so local `wrangler dev` is not enough to run them end to end. `link:matches` defaults to the YNAB backend; pass `--backend howmuch` to match the web app. That CLI default is separate from the web app's HowMuch default.
