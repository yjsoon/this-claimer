# Agent Instructions

This Claimer (formerly `ynab-claimer`) matches expense claims with uploaded receipts and submits them to Volopay or Xero. Human docs (setup, usage, worker API, WebMCP) are in `docs/`.

## Sensitive data

**Do not commit or expose:**
- Actual Cloudflare Worker URLs (use `https://receipts.yourdomain.com` as placeholder)
- YNAB API keys, budget or plan IDs
- Any values from `.env` or `upload-app/.dev.vars`
- Exported receipt PDFs

In documentation and examples, always use placeholders. `.env.example` documents the local variables.

## Claims processing

The `claims` skill handles matching claims with uploaded receipts. Before manual matching, run the auto-link helper from `scripts/`:

```bash
npm run link:matches
```

This is a dry run. Always show the full dry-run output to the user, itemising each clear match, before applying anything. If the user confirms the clear one-to-one matches should be marked as done, apply them with `npm run link:matches -- --apply`.

The helper only writes receipt link metadata through `PATCH /receipt/:key/link`; it does not delete receipts, update YNAB memos, or submit Volopay claims. Default matching is intentionally conservative: exact receipt date plus amount within 1 cent, with ambiguous candidates skipped. Do not use `--near-days` or `--allow-upload-date` unless the user explicitly asks for looser matching. Always report ambiguous skipped candidates and ask which receipt, if any, should be linked. The CLI defaults to the YNAB backend; pass `--backend howmuch` to match the web app, which defaults to HowMuch.

"Ready to Claim" (formerly "Already Linked") includes receipts the user has explicitly marked ready even when no matching TODO claim is visible. Ready-only receipts use synthetic link IDs prefixed with `receipt-ready:`; treat them as intentional ready markers, not broken links.

YNAB memo convention: `TODO: <description>` is a pending claim; `CLAIMED: <description>` is processed.

## Volopay claim submission

`npm run submit -- claim.json` (from `scripts/`) logs into Volopay, fills the Create-claim form, then **pauses for manual review**; the user clicks Continue and closes the browser. It never auto-submits. The claim JSON requires `merchant`, `amount`, `date`, `memo`, `xeroCategory`, `xeroTaxCode` and `receiptPath`.

### Tax code rules (CRITICAL)

**Only use `INPUTY24` when the receipt shows an explicit GST line item. Never assume GST.**

| Condition | Tax Code |
| :---- | :---- |
| Receipt shows a GST amount | `INPUTY24:Standard-Rated Purchases` |
| No GST + foreign currency | `OPINPUT:Out Of Scope Purchases` |
| No GST + SGD | `NRINPUT:Purchases from Non-GST Registered Suppliers` |

### Category mappings

**Volopay**: Software, Equipment & hardware, Entertainment

**Xero**:
- Software → Computer Software (463)
- IMDA VIBE / "for class" → Cost of Sales (320)
- Hardware → Computer Hardware & Accessories (464)

## Invoices (Xero claim bills)

An alternative to Volopay: the web app's **Invoices** tab turns ready-to-claim items into monthly DRAFT bills in Xero (payee "Soon Yin Jie"), split into GST / non-GST / transport, with receipts attached. After a push, receipts are tagged `xeroInvoiceId` (so they drop off the tab) and the linked `TODO:` memos become `CLAIMED:`. Setup and usage are in the `claim-invoices` skill. Do not deploy to the live worker without the user's go-ahead.

- Account/tax-code rules match the Volopay section (amounts are tax-inclusive SGD). Xero attachment caps (3 MB/file, 10/bill) are handled by merging receipts into chunked combined PDFs; HEIC/WEBP can't be embedded and are flagged for manual upload.
- Manual invoice overrides go through `GET|PATCH /receipt/:key/invoice-edits`. Use the exact revision from GET for PATCH; a 409 requires deliberate conflict resolution, not a blind retry. Overrides are separate from the AI `taggedGst*` findings. For YJ's Foodpanda platform-fee-only GST exception, set the line to `section: "nongst"`, `gstShown: false`, `taxType: "NRINPUT"`; do not falsify the AI's printed GST finding. See `docs/api.md`. Never mutate live receipt overrides just to verify an implementation.

