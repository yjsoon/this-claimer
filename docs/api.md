# Worker API

All endpoints require the `X-Auth-Token` header.

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
- `POST /xero/connect` · `GET /xero/callback` · `GET /xero/status` · `POST /xero/disconnect` · `GET /xero/meta` · `POST /xero/invoices/push` - Xero integration for the Invoices tab (see [usage](usage.md#xero-invoices))

`GET /agent/unclaimed-expenditures` accepts an optional `since_date=YYYY-MM-DD` query param and returns:
- `summary` - counts for TODO claims, missing receipt claims, linked claims, and unlinked receipts
- `missingReceiptClaims` - TODO expenditures with no linked uploaded receipt, including Gmail search hints
- `linkedClaims` - TODO claims that already have linked receipt metadata
- `unlinkedReceipts` - uploaded receipts that are not linked to any claim

`GET /list` and `GET /ynab/todos` also return a `Server-Timing` header; see [AGENTS.md](../AGENTS.md) for the Gmail, GST-tagging and diagnostics routes.
