---
name: claim-invoices
description: Generate monthly Xero DRAFT bills (GST / non-GST / transport) from ready-to-claim receipts via the receipts.soon.sg Invoices tab. Use when the user wants to invoice claims to Xero, set up or connect the Xero integration, or work on the Invoices tab / push-to-Xero flow.
---

# Claim Invoices → Xero draft bills

Turns the "ready to claim" items in the receipts.soon.sg upload-app into monthly
**DRAFT bills in Xero**, replacing the Volopay flow. Bills are split into GST /
non-GST / transport; line items are grouped by account and sorted by date; payee
is **"Soon Yin Jie"**; receipts are attached. After a push, receipts are tagged
`xeroInvoiceId` (so they drop off the tab) and the linked YNAB `TODO:` memos are
flipped to `CLAIMED:`.

## Where it lives

- Worker (Xero OAuth + push): `upload-app/worker/xero.ts`, `upload-app/worker/index.ts`
- UI (Invoices tab): `upload-app/src/{index.html,main.js,style.css}`
- Config: `upload-app/wrangler.toml` (`XERO_TOKENS` KV + `XERO_SCOPES` / `XERO_INPUT_TAXTYPE` vars)
- Local secrets template: `upload-app/.dev.vars.example`

## One-time setup (the user does this)

1. Xero developer portal → the **existing** Xero app (same one the local `xero/`
   project uses) → add redirect URIs:
   - `https://receipts.soon.sg/xero/callback`
   - `http://localhost:8787/xero/callback` (only if testing via `wrangler dev`; match the dev port)
2. Create the token KV namespace and paste the id into `wrangler.toml`:
   ```bash
   cd upload-app && npx wrangler kv namespace create XERO_TOKENS
   ```
3. Set the worker secrets:
   ```bash
   npx wrangler secret put XERO_CLIENT_ID
   npx wrangler secret put XERO_CLIENT_SECRET
   ```
4. `npm run deploy`, open the **Invoices** tab, click **Connect Xero**, authorise once.
5. Confirm the tenant's tax codes: open the connected `/xero/meta` (or Xero →
   Settings → Tax rates). If the 9% standard-rated **purchase** TaxType is not
   `INPUTY24`, set `XERO_INPUT_TAXTYPE` in `wrangler.toml` to the correct string.

## Using it

Open receipts.soon.sg → **Invoices** (toolbar toggle). Review the editable table —
tweak description, **Account**, the **GST?** toggle (sets the input tax code), and
the per-line **remark**; the GST / non-GST / transport buckets update live. If a
line is still on this tab, it is not claimed. HowMuch/YNAB stay `TODO:` until
**Mark checked as claimed**. Do not treat `xeroPending*` metadata as a live Xero
bill — use **Clear stale draft stamps** (or `PATCH /receipt/:key/xero-pending`
with `{ "clear": true }`) to drop leftover stamps only; never delete the receipt
file. Click **Generate … invoice** to preview, then **Push to Xero (draft)**.
Open the returned link, review/approve in Xero.

The **GST?** toggle defaults from an AI verdict (`taggedGstShown` receipt
metadata). Vision tagging (amount extraction + GST detection) uses MiniMax
coding-plan VLM for images (`MINIMAX_API_KEY` secret) with Gemini as backup and
for PDFs/HEIC; switch with the `VISION_PROVIDER` var. New uploads are tagged
automatically; the **Detect GST** button backfills receipts without a verdict
(or `POST /gst-tags/pending?limit=8` until `remaining` is 0).

## Endpoints (worker)

| Method | Path | Purpose |
| :-- | :-- | :-- |
| POST | `/xero/connect` | Start OAuth (header-authed; returns `{authorizeUrl}` for the SPA to navigate to) |
| GET | `/xero/callback` | OAuth redirect target (trusted via one-time state) |
| GET | `/xero/status` | `{connected, tenantName}` |
| POST | `/xero/disconnect` | Forget stored tokens |
| GET | `/xero/meta` | Tax rates + expense accounts (dropdowns / verification) |
| POST | `/xero/invoices/push` | Create DRAFT bill, attach receipts, tag + flip YNAB CLAIMED |
| PATCH | `/receipt/:key/xero-pending` | Clear leftover `xeroPending*` stamps only (`{ "clear": true }`); never deletes the file |
| POST | `/gst-tags/pending?limit=8` | Detect GST for receipts without a verdict (backfill; returns `remaining`) |
| POST | `/receipt/:key/tag-gst` | Force GST re-detection for one receipt |

## Rules

- **Accounts**: 463 Software · 320 Cost of Sales (IMDA VIBE / "for class") · 464
  Hardware · 460 Books · 451 Local transport · 452 Overseas transport · 467 Phone/Internet.
- **Tax**: `INPUTY24` only if the receipt shows an explicit GST line; USD no-GST →
  `OPINPUT`; SGD no-GST → `NRINPUT`. Amounts are **tax-inclusive SGD** (the YNAB
  amount is the source of truth; Xero back-computes GST on standard-rated lines).
- **Buckets**: transport = accounts 451/452; GST = non-transport `INPUTY24`; non-GST
  = non-transport `NRINPUT`/`OPINPUT`.
- **Attachments**: Xero caps at 3 MB/file and 10/bill. Within caps → individual
  named files; otherwise the worker merges embeddable receipts (PDF/JPG/PNG) into
  chunked combined PDFs. HEIC/WEBP/GIF/TIFF can't be embedded → re-upload as PDF/JPG/PNG.

## Local testing

```bash
cd upload-app
cp .dev.vars.example .dev.vars   # fill in real values (gitignored)
npx wrangler dev
```

`/xero/status` and the connect flow work locally if the localhost callback is
registered on the Xero app. **Do not** `npm run deploy` to production without the
user's go-ahead.