## Receipt tagging

- Vision tagging (amount, date, vendor, purpose, GST) is provider-switched. MiniMax coding-plan VLM (`sk-cp-` key) reads images only; Claude reads images and PDFs (model from `CLAUDE_MODEL`); Gemini reads everything, including HEIC. `VISION_PROVIDER` picks the first; every other provider with a key that can read the file type is a fallback, in the order MiniMax, Claude, Gemini.
- Use the Gemini model name `gemini-3-flash-preview` (hyphenated), not dotted/underscored variants.
- The GST verdict is strictly "an explicit GST line is printed on the receipt", never inferred from vendor or total. A USD receipt can legitimately show SG GST (overseas-vendor-registration suppliers such as Fireworks AI). The invoice-line GST checkbox defaults from this verdict and remains the manual override.
- For USD receipts, store SGD approximations at the day rate and at the day rate plus 3.25%.
- AI keys saved in the app's Settings > AI are stored in KV, never returned to the browser, and win over the matching Worker secret; the provider and Claude model set there override `VISION_PROVIDER` / `CLAUDE_MODEL`.
- With a Claude key, **Find matches** sends claims and receipts the exact rules didn't clearly pair to Claude. Nothing is linked until the user accepts a suggestion; Claude's pick replaces an ambiguous rule suggestion but never a clear one.

## Gmail receipts

- The worker imports receipts from linked Gmail accounts read-only, on a cron and via **Scan now**. Each message is imported at most once; nothing is written to Gmail. The Google OAuth consent screen must be published "In production"; in Testing, refresh tokens expire after 7 days.
- For missing Grab or Gojek ride receipts, use the `ride-gmail-receipts` skill. Repeat exports start after the newest receipt already labelled `exported`; add `--label-exported` only after a PDF rendered successfully. Ignore GrabFood receipts unless the user explicitly asks for food claims.

## Worker API

- All receipt worker endpoints require the `X-Auth-Token` header (not `Authorization` or `X-Auth-Password`), whose value is `R2_PASSWORD` and must match the worker's `AUTH_PASSWORD` secret. Behind Cloudflare Access, non-browser calls also need `CF-Access-Client-Id` / `CF-Access-Client-Secret`. Wrong passwords are rate-limited per IP (10 a minute, then a five-minute 429 lockout).
- Read the worker URL from `.env`; don't hardcode it.
- YNAB amounts are in milliunits. Filter for `amount < 0` to avoid counting transfers twice.
- `GET /list` and `GET /ynab/todos` return a `Server-Timing` header (`r2-list`, `r2-metadata`, `claims-upstream`) for diagnosing slow loads.

## Local development

- Two npm packages, no root `package.json`: `upload-app/` (Worker + static UI) and `scripts/` (tsx/Playwright CLIs). Run npm commands inside each. `upload-app/` needs `npx playwright install chromium` for its browser smokes.
- `npm run dev` in `upload-app/` runs `wrangler dev`; Miniflare emulates R2 and KV, so no Cloudflare login is needed. Copy `upload-app/.dev.vars.example` to `.dev.vars` and set `AUTH_PASSWORD` to a throwaway value. Run `npm run deploy` or `wrangler deploy` only on an explicit user request.
- The claims backend defaults to HowMuch and needs `HOWMUCH_PAT` plus a plan id; without it the claims panes show "not configured" errors. Receipt upload, list and link work with only `AUTH_PASSWORD`.
- Checks (from `upload-app/`, as the deploy workflow runs them): `npx tsc --noEmit`, `npm run smoke:frontend`, `npm run smoke:worker-claims`, `npm run test:pending-tags`, `npm run test:access`, `npm run test:ai`, `npm run smoke:ai-frontend`. `npm run test:gmail` is a separate Gmail contract test. There is no linter or formatter config.
- The `scripts/` CLIs read the repo-root `.env` and call a reachable worker plus external services, so local `wrangler dev` is not enough to run them end to end.
